/**
 * Ticket 106: the Claude Code version the native probes (`tests/hosts/cc-*-native*.test.ts`) last
 * passed on. It is a record, not a gate: nothing refuses to run on another version. The status line
 * shows a marker while the running version differs. Kept in its own file so `status-entry.ts` can
 * import it without pulling in `config.ts`.
 */
export const CC_VERIFIED_VERSION = "2.1.284";
