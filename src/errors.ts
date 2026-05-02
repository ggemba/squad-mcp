export type SquadErrorCode =
  | 'PATH_TRAVERSAL_DENIED'
  | 'PATH_REQUIRES_WORKSPACE'
  | 'PATH_INVALID'
  | 'AGENT_DIR_MISSING'
  | 'UNKNOWN_AGENT'
  | 'INVALID_INPUT'
  | 'INTERNAL_ERROR'
  | 'GIT_EXEC_DENIED'
  | 'GIT_EXEC_TIMEOUT'
  | 'GIT_NOT_FOUND'
  | 'GIT_OUTPUT_TOO_LARGE'
  | 'GIT_NOT_A_REPO';

export class SquadError extends Error {
  readonly code: SquadErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: SquadErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SquadError';
    this.code = code;
    this.details = details;
  }
}

export function isSquadError(err: unknown): err is SquadError {
  return err instanceof SquadError;
}
