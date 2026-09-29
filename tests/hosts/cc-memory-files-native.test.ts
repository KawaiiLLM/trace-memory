// 101: real, pinned Claude Code 2.1.280 with this plugin reads Trace Memory under /tm through its own
// Read, Grep and Glob — in the main thread and inside a general-purpose and an Explore subagent — with no
// permission prompt, while a real file still reaches the real Read and an Edit under /tm is refused.
// Behind the network fence (cc-native-fence.ts), against a loopback provider; run at the outer level
// like cc-compaction-native.test.ts, since the fence cannot nest.
import { afterAll, expect, test } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { TraceMemory } from "../../src/core/api/index.ts";
import { MEMORY_READ_ONLY } from "../../src/core/model/address.ts";
import { entry, fact, knowledge, session } from "../support/seed.ts";
import { assertPinnedClaudeVersion, createFencedClaudeExecutable, fenceToolsAvailable, preflightNetworkFence } from "./cc-native-fence.ts";

const executable = process.env.TM_NATIVE_CLAUDE_EXECUTABLE ?? "/opt/homebrew/bin/claude";
let fenced: string;
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Body = { messages?: { role: string; content: unknown }[]; tools?: { name: string }[] };
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
const OPT_OUTS = { DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1" };
const texts = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.map(block => block?.type === "text" ? String(block.text) : block?.type === "tool_result" ? texts(block.content) : "").join("\n") : "";
const opening = (body: Body) => texts(body.messages?.[0]?.content);
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
/** Every tool result a request carries, by tool_use id. */
function results(requests: Body[]): Map<string, { text: string; isError: boolean }> {
  const found = new Map<string, { text: string; isError: boolean }>();
  for (const body of requests) for (const message of body.messages ?? []) if (Array.isArray(message.content))
    for (const block of message.content as any[]) if (block?.type === "tool_result")
      found.set(block.tool_use_id, { text: texts(block.content), isError: block.is_error === true });
  return found;
}

test("the main thread and its general-purpose and Explore subagents read /tm with Claude Code's own tools, unprompted", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tm101-native-"))); dirs.push(root);
  for (const d of ["home", "config", "cwd", "state/bindings"]) mkdirSync(join(root, d), { recursive: true });
  const plugin = join(root, "plugin"), dbPath = join(root, "memory.sqlite"), stateDir = join(root, "state"), cwd = join(root, "cwd");
  cpSync(resolve("plugin"), plugin, { recursive: true });
  // Never the shipped configuration: it would name the default database.
  writeFileSync(join(plugin, "cc.config.json"), JSON.stringify({ dbPath, stateDir, baseline: "2025-01-01T00:00:00.000Z" }));
  writeFileSync(join(cwd, "notes.txt"), "a real file in the working directory\n");
  // Memory from an earlier session: its Raw, one fact and one global knowledge item.
  const memory = TraceMemory(dbPath, async () => { throw new Error("no model work"); });
  let seed: number;
  try {
    const project = memory.store.createProject({ name: "seed", declaredBy: "mark" }), s = session(memory.store, project.id, "pi:seed");
    seed = s.id;
    const turn = memory.store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00.000Z" });
    const source = entry(memory.store, s.id, turn.id, "seed-1", "user", "Use pnpm, never npm, for hashline.");
    memory.selectEntries(s.id, "main", [source.id]);
    memory.store.setCurrentPath(s.id, "main", turn.id, "seed");
    const path = { sessionId: s.id, branch: "main", headTurnId: turn.id };
    knowledge(memory.store, path, "global", "constraint", [fact(memory, path, "Package manager", [{ entry: source, text: "The user rules pnpm." }]).id],
      "Use pnpm, never npm.");
  } finally { memory.close(); }

  const S = `/tm/S${seed!}`;
  const subagent = (who: string) => [use(`${who}_read`, "Read", { file_path: "/tm/knowledge-all" }),
    use(`${who}_grep`, "Grep", { pattern: "hashline", path: S }), use(`${who}_inherit`, "Read", { file_path: `${S}/knowledge` })];
  const main = [use("main_read", "Read", { file_path: "/tm/K1" }), use("main_glob", "Glob", { pattern: "S*/T*/E*", path: "/tm" }),
    use("main_lines", "Grep", { pattern: "pnpm", path: "/tm/knowledge-all", output_mode: "content", "-i": true }),
    use("main_real", "Read", { file_path: join(cwd, "notes.txt") }), use("main_edit", "Edit", { file_path: "/tm/K1", old_string: "pnpm", new_string: "npm" }),
    use("main_gp", "Agent", { description: "memory read", subagent_type: "general-purpose", prompt: "GP-TASK: read Trace Memory under /tm.", run_in_background: false }),
    use("main_explore", "Agent", { description: "memory read", subagent_type: "Explore", prompt: "EXPLORE-TASK: read Trace Memory under /tm.", run_in_background: false })];
  const requests: Body[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
      if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 42 })); return; }
      const body = JSON.parse(raw) as Body;
      requests.push(body);
      const turns = (body.messages ?? []).filter(message => message.role === "assistant").length, first = opening(body);
      const script = first.includes("GP-TASK") ? subagent("gp") : first.includes("EXPLORE-TASK") ? subagent("explore")
        : first.includes("MAIN-PROMPT") ? main : [];
      const block = script[turns] ?? { type: "text" as const, text: first.includes("TASK") ? `${first.includes("GP") ? "GP" : "EXPLORE"}-FINAL-ANSWER` : "MAIN-DONE" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: `loopback-${requests.length}`, type: "message", role: "assistant",
        model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: block.type === "text"
        ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: block.type === "text" ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((listening, reject) => { server.once("error", reject); server.listen(Number(process.env.TM_NATIVE_PREPARED_PORT || 0), "127.0.0.1", listening); });
  if (!fenceToolsAvailable(executable)) throw new Error("native CC acceptance requires pinned CLI and sandbox-exec");
  const port = (server.address() as { port: number }).port;
  const fence = createFencedClaudeExecutable(join(root, "fence"), executable, [port], root);
  await preflightNetworkFence(fence.profilePath, [port], root);
  await assertPinnedClaudeVersion(fence.wrapperPath, root);
  fenced = fence.wrapperPath;
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, CLAUDE_CODE_TMPDIR: root, CLAUDE_CONFIG_DIR: join(root, "config"),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ANTHROPIC_API_KEY: "sk-ant-local-only",
    CLAUDE_CODE_MAX_RETRIES: "0", CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "1", ...OPT_OUTS };
  const prompts: { toolName: string; input: unknown }[] = [], logs: string[] = [];
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 240_000);
  let result: { subtype: string; permission_denials?: unknown[] } | undefined;
  try {
    for await (const message of query({ prompt: "MAIN-PROMPT: read Trace Memory under /tm, then ask two subagents.", options: {
      model: "sonnet", cwd, pathToClaudeCodeExecutable: fenced, env, settingSources: [], tools: ["Agent", "Read", "Grep", "Glob", "Edit"],
      plugins: [{ type: "local", path: plugin }], strictMcpConfig: true, permissionMode: "default", abortController: controller,
      canUseTool: async (toolName, input) => { prompts.push({ toolName, input }); return { behavior: "allow", updatedInput: input }; },
      stderr: data => logs.push(data), extraArgs: { "session-id": randomUUID(), "no-chrome": null } } })) {
      if (message.type === "result") { result = message as typeof result; break; }
    }
  } finally { clearTimeout(timer); await new Promise(close => server.close(close)); }
  expect(result?.subtype, logs.join("")).toBe("success");

  const seen = results(requests);
  // Main thread: an exact knowledge read, a glob, content lines, and a real file through the real Read.
  expect(seen.get("main_read")?.text).toContain("Use pnpm, never npm.");
  expect(seen.get("main_glob")?.text).toContain(`S${seed!}/T`);
  expect(seen.get("main_lines")?.text).toMatch(/\/tm\/K1@v1:1:.*Use pnpm, never npm\./);
  expect(seen.get("main_real")?.text).toContain("a real file in the working directory");
  expect(seen.get("main_edit")).toMatchObject({ isError: true, text: expect.stringContaining(MEMORY_READ_ONLY) });
  // Each subagent: the all-scope listing, a search reaching Raw, and the inheritance view.
  for (const who of ["gp", "explore"]) {
    expect(seen.get(`${who}_read`)?.text, who).toMatch(/\/tm\/K1@v1\s+\[constraint\/global\] Use pnpm, never npm\./);
    expect(seen.get(`${who}_grep`)?.text, who).toContain(`${S}/T`);
    expect(seen.get(`${who}_grep`)?.text, who).toMatch(/\/E1\b/);
    expect(seen.get(`${who}_inherit`)?.text, who).toContain(`Session S${seed!}: a subagent inherits this session's knowledge by reading ${S}/knowledge.`);
  }
  // The main thread received only each subagent's answer, never the files it read.
  const mainRequests = requests.filter(body => opening(body).includes("MAIN-PROMPT"));
  expect(seen.get("main_gp")?.text).toContain("GP-FINAL-ANSWER");
  expect(seen.get("main_explore")?.text).toContain("EXPLORE-FINAL-ANSWER");
  expect(mainRequests.some(body => JSON.stringify(body.messages).includes(`${S}/knowledge.`))).toBe(false);
  // No permission prompt for any /tm call; the real Read inside cwd needs none either.
  expect(prompts.filter(prompt => JSON.stringify(prompt.input).includes("/tm"))).toEqual([]);
  expect(result?.permission_denials ?? []).toEqual([]);
}, 300_000);
