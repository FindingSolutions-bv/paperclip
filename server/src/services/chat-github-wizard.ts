import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  chatEndpoints,
  chatGitHubRegistrations,
  chatExternalPrincipals,
  chatIdentityLinks,
  companies,
  companyMemberships,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import type {
  GitHubAppRegistrationInput,
  GitHubAppWizardState,
} from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import {
  githubBotCredentials,
  githubBotRequest,
} from "./chat-github-client.js";
import {
  resyncGitHubAppWebhook,
  listGitHubAppWebhookDeliveries,
  requestGitHubAppWebhookRedelivery,
} from "./chat-github-webhook-config.js";
import { githubChatManagementService } from "./chat-github-management.js";
import {
  createPaperclipCloudConnector,
  paperclipCloudConnectorConfigFromEnv,
  type PaperclipCloudConnector,
} from "./paperclip-cloud-connector.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const nonce = () => randomBytes(32).toString("base64url");
type Endpoint = typeof chatEndpoints.$inferSelect;
type Resource = { id: string; enabled: boolean; availability: string };
/** Manager-only orchestration. Provider callbacks resume this same durable draft. */
export function githubChatWizardService(
  db: Db,
  options: {
    origin: () => string | null;
    fetch?: typeof fetch;
    connector?: () => PaperclipCloudConnector | null;
    startDirect: (
      endpointId: string,
      userId: string,
      input: GitHubAppRegistrationInput,
    ) => Promise<{
      registrationUrl: string;
      manifest: Record<string, unknown>;
      expiresAt: string;
    }>;
    resumeDirect?: (
      endpointId: string,
      userId: string,
    ) => Promise<{
      registrationUrl: string;
      manifest: Record<string, unknown>;
      expiresAt: string;
    }>;
    completeDirect?: (state: string, code: string) => Promise<string>;
    storeApp: (
      endpointId: string,
      userId: string,
      credentials: Record<string, string>,
    ) => Promise<unknown>;
    storeCredentials: (
      endpointId: string,
      userId: string,
      credentials: Record<string, string>,
    ) => Promise<void>;
    refreshRepositories: (
      endpointId: string,
      userId: string,
    ) => Promise<Resource[]>;
    resources: (endpointId: string) => Promise<Resource[]>;
    replaceResources: (
      endpointId: string,
      updates: Array<{ id: string; enabled: boolean }>,
      userId: string,
      options?: { initialGitHubImport?: boolean },
    ) => Promise<unknown>;
    configure: (endpointId: string, userId: string) => Promise<unknown>;
    finish: (endpointId: string, userId: string) => Promise<unknown>;
  },
) {
  const fetchImpl = options.fetch ?? fetch;
  const management = githubChatManagementService(db, fetchImpl);
  const connector =
    options.connector ??
    (() => {
      const config = paperclipCloudConnectorConfigFromEnv();
      return config
        ? createPaperclipCloudConnector({ config, request: fetchImpl })
        : null;
    });
  const pending = new Map<string, Promise<GitHubAppWizardState>>();
  async function endpoint(id: string, userId: string): Promise<Endpoint> {
    const [bot] = await db
      .select()
      .from(chatEndpoints)
      .where(
        and(eq(chatEndpoints.id, id), eq(chatEndpoints.provider, "github")),
      );
    if (!bot || bot.status === "archived")
      throw notFound("GitHub bot not found");
    const [member] = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, bot.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      );
    if (!member || member.membershipRole === "viewer")
      throw forbidden("An active company manager is required");
    return bot;
  }
  async function registration(bot: Endpoint) {
    const [session] = await db
      .select()
      .from(chatGitHubRegistrations)
      .where(
        and(
          eq(chatGitHubRegistrations.companyId, bot.companyId),
          eq(chatGitHubRegistrations.endpointId, bot.id),
        ),
      )
      .orderBy(desc(chatGitHubRegistrations.createdAt))
      .limit(1);
    return session;
  }
  async function setup(
    bot: Endpoint,
    values: Partial<NonNullable<Endpoint["setup"]["github"]>>,
  ) {
    await db
      .update(chatEndpoints)
      .set({
        setup: sql`jsonb_set(${chatEndpoints.setup}, '{github}', coalesce(${chatEndpoints.setup}->'github','{}'::jsonb) || ${JSON.stringify(values)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatEndpoints.id, bot.id),
          eq(chatEndpoints.companyId, bot.companyId),
        ),
      );
  }
  async function resume(bot: Endpoint) {
    const [company] = await db
      .select({ prefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, bot.companyId));
    return `${options.origin()}/${company!.prefix}/apps/chat/connect?provider=github&purpose=chat&resume=${bot.id}`;
  }
  function origin() {
    const value = options.origin();
    if (!value)
      throw badRequest(
        "Configure this instance's browser address before connecting GitHub",
      );
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw badRequest("Use an enrolled HTTPS or local browser address");
    return url.origin;
  }
  async function start(
    id: string,
    userId: string,
    input: GitHubAppRegistrationInput,
  ) {
    const bot = await endpoint(id, userId);
    if (bot.botExternalId)
      throw conflict(
        "This draft already has an App. Continue its installation or recover its credentials.",
      );
    const prior = await registration(bot);
    if (prior && ["pending", "exchanging", "failed"].includes(prior.status)) {
      if (prior.userId !== userId)
        throw conflict("The configuring member must resume this registration");
      if (prior.status !== "pending" || prior.expiresAt <= new Date())
        throw conflict(
          "Recover the existing App from GitHub settings; its registration cannot safely be repeated.",
        );
      if (prior.handoff) return advance(id, userId);
      // The direct flow's hashed state cannot be reconstructed. Do not create a duplicate App.
      throw conflict(
        "An App registration is already pending. Complete its open GitHub page, or use existing-App recovery.",
      );
    }
    await saveDraft(id, userId, input);
    // Only a fresh registration may import GitHub's initial selection. Old
    // drafts without this marker retain even an entirely disabled selection.
    if (
      !bot.setup.github?.repositorySelectionSaved &&
      !(await options.resources(id)).length
    )
      await setup(bot, { initialRepositoryImportPending: true });
    const cloud = connector();
    if (!cloud) {
      if (origin().startsWith("https://"))
        return {
          endpointId: id,
          state: "create",
          registration: await options.startDirect(id, userId, input),
        } satisfies GitHubAppWizardState;
      return {
        endpointId: id,
        state: "enrollment",
        message:
          "Use Paperclip Cloud to receive GitHub events for this local instance.",
      } satisfies GitHubAppWizardState;
    }
    if (!(await cloud.githubAppsAvailable()))
      throw conflict(
        "GitHub App setup is not enabled on your Paperclip Cloud connector yet.",
      );
    const trustedOrigin = origin();
    const session = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, id))
        .for("update");
      if (!locked || locked.botExternalId || locked.status === "archived")
        throw conflict("This draft changed. Resume its existing App.");
      const [prior] = await tx
        .select()
        .from(chatGitHubRegistrations)
        .where(eq(chatGitHubRegistrations.endpointId, id))
        .orderBy(desc(chatGitHubRegistrations.createdAt))
        .limit(1);
      if (prior) {
        if (
          prior.userId !== userId ||
          !prior.handoff?.cloudId ||
          prior.status !== "pending" ||
          prior.expiresAt <= new Date()
        )
          throw conflict(
            "Resume or recover the App already registered for this draft.",
          );
        return prior;
      }
      const returnState = nonce();
      const [created] = await tx
        .insert(chatGitHubRegistrations)
        .values({
          companyId: bot.companyId,
          endpointId: id,
          userId,
          stateHash: hash(returnState),
          trustedOrigin,
          ownerType: input.ownerType,
          ownerLogin: input.ownerLogin,
          appName: input.name,
          expiresAt: new Date(Date.now() + 30 * 60_000),
          handoff: { cloudId: nonce(), returnState, redemptionId: nonce() },
        })
        .returning();
      await logActivity(tx as unknown as Db, {
        companyId: bot.companyId,
        actorType: "user",
        actorId: userId,
        action: "chat_github.registration_started",
        entityType: "tool_connection",
        entityId: bot.connectionId,
        details: {
          endpointId: id,
          registrationId: created!.id,
          ownerType: input.ownerType,
          transport: "paperclip_cloud",
        },
      });
      return created!;
    });
    await setup(bot, {
      stage: "connect",
      ownerType: session.ownerType,
      ownerLogin: session.ownerLogin ?? undefined,
      appName: session.appName ?? undefined,
      cloudRegistrationId: session.handoff!.cloudId,
      registrationStatus: "pending",
    });
    const state = await cloud.githubApp({
      subject: userId,
      companyId: bot.companyId,
      binding: cloudStart(bot, session),
    });
    if (!state.registrationUrl || !state.manifest)
      throw conflict(
        "GitHub App registration could not be prepared. Resume the existing draft.",
      );
    return {
      endpointId: id,
      state: "create",
      registration: {
        registrationUrl: state.registrationUrl,
        manifest: state.manifest,
        expiresAt: state.expiresAt,
      },
    } satisfies GitHubAppWizardState;
  }
  function cloudStart(
    bot: Endpoint,
    session: typeof chatGitHubRegistrations.$inferSelect,
  ) {
    return {
      action: "start",
      id: session.handoff!.cloudId,
      endpointId: bot.id,
      connectionId: bot.connectionId,
      agentId: bot.assignedAgentId,
      name: session.appName!,
      ownerType: session.ownerType,
      ...(session.ownerLogin ? { ownerLogin: session.ownerLogin } : {}),
      returnUri: `${session.trustedOrigin}/api/chat-github/cloud/callback`,
      returnState: session.handoff!.returnState,
    };
  }
  async function saveDraft(
    id: string,
    userId: string,
    input: GitHubAppRegistrationInput,
  ) {
    const bot = await endpoint(id, userId);
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, id))
        .for("update");
      const [session] = await tx
        .select()
        .from(chatGitHubRegistrations)
        .where(eq(chatGitHubRegistrations.endpointId, id))
        .limit(1);
      if (bot.botExternalId || session)
        throw conflict(
          "Resume the existing App registration before changing its account.",
        );
      await tx
        .update(chatEndpoints)
        .set({
          setup: sql`jsonb_set(${chatEndpoints.setup}, '{github}', coalesce(${chatEndpoints.setup}->'github','{}'::jsonb) || ${JSON.stringify({ ownerType: input.ownerType, ownerLogin: input.ownerType === "organization" ? input.ownerLogin : null, appName: input.name })}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(eq(chatEndpoints.id, id));
      await logActivity(tx as unknown as Db, {
        companyId: bot.companyId,
        actorType: "user",
        actorId: userId,
        action: "chat_github.draft_saved",
        entityType: "tool_connection",
        entityId: bot.connectionId,
        details: { endpointId: id },
      });
    });
    return { saved: true as const };
  }
  async function repairCloud(id: string, userId: string) {
    const bot = await endpoint(id, userId),
      session = await registration(bot),
      cloud = connector();
    if (!session?.handoff?.cloudId) return;
    if (session.userId !== userId)
      throw forbidden("The configuring member must recover this registration");
    if (!cloud)
      throw conflict(
        "Restore Paperclip Cloud enrollment before reconnecting this App",
      );
    const binding = { subject: userId, companyId: bot.companyId };
    const state = await cloud.githubApp({
      ...binding,
      binding: cloudStart(bot, session),
    });
    const { credentials, appJwt } = await githubBotCredentials(
      db,
      bot.companyId,
      id,
    );
    if (!credentials.webhookSecret)
      throw conflict("Recover this App's webhook secret before continuing");
    if (state.appId && state.appId !== credentials.appId)
      throw conflict("Recovery must use the original GitHub App");
    if (!state.webhookUrl)
      throw conflict(
        "Paperclip Cloud does not support recovering this App yet",
      );
    await logActivity(db, {
      companyId: bot.companyId,
      actorType: "user",
      actorId: userId,
      action: "chat_github.webhook_repair_started",
      entityType: "tool_connection",
      entityId: bot.connectionId,
      details: { endpointId: id, appId: credentials.appId },
    });
    await resyncGitHubAppWebhook({
      fetch: fetchImpl,
      appToken: appJwt,
      webhookUrl: state.webhookUrl,
      webhookSecret: credentials.webhookSecret,
    });
    const repaired = await cloud.githubApp({
      ...binding,
      binding: {
        action: "repair",
        id: session.handoff.cloudId,
        appToken: appJwt,
        webhookSecret: credentials.webhookSecret,
      },
    });
    if (repaired.appId !== credentials.appId)
      throw conflict("GitHub App recovery binding did not match");
    await db
      .update(chatGitHubRegistrations)
      .set({
        handoff: sql`jsonb_set(${chatGitHubRegistrations.handoff}, '{webhookSecretHash}', ${JSON.stringify(hash(credentials.webhookSecret))}::jsonb)`,
        status: "completed",
      })
      .where(eq(chatGitHubRegistrations.id, session.id));
    await setup(bot, {
      cloudRegistrationId: session.handoff.cloudId,
      registrationStatus: "completed",
    });
    await db
      .update(chatEndpoints)
      .set({
        setup: sql`jsonb_set(${chatEndpoints.setup}, '{webhookVerifiedAt}', 'null'::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(chatEndpoints.id, id));
    try {
      const history = await listGitHubAppWebhookDeliveries({
        fetch: fetchImpl,
        appToken: appJwt,
      });
      const ping = history.deliveries.find(
        (delivery) => delivery.event === "ping",
      );
      if (ping)
        await requestGitHubAppWebhookRedelivery({
          fetch: fetchImpl,
          appToken: appJwt,
          deliveryId: ping.id,
        });
    } catch {
      /* Keep verification pending until a fresh provider-signed delivery arrives. */
    }
    await logActivity(db, {
      companyId: bot.companyId,
      actorType: "user",
      actorId: userId,
      action: "chat_github.webhook_repaired",
      entityType: "tool_connection",
      entityId: bot.connectionId,
      details: { endpointId: id, appId: credentials.appId },
    });
  }
  async function advance(
    id: string,
    userId: string,
  ): Promise<GitHubAppWizardState> {
    // Multiple open tabs for this manager share one operation, not concurrent vault writes.
    const key = `${id}:${userId}`;
    if (pending.has(key)) return pending.get(key)!;
    const work = advanceOnce(id, userId);
    pending.set(key, work);
    try {
      return await work;
    } finally {
      if (pending.get(key) === work) pending.delete(key);
    }
  }
  async function advanceOnce(
    id: string,
    userId: string,
  ): Promise<GitHubAppWizardState> {
    let bot = await endpoint(id, userId);
    if (["paused", "revoked"].includes(bot.status))
      return {
        endpointId: id,
        state: "recovery",
        message: "Reconnect this App from connection settings.",
      };
    const session = await registration(bot),
      cloud = connector();
    if (session?.handoff?.cloudId) {
      if (session.userId !== userId)
        throw forbidden(
          "The configuring member must complete this registration",
        );
      if (!cloud)
        return {
          endpointId: id,
          state: "enrollment",
          message:
            "Restore this instance's Paperclip Cloud enrollment to resume.",
        };
      const [connection] = await db
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.id, bot.connectionId),
            eq(toolConnections.companyId, bot.companyId),
          ),
        );
      const vaulted =
        !!bot.botExternalId &&
        [
          "appId",
          "privateKey",
          "webhookSecret",
          "clientId",
          "clientSecret",
        ].every((key) =>
          connection?.refs.some(
            (ref) => ref.configPath === `credentials.${key}`,
          ),
        );
      const hasAppCredentials =
        !!bot.botExternalId &&
        ["appId", "privateKey", "webhookSecret"].every((key) =>
          connection?.refs.some(
            (ref) => ref.configPath === `credentials.${key}`,
          ),
        );
      const binding = { subject: userId, companyId: bot.companyId };
      let state = await cloud.githubApp({
        ...binding,
        binding: cloudStart(bot, session),
      });
      if (hasAppCredentials) {
        const { credentials } = await githubBotCredentials(
          db,
          bot.companyId,
          id,
        );
        if (
          ["pending", "exchanging", "failed"].includes(state.status) ||
          (session.handoff.webhookSecretHash &&
            session.handoff.webhookSecretHash !==
              hash(credentials.webhookSecret ?? ""))
        ) {
          await repairCloud(id, userId);
          state = await cloud.githubApp({
            ...binding,
            binding: { action: "status", id: session.handoff.cloudId },
          });
          bot = await endpoint(id, userId);
        }
      }
      if (state.status === "failed" || state.status === "exchanging")
        return {
          endpointId: id,
          state: "recovery",
          message:
            state.status === "exchanging"
              ? "GitHub registration is still being processed. If it was interrupted, recover the App already created on GitHub."
              : "Recover the App already created on GitHub. Registration was interrupted and cannot safely be repeated.",
        };
      if (state.status === "pending") {
        if (Date.parse(state.expiresAt) <= Date.now())
          return {
            endpointId: id,
            state: "recovery",
            message:
              "Registration expired. Check GitHub for the App before using existing-App recovery.",
          };
        return {
          endpointId: id,
          state: "create",
          registration:
            state.registrationUrl && state.manifest
              ? {
                  registrationUrl: state.registrationUrl,
                  manifest: state.manifest,
                  expiresAt: state.expiresAt,
                }
              : undefined,
        };
      }
      if (state.claimExpired && !vaulted)
        return {
          endpointId: id,
          state: "recovery",
          message:
            "Credential delivery expired. Recover the App already created on GitHub; do not create another App.",
        };
      if (state.claimId && !vaulted) {
        const material = await cloud.claimGitHubApp({
          ...binding,
          claimId: state.claimId,
          redemptionId: session.handoff.redemptionId,
        });
        if (
          material.kind !== "github_app" ||
          material.registrationId !== session.handoff.cloudId ||
          material.endpointId !== bot.id ||
          material.connectionId !== bot.connectionId ||
          material.agentId !== bot.assignedAgentId
        )
          throw forbidden(
            "GitHub App credential binding did not match this draft",
          );
        const credentials: Record<string, string> = {};
        for (const key of [
          "appId",
          "privateKey",
          "webhookSecret",
          "clientId",
          "clientSecret",
        ]) {
          if (typeof material[key] !== "string" || !material[key])
            throw conflict("GitHub returned incomplete App credentials");
          credentials[key] = material[key] as string;
        }
        await options.storeApp(id, userId, credentials);
      }
      bot = await endpoint(id, userId);
      if (!bot.botExternalId || bot.botExternalId !== state.appId)
        throw conflict("Recover this App's credentials before continuing.");
      await cloud.githubApp({
        ...binding,
        binding: { action: "stored", id: session.handoff.cloudId },
      });
      const { credentials: storedCredentials } = await githubBotCredentials(
        db,
        bot.companyId,
        id,
      );
      if (!session.handoff.webhookSecretHash)
        await db
          .update(chatGitHubRegistrations)
          .set({
            handoff: sql`jsonb_set(${chatGitHubRegistrations.handoff}, '{webhookSecretHash}', ${JSON.stringify(hash(storedCredentials.webhookSecret))}::jsonb)`,
          })
          .where(eq(chatGitHubRegistrations.id, session.id));
      if (session.status !== "completed")
        await db
          .update(chatGitHubRegistrations)
          .set({ status: "completed" })
          .where(eq(chatGitHubRegistrations.id, session.id));
      await setup(bot, {
        cloudRegistrationId: session.handoff.cloudId,
        ownerType: session.ownerType,
        ownerLogin: state.ownerLogin ?? session.ownerLogin ?? undefined,
        appName: session.appName ?? undefined,
        registrationStatus: "completed",
      });
      if (state.signedDeliveryAt && !bot.setup.webhookVerifiedAt) {
        await db
          .update(chatEndpoints)
          .set({
            setup: sql`jsonb_set(${chatEndpoints.setup}, '{webhookVerifiedAt}', ${JSON.stringify(state.signedDeliveryAt)}::jsonb)`,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, id));
      }
    }
    bot = await endpoint(id, userId);
    if (!bot.botExternalId) {
      if (session && !session.handoff?.cloudId) {
        if (
          session.status === "pending" &&
          session.expiresAt > new Date() &&
          session.handoff?.returnState &&
          options.resumeDirect
        )
          return {
            endpointId: id,
            state: "create",
            registration: await options.resumeDirect(id, userId),
          };
        return {
          endpointId: id,
          state: "recovery",
          message:
            "Resume the open GitHub registration page or recover the existing App from GitHub settings.",
        };
      }
      return { endpointId: id, state: "create" };
    }
    if (!bot.providerAccountId || bot.setup.github?.stage === "install") {
      try {
        await options.refreshRepositories(id, userId);
      } catch (error) {
        return {
          endpointId: id,
          state: "install",
          installationUrl: bot.setup.github?.installationUrl,
          message:
            error instanceof Error
              ? error.message
              : "Waiting for installation or administrator approval on GitHub.",
        };
      }
    }
    bot = await endpoint(id, userId);
    const saved = await management.configuration(id, userId);
    if (!bot.setup.github?.initialRepositoriesImported) {
      const resources = await options.resources(id);
      // Existing saved selections/behavior belong to the user. Only a fresh registration imports GitHub's choices.
      if (
        session &&
        bot.status !== "active" &&
        saved.revision === 0 &&
        bot.setup.github?.initialRepositoryImportPending === true &&
        !bot.setup.github?.repositorySelectionSaved &&
        !resources.some((resource) => resource.enabled)
      ) {
        await options.replaceResources(
          id,
          resources
            .filter((resource) => resource.availability === "available")
            .map((resource) => ({ id: resource.id, enabled: true })),
          userId,
          { initialGitHubImport: true },
        );
      }
      if (session && saved.revision === 0 && bot.status !== "active")
        await management.saveConfiguration(
          id,
          {
            expectedRevision: 0,
            configuration: {
              ...saved.configuration,
              toolsEnabled: true,
              defaults: {
                ...saved.configuration.defaults,
                invocation: "mentions_only",
                events: [],
              },
            },
          },
          userId,
        );
      await setup(bot, { initialRepositoriesImported: true });
    }
    if (bot.status !== "active" && bot.status !== "verifying")
      await options.configure(id, userId);
    bot = await endpoint(id, userId);
    let linked = await linkedIdentity(bot, userId);
    if (!linked) {
      const [prior] = await db
        .select({
          githubUserId: chatExternalPrincipals.externalId,
          login: chatExternalPrincipals.handle,
        })
        .from(chatIdentityLinks)
        .innerJoin(
          chatExternalPrincipals,
          eq(chatExternalPrincipals.id, chatIdentityLinks.principalId),
        )
        .where(
          and(
            eq(chatIdentityLinks.companyId, bot.companyId),
            eq(chatIdentityLinks.paperclipUserId, userId),
            eq(chatIdentityLinks.status, "linked"),
            eq(chatExternalPrincipals.provider, "github"),
          ),
        )
        .limit(1);
      if (prior?.login) {
        await management.linkObservedIdentity(id, userId, {
          githubUserId: prior.githubUserId,
          login: prior.login,
          avatarUrl: null,
        });
        linked = true;
      }
    }
    if (!linked) {
      const { credentials } = await githubBotCredentials(db, bot.companyId, id);
      return {
        endpointId: id,
        state: "identity",
        identityMethod:
          session && credentials.clientId && credentials.clientSecret
            ? "dedicated_app"
            : "existing_connection",
        identity:
          session?.handoff?.identity &&
          Date.parse(session.handoff.identity.expiresAt) > Date.now()
            ? session.handoff.identity
            : undefined,
      };
    }
    const verification = await management.verification(id);
    const connectionChecks = verification.checks.filter(
      (check) => !["runtime", "isolation"].includes(check.key),
    );
    const runtimeChecks = verification.checks.filter((check) =>
      ["runtime", "isolation"].includes(check.key),
    );
    const connectionReady = connectionChecks.every((check) => check.ok);
    if (connectionReady && bot.status !== "active")
      await options.finish(id, userId);
    return {
      endpointId: id,
      state: connectionReady ? "connected" : "verify",
      identityLinked: true,
      verification: { ready: connectionReady, checks: connectionChecks },
      runtimeChecks,
    };
  }
  async function linkedIdentity(bot: Endpoint, userId: string) {
    const [link] = await db
      .select({ id: chatIdentityLinks.id })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.companyId, bot.companyId),
          eq(chatIdentityLinks.endpointId, bot.id),
          eq(chatIdentityLinks.paperclipUserId, userId),
          eq(chatIdentityLinks.status, "linked"),
        ),
      )
      .limit(1);
    return !!link;
  }
  async function withIdentityLease<T>(
    sessionId: string,
    work: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const leaseId = nonce();
    const leaseUntil = () => new Date(Date.now() + 120_000).toISOString();
    const [claimed] = await db
      .update(chatGitHubRegistrations)
      .set({
        handoff: sql`coalesce(${chatGitHubRegistrations.handoff}, '{"cloudId":"","returnState":"","redemptionId":""}'::jsonb) || ${JSON.stringify({ identityLeaseId: leaseId, identityLeaseExpiresAt: leaseUntil() })}::jsonb`,
      })
      .where(
        and(
          eq(chatGitHubRegistrations.id, sessionId),
          sql`(${chatGitHubRegistrations.handoff}->>'identityLeaseExpiresAt' is null or ${chatGitHubRegistrations.handoff}->>'identityLeaseExpiresAt' <= ${new Date().toISOString()})`,
        ),
      )
      .returning({ id: chatGitHubRegistrations.id });
    if (!claimed)
      throw conflict(
        "Another account-linking attempt is in progress. Try again shortly.",
      );
    let lost = false;
    const assertOwned = async () => {
      const [owned] = await db
        .select({ id: chatGitHubRegistrations.id })
        .from(chatGitHubRegistrations)
        .where(
          and(
            eq(chatGitHubRegistrations.id, sessionId),
            sql`${chatGitHubRegistrations.handoff}->>'identityLeaseId' = ${leaseId}`,
            sql`${chatGitHubRegistrations.handoff}->>'identityLeaseExpiresAt' > ${new Date().toISOString()}`,
          ),
        );
      if (lost || !owned)
        throw conflict("Account-linking changed. Connect your account again.");
    };
    const renewal = setInterval(() => {
      void db
        .update(chatGitHubRegistrations)
        .set({
          handoff: sql`jsonb_set(${chatGitHubRegistrations.handoff}, '{identityLeaseExpiresAt}', ${JSON.stringify(leaseUntil())}::jsonb)`,
        })
        .where(
          and(
            eq(chatGitHubRegistrations.id, sessionId),
            sql`${chatGitHubRegistrations.handoff}->>'identityLeaseId' = ${leaseId}`,
          ),
        )
        .returning({ id: chatGitHubRegistrations.id })
        .then((rows) => {
          if (!rows.length) lost = true;
        })
        .catch(() => {
          lost = true;
        });
    }, 30_000);
    renewal.unref();
    try {
      return await work(assertOwned);
    } finally {
      clearInterval(renewal);
      await db
        .update(chatGitHubRegistrations)
        .set({
          handoff: sql`${chatGitHubRegistrations.handoff} - 'identityLeaseId' - 'identityLeaseExpiresAt'`,
        })
        .where(
          and(
            eq(chatGitHubRegistrations.id, sessionId),
            sql`${chatGitHubRegistrations.handoff}->>'identityLeaseId' = ${leaseId}`,
          ),
        );
    }
  }
  async function startIdentity(id: string, userId: string) {
    const bot = await endpoint(id, userId),
      session = await registration(bot);
    if (!session || session.userId !== userId)
      throw forbidden("The configuring member must link their GitHub account");
    return withIdentityLease(session.id, (assertOwned) =>
      startIdentityLocked(id, userId, assertOwned),
    );
  }
  async function startIdentityLocked(
    id: string,
    userId: string,
    assertOwned: () => Promise<void>,
  ) {
    const bot = await endpoint(id, userId),
      session = await registration(bot);
    if (!session || session.userId !== userId)
      throw forbidden("The configuring member must link their GitHub account");
    const credentials = await githubBotCredentials(db, bot.companyId, id);
    if (
      !credentials.credentials.clientId ||
      !credentials.credentials.clientSecret
    )
      throw conflict(
        "This existing App needs a personal GitHub connection to verify your account.",
      );
    const verifier = nonce(),
      state = nonce();
    await assertOwned();
    await options.storeCredentials(id, userId, {
      identityCodeVerifier: verifier,
    });
    await assertOwned();
    await db
      .update(chatGitHubRegistrations)
      .set({
        handoff: sql`(${chatGitHubRegistrations.handoff} - 'identity') || ${JSON.stringify({ identityStateHash: hash(state), identityExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), identityRedemptionId: nonce() })}::jsonb`,
      })
      .where(eq(chatGitHubRegistrations.id, session.id));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (session.handoff?.cloudId) {
      const cloud = connector();
      if (!cloud) throw conflict("Restore Paperclip Cloud enrollment");
      const result = await cloud.githubApp({
        subject: userId,
        companyId: bot.companyId,
        binding: {
          action: "identity",
          id: session.handoff.cloudId,
          codeChallenge: challenge,
          returnState: state,
        },
      });
      if (!result.authorizationUrl)
        throw conflict("GitHub account authorization is unavailable");
      return { authorizationUrl: result.authorizationUrl };
    }
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", credentials.credentials.clientId);
    url.searchParams.set(
      "redirect_uri",
      `${origin()}/api/chat-github/identity/callback`,
    );
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { authorizationUrl: url.toString() };
  }
  async function completeIdentity(
    session: typeof chatGitHubRegistrations.$inferSelect,
    code: string,
    redirectUri: string,
  ) {
    return withIdentityLease(session.id, async (assertOwned) => {
      const [current] = await db
        .select()
        .from(chatGitHubRegistrations)
        .where(eq(chatGitHubRegistrations.id, session.id));
      if (
        !current ||
        current.handoff?.identityStateHash !==
          session.handoff?.identityStateHash
      )
        return resume(await endpoint(session.endpointId, session.userId));
      return completeIdentityLocked(current, code, redirectUri, assertOwned);
    });
  }
  async function completeIdentityLocked(
    session: typeof chatGitHubRegistrations.$inferSelect,
    code: string,
    redirectUri: string,
    assertOwned: () => Promise<void>,
  ) {
    const bot = await endpoint(session.endpointId, session.userId);
    if (
      !session.handoff?.identityExpiresAt ||
      Date.parse(session.handoff.identityExpiresAt) <= Date.now()
    )
      throw conflict(
        "GitHub identity authorization expired. Connect your account again.",
      );
    const [consumed] = await db
      .update(chatGitHubRegistrations)
      .set({
        handoff: sql`${chatGitHubRegistrations.handoff} - 'identityStateHash'`,
      })
      .where(
        and(
          eq(chatGitHubRegistrations.id, session.id),
          sql`${chatGitHubRegistrations.handoff}->>'identityStateHash' = ${session.handoff?.identityStateHash ?? ""}`,
        ),
      )
      .returning();
    if (!consumed) return resume(bot);
    const material = await githubBotCredentials(db, bot.companyId, bot.id);
    const response = await fetchImpl(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: material.credentials.clientId,
          client_secret: material.credentials.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: material.credentials.identityCodeVerifier,
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw conflict(
        "GitHub authorization failed. Connect your account again.",
      );
    }
    const token = (await response.json()) as { access_token?: string };
    if (!token.access_token)
      throw conflict(
        "GitHub authorization was denied. Connect your account again.",
      );
    const user = await githubBotRequest<{
      id: number;
      login: string;
      avatar_url?: string;
    }>(fetchImpl, token.access_token, "/user");
    let allowed = false;
    for (let page = 1; page <= 100; page++) {
      const result = await githubBotRequest<{
        installations: Array<{ id: number; app_id: number }>;
      }>(
        fetchImpl,
        token.access_token,
        `/user/installations?per_page=100&page=${page}`,
      );
      allowed = result.installations.some(
        (installation) =>
          String(installation.app_id) === bot.botExternalId &&
          String(installation.id) === material.credentials.installationId,
      );
      if (allowed || result.installations.length < 100) break;
    }
    if (!allowed)
      throw forbidden(
        "Your GitHub account cannot access this App installation",
      );
    if (
      !Number.isSafeInteger(user.id) ||
      user.id <= 0 ||
      !/^[A-Za-z0-9-]{1,39}$/.test(user.login)
    )
      throw conflict("GitHub returned an invalid account");
    // OAuth token remains transient; only an expiring observed identity is saved.
    await assertOwned();
    const identity = {
      githubUserId: String(user.id),
      login: user.login,
      avatarUrl: user.avatar_url ?? null,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    await db
      .update(chatGitHubRegistrations)
      .set({
        handoff: sql`jsonb_set(${chatGitHubRegistrations.handoff}, '{identity}', ${JSON.stringify(identity)}::jsonb)`,
      })
      .where(eq(chatGitHubRegistrations.id, session.id));
    await assertOwned();
    await options.storeCredentials(bot.id, session.userId, {
      identityCodeVerifier: nonce(),
    });
    return resume(bot);
  }
  async function directCallback(state: string, code: string) {
    const [session] = await db
      .select()
      .from(chatGitHubRegistrations)
      .where(eq(chatGitHubRegistrations.stateHash, hash(state)))
      .limit(1);
    if (
      !session ||
      session.handoff?.cloudId ||
      session.trustedOrigin !== origin()
    )
      throw forbidden("GitHub return did not match this instance");
    const bot = await endpoint(session.endpointId, session.userId);
    if (session.status === "failed" || session.status === "exchanging")
      return resume(bot);
    if (session.status === "pending") {
      if (!options.completeDirect)
        throw conflict("GitHub registration is unavailable");
      await options.completeDirect(state, code);
    }
    const progress = await advance(bot.id, session.userId);
    return progress.state === "install" && progress.installationUrl
      ? progress.installationUrl
      : resume(bot);
  }
  async function cloudCallback(
    state: string,
    registrationId: string,
    claimId?: string,
  ) {
    const [session] = await db
      .select()
      .from(chatGitHubRegistrations)
      .where(
        sql`${chatGitHubRegistrations.handoff}->>'cloudId' = ${registrationId}`,
      )
      .limit(1);
    if (
      !session?.handoff ||
      (session.stateHash !== hash(state) &&
        session.handoff.identityStateHash !== hash(state))
    )
      throw forbidden("GitHub return did not match this instance");
    const bot = await endpoint(session.endpointId, session.userId);
    if (session.trustedOrigin !== origin()) {
      const cloud = connector();
      if (!cloud) throw forbidden("GitHub return did not match this instance");
      const current = await cloud.githubApp({
        subject: session.userId,
        companyId: session.companyId,
        binding: { action: "status", id: registrationId },
      });
      // A manager-authenticated Cloud lookup, rather than a callback parameter,
      // proves the current enrolled destination after an instance rename.
      if (current.returnOrigin !== origin())
        throw forbidden("GitHub return did not match this instance");
      await db
        .update(chatGitHubRegistrations)
        .set({ trustedOrigin: origin() })
        .where(
          and(
            eq(chatGitHubRegistrations.id, session.id),
            eq(chatGitHubRegistrations.trustedOrigin, session.trustedOrigin),
          ),
        );
      await logActivity(db, {
        companyId: session.companyId,
        actorType: "system",
        actorId: "chat-github-setup",
        action: "chat_github.registration_origin_recovered",
        entityType: "tool_connection",
        entityId: bot.connectionId,
        details: { registrationId: session.id },
      });
    }
    if (session.handoff.identityStateHash === hash(state)) {
      if (!claimId) {
        await db
          .update(chatGitHubRegistrations)
          .set({
            handoff: sql`${chatGitHubRegistrations.handoff} - 'identityStateHash'`,
          })
          .where(
            and(
              eq(chatGitHubRegistrations.id, session.id),
              sql`${chatGitHubRegistrations.handoff}->>'identityStateHash' = ${hash(state)}`,
            ),
          );
        return resume(bot);
      }
      const cloud = connector();
      if (!cloud) throw conflict("Restore Paperclip Cloud enrollment");
      const opened = await cloud.claimGitHubApp({
        subject: session.userId,
        companyId: session.companyId,
        claimId,
        redemptionId: session.handoff.identityRedemptionId!,
      });
      if (
        opened.kind !== "github_app_identity" ||
        opened.registrationId !== registrationId ||
        opened.endpointId !== bot.id ||
        opened.connectionId !== bot.connectionId ||
        opened.agentId !== bot.assignedAgentId ||
        typeof opened.code !== "string" ||
        typeof opened.redirectUri !== "string"
      )
        throw forbidden("GitHub identity return did not match this draft");
      return completeIdentity(session, opened.code, opened.redirectUri);
    }
    if (hash(state) !== session.stateHash)
      throw forbidden("GitHub return state did not match");
    const progress = await advance(session.endpointId, session.userId);
    return progress.state === "install" && progress.installationUrl
      ? progress.installationUrl
      : resume(bot);
  }
  async function identityCallback(state: string, code: string) {
    const [session] = await db
      .select()
      .from(chatGitHubRegistrations)
      .where(
        sql`${chatGitHubRegistrations.handoff}->>'identityStateHash' = ${hash(state)}`,
      )
      .limit(1);
    if (!session || session.trustedOrigin !== origin())
      throw forbidden("GitHub identity return did not match");
    await endpoint(session.endpointId, session.userId);
    if (!code) {
      await db
        .update(chatGitHubRegistrations)
        .set({
          handoff: sql`${chatGitHubRegistrations.handoff} - 'identityStateHash'`,
        })
        .where(
          and(
            eq(chatGitHubRegistrations.id, session.id),
            sql`${chatGitHubRegistrations.handoff}->>'identityStateHash' = ${hash(state)}`,
          ),
        );
      return resume(await endpoint(session.endpointId, session.userId));
    }
    return completeIdentity(
      session,
      code,
      `${origin()}/api/chat-github/identity/callback`,
    );
  }
  async function confirmIdentity(
    id: string,
    userId: string,
    githubUserId: string,
  ) {
    const bot = await endpoint(id, userId),
      session = await registration(bot),
      candidate = session?.handoff?.identity;
    if (
      session?.userId !== userId ||
      !candidate ||
      candidate.githubUserId !== githubUserId ||
      Date.parse(candidate.expiresAt) <= Date.now()
    )
      throw conflict(
        "Connect your GitHub account again before confirming its identity",
      );
    await withIdentityLease(session.id, async (assertOwned) => {
      const [current] = await db
        .select()
        .from(chatGitHubRegistrations)
        .where(eq(chatGitHubRegistrations.id, session.id));
      if (
        current?.handoff?.identity?.githubUserId !== githubUserId ||
        current.handoff.identity.expiresAt !== candidate.expiresAt
      )
        throw conflict("GitHub identity changed. Connect your account again.");
      await assertOwned();
      await management.linkObservedIdentity(id, userId, candidate);
      await db
        .update(chatGitHubRegistrations)
        .set({ handoff: sql`${chatGitHubRegistrations.handoff} - 'identity'` })
        .where(eq(chatGitHubRegistrations.id, session.id));
    });
    return advance(id, userId);
  }
  return {
    saveDraft,
    repairCloud,
    start,
    advance,
    startIdentity,
    directCallback,
    cloudCallback,
    identityCallback,
    confirmIdentity,
  };
}
