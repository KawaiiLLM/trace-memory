// A test-only fence: exactly the live mock ports and this scenario's private socket tree.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createTcpServer } from "node:net";
import { createServer as createUnixServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
export function fenceToolsAvailable(executable: string): boolean {
  return existsSync(executable) && existsSync(SANDBOX_EXEC_PATH);
}
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const regex = (path: string) => `^${resolve(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.*$`;
/** Create only after the mock is listening; an unlisted port is never allowed. */
export function createFencedClaudeExecutable(dir: string, executable: string, ports: readonly number[], socketRoot: string) {
  if (!socketRoot || !ports.every(port => Number.isInteger(port) && port > 0 && port < 65536))
    throw new Error("native fence needs an exact private socket root and live mock ports");
  if (process.env.TM_NATIVE_PREPARED_PORT) {
    if (!resolve(socketRoot).startsWith(`${resolve(process.env.TM_NATIVE_SOCKET_ROOT ?? "/nonexistent")}/`) ||
        ports.some(port => port !== Number(process.env.TM_NATIVE_PREPARED_PORT)))
      throw new Error("native inherited fence does not match the test mock/root");
    // The outer driver fences Vitest, SDK and Claude together. Never nest sandbox-exec.
    return { profilePath: "inherited", wrapperPath: executable };
  }
  mkdirSync(dir, { recursive: true });
  const profilePath = join(dir, "network.sb"), wrapperPath = join(dir, "claude-fenced.sh");
  const pattern = JSON.stringify(regex(socketRoot));
  writeFileSync(profilePath, `(version 1)\n(allow default)\n(deny network*)\n${ports.map(port => `(allow network-outbound (remote ip "localhost:${port}"))`).join("\n")}\n(allow network-outbound (remote unix-socket (path-regex ${pattern})))\n(allow network-bind (local unix-socket (path-regex ${pattern})))\n(allow network-inbound (local unix-socket (path-regex ${pattern})))\n`);
  writeFileSync(wrapperPath, `#!/bin/sh\nexec ${SANDBOX_EXEC_PATH} -f ${quote(profilePath)} ${quote(executable)} "$@"\n`);
  chmodSync(wrapperPath, 0o755);
  return { wrapperPath, profilePath };
}
async function listen(server: ReturnType<typeof createTcpServer>, pathOrPort: string | number) {
  await new Promise<void>((done, fail) => { server.once("error", fail); if (typeof pathOrPort === "number") server.listen(pathOrPort, "127.0.0.1", done); else server.listen(pathOrPort, done); });
}
async function check(profile: string, target: { host?: string; port?: number; path?: string }, expected: "CONNECTED" | "EPERM") {
  const code = `const n=require('node:net');const s=n.connect(${JSON.stringify(target)});const t=setTimeout(()=>process.exit(3),2000);s.on('connect',()=>{clearTimeout(t);s.destroy();console.log('CONNECTED')});s.on('error',e=>{clearTimeout(t);console.log(e.code)})`;
  const { stdout } = await execFileAsync(profile === "inherited" ? process.execPath : SANDBOX_EXEC_PATH,
    profile === "inherited" ? ["-e", code] : ["-f", profile, process.execPath, "-e", code],
    { timeout: 5_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  if (stdout.trim() !== expected) throw new Error(`native fence ${JSON.stringify(target)}: expected ${expected}, got ${stdout.trim()}`);
}
/** The same fenced executable used by SDK calls must report the pinned runtime. */
export async function assertPinnedClaudeVersion(wrapperPath: string, socketRoot: string) {
  const { stdout } = await execFileAsync(wrapperPath, ["--version"], { timeout: 10_000,
    env: { PATH: process.env.PATH ?? "", HOME: socketRoot, TMPDIR: socketRoot, CLAUDE_CODE_TMPDIR: socketRoot,
      DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1" } });
  if (stdout.trim() !== "2.1.280 (Claude Code)") throw new Error(`native acceptance requires Claude Code 2.1.280, got ${stdout.trim()}`);
}
/** Check permitted mock/private socket and rejected live other-local, other socket and external 22/443. */
export async function preflightNetworkFence(profile: string, ports: readonly number[], socketRoot: string) {
  if (profile === "inherited") {
    const otherPort = Number(process.env.TM_NATIVE_GUARD_PORT);
    const otherSocket = process.env.TM_NATIVE_GUARD_SOCKET;
    if (!Number.isInteger(otherPort) || !otherSocket) throw new Error("native inherited fence missing live negative controls");
    for (const port of ports) await check(profile, { host: "127.0.0.1", port }, "CONNECTED");
    await check(profile, { host: "127.0.0.1", port: otherPort }, "EPERM");
    await check(profile, { path: otherSocket }, "EPERM");
    for (const port of [22, 443]) await check(profile, { host: "1.1.1.1", port }, "EPERM");
    return;
  }
  const other = createTcpServer(socket => socket.destroy());
  const own = createUnixServer(socket => socket.destroy());
  const outside = createUnixServer(socket => socket.destroy());
  const probeDir = mkdtempSync(join(tmpdir(), "fence-other-"));
  const ownPath = join(socketRoot, `allowed-${process.pid}.sock`), outsidePath = join(probeDir, "denied.sock");
  mkdirSync(dirname(ownPath), { recursive: true });
  try {
    await listen(other, 0); await listen(own, ownPath); await listen(outside, outsidePath);
    const otherAddress = other.address();
    if (!otherAddress || typeof otherAddress === "string") throw new Error("native fence other listener unavailable");
    for (const port of ports) await check(profile, { host: "127.0.0.1", port }, "CONNECTED");
    await check(profile, { path: ownPath }, "CONNECTED");
    await check(profile, { host: "127.0.0.1", port: otherAddress.port }, "EPERM");
    await check(profile, { path: outsidePath }, "EPERM");
    for (const port of [22, 443]) await check(profile, { host: "1.1.1.1", port }, "EPERM");
  } finally {
    await Promise.all([other, own, outside].map(server => new Promise<void>(done => server.close(() => done()))));
    rmSync(probeDir, { recursive: true, force: true });
  }
}
