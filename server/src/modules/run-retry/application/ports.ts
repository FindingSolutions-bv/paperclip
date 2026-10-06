import type {
  RunRetryInvokabilityInput,
  RunRetryInvokabilityResult,
  RunRetryWriterInput,
  RunRetryWriterResult,
} from "./types.js";

export interface RunRetryWriter<Run> {
  scheduleRetry(input: RunRetryWriterInput<Run>): Promise<RunRetryWriterResult<Run>>;
}

export interface RunRetryAgentInvokability<Agent> {
  checkAgentInvokability(input: RunRetryInvokabilityInput<Agent>): Promise<RunRetryInvokabilityResult>;
}
