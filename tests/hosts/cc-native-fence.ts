// 78 review: a network fence for the probes in cc-native-probe.test.ts, the only file that spawns
// the real, pinned `claude` executable. ANTHROPIC_BASE_URL pointing at the loopback server in
// cc-native-loopback.ts stops the *model* traffic, but nothing stops the CLI (or a child process it
// spawns) from reaching the real internet for telemetry, update checks or feature flags. This module
// wraps the executable in an OS-level sandbox (macOS Seatbelt, via /usr/bin/sandbox-exec) that denies
// every network operation except loopback, so a probe fails loudly instead of quietly phoning home.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

// Seatbelt operations are `network-outbound` / `network-inbound` / `network-bind`; `network*` is the
// wildcard over all three. `(allow default)` keeps every non-network operation (file read/write,
// process exec, mach lookups) working — the CLI needs those for its config dir, its cwd and its own
// child processes — then `(deny network*)` removes all networking, and the two `(allow ... "localhost:*")`
// rules and the unix-socket rules hand loopback TCP and local sockets back, which is what the loopback
// server (cc-native-loopback.ts) and the SDK's stdio-based control protocol need.
const NETWORK_FENCE_PROFILE = `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-bind (local unix-socket))
(allow network-inbound (local unix-socket))
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Portability gate: both the pinned executable and the sandboxing tool must exist. Absent either,
 * the probes in cc-native-probe.test.ts skip (never silently run unfenced). */
export function fenceToolsAvailable(claudeExecutable: string): boolean {
  return existsSync(claudeExecutable) && existsSync(SANDBOX_EXEC_PATH);
}

/** Writes the fence profile and a wrapper executable into `dir`, and returns the wrapper's absolute
 * path — pass it as `claudeExecutable` / `pathToClaudeCodeExecutable` everywhere the probes launch
 * the real CLI, so every invocation (including the worker's own `--version` check) is fenced. */
export function createFencedClaudeExecutable(dir: string, realExecutable: string): { wrapperPath: string; profilePath: string } {
  mkdirSync(dir, { recursive: true });
  const profilePath = join(dir, "network.sb");
  writeFileSync(profilePath, NETWORK_FENCE_PROFILE);
  const wrapperPath = join(dir, "claude-fenced.sh");
  // Claude Code 2.1.284 auto-installs its official marketplace with `git clone`, and this fence does not
  // stop every git transport; the switch stops the clone itself in every fenced run.
  writeFileSync(wrapperPath, `#!/bin/sh\nexport CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1\nexec ${SANDBOX_EXEC_PATH} -f ${shellQuote(profilePath)} ${shellQuote(realExecutable)} "$@"\n`);
  chmodSync(wrapperPath, 0o755);
  return { wrapperPath, profilePath };
}

// A raw TCP connect, run as its own sandboxed process. Deliberately not curl or node's `http`
// module: on this kind of machine an ambient HTTP_PROXY/NODE_USE_ENV_PROXY setup makes those
// transparently tunnel an "external" request back out through an *allowed* loopback proxy port,
// which would make the profile look like it denies nothing when it actually does — a raw socket
// never consults a proxy, so it reports the sandbox's own decision. The spawned env carries only
// PATH/HOME, so no proxy variable can reach it regardless.
// Only the sandbox's own refusal (EPERM) counts as denied: an unreachable route or a refused port
// would otherwise pass the preflight on a machine that is merely offline.
function sandboxedConnect(profilePath: string, host: string, port: number): Promise<string> {
  const script = `const net=require("node:net");const s=net.createConnection({host:${JSON.stringify(host)},port:${port}});` +
    `const t=setTimeout(()=>{console.log("timeout");process.exit(2)},2000);` +
    `s.once("connect",()=>{clearTimeout(t);s.destroy();console.log("connected");process.exit(0)});` +
    `s.once("error",e=>{clearTimeout(t);console.log(e.code==="EPERM"?"denied":"error:"+e.code);process.exit(1)});`;
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  return execFileAsync(SANDBOX_EXEC_PATH, ["-f", profilePath, process.execPath, "-e", script], { timeout: 5_000, env })
    .then(({ stdout }) => stdout.trim())
    .catch((error: { stdout?: string }) => {
      const stdout = error.stdout?.trim();
      if (stdout) return stdout;
      throw error;
    });
}

/** Proves the fence bites before any probe spawns the real CLI: a loopback connect succeeds and a
 * non-loopback connect is denied, both through the same profile the probes use. Throws (never
 * skips) if either control fails — the probes must fail loudly, not run unfenced. */
export async function preflightNetworkFence(profilePath: string): Promise<void> {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  try {
    if (!address || typeof address === "string") throw new Error("network fence preflight: loopback listener did not bind a TCP port");
    const loopback = await sandboxedConnect(profilePath, "127.0.0.1", address.port);
    if (loopback !== "connected")
      throw new Error(`network fence preflight: expected the sandbox to allow a loopback connection, got "${loopback}"`);
    const external = await sandboxedConnect(profilePath, "1.1.1.1", 443);
    if (external !== "denied")
      throw new Error(`network fence preflight: expected the sandbox to deny an outbound connection to 1.1.1.1:443, got "${external}"`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
