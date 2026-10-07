import { normalizeGitHubBotCloudPayload } from "./chat-github-cloud-payload.js";
import type { Db, chatEndpoints } from "@paperclipai/db";
import { chatEndpoints as endpoints } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { forbidden } from "../errors.js";
import type { SealedConnectorEvents } from "./paperclip-cloud-connector.js";

type Event = SealedConnectorEvents["events"][number];
type Endpoint = typeof chatEndpoints.$inferSelect;
type Handler = (
  endpoint: Endpoint,
  event: { event: string; deliveryId: string },
  body: Record<string, unknown>,
) => Promise<void>;
const handlers = new WeakMap<Db, Handler>();
export function registerGitHubBotCloudIngress(db: Db, handler: Handler) {
  handlers.set(db, handler);
  return () => {
    if (handlers.get(db) === handler) handlers.delete(db);
  };
}
/** Called only for an authenticated, decrypted broker lease, never from a board request body. */
export async function dispatchGitHubBotCloudEvent(
  db: Db,
  event: Event,
): Promise<boolean> {
  const value = event.payload.githubApp;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const packet = value as Record<string, unknown>;
  if (
    typeof packet.endpointId !== "string" ||
    typeof packet.companyId !== "string" ||
    typeof packet.registrationId !== "string" ||
    typeof packet.deliveryId !== "string" ||
    !/^[A-Za-z0-9_-]{8,200}$/.test(packet.deliveryId) ||
    !event.bindingIds.includes(`github-app:${packet.registrationId}`) ||
    !packet.body ||
    typeof packet.body !== "object" ||
    Array.isArray(packet.body) ||
    JSON.stringify(packet.body).length > 1_048_576
  )
    throw forbidden("Invalid GitHub Cloud event");
  const [endpoint] = await db
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.companyId, packet.companyId),
        eq(endpoints.id, packet.endpointId),
        eq(endpoints.provider, "github"),
      ),
    );
  if (!endpoint || endpoint.status === "archived") return true;
  if (
    endpoint.connectionId !== packet.connectionId ||
    endpoint.assignedAgentId !== packet.agentId ||
    endpoint.botExternalId !== packet.appId ||
    endpoint.setup.github?.cloudRegistrationId !== packet.registrationId
  )
    throw forbidden("GitHub Cloud event does not belong to this bot");
  if (
    ![
      "ping",
      "issue_comment",
      "pull_request_review_comment",
      "pull_request",
      "installation",
      "installation_repositories",
      "github_app_authorization",
    ].includes(event.event)
  )
    throw forbidden("Unsupported GitHub Cloud event");
  const handler = handlers.get(db);
  if (!handler) throw new Error("GitHub bot Cloud ingress is not ready");
  await handler(
    endpoint,
    { event: event.event, deliveryId: packet.deliveryId },
    normalizeGitHubBotCloudPayload(packet.body as Record<string, unknown>),
  );
  return true;
}
