# OpenAI Dot with Paperclip Runner

OpenAI Dot is an experimental provider of `paperclip_runner`. A dedicated
agent OAuth connection and MCP Events wake an existing Dot. The Rust Runner
owns the assignment lifecycle and durable tool receipts. Dot uses Paperclip's
existing agent permissions and task tools, including document writes and
completion feedback.

This first version supports a self-hosted instance with a local Runner
controller and a stable public HTTPS origin. Hosted agent-broker and remote
controller deployments are not qualified. The feature is off by default.

## Enable and pair

1. Configure `PAPERCLIP_PUBLIC_URL` to the instance's stable HTTPS origin and
   enable Public MCP and Paperclip Runner in experimental settings. Set
   `PAPERCLIP_ENABLE_OPENAI_DOT=1` on the server.
2. Create an approved Paperclip Runner agent with provider **OpenAI Dot**.
   Acknowledge that its provider billing is external and unmetered. Save it.
3. In the agent configuration, choose **Pair Dot**. Connect a private ChatGPT
   plugin to the displayed `/mcp/runner` URL and approve its dedicated agent
   OAuth scope. The personal `/mcp/paperclip` connection cannot execute as Dot.
4. Give the Dot the one-use pairing code. It calls `paperclip_dot_pair`, then
   subscribes to `paperclip.dot.mailbox_updated` with the returned company and
   binding IDs. Its callback must pass the signed webhook verification.
5. Choose **Test event delivery**. Dot drains `paperclip_dot_inbox` and confirms
   the readiness challenge. Readiness requires this round trip, not just an
   HTTP acknowledgement from the callback.
6. Assign a task to the agent. Normal scheduling, checkout, company access,
   budgets and approval rules still determine admission.

Only the operator's one-use pairing code is displayed. OAuth tokens and callback
signing secrets stay on the server and never enter the Runner descriptor,
task prompt or saved adapter config. Pairing codes expire after 15 minutes.

## Assignment protocol

Events contain mailbox references. Dot drains the inbox after its saved cursor,
reads the assignment, and explicitly accepts it before executing tools. A
webhook `2xx` does not mean Dot accepted or started the task. Duplicate or
out-of-order events must not create another assignment.

Dot invokes catalogued tools through `paperclip_dot_tool`. Every operation uses
a UUID request ID. A pending response is reconciled with
`paperclip_dot_operation_status` or retried with **the same ID and arguments**.
Changing arguments under the same ID is rejected. An unknown write must never
be retried under a new ID.

Dot calls `paperclip_finish` or `paperclip_block` through the tool bridge, then
ends the external turn with `paperclip_dot_finish` using exactly the accepted
structured report. Paperclip's ordinary result and status finalizers decide
the task disposition. Dot can also discover its assigned tasks and request
normal admission with `paperclip_dot_tasks` and `paperclip_dot_request_work`.

## Limits and recovery

- One active assignment per binding. Acceptance expires after 10 minutes;
  execution authority expires after two hours. Fifteen minutes without useful
  activity is shown in the connection panel as requiring attention.
- No mounted workspace, selectable model, native Dot thread identifier,
  provider usage or provider cost. Text deliverables use Paperclip documents.
  Assigned skill files and third-party MCP bindings are currently unsupported
  and fail admission explicitly.
- Cancel, pause, reassignment and revocation fence Paperclip authority. They do
  not confirm that Dot stopped all external activity. A fence acknowledgement
  records receipt only.
- Controller recovery restores the same bridge and assignment. A missing or
  invalid advertised checkpoint requires reconciliation. Automatic bounded
  retries do not create replacement Dot assignments. A tool effect still in
  flight when its controller detaches stays pending if its exact outcome was
  not durably recorded; recovery does not execute that write again.
- Keep the public origin stable. Subscriptions expire and must be renewed;
  reconnection drains current mailbox references rather than claiming event
  replay. Disabling new Dot work does not grant old assignments new authority.

## Verification evidence

`server/src/__tests__/dot-runner.test.ts` uses an isolated PostgreSQL database,
real Rust Runner, dedicated PKCE OAuth, a signed synthetic callback, normal
semantic authority, a document write and the ordinary status finalizer. It
checks duplicate writes, changed-argument rejection, membership loss and
revocation. Runner tests cover bridge reattachment, missing checkpoints,
closed launch fields, expiry and late effect receipts after fencing.

The earlier real-Dot account experiment proved OAuth and signed wake/report
transport through the reference harness; see `dot-runner-prototype.md`. That
proof does not qualify this new dedicated endpoint against a real account.
The dedicated adapter's account acceptance test remains to be run. The new
connection UI has passed compilation and token gates; it has not yet received
a hands-on browser acceptance test.

Local verification on 2026-10-03:

| Check | Result |
| --- | --- |
| `pnpm -r typecheck`, `pnpm build`, UI token gates | Passed |
| Rust workspace library tests | 312 passed |
| PRP schema tests and CI shard selection tests | 13 and 24 passed |
| Control-plane and Dot driver regression tests | 97 passed, including late callback retirement |
| Real Rust / PostgreSQL Dot integration | 2 passed |
| Agent configuration route tests | 36 passed, including unpaired create and conversion |
| Stable shared package lane | 837 passed |
| Adapter utilities and Codex adapter source tests | 1,883 passed, 12 skipped |
| Root `pnpm test:run` attempt | Server group: 744 files passed, 2 failed, 4 skipped; 14,997 tests passed. Wrapper stopped at that failed group. |

The root run's failures were a Calendar socket reset and a Git scan load
assertion (497 of 498 expected joined requests). Both failing cases passed in
isolation. A subsequent stable database lane passed 126 tests but failed one
embedded PostgreSQL startup; that test also passed in isolation. These results
do not establish a completely green repository suite or release readiness.
