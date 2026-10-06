import { expect, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectChatRunEvidence } from "./chat-flow.js";
import { FixtureRegistry } from "./fixture-registry.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { MatrixExecution } from "./types.js";
import { createTaskThroughUi } from "./user-actions.js";
import { PLAN_BASE_SHA, PLAN_BUDGET_CENTS, PLAN_MAX_RUNS, PLAN_SKILLS, parsePlanCase, planDefinitionDigest, planHash, planScenario } from "./plan-task-cases.js";
import { gradePlanTask, type PlanCheck, type PlanDocument, type PlanObservation, type PlanRow } from "./plan-task-scoring.js";

type Input = {
  page: Page; api: RunnerApi; fixtures: LiveFixtureValues; execution: MatrixExecution;
  nonce: string; workspacePath: string; deadlineAt: number;
  observe(issue: PlanRow, runs: PlanRow[], checks: PlanCheck[]): void;
  capture(id: string, label: string, file: string): Promise<void>;
  evidence(name: string, value: unknown): Promise<void>;
};

export async function runPlanTaskFlow(input: Input) {
  const { api, page, fixtures: f, execution } = input;
  const { variant, caseId } = parsePlanCase(execution.task.id);
  const scenario = planScenario(caseId, input.nonce);
  const company = `/api/companies/${f.company.id}`;
  const source: PlanRow = { origin: api.baseURL, variant, base: PLAN_BASE_SHA, definitionDigest: planDefinitionDigest, skills: [], agents: [] };
  let parent: PlanRow | undefined, alexId = "", rileyId = "", failure: string | undefined;
  let observed: PlanObservation = { issues: [], runs: [], documents: [], comments: [], activity: [], interactions: [], wakes: [] };
  let checks: PlanCheck[] = [];
  const grade = () => gradePlanTask({ caseId, marker: scenario.marker, parentId: parent?.id ?? "", leadId: f.agent.id,
    alexId, rileyId, observation: observed, maxRuns: PLAN_MAX_RUNS, origin: api.baseURL });

  async function observe() {
    const [issues, list] = await Promise.all([api.get<PlanRow[]>(`${company}/issues`), api.get<PlanRow[]>(`${company}/heartbeat-runs?limit=100`)]);
    if (list.length >= 100) throw new Error("Company run list is truncated; cannot qualify accounting");
    const runs = await Promise.all(list.map(run => api.get<PlanRow>(`/api/heartbeat-runs/${run.id}`)));
    const details = await Promise.all(issues.map(async issue => {
      const base = `/api/issues/${issue.id}`;
      const [full, docs, comments, activity, interactions, wakes] = await Promise.all([
        api.get<PlanRow>(base), api.get<PlanRow[]>(`${base}/documents`), api.get<PlanRow[]>(`${base}/comments?order=asc`),
        api.get<PlanRow[]>(`${base}/activity`), api.get<PlanRow[]>(`${base}/interactions`), api.get<PlanRow>(`${base}/diagnostics/wakes`),
      ]);
      const documents = await Promise.all(docs.map(async doc => ({ ...doc, issueId: issue.id,
        revisions: await api.get<PlanRow[]>(`${base}/documents/${encodeURIComponent(doc.key)}/revisions`) } as PlanDocument)));
      return { full, documents, comments, activity, interactions, wakes: { ...wakes, issueId: issue.id } };
    }));
    observed = { issues: details.map(d => d.full), runs, documents: details.flatMap(d => d.documents),
      comments: details.flatMap(d => d.comments), activity: details.flatMap(d => d.activity),
      interactions: details.flatMap(d => d.interactions), wakes: details.map(d => d.wakes) };
    if (parent) { parent = observed.issues.find(i => i.id === parent!.id) ?? parent; input.observe(parent, runs, checks); }
    return observed;
  }

  try {
    // Public fixture APIs and normal skill versioning only. No provider begins
    // until the served bytes and all three agents' selections are verified.
    await api.patch(`${company}/budgets`, { budgetMonthlyCents: PLAN_BUDGET_CENTS });
    const catalog = await api.get<PlanRow[]>("/api/skills/catalog?kind=bundled&q=task-planning");
    const planning = catalog.find(s => s.key === PLAN_SKILLS[1].key);
    if (!planning) throw new Error("Bundled task-planning catalog entry is missing");
    await api.post(`${company}/skills/install-catalog`, { catalogSkillId: planning.id });
    const library = await api.get<PlanRow[]>(`${company}/skills`);
    for (const skill of PLAN_SKILLS) {
      const installed = library.find(s => s.key === skill.key);
      if (!installed) throw new Error(`Missing production planning skill ${skill.key}`);
      const relative = variant === "current" ? skill.current : skill.short;
      const content = await readFile(new URL(`../../${relative}`, import.meta.url), "utf8");
      if (variant !== "disabled") {
        await api.patch(`${company}/skills/${installed.id}/files`, { path: "SKILL.md", content });
        const served = await api.get<{ content: string }>(`${company}/skills/${installed.id}/files?path=SKILL.md`);
        if (planHash(served.content) !== planHash(content)) throw new Error(`Served skill differs from selected source ${relative}`);
      }
      source.skills.push({ key: skill.key, id: installed.id, sourcePath: relative, sha256: planHash(content),
        bytes: Buffer.byteLength(content), words: content.split(/\s+/).filter(Boolean).length, selected: variant !== "disabled" });
    }
    const registry = new FixtureRegistry();
    for (const [id, name, role, capabilities] of [
      ["alex", "Alex Metrics", "engineer", "Owns arithmetic verification, operational metrics, and signed order summaries."],
      ["riley", "Riley Copy", "qa", "Owns publication copy, release verification and independent arithmetic audits."],
    ] as const) {
      registry.register<PlanRow>({ id, async setup() {
        const workspacePath = path.join(input.workspacePath, id);
        await mkdir(workspacePath, { recursive: true });
        const payload = execution.profile.buildAgent({ environmentId: f.environment.id, environmentFixtureId: "local",
          workspacePath, secretRefs: f.secretRefs, executionId: input.nonce });
        return api.post(`${company}/agents`, { ...payload, name, role, title: name, capabilities, reportsTo: f.agent.id,
          instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": `You are ${name}. ${capabilities} Deliver accurate work that meets your assignment.` } } });
      } });
    }
    const team = await registry.setupAll();
    alexId = (team.values.get("alex") as PlanRow).id;
    rileyId = (team.values.get("riley") as PlanRow).id;
    const selected = variant === "disabled" ? [] : PLAN_SKILLS.map(s => s.key);
    for (const id of [f.agent.id, alexId, rileyId]) {
      await api.patch(`/api/agents/${id}/permissions`, { canCreateAgents: false, canAssignTasks: id === f.agent.id });
      await api.patch(`/api/agents/${id}/budgets`, { budgetMonthlyCents: PLAN_BUDGET_CENTS });
      await api.post(`/api/agents/${id}/skills/sync?companyId=${f.company.id}`, { desiredSkills: selected, mode: "replace" });
      const skills = await api.get<PlanRow>(`/api/agents/${id}/skills?companyId=${f.company.id}`);
      if (JSON.stringify([...(skills.desiredSkills ?? [])].sort()) !== JSON.stringify([...selected].sort())) throw new Error("Agent planning skill selection differs from selected variant");
      source.agents.push({ id, skills });
    }
    if (variant === "disabled") {
      for (const skill of source.skills) await api.delete(`${company}/skills/${skill.id}`);
      const after = await api.get<PlanRow[]>(`${company}/skills`);
      if (after.some(s => PLAN_SKILLS.some(wanted => wanted.key === s.key))) throw new Error("Disabled planning skills remain in company library");
    }
    await input.evidence("plan-task-source.json", source);
    await api.patch("/api/instance/settings/experimental", { enableClassicTaskInterface: false });
    await createTaskThroughUi({ page, issuePrefix: f.company.issuePrefix!, agentName: f.agent.name,
      title: execution.task.buildTitle(input.nonce), prompt: scenario.prompt, workMode: "standard" });
    parent = await pollUntil({ label: "browser-created planning-guidance task", deadlineAt: input.deadlineAt,
      load: async () => (await api.get<PlanRow[]>(`${company}/issues`)).find(i => i.title === execution.task.buildTitle(input.nonce)), accept: Boolean });
    if (!parent) throw new Error("Browser task not found");
    let previous = "", same = 0;
    await pollUntil({ label: "planning work and handoffs settle", deadlineAt: input.deadlineAt, intervalMs: 1_500, load: observe,
      accept: o => {
        const idle = o.runs.length > 0 && o.runs.every(r => ["succeeded", "failed", "timed_out", "cancelled"].includes(r.status));
        const done = o.issues.length > 0 && o.issues.every(i => i.status === "done" && !i.scheduledRetry && !i.activeRecoveryAction);
        const signature = idle && done ? JSON.stringify(o) : "";
        same = signature && signature === previous ? same + 1 : 0; previous = signature;
        return same >= 2;
      }, reject: o => o.runs.length > PLAN_MAX_RUNS ? "bounded run count exceeded" :
        o.runs.some(r => ["failed", "timed_out", "cancelled"].includes(r.status)) ? "actual run failed; retain original failure" : undefined });
    const finalLibrary = await api.get<PlanRow[]>(`${company}/skills`);
    for (const skill of source.skills) {
      const found = finalLibrary.find(s => s.key === skill.key);
      if (variant === "disabled") {
        if (found) throw new Error("Disabled planning guidance was reinstalled; comparison is uncomparable");
      } else {
        if (!found) throw new Error("Selected planning guidance disappeared; comparison is uncomparable");
        const served = await api.get<{ content: string }>(`${company}/skills/${found.id}/files?path=SKILL.md`);
        if (planHash(served.content) !== skill.sha256) throw new Error("Planning guidance changed during execution; comparison is uncomparable");
      }
    }
    for (const id of [f.agent.id, alexId, rileyId]) {
      const skills = await api.get<PlanRow>(`/api/agents/${id}/skills?companyId=${f.company.id}`);
      if (JSON.stringify([...(skills.desiredSkills ?? [])].sort()) !== JSON.stringify([...selected].sort())) throw new Error("Planning skill selection changed during execution; comparison is uncomparable");
    }
    checks = grade().checks;
    input.observe(parent, observed.runs, checks);
    await page.goto(`/${f.company.issuePrefix}/issues/${parent.identifier ?? parent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: parent.title, exact: true })).toBeVisible();
    await expect(page.getByTestId("issue-chat-skeleton")).toHaveCount(0);
    await input.capture("final-state", "Saved planning outcome and task graph", "final-state.png");
    if (checks.some(c => !c.passed)) throw new Error(`Planning outcome failed: ${checks.filter(c => !c.passed).map(c => c.id).join(", ")}`);
    return { issue: parent, runs: observed.runs, checks };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    checks = [...grade().checks, { id: "workflow-completed", passed: false, detail: failure }];
    if (parent) input.observe(parent, observed.runs, checks);
    throw error;
  } finally {
    let captureError: string | undefined;
    try { await observe(); } catch (error) { captureError = String(error); }
    const finalSkills = await Promise.all([f.agent.id, alexId, rileyId].filter(Boolean).map(async id => ({ id,
      skills: await api.get(`/api/agents/${id}/skills?companyId=${f.company.id}`).catch(error => ({ error: String(error) })) })));
    await input.evidence("plan-task-runs.json", await Promise.all(observed.runs.map(run => collectChatRunEvidence(api, run as Parameters<typeof collectChatRunEvidence>[1])
      .catch(error => ({ runId: run.id, evidenceError: String(error) })))));
    await input.evidence("plan-task-guidance.json", { variant, caseId, scenario, source, finalSkills, parentId: parent?.id,
      leadId: f.agent.id, alexId, rileyId, budgetCents: PLAN_BUDGET_CENTS, maxRuns: PLAN_MAX_RUNS,
      observation: observed, result: grade(), failure, captureError });
    await input.evidence("api-state.json", { capturePhase: "plan-task-final", issue: parent, runs: observed.runs, checks, failure, captureError });
  }
}
