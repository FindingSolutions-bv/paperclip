# OpenAI Dot runner prototype

Built 2026-10-02 on the public MCP foundation from `codex/paperclip-mcp-experimental-setting`
(commit `a88448f77`), merged into the fresh `codex/dot-events-prototype` worktree.

This is a working **local protocol prototype**, not a production-selectable Dot
agent. The demo's Dot peer and task authority are synthetic. It does not contact
OpenAI, spend model credits, or modify an existing company. The new provider
implements the runner's `HarnessDriver` contract and executes through
`HarnessDriverBackend`; it does not use the legacy HTTP adapter.

## Try it

After installing and building workspace dependencies:

```sh
pnpm prototype:dot
```

The command creates a temporary PostgreSQL database, company, user and task;
creates a real OAuth grant through PKCE and consent; starts two loopback HTTP
servers; subscribes to a signed event; and drives a runner assignment to
completion through authenticated MCP. It prints each successful stage and
removes the temporary state. Its synthetic Dot peer deliberately retries a
write concurrently to prove there is only one report. No credentials are
printed. This is a CLI demo, not a mock UI or a connection to your Dot account.

Fresh-worktree preparation (use the repository's pinned pnpm version):

```sh
pnpm install --no-frozen-lockfile
pnpm --filter '@paperclipai/server^...' --filter '!@paperclipai/paperclip-runner' --filter '!@paperclipai/ui' build
```

The local callback uses an injected transport restricted to one fixed synthetic
HTTPS URL and rewrites it to loopback. The production event transport retains
its HTTPS, public-IP DNS pinning and no-redirect checks.

## Two directions, two explicit identities

```mermaid
sequenceDiagram
  participant Host as Paperclip host
  participant Runner as Dot runner bridge
  participant MCP as OAuth MCP + event outbox
  participant Dot as OpenAI Dot
  Host->>Runner: Admitted task + explicit grant/agent binding
  Runner->>MCP: Persist work_available references
  MCP->>Dot: Signed webhook wakeup
  Dot-->>MCP: Receipt (does not mean work started)
  Dot->>MCP: Read inbox and assignment; accept
  MCP->>Runner: Authenticated, bound commands
  Runner-->>Host: PRP turn.started
  Dot->>MCP: Call projected tools / report progress / propose result
  MCP->>Runner: Check current authority; deduplicate request ID
  Runner-->>Host: PRP progress and structured result
  Note over Host: Paperclip decides final task disposition
  Dot->>MCP: Personal Paperclip reads/writes while idle
  Note over MCP: These retain the consenting person's identity
```

Dot's always-available personal tools come from the merged public MCP connection.
They act as the person who consented. Agent participation is separate: a trusted
host binds an already admitted run to one OAuth grant, company, agent, task,
session and turn. Connecting or selecting a task never grants impersonation.
The registry has no MCP registration tool and no generic API executor.

## What is implemented

- `DotHarnessDriver`: one turn per admitted run, explicit acceptance, bounded
  lifetime, projected tools, progress and validated `paperclip.run_result.v1`
  completion. Reports normal PRP events consumed by the existing native backend.
- `createDotRunnerMcpBridge`: six tools on the existing authenticated endpoint:
  `paperclip_dot_inbox`, `paperclip_dot_read`, `paperclip_dot_accept`,
  `paperclip_dot_tool`, `paperclip_dot_progress`, `paperclip_dot_finish`.
  Bound tools are visible only to the selected grant with write consent.
- Optional `paperclip.dot.work_available` event on the existing durable outbox.
  Its `companyId` and `taskId` identify a designated standing inbox task. Each
  assignment can concern a different task; the event carries only IDs, and Dot
  retrieves the current assignment through authenticated tools. Existing
  authorization, encrypted callback material, signed verification, retry,
  expiration, rotation and unsubscribe behavior are reused.
- Matching duplicate commands share one receipt, including simultaneous writes.
  A changed retry is rejected. Ambiguous writes remain `unknown` and are not
  redispatched. Per-run receipts are memory-only in this prototype.
- Revocation/expiry prevents further accepted commands and ends event waiting.
  The live host authority callback runs for each new operation and before
  returning tool output. The host's tool dispatcher must enforce atomic domain
  permissions, pause, ownership, approvals and budget checks at the actual write.
- Usage and cost remain unknown. Delivery does not fabricate a started turn.
  Result acceptance proposes a disposition; it does not directly set issue status.

## Host wiring and the production gap

The default app does **not** construct the bridge or advertise the Dot event.
The host must explicitly pass `enableDotPrototype: true` to
`createPublicMcpEvents`, pass the bridge as the fourth argument to
`publicMcpIngressRoutes`, and register a driver for a trusted admitted run.
The lab demonstrates that composition with synthetic admission and a single
synthetic projected tool. There is no production scheduling integration yet.

Do not enable this by supplying a fake Codex profile to the native execution
factory or by creating a heartbeat row from an MCP request. Production needs:

1. An explicit governed agent binding/consent and a qualified Dot provider in
   native admission, with task checkout, budgets, pause and policy checks.
2. Durable provider mailbox and command receipts, reconnect/recovery and
   reconciliation of uncertain tool outcomes. The event outbox already persists;
   this prototype's runner registry does not. After restart it refuses recovery.
3. Server-owned runtime tool projection/dispatch with ordinary audit receipts.
   The lab tool is not the production runner tool authority.
4. A stop policy that can handle remote autonomy honestly. Revoking Paperclip
   access cannot prove that Dot or its child tasks stopped. Active close reports
   `provider stop is unconfirmed`; interruption, steering and resume are not
   advertised. `dot-bridge:<session>` identifies this bridge, not an OpenAI task.
5. A reachable staging deployment, real Dot plugin onboarding, and a live
   event-triggered assignment before claiming client compatibility or release
   readiness. Hosted use also needs the companion Cloud broker deployed.

An existing in-flight external write can finish after revocation. Do not retry
with a fresh request ID to force a result. Inspect authoritative task state.
Unregister completed runs to release the bounded in-process registry.

## Intended live onboarding

1. Connect the existing Paperclip MCP plugin in developer mode and consent to
   the team and requested writes.
2. Explicitly bind that connection to the chosen Dot agent after the production
   admission work above. Show the identity and the standing inbox task.
3. Give Dot one standing instruction to subscribe to `paperclip.dot.work_available`
   for that inbox, inspect current assignments, accept intended work, use the
   projected tools, and finish with a structured result. Treat duplicate events
   as wakeups, never as another task. Avoid comment-acknowledgement loops.
4. Assign work in Paperclip and verify the entire loop with the actual account.

OpenAI now documents MCP Events for dots. Private developer-mode testing does
not require a public directory listing; public distribution is a separate review.
See [MCP Events](https://developers.openai.com/plugins/build/mcp-events),
[developer mode](https://developers.openai.com/api/docs/guides/developer-mode),
and [app review](https://developers.openai.com/plugins/deploy/app-review).

## Verification

```sh
pnpm --filter @paperclipai/paperclip-runner exec vitest run src/drivers/dot/dot-harness-driver.test.ts
pnpm --filter @paperclipai/server exec vitest run src/__tests__/public-mcp.test.ts
pnpm prototype:dot
```

Runner tests cover native PRP validation, cross-company/grant/turn rejection,
unknown outcomes, concurrent retries, expiry, live authority checks, malformed
results, late writes, revocation and unsupported recovery. The MCP suite checks
real OAuth, event signatures, the opt-in catalog, personal-tool coexistence and
revocation. The CLI demo uses real TCP for both directions.

Recorded validation: eight runner tests passed; all 37 MCP tests passed; the
changed Dot scenario passed again after the final uncertainty-handling fix;
runner and server TypeScript checks passed; the loopback CLI demo passed.
Shared/server dependency builds and the runner TypeScript build also passed.
The repository-wide test/build, Rust provider qualification, hosted Cloud and
actual OpenAI Dot acceptance were not run. This is not a PR-ready production
provider handoff.
