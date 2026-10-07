// Pure retry policy rules for the bounded heartbeat retry scheduler.
// The use case calls these functions. The service also checks whether a
// schedule can reach the legacy reconciliation check. This file never queries
// a database, calls a service, or reads the system clock. The caller passes
// `now` and `random` as explicit values.

/** The fixed delay table for the default bounded transient-failure lane. */
export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS = [
  30_000, 30_000,
] as const;
export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_JITTER_RATIO = 0;
export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON = "transient_failure";
export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON =
  "transient_failure_retry";
export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS =
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length;

export type HardRetryExclusionFacts = {
  errorCode: string | null;
  hasChatCompletionDeliveryIds: boolean;
};

export type HardRetryExclusionDecision =
  | { excluded: false }
  | { excluded: true; reason: string }
  | {
      excluded: true;
      reason: string;
      errorCode: "chat_completion_outbox_owns_retry";
    };

/**
 * Decides the two hard exclusions that stop a bounded retry before any
 * attempt, budget, or schedule calculation runs. The invalid-tool-definition
 * branch carries no errorCode. The chat-outbox branch carries one, because
 * the completion outbox already owns that reply's retry budget.
 */
export function decideHardRetryExclusion(
  facts: HardRetryExclusionFacts,
): HardRetryExclusionDecision {
  if (facts.errorCode === "provider_tool_definition_invalid") {
    return {
      excluded: true,
      reason:
        "Repair the invalid tool definitions before starting a new attempt.",
    };
  }
  if (facts.hasChatCompletionDeliveryIds) {
    return {
      excluded: true,
      reason:
        "The completion outbox owns this reply's retry budget and publication identity.",
      errorCode: "chat_completion_outbox_owns_retry",
    };
  }
  return { excluded: false };
}

/**
 * Computes one bounded transient retry's delay from the fixed delay table,
 * applying the configured jitter ratio. The caller passes `now` and
 * `random` as explicit values.
 */
export function computeBoundedTransientHeartbeatRetrySchedule(
  attempt: number,
  now: Date,
  random: () => number,
) {
  if (!Number.isInteger(attempt) || attempt <= 0) return null;
  const baseDelayMs = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[attempt - 1];
  if (typeof baseDelayMs !== "number") return null;
  const sample = Math.min(1, Math.max(0, random()));
  const jitterMultiplier =
    1 + (sample * 2 - 1) * BOUNDED_TRANSIENT_HEARTBEAT_RETRY_JITTER_RATIO;
  const delayMs = Math.max(1_000, Math.round(baseDelayMs * jitterMultiplier));
  return {
    attempt,
    baseDelayMs,
    delayMs,
    dueAt: new Date(now.getTime() + delayMs),
    maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  };
}

export type RetrySchedule = {
  attempt: number;
  baseDelayMs: number;
  delayMs: number;
  dueAt: Date;
  maxAttempts: number;
};

export type BoundedRetryScheduleInput = {
  /** Attempts this retry reason already consumed, before this decision. */
  consumedAttempts: number;
  maxAttempts?: number;
  delayMs?: number;
  now: Date;
  random: () => number;
};

export type BoundedRetryScheduleDecision = {
  /** The floored, zero-clamped attempt budget this decision used. */
  maxAttempts: number;
  /** Null when the next attempt exceeds `maxAttempts`: the budget is spent. */
  schedule: RetrySchedule | null;
};

/**
 * Decides the next bounded retry's attempt number, budget, and schedule.
 * `schedule` is null once the next attempt exceeds the clamped budget,
 * which is the retry-exhausted decision.
 *
 * A caller that passes an explicit `delayMs` — every named retry reason
 * except the default transient-failure lane — gets that delay back, floored
 * and clamped to zero. The general lane (no explicit `delayMs`) falls back
 * to the fixed delay table through
 * `computeBoundedTransientHeartbeatRetrySchedule`.
 */
export function decideBoundedRetrySchedule(
  input: BoundedRetryScheduleInput,
): BoundedRetryScheduleDecision {
  const maxAttempts = Math.max(
    0,
    Math.floor(
      input.maxAttempts ?? BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
    ),
  );
  const nextAttempt = input.consumedAttempts + 1;
  if (nextAttempt > maxAttempts) return { maxAttempts, schedule: null };

  if (input.delayMs != null) {
    const delayMs = Math.max(0, Math.floor(input.delayMs));
    return {
      maxAttempts,
      schedule: {
        attempt: nextAttempt,
        baseDelayMs: delayMs,
        delayMs,
        dueAt: new Date(input.now.getTime() + delayMs),
        maxAttempts,
      },
    };
  }

  const computed = computeBoundedTransientHeartbeatRetrySchedule(
    nextAttempt,
    input.now,
    input.random,
  );
  if (!computed) return { maxAttempts, schedule: null };
  return { maxAttempts, schedule: { ...computed, maxAttempts } };
}

/**
 * Decides whether the default transient-failure lane's recovery contract
 * applies. Only that lane honors a provider-reported retryNotBefore
 * override; every other named reason and the general lane ignore it.
 */
export function isBoundedTransientRetryReason(retryReason: string): boolean {
  return retryReason === BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON;
}

/**
 * Applies the provider-reported retryNotBefore override on top of a
 * computed schedule. The override only pushes the due time later; it never
 * moves a retry earlier than the schedule the budget calculation produced.
 */
export function applyRetryNotBeforeOverride(
  schedule: RetrySchedule,
  transientRetryNotBefore: Date | null,
  now: Date,
): RetrySchedule {
  if (
    transientRetryNotBefore &&
    transientRetryNotBefore.getTime() > schedule.dueAt.getTime()
  ) {
    return {
      ...schedule,
      dueAt: transientRetryNotBefore,
      delayMs: Math.max(0, transientRetryNotBefore.getTime() - now.getTime()),
    };
  }
  return schedule;
}

export type CodexTransientFallbackMode =
  | "same_session"
  | "safer_invocation"
  | "fresh_session"
  | "fresh_session_safer_invocation";

/**
 * Maps a Codex local attempt number to its fallback invocation mode.
 * Attempt one keeps the same session; each later attempt escalates to a
 * safer or fresher invocation.
 */
export function resolveCodexTransientFallbackMode(
  attempt: number,
): CodexTransientFallbackMode {
  if (attempt <= 1) return "same_session";
  if (attempt === 2) return "safer_invocation";
  if (attempt === 3) return "fresh_session";
  return "fresh_session_safer_invocation";
}

export type CodexTransientFallbackFacts = {
  isCodexLocalAdapter: boolean;
  isTransientUpstreamErrorFamily: boolean;
  attempt: number;
};

/**
 * Decides whether a retry needs a Codex fallback invocation mode. Only a
 * Codex local adapter recovering from a transient-upstream error family
 * gets a fallback mode; every other agent or error family gets none.
 */
export function decideCodexTransientFallbackMode(
  facts: CodexTransientFallbackFacts,
): CodexTransientFallbackMode | null {
  if (!facts.isCodexLocalAdapter || !facts.isTransientUpstreamErrorFamily) {
    return null;
  }
  return resolveCodexTransientFallbackMode(facts.attempt);
}
