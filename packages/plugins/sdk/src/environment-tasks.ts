import { z } from "zod";
import type { PluginEnvironmentDriverBaseParams, PluginEnvironmentLease } from "./protocol.js";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const secureUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "wss:" && !url.username && !url.password && !url.search && !url.hash;
}, "Expected a credential-free WSS URL");

/** One durable execution attempt. Secrets are transient RPC input, never lease metadata. */
export const environmentTaskOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("submit"),
    runner: z.object({
      revision: z.string().regex(/^[a-f0-9]{40}$/),
      harness: identifier,
      runnerId: identifier, leaseId: identifier, runId: identifier,
      sessionId: identifier, turnId: identifier, itemId: identifier,
      connectUrl: secureUrl.optional(),
    }).strict(),
    bootstrapTicket: z.string().min(1).max(65_536),
  }).strict(),
  z.object({ kind: z.literal("status") }).strict(),
  z.object({ kind: z.literal("connection") }).strict(),
  z.object({ kind: z.literal("complete") }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
]);

export const environmentTaskResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), taskId: identifier }).strict(),
  z.object({
    kind: z.literal("status"), taskId: identifier,
    phase: z.enum(["preparing", "running", "completed", "failed", "cancelled", "interrupted"]),
    exitCode: z.number().int().optional(),
    /** Provider observed the task and all descendants stopped; terminal phase alone is insufficient. */
    executionStopped: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("connection"), taskId: identifier,
    endpoint: z.object({
      kind: z.literal("authenticated_websocket"), websocketUrl: secureUrl,
      generation: identifier,
      secretHeaders: z.array(z.object({
        name: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
        value: z.string().min(1).max(65_536).regex(/^[^\r\n]+$/),
      }).strict()).max(16),
    }).strict(),
  }).strict(),
]);

export type PluginEnvironmentTaskOperation = z.infer<typeof environmentTaskOperationSchema>;
export type PluginEnvironmentTaskResult = z.infer<typeof environmentTaskResultSchema>;

export interface PluginEnvironmentTaskParams extends PluginEnvironmentDriverBaseParams {
  lease: PluginEnvironmentLease;
  /** Provider-issued task identifier persisted in the lease, stable across ambiguous submission retries. */
  taskId: string;
  runId: string;
  agentId: string;
  projectId: string | null;
  operation: PluginEnvironmentTaskOperation;
}

/** An accepted stop is not proof of process termination. */
export function parseEnvironmentTaskResult(operation: PluginEnvironmentTaskOperation, taskId: string, value: unknown): PluginEnvironmentTaskResult {
  const result = environmentTaskResultSchema.parse(value);
  const expected = operation.kind === "status" || operation.kind === "connection" ? operation.kind : "accepted";
  if (result.taskId !== taskId || result.kind !== expected) throw new Error("Invalid environment task response");
  return result;
}
