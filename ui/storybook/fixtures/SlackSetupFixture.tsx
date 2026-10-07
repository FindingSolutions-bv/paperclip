import { useLayoutEffect, useState } from "react";
import { ChatEndpointSetup } from "@/pages/apps/chat/ChatEndpointSetup";
import { Button } from "@/components/ui/button";
import { ChatSetupSidebar } from "@/components/chat/ChatSetupNavigation";
import { ChatSetupSidebarProvider } from "@/context/ChatSetupSidebarContext";
import { type ChatEndpoint } from "@/api/chatEndpoints";
import { storybookAgents, storybookAuthSession } from "./paperclipData";

export type SlackSetupScenario = "create" | "manual" | "install" | "declined" | "uncertain" | "recovery" | "verify";

/** Production wizard over a local provider fixture. No requests go to Slack. */
export function SlackSetupFixture({ scenario = "create" }: { scenario?: SlackSetupScenario }) {
  const [ready, setReady] = useState(false);
  const [signalVerification, setSignalVerification] = useState<() => void>(() => () => {});
  useLayoutEffect(() => {
    const original = window.fetch;
    const agent = storybookAgents[0];
    const endpoint: ChatEndpoint = {
      id: "slack-story", companyId: "company-storybook", provider: "slack", status: "draft",
      assignedAgentId: agent.id, assignedAgentName: agent.name, allowUnlinkedPeople: false,
      setup: { step: "provider_setup", slackSetupMethod: scenario === "manual" ? "manual" : "automatic",
        slackApp: { appName: "maya-paperclip", botName: "maya", command: "/maya" },
        webhookUrl: "https://ingress.example/api/chat-webhooks/slack-story/slack",
        slackOAuthCallbackUri: "https://board.example/api/chat-slack/oauth/callback",
      },
    };
    const created = () => { endpoint.setup!.slackRegistration = { status: "install", appId: "ASTORY", managementUrl: "https://api.slack.com/apps/ASTORY" }; };
    const installed = () => {
      created(); endpoint.setup!.slackRegistration!.status = "configured";
      endpoint.status = "verifying"; endpoint.providerAccountId = "TSTORY"; endpoint.botExternalId = "USTORY"; endpoint.botUsername = "maya";
    };
    if (["install", "declined", "recovery"].includes(scenario)) created();
    if (scenario === "declined") endpoint.setup!.slackRegistration!.errorCode = "slack_install_declined";
    if (scenario === "recovery") endpoint.setup!.slackRegistration = { ...endpoint.setup!.slackRegistration!, status: "credentials_saved", errorCode: "slack_configuration_incomplete" };
    if (scenario === "uncertain") endpoint.setup!.slackRegistration = { status: "uncertain", errorCode: "slack_creation_uncertain", managementUrl: "https://api.slack.com/apps" };
    if (scenario === "verify") installed();
    let linked = false;
    setSignalVerification(() => () => { endpoint.setup!.webhookVerifiedAt = new Date().toISOString(); });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      const path = url.pathname;
      if (path === "/api/companies/company-storybook/agents") return Response.json(storybookAgents);
      if (path === `/api/agents/${agent.id}`) return Response.json(agent);
      if (path === "/api/companies/company-storybook/chat-endpoints") return Response.json(endpoint);
      if (path === "/api/chat-endpoints/slack-story") {
        if (init?.method === "PATCH") {
          const { slackApp, slackSetupMethod } = JSON.parse(String(init.body));
          if (slackApp) endpoint.setup!.slackApp = slackApp;
          if (slackSetupMethod) endpoint.setup!.slackSetupMethod = slackSetupMethod;
        }
        return Response.json(endpoint);
      }
      if (path === "/api/chat-endpoints/slack-story/slack/registration") { created(); return Response.json(endpoint); }
      if (path === "/api/chat-endpoints/slack-story/slack/install") {
        installed();
        return Response.json({ authorizationUrl: `${window.location.href.split("#")[0]}#simulated-slack-consent`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      if (path === "/api/chat-endpoints/slack-story/slack/resume") { installed(); return Response.json(endpoint); }
      if (path === "/api/chat-endpoints/slack-story/setup") {
        const { action } = JSON.parse(String(init?.body));
        if (action === "verify") { endpoint.setup!.step = "test"; endpoint.setup!.testStartedAt = new Date().toISOString(); }
        else installed();
        return Response.json(endpoint);
      }
      if (path === "/api/chat-endpoints/slack-story/principals") return Response.json([{
        id: "slack-person", principalId: "slack-person", externalLabel: "Preview person", externalDetail: "Preview workspace",
        status: linked ? "linked" : "pending", paperclipUserId: linked ? storybookAuthSession.user.id : null,
        lastConnectAt: new Date().toISOString(),
      }]);
      if (path.endsWith("/slack-person/link-intent")) return Response.json({ confirmationUrl: "https://board.example/confirm?token=fixture" });
      if (path === "/api/chat-identity-links/confirm") { linked = true; return Response.json({ ok: true }); }
      if (path.endsWith("/test-status")) return Response.json({ messageReceivedAt: null });
      if (path.endsWith("/finish")) { endpoint.status = "active"; endpoint.setup!.step = "complete"; return Response.json(endpoint); }
      return original(input, init);
    };
    setReady(true);
    return () => { window.fetch = original; };
  }, [scenario]);
  return <div className="space-y-6 p-6">
    <aside className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm text-muted-foreground">
      Preview fixture: Slack consent, callbacks, and identity discovery are simulated.
      <Button variant="outline" size="sm" onClick={signalVerification}>Simulate signed verification</Button>
    </aside>
    {ready && <ChatSetupSidebarProvider><div className="flex flex-col gap-8 md:flex-row"><aside className="w-56 shrink-0"><ChatSetupSidebar /></aside><main className="min-w-0 flex-1"><ChatEndpointSetup /></main></div></ChatSetupSidebarProvider>}
  </div>;
}
