// The run-retry module's public seam. Code outside this module imports only
// from this file, never from a file inside domain/, application/, or
// adapters/ directly.
export {
  applyRetryNotBeforeOverride,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_JITTER_RATIO,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON,
  computeBoundedTransientHeartbeatRetrySchedule,
  decideBoundedRetrySchedule,
  decideCodexTransientFallbackMode,
  decideHardRetryExclusion,
  isBoundedTransientRetryReason,
  resolveCodexTransientFallbackMode,
} from "./domain/policy.js";
export type {
  BoundedRetryScheduleDecision,
  BoundedRetryScheduleInput,
  CodexTransientFallbackFacts,
  CodexTransientFallbackMode,
  HardRetryExclusionDecision,
  HardRetryExclusionFacts,
  RetrySchedule,
} from "./domain/policy.js";

export { createPostgresRunRetryAdapter } from "./adapters/postgres.js";
