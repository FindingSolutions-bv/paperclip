import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, dotMailboxItems, dotRunnerAssignments, dotRunnerOperations,
  heartbeatRuns, issues, nativeRunResults, nativeRunFinalizations, completionContracts, mcpEventDeliveries, workspaceOperations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPublicMcpOAuth, DEVICE_GRANT } from "../services/public-mcp/oauth.js";
import { createPublicMcpExecutor } from "../services/public-mcp/capabilities.js";
import { publicMcpIngressRoutes, publicMcpManagementRoutes } from "../routes/public-mcp.js";
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
    let verifications = 0;
    const fetcher: EventFetch = async (_url, init) => {
      const headers = new Headers(init.headers); const bytes = String(init.body); const body = JSON.parse(bytes);
      const signature = "v1," + createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
        .update(`${headers.get("webhook-id")}.${headers.get("webhook-timestamp")}.${bytes}`).digest("base64");
      expect(headers.get("webhook-signature")).toContain(signature);
      if (body.type === "verification") { verifications++; return Response.json({ challenge: body.challenge }); }
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
    return { company: company!, agent: agent!, userId, broker, principal, oauth, events, subscription, received, snapshot, tokens, client, verifications: () => verifications };
  }

  async function offeredWork(f: Awaited<ReturnType<typeof fixture>>) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "queued", invocationSource: "assignment", triggerDetail: "system" }).returning();
    const [assignment] = await db.insert(dotRunnerAssignments).values({ companyId: f.company.id, bindingId: f.snapshot.bindingId,
      bindingGeneration: f.snapshot.bindingGeneration, runId: run!.id, agentId: f.agent.id, normalizedSessionId: randomUUID(),
      turnId: randomUUID(), controllerGeneration: 1, catalogDigest: "test", status: "offered", projection: {},
      acceptBy: new Date(Date.now() + 10 * 60_000), expiresAt: new Date(Date.now() + 2 * 60 * 60_000) }).returning();
    await db.insert(dotMailboxItems).values({ companyId: f.company.id, bindingId: f.snapshot.bindingId,
      bindingGeneration: f.snapshot.bindingGeneration, assignmentId: assignment!.id, kind: "assignment", sourceEventId: randomUUID(),
      references: { assignmentId: assignment!.id, runId: run!.id, revision: 1 } });
    return { run: run!, assignment: assignment! };
  }

  function gateway(oauth: ReturnType<typeof createPublicMcpOAuth>, actor: Request["actor"]) {
    const personal = createPublicMcpOAuth(db, { ...oauth.config, resource: oauth.config.origin + "/mcp/paperclip" });
    const dispatch = async () => { throw new Error("Personal API dispatch forbidden"); };
    const app = express();
    app.use(express.json());
    app.use(publicMcpIngressRoutes(personal, createPublicMcpExecutor(db, personal, dispatch)));
    app.use(publicMcpIngressRoutes(oauth, createPublicMcpExecutor(db, oauth, dispatch)));
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", publicMcpManagementRoutes(personal, oauth));
    return { app, personal };
  }

  it("reapplies the Dot-only migration after the merged gateway schema", async () => {
    const migration = await readFile(new URL("../../../packages/db/src/migrations/0312_broken_sentinels.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.execute(sql.raw(statement));
    }
  });

  it("verifies reconnects and wakes the same outstanding assignment after exhausted delivery", async () => {
    const f = await fixture();
    const { assignment } = await offeredWork(f);
    await f.events.tick();
    const previousEventId = f.received.at(-1)?.eventId;
    const before = await f.broker.mailbox(f.principal);
    const oldItem = before.items.find(item => item.assignmentId === assignment.id)!;
    await db.update(mcpEventDeliveries).set({ attempts: 6, finishedAt: new Date(), outcome: "delivery_exhausted" })
      .where(eq(mcpEventDeliveries.mailboxItemId, oldItem.id));
    const failedReconnect = createPublicMcpEvents(db, f.oauth, async () => { throw new Error("personal dispatch forbidden"); },
      { enableDotRunner: true, fetch: async () => Response.json({ challenge: "wrong" }) });
    await expect(failedReconnect.subscribe(f.principal, f.subscription)).rejects.toThrow();
    expect((await f.broker.mailbox(f.principal, before.nextCursor)).items).toEqual([]);
    const verificationCount = f.verifications();
    await f.events.subscribe(f.principal, f.subscription);
    expect(f.verifications()).toBe(verificationCount + 1);
    const after = await f.broker.mailbox(f.principal, before.nextCursor);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ kind: "assignment", assignmentId: assignment.id });
    expect(await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.bindingId, f.snapshot.bindingId))).toHaveLength(1);
    await f.events.tick();
    expect(f.received.at(-1)?.data.mailboxItemId).toBe(after.items[0]!.id);
    expect(f.received.at(-1)?.eventId).not.toBe(previousEventId);
  }, 30000);

  it.each(["OAuth revocation", "refresh-token replay"])("%s fences Dot and cancels waiting work", async reason => {
    const f = await fixture();
    const { run, assignment } = await offeredWork(f);
    const { app, personal } = gateway(f.oauth, { type: "board", source: "session", userId: f.userId });
    // A token submitted to the other resource's revocation endpoint has no effect.
    await personal.revokeToken(f.tokens.access_token, f.client.client_id);
    expect(await f.broker.bindingForAgent(f.company.id, f.agent.id)).not.toBeNull();
    if (reason === "OAuth revocation") {
      expect((await request(app).post("/mcp/runner/oauth/revoke").send({ token: f.tokens.access_token, client_id: f.client.client_id })).status).toBe(200);
    } else {
      const refresh = { grant_type: "refresh_token", refresh_token: f.tokens.refresh_token, client_id: f.client.client_id, resource: f.oauth.config.resource };
      await f.oauth.token(refresh);
      await expect(f.oauth.token(refresh)).rejects.toThrow();
    }
    expect(await f.broker.bindingForAgent(f.company.id, f.agent.id)).toBeNull();
    expect((await db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.id, assignment.id)))[0]?.status).toBe("fenced");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]?.status).toBe("cancelled");
    await expect(f.oauth.authenticate(f.tokens.access_token)).rejects.toThrow();
    const next = await f.broker.createPairing({ companyId: f.company.id, agentId: f.agent.id, operatorId: f.userId });
    await f.oauth.revokeToken(f.tokens.access_token, f.client.client_id);
    expect((await f.broker.bindingForAgent(f.company.id, f.agent.id))?.id).toBe(next.bindingId);
  }, 30000);

  it("uses merged client metadata and scoped browser consent with a distinct Dot issuer", async () => {
    const f = await fixture();
    const clientId = `https://dot-${randomUUID()}.example/oauth.json`;
    const redirectUri = "https://chatgpt.com/connector_platform/oauth/callback";
    const oauth = createPublicMcpOAuth(db, f.oauth.config, { metadataFetch: async () => Response.json({
      client_id: clientId, client_name: "Dot metadata client", redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
    }) });
    const { app, personal } = gateway(oauth, { type: "board", source: "session", userId: f.userId });
    const metadata = await request(app).get("/.well-known/oauth-protected-resource/mcp/runner");
    expect(metadata.body.authorization_servers).toEqual([oauth.config.origin + "/mcp/runner/oauth"]);
    const issuer = await request(app).get("/.well-known/oauth-authorization-server/mcp/runner/oauth");
    expect(issuer.body).toMatchObject({ issuer: oauth.config.origin + "/mcp/runner/oauth", client_id_metadata_document_supported: true,
      scopes_supported: ["paperclip:agent", "offline_access"], device_authorization_endpoint: oauth.config.origin + "/mcp/runner/oauth/device_authorization" });
    expect((await request(app).get("/.well-known/oauth-authorization-server")).body.issuer).toBe(oauth.config.origin);
    const verifier = randomBytes(32).toString("base64url");
    const input = { client_id: clientId, redirect_uri: redirectUri, response_type: "code", resource: oauth.config.resource,
      company_id: f.company.id, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
    const id = (await oauth.authorize(input)).split("/").at(-1)!;
    await expect(personal.describeRequest(id, { type: "board", source: "session", userId: f.userId }, null)).rejects.toThrow();
    const description = await request(app).get("/api/mcp/requests/" + id);
    expect(description.body).toMatchObject({ agentConnection: true, requestedCompanyId: f.company.id, clientOrigin: new URL(clientId).origin });
    expect(description.body.companies.map((c: { id: string }) => c.id)).toEqual([f.company.id]);
    expect((await request(app).post(`/api/mcp/requests/${id}/consent`).set("Origin", oauth.config.origin)
      .send({ decision: "approve", companyId: randomUUID(), allowWrites: false })).status).toBe(403);
    const consent = await request(app).post(`/api/mcp/requests/${id}/consent`).set("Origin", oauth.config.origin)
      .send({ decision: "approve", companyId: f.company.id, allowWrites: false });
    expect(consent.status).toBe(200);
    const redirect = new URL(consent.body.redirectUrl);
    expect(redirect.searchParams.get("iss")).toBe(issuer.body.issuer);
    const tokens = await oauth.token({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri,
      resource: oauth.config.resource, code: redirect.searchParams.get("code"), code_verifier: verifier });
    expect((await oauth.authenticate(tokens.access_token)).grant).toMatchObject({ purpose: "agent", agentId: null, scopes: ["paperclip:agent"] });
    await expect(personal.authenticate(tokens.access_token)).rejects.toThrow();
    await expect(oauth.authorize({ ...input, scope: "paperclip:read" })).rejects.toMatchObject({ code: "invalid_scope" });
    await f.events.unsubscribe(f.principal, f.subscription);
  }, 30000);

  it("routes merged device consent to Dot without granting personal or cross-company access", async () => {
    const f = await fixture();
    const { app, personal } = gateway(f.oauth, { type: "board", source: "session", userId: f.userId });
    const client = await f.oauth.register({ client_name: "Dot device", redirect_uris: [], response_types: [], grant_types: [DEVICE_GRANT, "refresh_token"] }, randomUUID());
    const started = await request(app).post("/mcp/runner/oauth/device_authorization")
      .send({ client_id: client.client_id, resource: f.oauth.config.resource, scope: "paperclip:agent offline_access", company_id: f.company.id });
    expect(started.status).toBe(200);
    const codes = started.body;
    expect(await f.oauth.ownsDevice(codes.user_code)).toBe(true);
    await expect(personal.describeDevice(codes.user_code, { type: "none" })).rejects.toThrow();
    const description = await request(app).get("/api/mcp/device").query({ user_code: codes.user_code });
    expect(description.body).toMatchObject({ agentConnection: true, requestedCompanyId: f.company.id });
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, f.userId));
    expect((await request(app).post("/api/mcp/device/consent").set("Origin", f.oauth.config.origin)
      .send({ userCode: codes.user_code, decision: "approve", companyId: f.company.id, allowWrites: false })).status).toBe(403);
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(eq(companyMemberships.principalId, f.userId));
    const approved = await request(app).post("/api/mcp/device/consent").set("Origin", f.oauth.config.origin)
      .send({ userCode: codes.user_code, decision: "approve", companyId: f.company.id, allowWrites: false });
    expect(approved.body).toEqual({ status: "approved" });
    const exchange = { grant_type: DEVICE_GRANT, client_id: client.client_id, resource: f.oauth.config.resource, device_code: codes.device_code };
    const tokens = (await request(app).post("/mcp/runner/oauth/token").send(exchange)).body;
    expect((await f.oauth.authenticate(tokens.access_token)).actor.type).toBe("none");
    await expect(personal.authenticate(tokens.access_token)).rejects.toThrow();
    const renewed = await f.oauth.token({ grant_type: "refresh_token", client_id: client.client_id, resource: f.oauth.config.resource, refresh_token: tokens.refresh_token });
    expect((await f.oauth.authenticate(renewed.access_token)).grant.purpose).toBe("agent");
    await expect(f.oauth.token(exchange)).rejects.toMatchObject({ code: "invalid_grant" });
    vi.stubEnv("PAPERCLIP_ENABLE_OPENAI_DOT", "0");
    try {
      expect((await request(app).get("/.well-known/oauth-protected-resource/mcp/runner")).status).toBe(503);
      expect((await request(app).get("/.well-known/oauth-protected-resource/mcp/paperclip")).status).toBe(200);
    } finally { vi.stubEnv("PAPERCLIP_ENABLE_OPENAI_DOT", "1"); }
    await f.events.unsubscribe(f.principal, f.subscription);
  }, 30000);

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
