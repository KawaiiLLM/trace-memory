// 102: Claude Code's manual and automatic compactions install Trace Memory's compaction. Real, pinned
// Claude Code 2.1.280 with this plugin, behind the network fence (cc-native-fence.ts), against a
// loopback provider that records every request; no request leaves the machine. Run at the outer
// level, like cc-92-native.test.ts: the fence cannot nest.
import { afterAll, beforeAll, expect, test } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../../src/core/store/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { ccNativeTranscriptPath } from "../../src/hosts/cc/worker.ts";
import { CC_INJECTION_BEGIN, CC_INJECTION_HEADER, databaseIdentity, decodeCcInjection } from "../../src/hosts/cc/injection.ts";
import { entry, knowledge, legacyFacts, session } from "../support/seed.ts";
import { createFencedClaudeExecutable, fenceToolsAvailable, preflightNetworkFence } from "./cc-native-fence.ts";

const executable = "/opt/homebrew/bin/claude";
let fenced: string;
const dirs: string[] = [];
beforeAll(async () => {
  // Acceptance evidence, not a portable skip: missing prerequisites are unverified.
  if (!fenceToolsAvailable(executable)) throw new Error("native CC acceptance requires pinned CLI and sandbox-exec");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tm102-fence-"))); dirs.push(dir);
  const fence = createFencedClaudeExecutable(dir, executable);
  await preflightNetworkFence(fence.profilePath); // abort before any CLI invocation if either control fails
  fenced = fence.wrapperPath;
});
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Body = { system?: unknown; messages?: { role: string; content: unknown }[] };
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
interface Scenario {
  prompts: string[];
  /** The provider's reply to one request, given what came before; `usage` is the input size it reports. */
  reply(body: Body, index: number): { status?: number; blocks?: Block[]; usage?: number };
  tools?: string[];
  autocompact?: string;
  /** Test-only fault: the copied plugin's bundle fails the compaction build. */
  failBuild?: boolean;
  settings?: Record<string, unknown>;
  resume?: boolean;
}
const OPT_OUTS = { DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
const texts = (content: unknown): string[] => typeof content === "string" ? [content]
  : Array.isArray(content) ? content.flatMap(block => block?.type === "text" ? [String(block.text)] : []) : [];
const lastUserText = (body: Body) => texts([...body.messages ?? []].reverse().find(message => message.role === "user")?.content).join("\n");
/** Claude Code's own summarisation request. */
const summarises = (body: Body) => JSON.stringify(body.messages).includes("CRITICAL: Respond with TEXT ONLY");
/** A Trace Memory block that opens the conversation; Claude Code ends each merged text with a newline. */
const blockOf = (body: Body) => texts(body.messages?.[0]?.content).find(isCarrier)?.replace(/\n$/, "");
const carriers = (body: Body) => JSON.stringify(body.messages).split(CC_INJECTION_HEADER).length - 1;
const isCarrier = (text: string) => text.startsWith(`${CC_INJECTION_BEGIN}\n${CC_INJECTION_HEADER}`);
/** The prompt a request answers: the last text of its last user message that is neither a reminder
 * nor a Trace Memory carrier; empty when a compaction is what it answers. */
const promptOf = (body: Body) => texts([...body.messages ?? []].reverse().find(message => message.role === "user")?.content)
  .filter(text => !text.startsWith("<") && !isCarrier(text)).at(-1) ?? "";
const ack = (body: Body) => ({ blocks: [{ type: "text" as const, text: `ACK ${promptOf(body) || "compaction"}` }] });

async function run(scenario: Scenario) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tm102-native-"))); dirs.push(root);
  // As on any machine that ran a session before, the bindings directory exists, so the executor
  // inside Claude Code watches it and imports as the conversation goes.
  for (const d of ["home", "config", "cwd", "state/bindings"]) mkdirSync(join(root, d), { recursive: true });
  const plugin = join(root, "plugin"), dbPath = join(root, "memory.sqlite"), stateDir = join(root, "state");
  cpSync(resolve("plugin"), plugin, { recursive: true });
  // Never the shipped configuration: it would name the default database.
  writeFileSync(join(plugin, "cc.config.json"), JSON.stringify({ dbPath, stateDir, baseline: "2025-01-01T00:00:00.000Z", ...scenario.settings }));
  if (scenario.failBuild) {
    cpSync(join(plugin, "dist", "cc.cjs"), join(plugin, "dist", "bundle.cjs"));
    writeFileSync(join(plugin, "dist", "cc.cjs"), `if (process.argv[2] === "hook-compact") { console.error("forced build failure"); process.exit(1); }\nrequire("./bundle.cjs");\n`);
  }
  // Global knowledge from another session, so every compaction and injection carries it.
  const store = new Store(dbPath);
  let rule: number;
  try {
    const project = store.createProject({ name: "seed", declaredBy: "mark" });
    const seed = session(store, project.id, "fixture");
    const turn = store.appendTurn({ sessionId: seed.id, kind: "turn", userPrompt: "rule", startedAt: "2026-01-01T00:00:00.000Z" });
    const source = entry(store, seed.id, turn.id, "rule", "user", "rule");
    const fact = legacyFacts(store, { kind: "manual", sessionId: seed.id, createdAt: "now" }, [{ sources: [{ entry: source,
      address: `T${turn.id}#E${source.entryOrdinal}` }], text: "rule", category: "decision", actor: "user", createdAt: "now" }]).facts[0]!;
    rule = knowledge(store, { sessionId: seed.id, headTurnId: turn.id }, "global", "constraint", [fact.id], "Use pnpm, never npm.",
      { run: { kind: "manual", createdAt: "now" } }).commit;
  } finally { store.close(); }

  const requests: Body[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
      if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 42 })); return; }
      const body = JSON.parse(raw) as Body;
      requests.push(body);
      const reply = summarises(body) ? { blocks: [{ type: "text" as const, text: "<summary>NATIVE-SUMMARY</summary>" }] } : scenario.reply(body, requests.length - 1);
      if (reply.status) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: `loopback-${requests.length}`, type: "message", role: "assistant",
        model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: reply.usage ?? 1000, output_tokens: 0 } } });
      reply.blocks!.forEach((block, index) => {
        send("content_block_start", { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
        send("content_block_delta", { type: "content_block_delta", index, delta: block.type === "text"
          ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        send("content_block_stop", { type: "content_block_stop", index });
      });
      send("message_delta", { type: "message_delta", delta: { stop_reason: reply.blocks!.at(-1)!.type === "tool_use" ? "tool_use" : "end_turn",
        stop_sequence: null }, usage: { output_tokens: 5 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as { port: number };
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, CLAUDE_CONFIG_DIR: join(root, "config"),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "sk-ant-local-only", CLAUDE_CODE_MAX_RETRIES: "0",
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1", ...OPT_OUTS };
  const sid = randomUUID(), cwd = join(root, "cwd"), pending = [...scenario.prompts], transcriptPath = ccNativeTranscriptPath(env, cwd, sid);
  // Likewise Claude Code's project directory for this cwd: the executor watches the transcript in it.
  mkdirSync(dirname(transcriptPath), { recursive: true });
  let results = 0, sent = 0;
  async function* prompts() {
    while (pending.length) {
      sent++;
      yield { type: "user" as const, message: { role: "user" as const, content: pending.shift()! }, parent_tool_use_id: null, session_id: sid };
      while (results < sent) await new Promise(wake => setTimeout(wake, 50));
    }
  }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 150_000);
  const logs: string[] = [];
  let resumed: Body[] = [];
  try {
    for await (const message of query({ prompt: prompts(), options: { model: "sonnet", cwd, pathToClaudeCodeExecutable: fenced, env,
      settingSources: [], tools: scenario.tools ?? [], plugins: [{ type: "local", path: plugin }], permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true, abortController: controller, stderr: data => logs.push(data),
      extraArgs: { "session-id": sid, "no-chrome": null, "debug-file": join(root, "debug.log"), ...(scenario.autocompact ? { autocompact: scenario.autocompact } : {}) } } })) {
      if (message.type === "result" && ++results === scenario.prompts.length) break;
    }
    if (scenario.resume) {
      const before = requests.length;
      await new Promise<void>((resolveResume, reject) => execFile(fenced, ["-p", "--resume", sid, "--model", "sonnet", "--output-format", "json",
        "--plugin-dir", plugin, "RESUME prompt"], { cwd, env, timeout: 60_000 }, error => error ? reject(error) : resolveResume()));
      resumed = requests.slice(before);
    }
  } finally { clearTimeout(timer); await new Promise(close => server.close(close)); }
  const debug = existsSync(join(root, "debug.log")) ? readFileSync(join(root, "debug.log"), "utf8") : "";
  expect(results, logs.join("")).toBe(scenario.prompts.length);

  // The executor inside Claude Code imports as it goes; an importer here finishes what it left.
  const config = resolveCcHostConfig({ dbPath, stateDir, baseline: "2025-01-01T00:00:00.000Z" });
  const importer = new CcImporter(config, readBinding(config, sid)!);
  try { const imported = await importer.reconcile(); expect(imported.state, imported.problems.join("; ")).toBe("ready"); }
  finally { importer.close(); }
  const binding = readBinding(config, sid)!;
  const visible = { db: databaseIdentity(dbPath), nativeSession: sid, coreSession: binding.coreSessionId };
  const transcript = readFileSync(transcriptPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { requests, resumed, rule: rule!, dbPath, binding, visible, transcript, debug,
    header: (body: Body) => decodeCcInjection(blockOf(body)!, visible)! };
}

/** The compaction's Turn and its recorded delivery, and no Raw entry carrying a Trace Memory block. */
function stored(result: Awaited<ReturnType<typeof run>>) {
  const store = new Store(result.dbPath);
  try {
    const core = result.binding.coreSessionId!;
    const turns = store.listTurns(core).filter(turn => turn.kind === "compaction");
    const raw = store.db.prepare(`SELECT r.content FROM source_entries e JOIN source_entry_raw r ON r.entry_id = e.id WHERE e.session_id = ?`)
      .all(core).map(row => String(row.content));
    return { turns, carriersInRaw: raw.filter(content => content.includes(CC_INJECTION_HEADER)).length,
      delivered: turns.map(turn => store.deliveredKnowledge({ owner: `cc:${result.binding.nativeSessionId}`, sessionId: core,
        branch: result.binding.branch, headTurnId: turn.id })) };
  } finally { store.close(); }
}

/** One installed compaction: its request, the block's decoded header and its Raw lines, oldest first. */
function installed(result: Awaited<ReturnType<typeof run>>) {
  expect(result.requests.filter(summarises)).toEqual([]); // no summarisation request
  const at = result.requests.findIndex(body => blockOf(body) !== undefined);
  expect(at).toBeGreaterThan(0);
  const block = blockOf(result.requests[at]!)!, header = result.header(result.requests[at]!);
  expect(header.commits).toEqual([result.rule]);
  // After it, the hooks add no knowledge on top: the block is the only carrier in every request.
  for (const body of result.requests.slice(at)) expect(carriers(body)).toBe(1);
  const persisted = stored(result);
  expect(persisted.carriersInRaw).toBe(0); // the block is never imported as Raw
  expect(persisted.turns).toHaveLength(1);
  // The compaction node's delivered state is exactly what the block emitted (97's records).
  expect(persisted.delivered[0]).toEqual({ knowledgeCommitIds: new Set(header.commits),
    knowledgeStates: new Set(header.states.map(state => `${state.fromCommit}>${state.toCommits.join(",")}`)), knowledgeTokens: header.knowledgeTokens });
  return { at, block, header, raw: block.split("\n").filter(line => /^\[T\d+#E\d+@/.test(line)) };
}

const T = ["T1 first turn", "T2 second turn", "T3 third turn"];

test("manual /compact installs the block in place of Claude Code's summary; --resume restores it", async () => {
  // The last reply has two blocks, which Claude Code writes as two rows of one message.
  const result = await run({ prompts: [...T, "/compact", "AFTER prompt"], resume: true, reply: body => promptOf(body).startsWith("T3")
    ? { blocks: [{ type: "text", text: "ACK T3 first part" }, { type: "text", text: "ACK T3 second part" }] } : ack(body) });
  const { at, block, raw } = installed(result);
  expect(lastUserText(result.requests[at]!)).toContain("AFTER prompt");
  expect(raw.at(-1)).toContain("ACK T3 second part"); // the newest Raw is the last reply before /compact
  expect(result.resumed.length).toBeGreaterThan(0);
  expect(blockOf(result.resumed[0]!)).toBe(block);
  expect(carriers(result.resumed[0]!)).toBe(1);
}, 180_000);

test("a threshold compaction at a prompt ends its block with that prompt", async () => {
  const result = await run({ prompts: [T[0]!, "T3 BIG", "AUTO-TRIGGER prompt", "AFTER prompt"], autocompact: "100k",
    reply: body => ({ ...ack(body), usage: promptOf(body).includes("BIG") ? 110_000 : 1000 }) });
  const { at, raw } = installed(result);
  expect(lastUserText(result.requests[at]!)).not.toContain("AFTER prompt"); // the interrupted turn continues on the block
  expect(raw.at(-1)).toMatch(/@user\] user: AUTO-TRIGGER prompt/);
}, 180_000);

test("a threshold compaction in the middle of a turn ends its block with the tool call and its result", async () => {
  let called = false;
  const result = await run({ prompts: [T[0]!, "MID-TURN prompt", "AFTER prompt"], autocompact: "100k", tools: ["Glob"],
    reply: body => {
      if (!lastUserText(body).includes("MID-TURN") || called) return ack(body);
      called = true;
      return { blocks: [{ type: "tool_use", id: "toolu_glob_1", name: "Glob", input: { pattern: "*.nothing" } }], usage: 110_000 };
    } });
  const { raw } = installed(result);
  expect(raw.slice(-2).map(line => line.replace(/^\[T\d+#E\d+@(\w+)\].*$/, "$1"))).toEqual(["assistant", "observation"]);
  expect(raw.at(-2)).toContain("Glob(");
  expect(raw.at(-3)).toMatch(/@user\] user: MID-TURN prompt/);
}, 180_000);

test("a prompt that is too long compacts with the block and retries on it", async () => {
  let refused = false;
  const result = await run({ prompts: [...T, "PTL-TRIGGER prompt", "AFTER prompt"],
    reply: body => lastUserText(body).includes("PTL-TRIGGER") && !refused ? (refused = true, { status: 400 }) : ack(body) });
  const { raw } = installed(result);
  expect(refused).toBe(true);
  expect(raw.at(-1)).toMatch(/@user\] user: PTL-TRIGGER prompt/);
}, 180_000);

test("a compaction that omits pending Raw warns in the foreground, never the model", async () => {
  const long = Array.from({ length: 6 }, (_, i) => `LONG turn ${i + 1}`);
  const result = await run({ prompts: [...long, "/compact", "AFTER prompt"], settings: { "compaction.sharedAllowanceTokens": 1 },
    reply: body => promptOf(body).startsWith("LONG") ? { blocks: [{ type: "text", text: `${promptOf(body)}: ${"many words ".repeat(3_000)}` }] } : ack(body) });
  const { block, raw } = installed(result);
  expect(raw.at(-1)).toContain("LONG turn 6"); // the newest Raw is kept; the oldest is omitted
  const warning = /Trace Memory: compaction omitted (\d+) pending Raw entr(y|ies); omitted Raw remains pending for Noting\./.exec(result.debug);
  expect(warning, "the engine's transcript notice").not.toBeNull();
  expect(JSON.stringify(result.requests)).not.toContain("compaction omitted");
  expect(block).toContain("omitted");
}, 180_000);

test("a build that fails keeps native compaction and today's knowledge supplement", async () => {
  const result = await run({ prompts: [...T, "/compact", "AFTER prompt"], reply: ack, failBuild: true });
  const summary = result.requests.findIndex(summarises);
  expect(summary).toBeGreaterThan(0);
  const after = result.requests.slice(summary + 1);
  expect(after.length).toBeGreaterThan(0);
  expect(JSON.stringify(after[0]!.messages)).toContain("NATIVE-SUMMARY");
  // The supplement: the knowledge the native summary lacks, once, after the summary and the reply it kept.
  const supplement = (after[0]!.messages ?? []).filter(message => message.role === "user").flatMap(message => texts(message.content)).find(isCarrier)!;
  expect(decodeCcInjection(supplement.replace(/\n$/, ""), result.visible)!.commits).toEqual([result.rule]);
  for (const body of after) expect(carriers(body)).toBe(1);
}, 180_000);

test("a subagent's own compaction passes through to Claude Code unchanged", async () => {
  const result = await run({ prompts: ["MAIN-SUB run the scripted subagent", "AFTER prompt"], autocompact: "100k", tools: ["Agent", "Glob"],
    reply: body => {
      const all = JSON.stringify(body.messages);
      // The subagent's own conversation opens with its task.
      if (texts(body.messages?.[0]?.content).some(text => text.includes("SUB-TASK"))) {
        const turns = (body.messages ?? []).filter(message => message.role === "assistant").length;
        return !all.includes("NATIVE-SUMMARY") && turns < 3
          ? { blocks: [{ type: "tool_use", id: `toolu_sub_${turns}`, name: "Glob", input: { pattern: "*.nothing" } }], usage: turns === 2 ? 110_000 : 1000 }
          : { blocks: [{ type: "text", text: "SUB-DONE" }] };
      }
      if (lastUserText(body).includes("MAIN-SUB") && !all.includes('"name":"Agent"'))
        return { blocks: [{ type: "tool_use", id: "toolu_agent_1", name: "Agent", input: { description: "scripted subagent",
          subagent_type: "general-purpose", prompt: "SUB-TASK: glob three times, then answer.", run_in_background: false } }] };
      return ack(body);
    } });
  const subSummaries = result.requests.filter(body => summarises(body) && texts(body.messages?.[0]?.content).some(text => text.includes("SUB-TASK")));
  expect(subSummaries).toHaveLength(1); // the subagent's compaction was Claude Code's own
  expect(result.requests.some(body => blockOf(body) !== undefined)).toBe(false);
  expect(result.transcript.some(record => record.subtype === "compact_boundary")).toBe(false); // the main transcript is untouched
}, 180_000);
