# Native delegation handoff repair

Date: 2026-10-06. Owner: this Codex task. Branch: `codex/delegation-handoff`.
Starting master: `0fe47882cfcb12082035113c59ca96091c46ebfc`.

## Finish line

A reopened ordinary native child can complete again and deliver one fresh completion
notification to its parent. Replaying the same committed completion remains
idempotent. Prepare a reviewed, verified PR; merging is a separate human action.

## Scope

The native status committer currently deduplicates parent notifications by the
parent/child pair. A consumed notification can therefore suppress a later
completion of the same child. Scope the key to the durable completion decision
in both parent-notification branches, including a child that is also a blocker.
Keep existing readiness, company, ownership, workspace finalization and governance
gates. Do not change model prompts, tools, dependency replacement semantics or
the outcome oracle. General dependency-only wake reconciliation is separate. Exact `task_watchdog`
children keep their existing stable wake key to avoid repeated watchdog loops;
near-match origin names remain ordinary children. Related open #10559 and
#4507 concern legacy wake deduplication; #11179 concerns delivery during an
active parent run; #13044 separately proposes suppressing watchdog signals.
This change preserves their existing routing boundaries and changes only the
native committed-decision wake key.

Prior procedure experiments in #15218 exposed stalled and premature parent
outcomes but do not alone prove this mechanism caused every failure. The
production relocation and earlier controller repairs were not shipped. #15296
shipped the smaller planning skills; its report publication is separate.

## Verification contract

1. Reproduce the consumed-wake collision against unchanged master production
   with the real database/control-plane conformance test. Cover parents with
   and without an explicit dependency edge, the latest child summary, and
   duplicate finalization.
2. Run relevant conformance checks, repository typecheck, tests and build.
   Preserve failures and distinguish environment limitations.
3. Freeze candidate and baseline branches on this master with identical
   Product E2E fixtures, graders, provider profiles and budgets. Run only
   `everyday-workflows.runner-codex.local.delegate-feedback` and
   `everyday-workflows.runner-acpx-claude.local.delegate-feedback` in each
   variant: one attempt each, 12-minute per-cell deadline, at most 12 story
   run records, 1,000-cent company and lead-agent hard stops, concurrency 2.
   No reroll of a completed behavior failure. All provider continuations and
   automatic recovery count in the actual run inventory.
4. Inspect original grades and retained chronology, including revised child
   delivery, worker ownership, parent review and parent completion ordering.
   A green workflow is not itself a behavioral pass. A single pair does not
   establish general equivalence, causation or cost/speed trends.
5. Retain dated measurement/results in the private `paperclip-evals` archive
   and existing campaign artifact storage. Keep a compact index here. Verify
   current-head CI and review before a readiness claim.

## Current state

- [x] Record merged #15218 and #15296 in the working checklist.
- [x] Reproduce both relationship cases: second completion leaves only the
  original wake against unchanged production.
- [x] Verify the scoped correction and replay behavior: all 20 database-backed
  control-plane conformance tests pass, including exact watchdog and near-match
  origin controls. Repository checks are still running.
- [ ] Complete frozen live comparison and retain original evidence.
- [ ] Complete PR review and CI.
