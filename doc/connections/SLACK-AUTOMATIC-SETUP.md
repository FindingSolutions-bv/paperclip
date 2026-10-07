# Automatic Slack app setup

New Slack bot drafts default to automatic setup. Existing drafts without a
`slackSetupMethod` remain manual. Paperclip uses Slack's Manifest API and OAuth
v2 directly; neither the operator nor the assisting agent needs the Slack CLI.

## Operator setup

1. Enable Chat connectors in Experimental settings and select an agent in
   Connectors → Slack → Chat with an agent.
2. Review the generated app name, bot name, and slash command. In
   [Slack app settings](https://api.slack.com/apps), open **Your App Configuration
   Tokens → Generate Token**, select the workspace, and paste the temporary
   configuration token directly into Paperclip's password field. Do not supply
   its refresh token. Select **Create Slack app**.
3. Select **Install in Slack** and approve installation in the intended workspace.
   If workspace policy requires administrator approval, return to this saved
   draft when approval is available. The existing app is reused.
4. In the created app's Event Subscriptions, click **Retry** beside the generated
   Request URL. Paperclip advances after receiving Slack's signed challenge and
   completing its credential checks. Opening the settings link is not proof.
5. Optionally upload the assigned agent's avatar.
6. Send the displayed `/command connect` command and explicitly confirm that the
   discovered Slack identity belongs to your Paperclip account. Installation does
   not link the installing user.
7. Optionally send a real mention and a same-thread follow-up in an allowed
   destination. Check the originating thread, assigned agent run, and delivery.

Paperclip captures the signing secret and client secret from creation and obtains
the bot token during installation. Durable secrets are stored in the company
vault and are not returned by setup APIs or added to the agent prompt. The
temporary configuration token is discarded after the request. Save & exit keeps
the draft and all saved non-secret progress.

**Create manually** uses the same generated manifest. **Use an existing app**
keeps the existing credential-entry workflow. Both options remain available for
recovery on the same draft. The setup prompt describes browser assistance and
requires the user to enter the temporary token and handle login/admin approval.

## Deployment

Automatic setup requires a canonical public HTTPS board origin and a public HTTPS
webhook ingress. The server derives URLs and permissions from its configuration;
the browser cannot supply a manifest, scopes, or callback destination.

- The OAuth redirect is `<canonical board origin>/api/chat-slack/oauth/callback`.
  It uses the existing authenticated board callback path and Cloud bootstrap
  checks. Keep board authentication enabled.
- Webhook URLs use `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` when configured, otherwise
  the canonical board origin. They end in `/api/chat-webhooks/<publicId>/slack`.
  A separate webhook ingress must route signed webhook requests to the instance.
- Cloud resolves its current canonical origin from its claimed runtime identity.
  Self-hosted deployments use the configured authentication public base URL
  (`PAPERCLIP_AUTH_PUBLIC_BASE_URL` or `PAPERCLIP_PUBLIC_URL`).
  Both URLs must have valid certificates and be reachable by their intended
  callers. A private Tailscale Serve address is insufficient for Slack webhooks.
- Origin changes invalidate outstanding authorization attempts. Restore the saved
  origins or reconcile the existing Slack app and use manual recovery. Never
  loosen authentication or signature verification to bypass a failed callback.

## Recovery and invariants

| Saved state | Operator action |
| --- | --- |
| Invalid/expired configuration token | Generate a new configuration token and retry. Draft details are preserved. |
| Creation uncertain after timeout/restart | Inspect Slack app settings. Recover an existing app manually on this draft. Start another creation only after explicitly confirming that no app exists. |
| App created; installation declined/pending | Install the saved app again. No configuration token is needed. |
| Authorization expired or code exchange uncertain | Start fresh installation authorization. Used codes are never replayed. |
| Credentials saved; connection check failed | Use Retry connecting. Paperclip reuses vaulted credentials. |
| Wrong app/workspace/bot or missing scopes | Correct the installation of this app. Activation remains blocked. |
| Removed connection | Pending state and app-registration secrets are invalidated. Remove the customer's app separately through its Slack management link if desired. |

App details are immutable after creation dispatch, including when the outcome is
uncertain. The endpoint's existing credential lease serializes creation,
configuration, recovery, and removal across server processes. Generic connection
removal uses the same lock. The unique-bot constraint still applies.

Registration secrets are separate from runtime credentials. The received bot token
is vaulted before `auth.test`, inventory, and configuration. Staged bot/signing
secret copies are deleted only after runtime binding commits. Client credentials
remain in the registration vault for subsequent authorization. Local activity
records contain safe IDs and outcome codes. This feature adds no telemetry.

## Verification

Focused checks:

```sh
pnpm exec vitest run packages/shared/src/slack-app-manifest.test.ts ui/src/pages/apps/chat/SlackAutomaticSetup.test.tsx
pnpm exec vitest run server/src/__tests__/chat-channels.integration.test.ts -t 'automatic Slack registration'
pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/chat-adapters-ui-providers.spec.ts
pnpm check:token-gates
```

The Storybook stories under **Connections / Slack / Automatic setup** render the
production wizard with simulated provider responses. They cover the automatic
journey, manual setup, pending/declined installation, uncertain creation, saved
credential recovery, verification waiting, and mobile layouts. These are fixture
checks, not live Slack qualification.

For live acceptance, use an isolated HTTPS Paperclip instance, a dedicated test
app, and an explicitly authorized Slack workspace and destination. Have the user
enter the configuration token directly. Verify app creation, consent return,
signed URL verification, avatar status, explicit identity linking, a real mention
and same-thread follow-up, the assigned agent run, and Slack delivery. Resume an
interrupted setup, reauthorize the same app, and remove the Paperclip connection
with an outstanding attempt. Record sanitized IDs/links and outcomes, without
secret fields, OAuth codes, or provider payloads. Record live results separately
from deterministic fixtures.

Provider references: [Manifest creation API](https://docs.slack.dev/reference/methods/apps.manifest.create/),
[OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/),
[Manifest reference](https://docs.slack.dev/reference/app-manifest/).
