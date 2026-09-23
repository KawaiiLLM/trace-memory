// 78: native probes against the pinned, real Claude Code executable (2.1.280) — the only file in
// this suite that spawns it for real. No real model call ever leaves the machine: every provider
// request goes to the loopback Anthropic-shaped server in cc-native-loopback.ts. These are slower
// than the mocked-transport suite (cc-worker.test.ts) and are kept to the minimum needed to prove
// the path rule and the native-file/isolation/daily-cost acceptance items against reality, not a
// stand-in for it.
import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { CcAgentWorker, ccNativeTranscriptPath, type CcAgentTask } from "../../src/hosts/cc/worker.ts";
import { startLoopbackAnthropic } from "./cc-native-loopback.ts";

const CLAUDE_EXECUTABLE = "/opt/homebrew/bin/claude";
const CLAUDE_VERSION = "2.1.280";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Claude Code reports (and this adapter's `assertInit` requires) the *real* path: macOS's
// `/var` -> `/private/var` symlink means the raw `tmpdir()` value the CLI never sees would fail
// that check, though nothing this size to a real host `worker.cwd` (no symlink component).
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return realpathSync(dir);
}

function loopbackEnvironment(configDir: string, baseUrl: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "sk-ant-fake-probe-key", CLAUDE_CODE_MAX_RETRIES: "0" };
}

function workerConfig(cwd: string, executable = CLAUDE_EXECUTABLE) {
  return resolveCcHostConfig({ dbPath: join(cwd, "memory.sqlite"), stateDir: join(cwd, "state"),
    notingModel: "sonnet", notingThinking: "medium",
    consolidationModel: "sonnet", consolidationThinking: "medium",
    "dreaming.model": "sonnet", "dreaming.thinking": "medium",
    worker: { claudeExecutable: executable, claudeVersion: CLAUDE_VERSION, contextWindows: { "sonnet": 200_000 }, cwd } });
}

test("native file: a real CC worker run writes its transcript under <config dir>/projects/<dir for cwd>/<session id>.jsonl, holding the worker's assistant messages, tool calls and results; claude-powerline counts it once", async () => {
  const cwd = tempDir("tm78-native-cwd-");
  const configDir = tempDir("tm78-native-config-");
  const loopback = await startLoopbackAnthropic((assistantTurns) => assistantTurns === 0
    ? { blocks: [{ type: "tool_use", id: "toolu_1", name: "mcp__trace_memory__trace", input: {} }], stopReason: "tool_use" }
    : { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" });
  try {
    const environment = loopbackEnvironment(configDir, loopback.url);
    const task = { kind: "noting", text: "material", prompt: "instructions",
      tools: [{ name: "trace", description: "read", parameters: { type: "object", properties: {} },
        execute: () => "tool result text" }], acknowledgeRequest: () => {} } as unknown as CcAgentTask;
    const result = await new CcAgentWorker(workerConfig(cwd), { environment }).run(task, 0);
    expect(result.outcome).toBe("success");
    expect(result.nativeLog).toBeTruthy();
    const nativeLog = result.nativeLog!;
    expect(existsSync(nativeLog)).toBe(true);

    // Path structure: <config dir>/projects/<dir for cwd>/<session id>.jsonl.
    const sessionDir = dirname(nativeLog);
    expect(dirname(sessionDir)).toBe(join(configDir, "projects"));
    const held = readFileSync(nativeLog, "utf8");
    const lines = held.trim().split("\n").map(line => JSON.parse(line));
    const sessionId = lines.find(line => typeof line.sessionId === "string")?.sessionId;
    expect(sessionId).toBeTruthy();
    expect(basename(nativeLog)).toBe(`${sessionId}.jsonl`);
    expect(basename(sessionDir)).toBe(cwd.replace(/[^A-Za-z0-9]/g, "-"));
    expect(ccNativeTranscriptPath(environment, cwd, sessionId)).toBe(nativeLog);

    // Content: the assistant's tool_use, the real MCP round trip's tool_result, and the final text.
    const assistantMessages = lines.filter(line => line.type === "assistant");
    expect(assistantMessages.some(line => line.message?.content?.some((block: { type?: string }) => block.type === "tool_use"))).toBe(true);
    expect(held).toContain("tool result text");
    expect(assistantMessages.some(line => line.message?.content?.some((block: { type?: string; text?: string }) =>
      block.type === "text" && block.text === "done"))).toBe(true);

    // Daily cost: claude-powerline's own project scanner finds and counts it, read-only, imported by
    // an absolute path built at runtime (not a static specifier, so it is never typechecked as part
    // of this project) — it is not a dependency of this repository.
    interface PowerlineEntry { message?: { id?: string; usage?: unknown }; raw?: { sessionId?: unknown } }
    const powerlineModule = pathToFileURL(join(homedir(), "Projects/claude-powerline/src/utils/claude.ts")).href;
    const powerline = await import(powerlineModule) as { loadEntriesFromProjects(): Promise<PowerlineEntry[]> };
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      const entries = await powerline.loadEntriesFromProjects();
      const usageEntries = entries.filter(entry => entry.raw?.sessionId === sessionId && entry.message?.usage);
      // Two assistant turns (tool_use, then the final text) — each counted exactly once, no duplicate.
      expect(usageEntries).toHaveLength(2);
      expect(new Set(usageEntries.map(entry => entry.message!.id)).size).toBe(2);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  } finally { await loopback.close(); }
}, 30_000);

test("isolation: a SessionStart Hook configured for the config directory never fires for a persisted worker session", async () => {
  const cwd = tempDir("tm78-isolation-cwd-");
  const configDir = tempDir("tm78-isolation-config-");
  const marker = join(configDir, "session-start-fired");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ hooks: { SessionStart: [
    { hooks: [{ type: "command", command: `/usr/bin/touch ${JSON.stringify(marker)}` }] } ] } }));
  const loopback = await startLoopbackAnthropic(() => ({ blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" }));
  try {
    const environment = loopbackEnvironment(configDir, loopback.url);
    const task = { kind: "noting", text: "material", prompt: "instructions", tools: [], acknowledgeRequest: () => {} } as unknown as CcAgentTask;
    const result = await new CcAgentWorker(workerConfig(cwd), { environment }).run(task, 0);
    expect(result.outcome).toBe("success");
    // `settingSources: []` (unchanged isolation) means the worker's session never loads this
    // directory's settings.json at all, so the Hook it declares can never be dispatched — the init
    // message's own isolation check (asserted throughout cc-worker.test.ts) is what would fail first
    // if that ever changed. The marker's absence is the outward proof: nothing fired.
    expect(existsSync(marker)).toBe(false);
  } finally { await loopback.close(); }
}, 30_000);

test("path rule: a custom CLAUDE_CONFIG_DIR and worker cwds with dots, spaces and non-ASCII characters each give the path this code records", async () => {
  const configDir = tempDir("tm78-path-config-");
  for (const leaf of ["plain", "dot.dir", "spaced dir", "unicode-café-日本語", "under_score", "paren(1)"]) {
    const base = tempDir("tm78-path-cwd-");
    const cwd = join(base, leaf);
    mkdirSync(cwd, { recursive: true });
    const environment = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_API_KEY: "sk-ant-fake-probe-key" };
    const controller = new AbortController();
    const execution = query({ prompt: "hello", options: {
      model: "sonnet", cwd, pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE, env: environment,
      tools: [], allowedTools: [], settingSources: [], plugins: [], permissionMode: "dontAsk", strictMcpConfig: true,
      abortController: controller, extraArgs: { "disable-slash-commands": null, "no-chrome": null, restricted: null },
    } });
    let sessionId: string | undefined;
    try {
      for await (const message of execution) {
        if (message.type === "system" && message.subtype === "init") { sessionId = message.session_id; controller.abort(); break; }
      }
    } catch { /* aborting the transport mid-stream rejects the iterator; the init above already landed */ }
    expect(sessionId, `no init for cwd leaf ${leaf}`).toBeTruthy();
    const expected = ccNativeTranscriptPath(environment, cwd, sessionId!);
    // Give the CLI a moment to flush; it writes the file at session start, independent of any reply.
    for (let attempt = 0; attempt < 20 && !existsSync(expected); attempt++) await new Promise(r => setTimeout(r, 50));
    expect(existsSync(expected), `expected native session file at ${expected}`).toBe(true);
    const actual = readdirSync(dirname(expected));
    expect(actual).toEqual([`${sessionId}.jsonl`]);
  }
}, 60_000);
