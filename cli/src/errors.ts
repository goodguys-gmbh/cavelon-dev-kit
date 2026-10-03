/**
 * Exit codes and the one error type every command throws.
 *
 * The codes are a public contract (README, "Exit codes"): agents and CI branch
 * on them, so a code never changes its meaning.
 */

export const ExitCode = {
  ok: 0,
  failure: 1,
  usage: 2,
  validation: 3,
  conflict: 4,
  needsAction: 5,
  timeout: 6,
  unauthorized: 7,
  server: 8,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface ErrorDetails {
  /** A stable machine code: the server's own code when it sent one. */
  code: string;
  message: string;
  hint?: string;
  docs?: string;
  /** The HTTP status, when the error came from the instance. */
  status?: number;
  /** Anything else a caller may act on, for example validation errors. */
  details?: unknown;
  /** What the instance's own check found, one sentence each (an import's `blockers`). */
  blockers?: string[];
}

export class CavelonError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly code: string;
  readonly hint?: string;
  readonly docs?: string;
  readonly status?: number;
  readonly details?: unknown;
  readonly blockers?: string[];

  constructor(exitCode: ExitCodeValue, details: ErrorDetails) {
    super(details.message);
    this.name = "CavelonError";
    this.exitCode = exitCode;
    this.code = details.code;
    this.hint = details.hint;
    this.docs = details.docs;
    this.status = details.status;
    this.details = details.details;
    this.blockers = details.blockers;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = { code: this.code, message: this.message, exit_code: this.exitCode };
    if (this.hint) out.hint = this.hint;
    if (this.docs) out.docs = this.docs;
    if (this.status !== undefined) out.status = this.status;
    if (this.details !== undefined) out.details = this.details;
    if (this.blockers?.length) out.blockers = this.blockers;
    return out;
  }
}

export function usageError(message: string, hint?: string): CavelonError {
  return new CavelonError(ExitCode.usage, { code: "usage", message, hint });
}

export function validationError(message: string, details?: unknown, hint?: string): CavelonError {
  return new CavelonError(ExitCode.validation, { code: "validation_failed", message, details, hint });
}

export function notLoggedIn(url?: string): CavelonError {
  return new CavelonError(ExitCode.unauthorized, {
    code: "not_logged_in",
    message: url ? `No token for ${url}.` : "No instance and no token.",
    hint: "A person runs `cavelon login` (or sets CAVELON_URL and CAVELON_TOKEN); the agent never handles the token.",
  });
}

/** Any thrown value as a CavelonError, so the runner prints one shape. */
export function asCavelonError(error: unknown): CavelonError {
  if (error instanceof CavelonError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CavelonError(ExitCode.failure, { code: "internal_error", message });
}
