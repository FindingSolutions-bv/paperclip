# Planning guidance utility

`plan-task-guidance` is an explicit-only Product E2E suite. It runs the real UI,
public API, native Codex and saved task graph on four scenarios: one cohesive
order summary; two independent specialist approvals; a release depending on a
saved upstream result; and an independent adverse audit.

Each scenario compares current (archived from master
`72ff3a9f27e581a27acb49771e8658bbb0bbaa47`), short (checkout production files),
and disabled planning skills. The fixture uses the normal company skill editing,
selection and removal APIs before any task starts. Both runtime plan conversion
and catalog task planning change together. All agents get the same treatment.
Disabled removes both from this disposable company, not from the product catalog.
The eval does not exercise automatic accepted-plan selection or installed-skill
migration, and cannot by itself qualify deleting that wiring.

The scenario prompts do not prescribe task counts or particular tools. They do
specify which specialist is accountable and what business output is required.
The grader checks independent arithmetic, actual latest document revisions and
author/run attribution through exact document-ID/revision-number activity joins,
owned work items, prerequisite execution order, reviewer write boundaries, and
completion handoffs. It reports parallel scheduling opportunity separately from
correctness. No run can pass through an agent-authored self-assessment.

Twelve local cells, one attempt each, 12-minute cell deadline, 360-second provider
deadline, eight total run records, and 500-cent company/per-agent budget hard stops
bound the initial comparison. Coordination wakes count. Failed or missing evidence
stays failed. No automatic retries. The initial paid selection is one exact pilot,
then the eleven remaining cells only if fixture admission is sound. All cells use
the same native Codex model and production tool contracts. This is a bounded pilot,
not a cross-model reliability, speed, or cost claim.

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
pnpm test:e2e:runner -- --list --suite plan-task-guidance
pnpm test:e2e:runner -- --id plan-task-guidance.runner-codex.local.short-cohesive --max-parallel 1
```

Each attempt keeps `plan-task-source.json`, `plan-task-guidance.json`,
`plan-task-runs.json`, API state, screenshots and the existing run/accounting
reports. Selections and served hashes establish availability, not successful
skill invocation or cognitive consumption. Word/UTF-8 byte counts are exact file
measurements; provider context, token usage and billing coverage come from actual
retained run records. Cleanup, credential scanning and public projection use the
existing Product E2E pipeline. Do not publish raw sessions or hidden reasoning.
