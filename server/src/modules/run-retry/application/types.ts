import type { RetrySchedule } from "../domain/policy.js";

export type RunRetryWriterInput<Run> = {
  companyId: string;
  now: Date;
  run: Run;
  agentName: string;
  retryReason: string;
  wakeReason: string;
  issueId: string | null;
  contextSnapshot: Record<string, unknown>;
  retryContextSnapshot: Record<string, unknown>;
  schedule: RetrySchedule;
  transientRecovery: { errorFamily: string } | null;
  transientRetryNotBefore: Date | null;
  codexTransientFallbackMode: string | null;
  interactionContinuationPayload: Record<string, unknown>;
  workspaceValidationRetryPayload: Record<string, unknown> | null;
  shouldQuarantineWorkspaceForRetry: boolean;
  responsibleUserId: string | null;
  sessionBefore: string | null;
  continuationRetryIdempotencyKey: string | null;
  legacyReconciliationBlocked: boolean;
  legacyReconciliationEvidence: { sourceRunId: string };
};

export type RunRetryWriterResult<Run> =
  | { outcome: "scheduled"; run: Run; reusedExisting: boolean }
  | {
      outcome: "not_scheduled";
      reason: string;
      errorCode:
        | "issue_not_found"
        | "issue_reassigned"
        | "issue_cancelled"
        | "issue_terminal_status"
        | "issue_not_in_progress"
        | "continuation_user_authorization_missing"
        | "issue_execution_lock_changed"
        | "legacy_execution_requires_reconciliation";
      issueId: string | null;
      details: Record<string, unknown>;
    };

export type RunRetryInvokabilityInput<Agent> = {
  companyId: string;
  now: Date;
  agent: Agent;
};

export type RunRetryInvokabilityResult =
  | { invokable: true }
  | {
      invokable: false;
      reason: string;
      invalidOrgChain: boolean;
      details: Record<string, unknown>;
    };
