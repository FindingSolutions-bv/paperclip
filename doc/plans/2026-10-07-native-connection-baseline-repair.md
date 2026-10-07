# Native connection baseline repair — 2026-10-07

The original baseline remains **0 PASS / 15 FAIL**. It did not exercise the intended user decisions and does not qualify a production instruction reduction. This repair makes a new baseline possible; it does not change the old grades.

## Original evidence

- [Campaign 37562577199, attempt 1](https://github.com/paperclipai/paperclip/actions/runs/37562577199).
- [Original public report](https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/gha-37562577199-1/index.html).
- Source and trusted workflow: `caf120105c487532db769670fcd39249483e1d99`.
- Suite hash: `d7bd6c177fe97e9cba28497555d475b545824796d33178fd0372ae21dbb06429`.
- Definition digest: `e2298d2e190448aa112167e8f2989b8d087766482af145007d86a36f8ab29830`.
- Five cases on native Codex `gpt-5.6-sol`, ACPX Claude `claude-sonnet-5`, and OpenCode `openrouter/deepseek/deepseek-v4-flash-0731`.
- One attempt per cell, 15 actual run records: 14 succeeded and one failed. No harness retries. All 15 cleanup and budget readbacks passed. A succeeded run record is not a passing behavioral grade.
- Recorded LLM cost subtotal: $0.01824843. Positive costs were reported only by the five OpenCode cells. Twelve of 15 runs had token coverage. Zero or missing Codex/Claude billing is unknown, not free; actual charges and local/hosted runtime cost are unknown.

| Cells | Observed failure | Supported diagnosis |
| --- | --- | --- |
| 10 | Browser could not find the creation-time title; renamed title and pending interaction were visible | Stale-title harness assertion, before any intended user decision |
| 2 Codex provider-choice cells | Native `request_human_input` schema denial before Paperclip execution | Rejected input; retained diagnostics omit the invalid field. Four rejections in the positive cell are calls within one run, not four paid harness attempts |
| 2 OpenCode provider-choice cells | Used the preinstalled HubSpot tool once without a choice card | Fixture had already granted real tool access. This does not prove a consent violation or disregard of a decline; no decline was sent |
| 1 Claude provider-decline cell | `native_finalization_missing: session returned no semantic result` | Native session failed before choice; retained evidence does not establish the underlying cause |

The schema accepts both canonical and legacy question forms. Conflicting native/legacy guidance is observable, but is not proven to have caused the old Codex denials. Do not infer that a corrected run explains the old Claude failure.

## Repair contract

1. Match the requested browser route and visible task identifier, then wait for the loaded conversation. Agent title changes are allowed; the wrong task still fails.
2. Configure the deterministic company Arcade gateway with zero agent installs and zero allowed tool entries. Verify public effective-access records before task creation.
3. The positive provider case requires the saved Arcade choice, followed by one real access card for the same agent, connection, selected interaction and exact HubSpot read tool. The browser grants access. The oracle requires the accepted result, exactly one provider call, and the independently observed fixture marker. The expected run count is three. Declines still require one decision, no tool calls and an attributed explanation.
4. Return a canonical `providerQuestionSet` alongside the legacy `providerQuestion`. Native guidance uses the canonical form. Both forms preserve the exact prompt and option IDs that validate saved consent.
5. Invalid native question input remains rejected before execution. Bounded feedback identifies authorized schema locations and required fields, without echoing submitted values or arbitrary keys. No schema or authorization gate is relaxed.

The historical Everyday fixture and prompts remain unchanged. The new fixture and production correctness fixes change the measured contract. Results from the new source must be reported separately; they cannot be treated as a matched comparison with the invalid original baseline.

## Validation and remaining gate

Credential-free checks pass: eval typecheck; 1,801 support tests plus 128 Node tests (one intentional support skip); 51 connection/schema tests; one real-server fixture test; one focused Rust feedback test; and local browser wrong-task/title calibration. Repository typecheck and build pass. The full repository test run is still under inspection after a Telegram integration test failed outside the changed paths.

A corrected paid baseline is pending. Run an explicit provider-choice canary first, then the other distinct cells only after that evidence is usable. Preserve every attempt, decision, actual run, cost gap and failure. No instruction reduction or general integration quality claim is qualified yet.
