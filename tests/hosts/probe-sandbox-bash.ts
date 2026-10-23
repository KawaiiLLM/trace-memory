// Manual ticket 151/152 evidence, not part of the long-term test suite.
// Run: node tests/hosts/probe-sandbox-bash.ts
// This retained probe always uses cc-native-fence.ts; nested Seatbelt prevents Bash initialization.
// Ticket 151 report-3 used a separately authorized unfenced run, then changed only cwd to workspace.
// Do not remove the fence to reproduce it without fresh maintainer authorization.
// All command targets, HOME, configuration, and artifacts are disposable /private/tmp paths.
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { createFencedClaudeExecutable, fencedClaudeVersion, preflightNetworkFence } from "./cc-native-fence.ts";
import { startLoopbackAnthropic } from "./cc-native-loopback.ts";

const run = promisify(execFile);
const root = mkdtempSync("/private/tmp/tm-sandbox-bash-");
// The fence helper creates its disposable negative-control socket directory via os.tmpdir().
process.env.TMPDIR = root;
const home = join(root, "home"), worker = join(root, "worker"), workspace = join(worker, "workspaces/run"), repo = join(root, "repository");
const sockets = join(root, "sockets"), outside = join(root, "outside"), config = join(home, ".claude");
for (const path of [home, worker, workspace, repo, sockets, outside, config, join(home, ".trace-memory"), join(home, ".pi/agent")]) mkdirSync(path, { recursive: true });
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: config, TMPDIR: sockets, CLAUDE_CODE_TMPDIR: sockets,
  DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  CLAUDE_CODE_MAX_RETRIES: "0", ANTHROPIC_API_KEY: "sk-ant-fake-sandbox-probe-key",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};
const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
git("init", "--quiet");
writeFileSync(join(repo, "history.txt"), "history-before\n");
git("add", "history.txt");
git("-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", "commit", "--quiet", "-m", "probe history");
writeFileSync(join(repo, "history.txt"), "history-after\n");
writeFileSync(join(repo, ".env"), "DUMMY_SECRET=probe-only\n");
writeFileSync(join(home, ".trace-memory/dummy"), "DUMMY_MEMORY=probe-only\n");
writeFileSync(join(home, ".pi/agent/dummy"), "DUMMY_AGENT=probe-only\n");
writeFileSync(join(workspace, "input.txt"), "alpha\nbeta\n");
symlinkSync(join(repo, ".env"), join(workspace, "secret-link"));
symlinkSync(outside, join(workspace, "outside-link"));
const q = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
type Attempt = { id: string; expected: "allowed" | "denied"; command: string; input?: Record<string, unknown> };
const attempts: Attempt[] = [];
const requests: unknown[] = [], messages: unknown[] = [];
let sandboxBlocked: string | undefined;
let localConnections = 0;
const local = createServer(socket => { localConnections++; socket.end("probe-local\n"); });
await new Promise<void>((done, fail) => { local.once("error", fail); local.listen(0, "127.0.0.1", done); });
const localAddress = local.address();
if (!localAddress || typeof localAddress === "string") throw new Error("local probe endpoint did not bind TCP");
const localPort = localAddress.port;
const add = (id: string, expected: Attempt["expected"], command: string, input?: Attempt["input"]) => attempts.push({ id, expected, command, input });
add("bash-smoke", "allowed", "printf 'BASH_OK\\n'; pwd");
add("workspace-grep", "allowed", `grep '^beta$' ${q(join(workspace, "input.txt"))}`);
add("workspace-sed", "allowed", `sed -n '1p' ${q(join(workspace, "input.txt"))}`);
add("workspace-python-write", "allowed", `python3 -c ${q(`from pathlib import Path; p=Path(${JSON.stringify(join(workspace, "output.txt"))}); p.write_text('python-ok\\n'); print(p.read_text())`)}`);
add("worker-sibling-write", "denied", `printf 'forbidden\\n' > ${q(join(worker, "sibling.txt"))}`);
add("outside-workspace-write", "denied", `printf 'forbidden\\n' > ${q(join(outside, "written.txt"))}`);
add("temp-write", "denied", `printf 'forbidden\\n' > ${q(join(sockets, "written.txt"))}`);
add("symlink-outside-write", "denied", `printf 'forbidden\\n' > ${q(join(workspace, "outside-link/symlink-written.txt"))}`);
add("git-log", "allowed", `git -C ${q(repo)} log -1 --format=%s`);
add("git-show", "allowed", `git -C ${q(repo)} show HEAD:history.txt`);
add("git-diff", "allowed", `git -C ${q(repo)} diff -- history.txt`);
add("repository-file-write", "denied", `printf 'forbidden\\n' > ${q(join(repo, "written.txt"))}`);
add("git-add", "denied", `git -C ${q(repo)} add history.txt`);
add("git-config-write", "denied", `git -C ${q(repo)} config probe.forbidden yes`);
add("git-branch-write", "denied", `git -C ${q(repo)} branch forbidden-probe`);
add("memory-read", "denied", `cat ${q(join(home, ".trace-memory/dummy"))}`);
add("pi-agent-read", "denied", `cat ${q(join(home, ".pi/agent/dummy"))}`);
add("env-secret-read", "denied", `cat ${q(join(repo, ".env"))}`);
add("env-symlink-read", "denied", `cat ${q(join(workspace, "secret-link"))}`);
add("python-secret-read", "denied", `python3 -c ${q(`from pathlib import Path; print(Path(${JSON.stringify(join(repo, ".env"))}).read_text())`)}`);
add("external-http", "denied", "curl --connect-timeout 2 --max-time 4 -sS -o /dev/null -w '%{http_code}\\n' https://example.com/");
add("external-direct-tcp", "denied", `python3 -c ${q("import socket; socket.create_connection(('1.1.1.1',443),2); print('CONNECTED')")}`);
add("local-tcp", "denied", `python3 -c ${q(`import socket; s=socket.create_connection(('127.0.0.1',${localPort}),2); print(s.recv(100).decode())`)}`);
add("local-no-proxy-http", "denied", `curl --noproxy '*' --connect-timeout 2 --max-time 4 -sS http://127.0.0.1:${localPort}/`);
add("explicit-unsandboxed-write", "denied", `printf 'forbidden\\n' > ${q(join(outside, "unsandboxed.txt"))}`, { dangerouslyDisableSandbox: true });
const secretFiles = [".env", ".env.*", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", ".npmrc", "credentials", "credentials.json", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore"];
const settings = {
  enabledPlugins: { "agents-md@builtin": false, "cc-plugin-plugin-authoring@builtin": false },
  permissions: { additionalDirectories: [repo] },
  sandbox: {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false, excludedCommands: [], enableWeakerNestedSandbox: false,
    filesystem: {
      allowWrite: [workspace], denyWrite: [repo, outside, home],
      denyRead: [join(home, ".trace-memory"), join(home, ".pi/agent"),
        ...secretFiles.map(name => `${repo}/**/${name}`), ...[".ssh", ".aws", ".gnupg"].map(name => `${repo}/**/${name}`)],
    },
    network: { allowedDomains: [], allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
  },
};
writeFileSync(join(root, "settings.json"), JSON.stringify(settings, null, 2));
writeFileSync(join(root, "attempts.json"), JSON.stringify(attempts, null, 2));
console.log(`PROBE_ROOT=${root}`);
const loopback = await startLoopbackAnthropic((turn, body) => {
  requests.push(body);
  writeFileSync(join(root, "requests.json"), JSON.stringify(requests, null, 2));
  if (sandboxBlocked) return { blocks: [{ type: "text", text: "Probe stopped: sandbox initialization is blocked." }], stopReason: "end_turn" };
  const attempt = attempts[turn];
  console.log(attempt ? `SCRIPTED_ACTION=${attempt.id}` : "SCRIPTED_DONE");
  return attempt
    ? { blocks: [{ type: "tool_use", id: `probe_${turn}`, name: "Bash", input: { command: attempt.command, timeout: 10_000, ...attempt.input } }], stopReason: "tool_use" }
    : { blocks: [{ type: "text", text: "probe complete" }], stopReason: "end_turn" };
});
env.ANTHROPIC_BASE_URL = loopback.url;
let execution: Query | undefined;
try {
  const apiPort = Number(new URL(loopback.url).port);
  const fence = createFencedClaudeExecutable(join(root, "fence"), process.env.TM_NATIVE_CLAUDE_EXECUTABLE ?? "/opt/homebrew/bin/claude", [apiPort, localPort], sockets);
  await preflightNetworkFence(fence.profilePath, [apiPort, localPort], sockets);
  const version = await fencedClaudeVersion(fence.wrapperPath, sockets);
  console.log(`CLAUDE_VERSION=${version}`);
  writeFileSync(join(root, "version.txt"), version);
  const help = await run(fence.wrapperPath, ["--help"], { env, cwd: worker, timeout: 10_000 });
  writeFileSync(join(root, "help.txt"), help.stdout);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("probe timeout")), 120_000);
  try {
    execution = query({ prompt: "Execute the scripted sandbox probe commands, then finish.", options: {
      model: "sonnet", cwd: worker, pathToClaudeCodeExecutable: fence.wrapperPath, env,
      tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"], allowedTools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash"],
      systemPrompt: "This is a scripted local sandbox capability probe using only dummy targets.",
      settingSources: [], plugins: [], permissionMode: "dontAsk", strictMcpConfig: true,
      abortController: controller, stderr: data => { process.stderr.write(data); },
      extraArgs: { "disable-slash-commands": null, "no-chrome": null, restricted: null, effort: "medium", settings: JSON.stringify(settings) },
    } });
    for await (const message of execution) {
      messages.push(message);
      writeFileSync(join(root, "messages.json"), JSON.stringify(messages, null, 2));
      if ("tool_use_result" in message && typeof message.tool_use_result === "string" &&
          message.tool_use_result.includes("Sandbox is required but failed to initialize")) {
        sandboxBlocked = message.tool_use_result;
        writeFileSync(join(root, "blocked.txt"), sandboxBlocked);
        process.exitCode = 1;
      }
      console.log(`SDK_EVENT=${message.type}${"subtype" in message ? `:${message.subtype}` : ""}`);
    }
  } finally { clearTimeout(timer); await execution?.return(undefined); }
  const state = {
    localConnections, gitStatus: git("status", "--porcelain"), gitBranches: git("branch", "--format=%(refname:short)"),
    repositoryConfig: readFileSync(join(repo, ".git/config"), "utf8"),
    files: Object.fromEntries([join(workspace, "output.txt"), join(worker, "sibling.txt"), join(outside, "written.txt"), join(sockets, "written.txt"), join(repo, "written.txt"), join(outside, "unsandboxed.txt"), join(outside, "symlink-written.txt")].map(path => [path, existsSync(path) ? readFileSync(path, "utf8") : null])),
  };
  writeFileSync(join(root, "state.json"), JSON.stringify(state, null, 2));
  console.log(`PROBE_STATE=${JSON.stringify(state)}`);
} catch (error) {
  writeFileSync(join(root, "blocked.txt"), String(error));
  console.error(`PROBE_BLOCKED=${String(error)}`);
  process.exitCode = 1;
} finally {
  await loopback.close();
  await new Promise<void>(done => local.close(() => done()));
  console.log(`PROBE_ARTIFACTS=${root}`);
}
