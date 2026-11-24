/**
 * Typed shell failures (S9). Parsers never throw: they return a
 * {@link ShellError}, and the public execution entry point wraps it in a
 * {@link ShellCommandError} so callers can both inspect the code and log a
 * normal Error.
 */

/** Stable error categories the shell promises to callers. */
export type ShellErrorCode =
  | "empty_command"
  | "unknown_command"
  | "unknown_subcommand"
  | "unknown_flag"
  | "missing_argument"
  | "invalid_argument"
  | "unexpected_argument"
  | "unsupported"
  | "execution_failed";

/** Plain, serializable parse/execution error. */
export interface ShellError {
  readonly kind: "shell_error";
  readonly code: ShellErrorCode;
  /** Command word the input belongs to (`ip`, `ping`, ...). */
  readonly command: string;
  readonly message: string;
}

/** Build a {@link ShellError}. */
export function shellError(
  code: ShellErrorCode,
  command: string,
  message: string,
): ShellError {
  return { kind: "shell_error", code, command, message };
}

/** Error thrown by `Shell.exec()`; carries the typed code. */
export class ShellCommandError extends Error {
  readonly kind = "shell_error" as const;
  readonly code: ShellErrorCode;
  readonly command: string;

  constructor(error: ShellError) {
    super(error.message);
    this.name = "ShellCommandError";
    this.code = error.code;
    this.command = error.command;
  }
}
