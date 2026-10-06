import { describe, expect, it } from "vitest";
import {
  applyRetryNotBeforeOverride,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON,
  decideBoundedRetrySchedule,
  decideCodexTransientFallbackMode,
  decideHardRetryExclusion,
  isBoundedTransientRetryReason,
  resolveCodexTransientFallbackMode,
  type BoundedRetryScheduleInput,
} from "./policy.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("decideHardRetryExclusion", () => {
  it("excludes the invalid-tool-definition branch without an errorCode", () => {
    const decision = decideHardRetryExclusion({
      errorCode: "provider_tool_definition_invalid",
      hasChatCompletionDeliveryIds: false,
    });
    expect(decision).toEqual({
      excluded: true,
      reason:
        "Repair the invalid tool definitions before starting a new attempt.",
    });
    expect(decision).not.toHaveProperty("errorCode");
  });

  it("excludes the chat-outbox branch with an errorCode", () => {
    const decision = decideHardRetryExclusion({
      errorCode: null,
      hasChatCompletionDeliveryIds: true,
    });
    expect(decision).toEqual({
      excluded: true,
      reason:
        "The completion outbox owns this reply's retry budget and publication identity.",
      errorCode: "chat_completion_outbox_owns_retry",
    });
  });

  it("does not exclude a run with neither condition", () => {
    expect(
      decideHardRetryExclusion({
        errorCode: "some_other_error",
        hasChatCompletionDeliveryIds: false,
      }),
    ).toEqual({ excluded: false });
  });

  it("prefers the invalid-tool-definition exclusion when both conditions are present", () => {
    const decision = decideHardRetryExclusion({
      errorCode: "provider_tool_definition_invalid",
      hasChatCompletionDeliveryIds: true,
    });
    expect(decision).not.toHaveProperty("errorCode");
  });
});

function baseScheduleFacts(): BoundedRetryScheduleInput {
  return {
    consumedAttempts: 0,
    now: NOW,
    random: () => 0,
  };
}

describe("decideBoundedRetrySchedule", () => {
  it.each([
    { name: "the general lane (default bounded transient-failure delay table)", overrides: {} },
    { name: "max_turns_continuation", overrides: { maxAttempts: 2, delayMs: 1_000 } },
    { name: "workspace_busy", overrides: { maxAttempts: 1, delayMs: 60_000 } },
    { name: "ai_connection_busy", overrides: { maxAttempts: 1, delayMs: 30_000 } },
    { name: "ai_connection_pool_wait", overrides: { maxAttempts: 1, delayMs: 45_000 } },
    { name: "interaction_continuation_infra_retry", overrides: { maxAttempts: 2, delayMs: 5_000 } },
    { name: "execution_review_participant_recovery", overrides: { maxAttempts: 2, delayMs: 2_000 } },
    { name: "transient_failure (explicit delay override)", overrides: { maxAttempts: 2, delayMs: 10_000 } },
  ])("computes the attempt, budget, and schedule for $name", ({ overrides }) => {
    const facts = { ...baseScheduleFacts(), ...overrides };
    const decision = decideBoundedRetrySchedule(facts);
    expect(decision.schedule).not.toBeNull();
    expect(decision.schedule?.attempt).toBe(1);
    expect(decision.maxAttempts).toBe(
      overrides.maxAttempts ?? BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
    );
    if (overrides.delayMs != null) {
      expect(decision.schedule?.delayMs).toBe(overrides.delayMs);
      expect(decision.schedule?.baseDelayMs).toBe(overrides.delayMs);
    } else {
      expect(decision.schedule?.baseDelayMs).toBe(30_000);
      expect(decision.schedule?.delayMs).toBe(30_000);
    }
    expect(decision.schedule?.dueAt.getTime()).toBe(
      NOW.getTime() + (decision.schedule?.delayMs ?? 0),
    );
  });

  it("floors and clamps a fractional or negative maxAttempts", () => {
    expect(
      decideBoundedRetrySchedule({ ...baseScheduleFacts(), maxAttempts: 3.9 }).maxAttempts,
    ).toBe(3);
    expect(
      decideBoundedRetrySchedule({ ...baseScheduleFacts(), maxAttempts: -5 }).maxAttempts,
    ).toBe(0);
  });

  it("defaults maxAttempts to the bounded transient retry budget when omitted", () => {
    expect(decideBoundedRetrySchedule(baseScheduleFacts()).maxAttempts).toBe(
      BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
    );
  });

  it("floors and clamps a fractional or negative explicit delayMs to zero", () => {
    const fractional = decideBoundedRetrySchedule({
      ...baseScheduleFacts(),
      maxAttempts: 1,
      delayMs: 1_500.7,
    });
    expect(fractional.schedule?.delayMs).toBe(1_500);

    const negative = decideBoundedRetrySchedule({
      ...baseScheduleFacts(),
      maxAttempts: 1,
      delayMs: -1_000,
    });
    expect(negative.schedule?.delayMs).toBe(0);
  });

  it("is exhausted once the next attempt exceeds maxAttempts (attempt three against a budget of two)", () => {
    const decision = decideBoundedRetrySchedule({
      ...baseScheduleFacts(),
      consumedAttempts: 2,
    });
    expect(decision.maxAttempts).toBe(2);
    expect(decision.schedule).toBeNull();
  });

  it("is exhausted immediately when maxAttempts clamps to zero", () => {
    const decision = decideBoundedRetrySchedule({
      ...baseScheduleFacts(),
      maxAttempts: 0,
    });
    expect(decision.schedule).toBeNull();
  });

  it("applies the zero jitter ratio exactly at the fixed delay for each attempt in the table", () => {
    const first = decideBoundedRetrySchedule({ ...baseScheduleFacts(), consumedAttempts: 0, random: () => 0.37 });
    const second = decideBoundedRetrySchedule({ ...baseScheduleFacts(), consumedAttempts: 1, random: () => 0.91 });
    expect(first.schedule?.delayMs).toBe(30_000);
    expect(second.schedule?.delayMs).toBe(30_000);
  });
});

describe("isBoundedTransientRetryReason", () => {
  it.each([
    "transient_failure",
    "max_turns_continuation",
    "workspace_busy",
    "ai_connection_busy",
    "ai_connection_pool_wait",
    "interaction_continuation_infra_retry",
    "execution_review_participant_recovery",
    "some_custom_reason",
  ])("reports %s", (retryReason) => {
    expect(isBoundedTransientRetryReason(retryReason)).toBe(
      retryReason === BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON,
    );
  });
});

describe("applyRetryNotBeforeOverride", () => {
  const baseSchedule = {
    attempt: 1,
    baseDelayMs: 30_000,
    delayMs: 30_000,
    dueAt: new Date(NOW.getTime() + 30_000),
    maxAttempts: 2,
  };

  it("overrides the due time when retryNotBefore is later than the computed schedule", () => {
    const retryNotBefore = new Date(NOW.getTime() + 120_000);
    const result = applyRetryNotBeforeOverride(baseSchedule, retryNotBefore, NOW);
    expect(result.dueAt).toEqual(retryNotBefore);
    expect(result.delayMs).toBe(120_000);
    expect(result.baseDelayMs).toBe(30_000);
    expect(result.attempt).toBe(1);
  });

  it("leaves the schedule unchanged when retryNotBefore is earlier than or equal to the computed schedule", () => {
    const earlier = new Date(NOW.getTime() + 10_000);
    expect(applyRetryNotBeforeOverride(baseSchedule, earlier, NOW)).toEqual(baseSchedule);
    const equal = new Date(baseSchedule.dueAt.getTime());
    expect(applyRetryNotBeforeOverride(baseSchedule, equal, NOW)).toEqual(baseSchedule);
  });

  it("leaves the schedule unchanged when there is no retryNotBefore", () => {
    expect(applyRetryNotBeforeOverride(baseSchedule, null, NOW)).toEqual(baseSchedule);
  });
});

describe("resolveCodexTransientFallbackMode", () => {
  it.each([
    { attempt: 1, mode: "same_session" },
    { attempt: 2, mode: "safer_invocation" },
    { attempt: 3, mode: "fresh_session" },
    { attempt: 4, mode: "fresh_session_safer_invocation" },
    { attempt: 5, mode: "fresh_session_safer_invocation" },
  ])("maps attempt $attempt to $mode", ({ attempt, mode }) => {
    expect(resolveCodexTransientFallbackMode(attempt)).toBe(mode);
  });

  it("treats a zero or negative attempt as the first attempt", () => {
    expect(resolveCodexTransientFallbackMode(0)).toBe("same_session");
    expect(resolveCodexTransientFallbackMode(-1)).toBe("same_session");
  });
});

describe("decideCodexTransientFallbackMode", () => {
  it("returns null for a non-Codex-local adapter", () => {
    expect(
      decideCodexTransientFallbackMode({
        isCodexLocalAdapter: false,
        isTransientUpstreamErrorFamily: true,
        attempt: 2,
      }),
    ).toBeNull();
  });

  it("returns null when the error family is not transient-upstream", () => {
    expect(
      decideCodexTransientFallbackMode({
        isCodexLocalAdapter: true,
        isTransientUpstreamErrorFamily: false,
        attempt: 2,
      }),
    ).toBeNull();
  });

  it("returns the mapped fallback mode for a Codex local transient-upstream retry", () => {
    expect(
      decideCodexTransientFallbackMode({
        isCodexLocalAdapter: true,
        isTransientUpstreamErrorFamily: true,
        attempt: 3,
      }),
    ).toBe("fresh_session");
  });
});
