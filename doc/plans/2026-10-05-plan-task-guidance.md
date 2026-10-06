# Planning guidance reduction — 5 October 2026

Status: implementation and eval preparation; no live result yet.

## Decision and scope

Shorten the runtime plan-to-tasks skill and the bundled task-planning skill together.
Preserve skill identities, installed-version behavior, automatic accepted-plan
selection, authorization, and native/legacy mechanics. Remove the duplicated
operational-skill pointer. Do not merge without the human's authorization.

Base: `72ff3a9f27e581a27acb49771e8658bbb0bbaa47`. Prior work on PR #15218 and
its separate checklist remains untouched.

## Bounded comparison

Four ordinary execution scenarios: cohesive work; independent specialist outputs;
a real prerequisite between specialists; an independent adverse review.
Compare current, short, and disabled planning skills using public skill editing
and selection APIs in isolated companies. Archived current skill bytes come from
the base above. The disabled variant is an availability ablation, not a production
removal or an accepted-plan continuation test. Other instructions, tools, models,
permissions, fixtures, graders, budgets, and deadlines stay matched.

Initial scope: native Codex default profile, local, 12 cells, one attempt each,
500-cent company and per-agent hard stops, at most eight total run records per
cell, including coordination wakes. One exact pilot cell precedes the remaining
selection. No automatic retries or outcome rerolls. User authorization for paid
runs persists. Extra profiles/repetitions are not part of this initial comparison.

Judge independently saved results, authorship, child boundaries, dependency order,
review delivery, and parent completion. Retain all run records, failures, missing
evidence, source/fixture hashes, skill selections and served bytes, screenshots,
usage and billing coverage. Byte/word reductions are not token or cost savings.
Skill availability is not proof that a model read or cognitively used a skill.

Run credential-free source, catalog, type and grader calibration checks before
providers. Preserve positive, plausible wrong, and missing-evidence calibration.
Report exact scenario pairs rather than equal aggregate totals. Short guidance is
eligible only if the retained comparison supports it; inconclusive evidence stays
explicit. Automatic removal and existing installed copies need separate migration
and continuation qualification before a deletion recommendation can be shipped.

## Credential-free admission

- Product E2E TypeScript compilation: pass.
- Product E2E support: 1,286 Vitest tests and 128 Node checks pass.
- Catalog discovery: twelve explicit local Codex cells; excluded from `--all`.
- Archived source hashes: conversion `08cb036df0e05b1d704dc0cd547c4e37b73078597c072a85ff982a2bb9b3a370`; planning `9c52a44a30ec8d306119da51bf298e9e3e6c382a9a9559ffd3054bf5e0c75f36`. Both match the named base Git blobs exactly.
- Generated capability inventory and catalog are synchronized.
- No provider call has started. Live outcomes remain unqualified.
