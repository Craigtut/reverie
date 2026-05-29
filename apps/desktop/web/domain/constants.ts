// Shared domain constants.

// Default working directory presented for new sessions and used to abbreviate
// cwds for display. Currently a fixed home path; will become the real OS home
// once the backend reports it.
export const USER_HOME = '/Users/user';

// Default scrollback the backend is asked to retain for a session's terminal.
export const DEFAULT_TERMINAL_SCROLLBACK_ROWS = 10_000;
