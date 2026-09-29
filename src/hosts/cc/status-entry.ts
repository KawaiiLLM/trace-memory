import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { memoryStatusLine, type StatusColorRole } from "../status-line.ts";
import { readCcStatus } from "./status.ts";
import { CC_VERIFIED_VERSION } from "./verified-version.ts";

/**
 * Ticket 75: the status command Claude Code's statusLine script runs after powerline. Deliberately
 * self-contained — no `config.ts` (which reaches `core/api/index.ts` and its full validation), no
 * `binding.ts` (which imports `node:sqlite`), no Store, no core. It reads Claude Code's own status-line
 * hook JSON from stdin for `session_id`, the tiny published status file, and — for ownership and
 * liveness only — the raw bytes of the matching binding file, never through the database. Target
 * end-to-end time is under 50 ms; anything it cannot cheaply and safely resolve renders `?` rather than
 * risk a slow or unsafe read. On any error it prints nothing and exits 0: it must never throw into the
 * user's status line.
 */

// Pi's bundled themes paint accent/success/customMessageLabel as teal/green/purple (24a/51); dim is
// the ANSI faint attribute Pi's own terminal fallback uses when no theme is available.
const ANSI: Record<StatusColorRole, string> = { accent: "\x1b[36m", success: "\x1b[32m", customMessageLabel: "\x1b[35m", dim: "\x1b[2m" };
const RESET = "\x1b[0m";
const paint = (role: StatusColorRole, text: string): string => `${ANSI[role]}${text}${RESET}`;

function executorAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; } // ESRCH (gone) and any other liveness doubt both render `?`, never a stale running indicator
}

async function readStdin(): Promise<string> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function resolveStateDir(configPath: string): string {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as { stateDir?: unknown };
  if (typeof raw.stateDir !== "string" || !isAbsolute(raw.stateDir)) throw new Error("CC configuration stateDir must be an absolute path");
  return raw.stateDir;
}

/** The publishing executor's token, read directly off the binding file's bytes — never through
 * `readBinding`/`parseBinding` (`binding.ts`), which would pull in `node:sqlite` for no reason here. */
function currentBindingExecutorToken(stateDir: string, nativeSessionId: string): string | undefined {
  try {
    const binding = JSON.parse(readFileSync(join(stateDir, "bindings", `${nativeSessionId}.json`), "utf8")) as { executor?: { token?: unknown } };
    return typeof binding.executor?.token === "string" ? binding.executor.token : undefined;
  } catch { return undefined; }
}

export interface CcStatusIo {
  argv?: string[];
  readStdin?: () => Promise<string>;
  write?: (line: string) => void;
}

/** Never throws: every failure mode (bad argv, unreadable config, malformed stdin, missing or
 * malformed status/binding file) is swallowed and prints nothing, per the acceptance criterion. */
export async function runCcStatusCommand(io: CcStatusIo = {}): Promise<void> {
  const { argv = process.argv.slice(2), readStdin: read = readStdin, write = (line: string) => { process.stdout.write(line); } } = io;
  try {
    const [configFlag, configPath] = argv;
    if (configFlag !== "--config" || typeof configPath !== "string" || !isAbsolute(configPath)) return;
    const stateDir = resolveStateDir(configPath);
    const input = JSON.parse(await read()) as { session_id?: unknown; version?: unknown };
    if (typeof input.session_id !== "string" || !input.session_id) return;
    const status = readCcStatus(stateDir, input.session_id);
    if (!status) return; // this session is not bound to Trace Memory: the status line is unchanged
    const owned = currentBindingExecutorToken(stateDir, input.session_id) === status.token;
    const alive = owned && executorAlive(status.pid);
    const segments = memoryStatusLine({
      enabled: status.enabled,
      running: alive ? status.running : { noting: false, dreaming: false },
      counts: alive ? status.counts : undefined,
      cost: alive ? status.cost : undefined,
    });
    // 106: the running Claude Code version comes from the status-line input; no process is started.
    if (typeof input.version === "string" && input.version && input.version !== CC_VERIFIED_VERSION)
      segments.push({ role: "dim", text: `unverified CC ${input.version}` });
    write(`🧠 ${segments.map(segment => paint(segment.role, segment.text)).join(" ")}\n`);
  } catch { /* never throw into the status line */ }
}
