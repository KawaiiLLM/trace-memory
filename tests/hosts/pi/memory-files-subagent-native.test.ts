// 101: a `pi-subagents` child session carries the extension's /tm `read` and `grep` (children inherit
// the parent's package extensions) and reads Trace Memory with them. Pi's own AgentSession, the real
// pi-subagents package and this package, a scripted provider and an isolated agent directory; run at the
// outer level with the native tests, since it needs the pi-subagents checkout.
import { afterAll, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { entry, fact, knowledge, session } from "../../support/seed.ts";
import { call, say, type Body } from "./native-fixture.ts";

const SUBAGENTS = process.env.PI_SUBAGENTS_PACKAGE ?? "/Users/zhaoqixuan/Projects/pi-packages/packages/pi-subagents";
const dirs: string[] = [];
afterAll(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const textOf = (content: unknown): string => typeof content === "string" ? content : (content as Body[] ?? []).map(part => part.text ?? "").join("\n");

test("a pi-subagents child reads /tm through the extension's read and grep; the parent gets its answer only", async () => {
  // Acceptance evidence, not a portable skip: without the package the inheritance is unverified.
  if (!existsSync(join(SUBAGENTS, "package.json"))) throw new Error(`pi-subagents is required at ${SUBAGENTS} (PI_SUBAGENTS_PACKAGE)`);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tm101-pi-subagent-"))); dirs.push(dir);
  const agentDir = join(dir, "agent"), cwd = join(dir, "cwd"), dbPath = join(dir, "trace.db");
  mkdirSync(agentDir, { recursive: true }); mkdirSync(cwd);
  // Never the user's ~/.pi/agent: Pi and pi-subagents resolve everything from this directory.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, packages: [SUBAGENTS, resolve(".")] }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { name: "Fake", baseUrl: "https://fake-tm101.invalid/v1", apiKey: "fake-key",
    api: "openai-completions", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
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

  const S = `/tm/S${seed!}`, sent: { kind: string; body: Body }[] = [];
  const child = [call("child_read", "read", { path: `${S}/knowledge` }), call("child_grep", "grep", { pattern: "hashline", path: S }), say("CHILD-FINAL-ANSWER")];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    const first = textOf((body.messages ?? []).find((m: Body) => m.role === "user")?.content);
    const kind = first.includes("CHILD-TASK") ? "child" : first.includes("PARENT-PROMPT") ? "parent" : "other";
    sent.push({ kind, body });
    const turns = (body.messages ?? []).filter((m: Body) => m.role === "assistant").length;
    if (kind === "child") return child[turns] ?? say("CHILD-FINAL-ANSWER");
    if (kind === "parent") return turns === 0 ? call("parent_spawn", "subagent", { prompt: `CHILD-TASK: read ${S}/knowledge and search ${S}.`,
      description: "read memory", subagent_type: "general-purpose" }) : say("PARENT-DONE");
    return say("OTHER");
  });
  const environment = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, TRACE_MEMORY_CONFIG: process.env.TRACE_MEMORY_CONFIG };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TRACE_MEMORY_CONFIG = JSON.stringify({ dbPath });
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const { session: parent, extensionsResult } = await createAgentSession({ cwd, agentDir, model: modelRuntime.getModel("fake", "test")!, modelRuntime,
      settingsManager, resourceLoader, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions", "parent")), tools: ["read", "grep", "subagent"] });
    expect(extensionsResult.errors).toEqual([]);
    await parent.bindExtensions({});
    try { await parent.prompt("PARENT-PROMPT: ask a subagent to read Trace Memory."); } finally { parent.dispose(); }
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }

  const results = (kind: string) => new Map<string, string>(sent.filter(request => request.kind === kind).flatMap(request => (request.body.messages ?? [])
    .filter((m: Body) => m.role === "tool").map((m: Body): [string, string] => [m.tool_call_id as string, textOf(m.content)])));
  const inChild = results("child");
  expect(inChild.get("child_read")).toContain(`Session S${seed!}: a subagent inherits this session's knowledge by reading ${S}/knowledge.`);
  expect(inChild.get("child_read")).toContain("Use pnpm, never npm.");
  expect(inChild.get("child_grep")?.split("\n")).toEqual([expect.stringMatching(new RegExp(`^${S}/T\\d+$`)), expect.stringMatching(new RegExp(`^${S}/T\\d+/E1$`))]);
  const answer = results("parent").get("parent_spawn");
  expect(answer).toContain("CHILD-FINAL-ANSWER");
  expect(answer).not.toContain("Use pnpm, never npm.");
}, 120_000);
