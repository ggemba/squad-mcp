export type SquadErrorCode =
  | "PATH_TRAVERSAL_DENIED"
  | "PATH_REQUIRES_WORKSPACE"
  | "PATH_INVALID"
  | "AGENT_DIR_MISSING"
  | "UNKNOWN_AGENT"
  | "OVERRIDE_REJECTED"
  | "INVALID_INPUT"
  | "INTERNAL_ERROR"
  | "GIT_EXEC_DENIED"
  | "GIT_EXEC_TIMEOUT"
  | "GIT_NOT_FOUND"
  | "GIT_OUTPUT_TOO_LARGE"
  | "GIT_NOT_A_REPO"
  | "CONFIG_READ_FAILED"
  // Emitted by `src/runs/store.ts` when `JSON.stringify(record)` exceeds
  // MAX_RECORD_BYTES. Plan v4 rejected the multi-row partial-fallback
  // mechanism (5 cycle-2 advisors converged on the same Major) and
  // chose loud rejection at validation time: the caller retries with
  // shorter fields rather than the store silently splitting rows.
  | "RECORD_TOO_LARGE";

export class SquadError extends Error {
  readonly code: SquadErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: SquadErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SquadError";
    this.code = code;
    this.details = details;
  }
}

export function isSquadError(err: unknown): err is SquadError {
  return err instanceof SquadError;
}
