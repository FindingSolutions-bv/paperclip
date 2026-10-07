import { z } from "zod";
import { SLACK_BOT_TOOL_SCOPES } from "./slack-tools.js";
import type { SlackAppConfiguration } from "./types/chat-channels.js";

export const SLACK_CHAT_BOT_SCOPES = [
  "app_mentions:read", "assistant:write", "channels:history", "channels:read",
  "chat:write", "commands", "files:read", "files:write", "groups:history",
  "groups:read", "im:history", "im:read", "mpim:history", "mpim:read",
  "reactions:read", "reactions:write", "users:read",
] as const;

export function buildSlackAppManifest(input: {
  app: SlackAppConfiguration;
  agentName: string;
  webhookUrl: string;
  redirectUri?: string;
}) {
  return {
    display_information: { name: input.app.appName },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      agent_view: { agent_description: "Work with a Paperclip agent in a task-backed conversation." },
      bot_user: { display_name: input.app.botName },
      slash_commands: [{ command: input.app.command, description: `Start or manage work with ${input.agentName}`,
        usage_hint: "status | new | close | <task>", should_escape: false, url: input.webhookUrl }],
    },
    oauth_config: {
      scopes: { bot: [...SLACK_CHAT_BOT_SCOPES, ...SLACK_BOT_TOOL_SCOPES] },
      ...(input.redirectUri ? { redirect_urls: [input.redirectUri] } : {}),
    },
    settings: {
      org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false,
      event_subscriptions: {
        request_url: input.webhookUrl,
        bot_events: ["agent_session_stopped", "app_mention", "message.channels", "message.groups", "message.im", "message.mpim",
          "member_joined_channel", "member_left_channel", "channel_left", "group_left", "reaction_added", "reaction_removed",
          "channel_archive", "group_archive", "channel_unarchive", "group_unarchive", "channel_deleted", "channel_rename",
          "group_rename", "app_uninstalled", "tokens_revoked"],
      },
      interactivity: { is_enabled: true, request_url: input.webhookUrl },
    },
  };
}

export const slackRegistrationSchema = z.object({
  requestId: z.string().uuid(),
  credentials: z.object({ configurationToken: z.string().trim().min(1).max(4096) }).strict(),
  confirmedNoAppCreated: z.boolean().optional(),
}).strict();
export type SlackRegistrationInput = z.infer<typeof slackRegistrationSchema>;
export const slackRegistrationStatusSchema = z.enum(["creating", "uncertain", "failed", "install", "credentials_saved", "configured", "removed"]);
export type SlackRegistrationStatus = z.infer<typeof slackRegistrationStatusSchema>;
export const slackRegistrationStateSchema = z.object({
  status: slackRegistrationStatusSchema,
  appId: z.string().nullable().optional(),
  managementUrl: z.string().url().nullable().optional(),
  errorCode: z.string().nullable().optional(),
}).strict();
export type SlackRegistrationState = z.infer<typeof slackRegistrationStateSchema>;
export const slackInstallAuthorizationSchema = z.object({ authorizationUrl: z.string().url(), expiresAt: z.string().datetime() });
export type SlackInstallAuthorization = z.infer<typeof slackInstallAuthorizationSchema>;
export const slackSetupActionSchema = z.object({}).strict();

export function slackRegistrationErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    slack_configuration_token_invalid: "Slack rejected the app configuration token. Generate a new configuration token and try again.",
    slack_manifest_invalid: "Slack rejected this app configuration. Check the app details or use manual setup.",
    slack_setup_rate_limited: "Slack is limiting setup requests. Wait a minute and try again.",
    slack_setup_permission_denied: "Slack requires permission to create or install this app. Ask your workspace administrator.",
    slack_creation_uncertain: "Slack may have created the app. Check your Slack app settings before trying again, or connect the existing app manually.",
    slack_install_declined: "Installation was not approved. You can install the same app when you are ready.",
    slack_install_expired: "Slack authorization expired. Install the same app again to continue.",
    slack_install_failed: "Slack installation could not be completed. Authorize the same app again.",
    slack_install_identity_mismatch: "Slack returned a different app, workspace, or bot. Install the app created for this connection.",
    slack_install_scopes_missing: "Slack did not grant all required bot permissions. Install the app again and approve its requested permissions.",
    slack_bot_already_connected: "This Slack bot is already connected to Paperclip. Resume its existing connection or use a different app.",
    slack_configuration_incomplete: "The app is installed, but Paperclip could not finish connecting it. Retry connecting the saved installation.",
  };
  return messages[code] ?? "Slack setup could not be completed. Resume setup and try again.";
}

