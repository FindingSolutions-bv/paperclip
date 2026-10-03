import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, dotMailboxItems, dotRunnerAssignments, dotRunnerOperations,
  heartbeatRuns, issues, nativeRunResults, nativeRunFinalizations, completionContracts, mcpEventDeliveries, workspaceOperations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPublicMcpOAuth } from "../services/public-mcp/oauth.js";
import { createPublicMcpEvents, type EventFetch } from "../services/public-mcp/events.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { canonicalNativeRuntimeContextDigest, type StrictCompletionContractInput } from "../vendor/paperclip-runner/index.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { executePaperclipNativeSession } from "../services/native-runtime/native-session-executor.js";
import { documentService } from "../services/documents.js";
import { setupRunnerPrpWebSocketServer } from "../realtime/runner-prp-ws.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";

describe("durable Dot Runner integration", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    const runnerRoot = fileURLToPath(new URL("../../../packages/paperclip-runner/", import.meta.url));
    execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(runnerRoot, "runner/Cargo.toml"), "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd"], { cwd: runnerRoot, stdio: "pipe", timeout: 300000 });
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-dot-runner-");
    db = createDb(temporary.connectionString);
    root = await mkdtemp(join(tmpdir(), "paperclip-dot-state-"));
    vi.stubEnv("PAPERCLIP_ENABLE_OPENAI_DOT", "1");
    vi.stubEnv("PAPERCLIP_RUNNER_BINARY", join(runnerRoot, "runner/target/release", process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true });
  }, 360000);
  afterAll(async () => { await temporary?.cleanup(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  async function fixture() {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Dot operator", email: userId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Dot test", issuePrefix: "DT" + randomBytes(3).toString("hex") }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Dot", adapterType: "paperclip_runner", status: "active", adapterConfig: { provider: "openai_dot", allowUnmeteredProvider: true } }).returning();
    const config = { origin: "https://paperclip.example", resource: "https://paperclip.example/mcp/runner" };
    const oauth = createPublicMcpOAuth(db, config);
    const client = await oauth.register({ client_name: "Dedicated Dot", redirect_uris: ["https://chatgpt.com/connector_platform/oauth/callback"] }, randomUUID());
    const verifier = randomBytes(32).toString("base64url");
    const input = { client_id: client.client_id, redirect_uri: "https://chatgpt.com/connector_platform/oauth/callback", response_type: "code", resource: config.resource,
      scope: "paperclip:agent offline_access", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    const requestId = (await oauth.authorize(input)).split("/").at(-1)!;
    const consent = await oauth.consent(requestId, { type: "board", source: "session", userId }, { decision: "approve", companyId: company!.id, allowWrites: false });
    const tokens = await oauth.token({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: input.redirect_uri,
      resource: config.resource, code: new URL(consent.redirectUrl).searchParams.get("code"), code_verifier: verifier });
    const unpaired = await oauth.authenticate(tokens.access_token);
    expect(unpaired.actor.type).toBe("none");
    const broker = dotRunnerBroker(db);
    const pairing = await broker.createPairing({ companyId: company!.id, agentId: agent!.id, operatorId: userId });
    await broker.pair(unpaired, pairing.pairingCode);
    await expect(broker.pair(unpaired, pairing.pairingCode)).rejects.toThrow();
    const principal = await oauth.authenticate(tokens.access_token);
    expect(principal.actor).toMatchObject({ type: "agent", agentId: agent!.id, companyId: company!.id });
    const personal = createPublicMcpOAuth(db, { ...config, resource: config.origin + "/mcp/paperclip" });
    await expect(personal.authenticate(tokens.access_token)).rejects.toThrow();
    const secret = "whsec_" + randomBytes(32).toString("base64");
    const received: Array<Record<string, any>> = [];
    const fetcher: EventFetch = async (_url, init) => {
      const headers = new Headers(init.headers); const bytes = String(init.body); const body = JSON.parse(bytes);
      const signature = "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
        .update(`${headers.get("webhook-id")}.${headers.get("webhook-timestamp")}.${bytes}`).digest("base64");
      expect(headers.get("webhook-signature")).toContain(signature);
      if (body.type === "verification") return Response.json({ challenge: body.challenge });
      received.push(body); return new Response(null, { status: 204 });
    };
    const events = createPublicMcpEvents(db, oauth, async () => { throw new Error("personal API dispatch forbidden"); }, { enableDotRunner: true, fetch: fetcher });
    const subscription = { name: "paperclip.dot.mailbox_updated", arguments: { companyId: company!.id, bindingId: pairing.bindingId }, delivery: { mode: "webhook", url: "https://example.com/dot-hook", secret } };
    await events.subscribe(principal, subscription);
    await broker.challenge(company!.id, agent!.id); await events.tick();
    if (!received.length) throw new Error("Dot readiness delivery missing: " + JSON.stringify(await db.select({ outcome: mcpEventDeliveries.outcome, event: mcpEventDeliveries.event }).from(mcpEventDeliveries)));
    expect(received.at(-1)?.data.kind).toBe("readiness_challenge");
    expect(received.at(-1)?.data).not.toHaveProperty("challenge");
    const challenge = (await broker.mailbox(principal)).items.find(i => i.kind === "readiness_challenge")!;
    await broker.confirmChallenge(principal, String(challenge.references.challenge));
    const snapshot = await broker.snapshot(company!.id, agent!.id, pairing.bindingId);
    await db.update(agents).set({ adapterConfig: { provider: "openai_dot", dotBindingId: pairing.bindingId, allowUnmeteredProvider: true, lifecycleMode: "per_turn" } }).where(eq(agents.id, agent!.id));
    return { company: company!, agent: agent!, userId, broker, principal, oauth, events, subscription, received, snapshot };
  }

  it("signed readiness, normal native authority, one document write and finalization through real Rust", async () => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Save the arithmetic report", description: "Save 17 + 25 = 42 as a task document.",
      status: "in_progress", workMode: "standard", assigneeAgentId: f.agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: issue!.id } }).returning();
    await db.update(issues).set({ executionRunId: run!.id, checkoutRunId: run!.id }).where(eq(issues.id, issue!.id));
    const prepared = await prepareNativeHeartbeatRun({ db, run: run!, issue: issue!, environmentLeaseId: randomUUID() });
    await db.insert(nativeRunFinalizations).values({ runId: run!.id, companyId: f.company.id, issueId: issue!.id, phase: "observed" });
    const [boundRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.id, boundRun!.completionContractId!));
    const runtimeContext = nativeRuntimeContextFixture();
    await writeFile(join(root, "AGENTS.md"), "Use Paperclip tools to save the report.");
    runtimeContext.instructions.bundle.rootPath = root;
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const execution = buildNativeExecutionInput({ companyId: f.company.id, agentId: f.agent.id, runId: run!.id, issue: issue!,
      taskPrompt: issue!.description!, normalizedSessionId: prepared.normalizedSessionId, provider: "openai_dot", dotBinding: f.snapshot,
      workspace: { id: randomUUID(), cwd: root, repoUrl: null, repoRef: null, branchName: null }, runtimeContext,
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256,
        schemaVersion: contract!.schemaVersion, contract: contract!.contractJson as unknown as StrictCompletionContractInput } });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, run!.id));
    const server = createServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test server");
    setupRunnerPrpWebSocketServer(server, { apiUrl: `http://127.0.0.1:${address.port}` });
    const observed: Array<Record<string, any>> = [];
    const resultPromise = executePaperclipNativeSession({ db, execution, runnerInstanceId: prepared.runnerInstanceId,
      useRunnerd: true, turnTimeoutMs: 45000, onEvent: async event => { observed.push(event); }, onLog: async () => {} });
    // Attach a handler immediately: a bootstrap error must never become an unhandled rejection.
    let startupError: unknown;
    let startupOutcome: unknown;
    void resultPromise.then(result => { startupOutcome = result; }, () => {});
    void resultPromise.catch(error => { startupError = error; });
    try {
      await vi.waitFor(async () => { if (startupError) throw startupError; expect(await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId, run!.id))).toHaveLength(1); }, { timeout: 30000, interval: 50 });
      const [assignment] = await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId, run!.id));
      await f.events.tick();
      expect(JSON.stringify(f.received)).not.toContain("17 + 25");
      const work = await f.broker.read(f.principal, assignment!.id);
      expect(work.accounting).toEqual({ usage: null, cost: null });
      expect(work.status).toBe("offered");
      expect(observed.filter(event => event.eventType === "turn.started")).toHaveLength(0);
      expect(JSON.stringify(work)).not.toContain(root);
      expect((work.tools as Array<{ operationId: string }>).some(tool => tool.operationId === "register_deliverable")).toBe(false);
      expect(await f.broker.operation(f.principal, assignment!.id, randomUUID(), "tool", { name: "write_document", arguments: {} })).toMatchObject({ status: "rejected" });
      await f.broker.operation(f.principal, assignment!.id, randomUUID(), "accept", {});
      await db.update(agents).set({ budgetMonthlyCents: 100, spentMonthlyCents: 100 }).where(eq(agents.id, f.agent.id));
      await expect(f.broker.read(f.principal, assignment!.id)).rejects.toThrow("execution authority");
      await db.update(agents).set({ budgetMonthlyCents: 0, spentMonthlyCents: 0, status: "paused" }).where(eq(agents.id, f.agent.id));
      await expect(f.broker.read(f.principal, assignment!.id)).rejects.toThrow("authority");
      await db.update(agents).set({ status: "active" }).where(eq(agents.id, f.agent.id));
      await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issue!.id));
      await expect(f.broker.read(f.principal, assignment!.id)).rejects.toThrow("execution authority");
      await db.update(issues).set({ executionRunId: run!.id, checkoutRunId: run!.id }).where(eq(issues.id, issue!.id));
      const writeId = randomUUID();
      const args = { name: "write_document", arguments: { key: "report", title: "Arithmetic", body: "17 + 25 = 42.", baseRevisionId: null, idempotencyKey: writeId } };
      await f.broker.operation(f.principal, assignment!.id, writeId, "tool", args);
      await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, writeId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
      await f.broker.operation(f.principal, assignment!.id, writeId, "tool", args);
      await expect(f.broker.operation(f.principal, assignment!.id, writeId, "tool", { ...args, arguments: { ...args.arguments, body: "changed" } })).rejects.toThrow("different arguments");
      const document = await documentService(db).getIssueDocumentByKey(issue!.id, "report");
      expect(document?.body).toBe("17 + 25 = 42.");
      const result = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Saved the arithmetic report.",
        completionClaim: { contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: true,
          criteria: execution.completionContract.contract.criteria.map(c => ({ criterionId: c.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
        evidence: [], verification: [{ commandOrCheck: "17 + 25", status: "passed" }], attentionRequests: [], artifacts: [] };
      const completionId = randomUUID();
      await f.broker.operation(f.principal, assignment!.id, completionId, "tool", { name: "paperclip_finish", arguments: result });
      await vi.waitFor(async () => expect(await f.broker.operationStatus(f.principal, assignment!.id, completionId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
      await f.broker.operation(f.principal, assignment!.id, randomUUID(), "finish", { result });
      await resultPromise;
      // The heartbeat records its controller workspace settlement before the
      // ordinary status finalizer commits the task disposition.
      await db.insert(workspaceOperations).values({ companyId: f.company.id, heartbeatRunId: run!.id, issueId: issue!.id,
        phase: "workspace_finalize", status: "succeeded", exitCode: 0, cwd: root, finishedAt: new Date() });
      await finalizeNativeRun({ db, runId: run!.id, workspaceFinalizeStatus: "succeeded" });
      await finalizeNativeRun({ db, runId: run!.id, workspaceFinalizeStatus: "succeeded" });
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, run!.id))).toHaveLength(1);
      expect((await db.select().from(issues).where(eq(issues.id, issue!.id)))[0]?.status).toBe("done");
      expect(await db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId, writeId))).toHaveLength(1);
      expect(startupOutcome).toMatchObject({ exitCode: 0, model: null, nativeFinalization: { providerSessionId: null, driverKind: "openai_dot_mcp" } });
      expect(observed.filter(event => event.eventType === "turn.started")).toHaveLength(1);
    } catch (error) {
      if (startupError) throw startupError;
      await Promise.race([resultPromise.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
      if (startupError) throw startupError;
      throw error;
    } finally { await f.events.unsubscribe(f.principal, f.subscription); await f.events.stop(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  }, 90000);

  it("revocation, membership loss and a foreign company cannot recover authority", async () => {
    const f = await fixture(); const other = await fixture();
    await expect(f.broker.authorizeBinding(other.principal, f.company.id, f.snapshot.bindingId)).rejects.toThrow();
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, f.userId));
    await expect(f.broker.mailbox(f.principal)).rejects.toThrow();
    await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.principalId, f.userId));
    await f.broker.revoke(f.company.id, f.agent.id, f.userId);
    await expect(f.broker.mailbox(f.principal)).rejects.toThrow();
    await expect(f.oauth.authorizeGrant(f.principal.grant.id)).rejects.toThrow();
    expect(await db.select().from(dotMailboxItems).where(eq(dotMailboxItems.bindingId, f.snapshot.bindingId))).toHaveLength(1);
    await other.events.unsubscribe(other.principal, other.subscription);
  }, 30000);
});
