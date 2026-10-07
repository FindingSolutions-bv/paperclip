import { describe, expect, it } from "vitest";
import { buildSlackAppManifest, slackRegistrationSchema } from "./slack-app-manifest.js";

describe("Slack app manifest", () => {
  const input = { app: { appName: 'Research "Ops"', botName: "research-ops", command: "/research" }, agentName: "Maya", webhookUrl: "https://ingress.example/api/chat-webhooks/public/slack" };
  it("uses identical manual and automatic configuration except the OAuth redirect", () => {
    const manual = buildSlackAppManifest(input);
    const automatic = buildSlackAppManifest({ ...input, redirectUri: "https://board.example/api/chat-slack/oauth/callback" });
    expect(automatic).toEqual({ ...manual, oauth_config: { ...manual.oauth_config, redirect_urls: ["https://board.example/api/chat-slack/oauth/callback"] } });
    expect(manual.features.bot_user.display_name).toBe("research-ops");
    expect(manual.features.slash_commands[0]).toMatchObject({ command: "/research", url: input.webhookUrl, should_escape: false });
    expect(manual.settings.event_subscriptions.request_url).toBe(input.webhookUrl);
    expect(manual.settings.interactivity).toEqual({ is_enabled: true, request_url: input.webhookUrl });
    expect(manual.settings.socket_mode_enabled).toBe(false);
    // The reviewed provider permissions/events stay pinned across both creation paths.
    expect(manual.oauth_config.scopes.bot).toMatchSnapshot();
    expect(manual.settings.event_subscriptions.bot_events).toMatchSnapshot();
  });
  it("rejects arbitrary manifests, scopes, callback destinations, and refresh tokens", () => {
    const request = { requestId: "12345678-1234-4123-8123-123456789abc", credentials: { configurationToken: "temporary" } };
    expect(slackRegistrationSchema.safeParse(request).success).toBe(true);
    for (const key of ["manifest", "scopes", "callbackUri", "configurationRefreshToken"])
      expect(slackRegistrationSchema.safeParse({ ...request, [key]: "untrusted" }).success).toBe(false);
    expect(slackRegistrationSchema.safeParse({ ...request, credentials: { ...request.credentials, refreshToken: "untrusted" } }).success).toBe(false);
  });
});
