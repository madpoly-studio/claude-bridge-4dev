// Exit codes shared by cli.mjs, setup.mjs and the supervisor, plus the error type that carries a Vietnamese message.

/** Process exit codes (README "Mã thoát"). */
export const EXIT = Object.freeze({
  OK: 0,
  RUNTIME: 1,
  SETTINGS: 2,
  ENVIRONMENT: 3,
  FORCED: 130,
});

/** Exit code when the console window is closed (SIGHUP). */
export const EXIT_HANGUP = 129;

/**
 * An error the user can fix. `message` is printed as is, `details` as a numbered list under it.
 */
export class UserError extends Error {
  /**
   * @param {string} message Vietnamese, user-facing.
   * @param {2 | 3} exitCode EXIT.SETTINGS or EXIT.ENVIRONMENT.
   * @param {string[]} [details]
   */
  constructor(message, exitCode, details = []) {
    super(message);
    this.name = "UserError";
    /** @readonly */
    this.exitCode = exitCode;
    /** @readonly */
    this.details = details;
  }
}
