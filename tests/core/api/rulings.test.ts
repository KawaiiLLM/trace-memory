import { readHandle } from "../../read-handle-fixture.ts";
import { suppliedHandles } from "../../dreaming-skips.ts";
import { knowledgeStatusNotes } from "../../../src/core/api/read.ts";
import { compacted, recorded } from "../../source-fixture.ts";
// Ruling test points: each test pins a user ruling that an implementation could silently deviate
// from. Names identify the ruling and its conversation date.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, REMOVED_SETTINGS, sourceSeededMemory, visibleTarget, canonicalFlatConfig, renderEntry, runMode, toolDefinitions, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import * as api from "../../source-fixture.ts";
import { tokens, hydrate } from "../../source-fixture.ts";
import { countPathSnapshots } from "../../perf/fixture.ts";
import { dreamingToolDefinitions } from "../../../src/core/api/tools.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { setKnowledgeCapacity, setKnowledgeInjection } from "../../knowledge-budget-fixture.ts";
import { visibleView } from "../../../src/hosts/pi/visible.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { CcTaskScheduler } from "../../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../../src/hosts/cc/binding.ts";
import { CcCoordinator, recordCcSessionEnd } from "../../../src/hosts/cc/lifecycle.ts";
import { handleCcHook } from "../../../src/hosts/cc/index.ts";
import * as ccNative from "../../../src/hosts/cc/native-session.ts";
import { CcImporter } from "../../../src/hosts/cc/importer.ts";
import { Store } from "../../../src/core/store/index.ts";
import { entry as seedEntry, fact as seedFact, facts as seedFacts, knowledge as seedKnowledge, legacyArchive, legacyFacts, session as seedSession } from "../../support/seed.ts";
import { ccCompaction, ccDeltaInjection, databaseIdentity, decodeCcInjection } from "../../../src/hosts/cc/injection.ts";
import { sliceCcInjection } from "../../../src/hosts/cc/slices.ts";
import { KNOWLEDGE_RECENCY_NOTICE, MEMORY_FILES_NOTICE } from "../../../src/core/render/index.ts";
import { CC_AUTO_CONTINUE_SUFFIX, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, ccStripAutoContinue } from "../../../src/hosts/cc/transcript.ts";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { DirectoryOptions } from "../../../src/core/project/directory.ts";

// 62 excludes temporary directories, where every fixture lives. As in directory-projects.test.ts, the
// hosts' `directoryAllocation` receives the exclusions a test sets; unset, it keeps the defaults.
const directoryExclusions = vi.hoisted(() => ({ excluded: undefined as DirectoryOptions["excluded"] }));
vi.mock("../../../src/core/project/directory.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/core/project/directory.ts")>();
  return { ...actual, directoryAllocation: (...args: Parameters<typeof actual.directoryAllocation>) =>
    actual.directoryAllocation(args[0], args[1], args[2], args[3] ?? { excluded: directoryExclusions.excluded }) };
});

let directory: string;
let memory: ReturnType<typeof sourceSeededMemory>;
let calls: NotingAgentInput[];
let admittedScenarios: AdmittedDreamerScenarios;
const time = "2026-09-06T00:00:00Z";
const ok = (output: unknown): RunAgentResult => ({ outcome: "success", output: JSON.stringify(output), request: { fake: true } });
const tagged = (knowledgeId: number, commitId: number) => `K${knowledgeId}#${memory.store.versionTag(knowledgeId, commitId)}`;
const history = (knowledgeId: number, commitId: number) => `K${knowledgeId}@v${memory.store.versionOrdinal(knowledgeId, commitId)}`;
/** Public receipts name per-identity history; database assertions resolve it explicitly. */
const commitOf = (item: { knowledgeId: number; version: string }): number => {
  const match = /^K([1-9][0-9]*)@v([1-9][0-9]*)$/.exec(item.version);
  expect(Number(match?.[1])).toBe(item.knowledgeId);
  return memory.store.resolveVersionOrdinal(item.knowledgeId, Number(match![2]));
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-rulings-"));
  calls = [];
  // 26a/92: a successful Noter script explicitly submits both empty layers.
  const fallback = async (raw: unknown) => { const input = raw as NotingAgentInput; calls.push(input);
    if (input.kind === "noting") {
      input.tools.find(t => t.name === "note")!.execute({ facts: [] });
      input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] });
    }
    return ok([]); };
  admittedScenarios = new AdmittedDreamerScenarios(fallback);
  memory = sourceSeededMemory(join(directory, "test.sqlite"), admittedScenarios.agent);
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

/** 73 "Shared allowance": knowledge fills its own base, Raw fills its own base plus what knowledge
 * left of the allowance, facts fills its own base plus what Raw left. A test that wants a tight
 * compaction budget shrinks all three bases and the allowance; `allowance` defaults to 0, since every
 * explicit caller here wants a scenario that omits or truncates something. */
const compactionWindows = (knowledge: number, facts: number, raw: number, allowance = 0) => {
  setKnowledgeInjection(memory, Math.max(0, knowledge));
  memory.config.compaction.factsTokens = facts;
  memory.config.compaction.rawTokens = raw;
  memory.config.compaction.sharedAllowanceTokens = allowance;
};
const defaultWindows = () => compactionWindows(memory.knowledgeBudgets().injection,
  DEFAULT_CONFIG.compaction.factsTokens, DEFAULT_CONFIG.compaction.rawTokens, DEFAULT_CONFIG.compaction.sharedAllowanceTokens);
/** The per-window accounting of one custom replacement (28a item 6). */
const charged = (result: ReturnType<typeof memory.compact>) => {
  if ("native" in result) throw new Error(`expected a custom replacement, got: ${result.reason}`);
  return result.charged!;
};

function completeToolRead(trace: { execute(input: Record<string, unknown>): string }, address: string) {
  let page = trace.execute({ address, itemBudget: null, pageBudget: 8_000 });
  const pages = [page];
  while (true) {
    const cursor = /cursor=(\S+)/.exec(page)?.[1];
    if (!cursor) return pages.join("\n");
    page = trace.execute({ address: `cursor=${cursor}` });
    if (page.includes("rejected:")) throw new Error(page);
    pages.push(page);
  }
}

function session() {
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "pi:fixture", startedAt: time, firstReplyAt: time, projectId: project.id });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "用 pnpm，不要 npm", assistantText: "好的。", startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: JSON.stringify({ command: "pnpm install" }), result: JSON.stringify({ stdout: "done", stderr: "" }), status: "success" });
  return { s, t };
}

test("2026-09-24, 86: 'catchup 选A' and '任务失败后不检查' — retry the failed phase before checking other phases", async () => {
  let attempts = 0;
  const retryMemory = sourceSeededMemory(":memory:", async raw => {
    const task = raw as NotingAgentInput;
    attempts++;
    expect(task.kind).toBe("noting");
    if (attempts === 1) return { outcome: "failure", request: { fake: true }, output: "first attempt failed" };
    expect(checks.mock.calls.map(([phase]) => phase)).toEqual(["dreaming"]);
    expect(retryMemory.store.taskFailures(target.sessionId).some(row => row.count === 1)).toBe(true);
    task.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    task.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    return ok([]);
  });
  const project = retryMemory.store.createProject({ name: "retry", declaredBy: "mark" });
  const session = retryMemory.store.createSession({ host: "cc:retry", projectId: project.id,
    enrollmentChoice: true, startedAt: time, firstReplyAt: time });
  const turn = retryMemory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "one pending entry", startedAt: time });
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const ids = retryMemory.store.pendingEntryIds(session.id, "main", turn.id);
  const checks = vi.spyOn(retryMemory, "taskEligibility");
  const worker = resolveCcHostConfig({ dbPath: join(directory, "unused.sqlite"), stateDir: directory,
    notingModel: "synthetic", notingThinking: "medium",
    "dreaming.model": "synthetic", "dreaming.thinking": "medium",
    worker: { cwd: directory, claudeExecutable: "/missing/claude", contextWindows: { synthetic: 200_000 } } }).worker;
  const scheduler = new CcTaskScheduler(retryMemory, worker, () => {});
  try {
    scheduler.startCatchup({ state: "ready", coreSessionId: session.id, branch: "main", headTurnId: turn.id,
      selectedEntryIds: ids, selectedCount: ids.length, selectedTailId: ids.at(-1)!,
      selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [], snapshot: {} as any });
    await vi.waitFor(() => expect(scheduler.catchupStatus().state).toBe("completed"));
    expect(attempts).toBe(2);
    expect(checks.mock.calls.length).toBeGreaterThan(2);
    expect(retryMemory.store.enabled(session.id)).toBe(true);
  } finally { scheduler.stop(); await scheduler.settle(); checks.mockRestore(); retryMemory.close(); }
});

test("2026-09-28, 102: 'A /clear 像退出一样正常关闭旧会话，执行器跟到本进程的新会话，和启动时一样。现在用cwd做自动归属，所以新会话应该是同一个project' — supersedes 86's '除了 clear，任何 SessionEnd 都算正常关闭'", async () => {
  // Control sockets live under stateDir: keep it short enough for a Unix-domain path.
  const stateDir = mkdtempSync("/tmp/tm102r-"), cwd = join(directory, "repository");
  mkdirSync(cwd);
  directoryExclusions.excluded = { home: join(directory, "home"), temporary: [] }; // the fixture's cwd counts as a directory
  const config = resolveCcHostConfig({ dbPath: join(directory, "cc.sqlite"), stateDir, baseline: "2025-01-01T00:00:00.000Z",
    pollIntervalMs: 10, finalSyncTimeoutMs: 300, finalSyncStablePolls: 2 });
  const exchange = (path: string) => writeFileSync(path, [
    { uuid: "u", parentUuid: null, type: "user", timestamp: time, promptId: "p", promptSource: "sdk", userType: "external", message: { role: "user", content: "rule" } },
    { uuid: "a", parentUuid: "u", type: "assistant", timestamp: time, message: { role: "assistant", content: [{ type: "text", text: "recorded" }] } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const start = (session_id: string, source: "startup" | "clear") =>
    handleCcHook(config, { hook_event_name: "SessionStart", session_id, transcript_path: join(directory, `${session_id}.jsonl`), source, cwd });
  // The OS process probe uses `ps`, which the network Seatbelt denies. Only its identity outlet is
  // controlled: one Claude Code process runs both sessions; binding, executor and Store stay real.
  const identity = vi.spyOn(ccNative, "currentNativeProcess").mockReturnValue({ pid: process.pid, startedAt: "fixture-start" });
  exchange(join(directory, "before-clear.jsonl"));
  await start("before-clear", "startup");
  const coordinator = new CcCoordinator(config, "before-clear", () => {});
  const store = new Store(config.dbPath);
  try {
    await coordinator.start();
    const before = readBinding(config, "before-clear")!;
    expect(before.executor?.pid).toBe(process.pid);
    // /clear: Claude Code ends the session, then starts a new one in the same process and directory.
    expect(await recordCcSessionEnd(config, { hook_event_name: "SessionEnd", session_id: "before-clear",
      transcript_path: join(directory, "before-clear.jsonl"), reason: "clear" })).toMatchObject({ confirmed: true, reason: "SessionEnd clear" });
    expect(store.getSession(before.coreSessionId!)!.closedAt).not.toBeNull();
    await start("after-clear", "clear");
    expect(await coordinator.retargetTo("after-clear")).toBe(true);
    exchange(join(directory, "after-clear.jsonl"));
    await vi.waitFor(() => expect(readBinding(config, "after-clear")!.coreSessionId).not.toBeNull(), { timeout: 5_000 });
    const after = readBinding(config, "after-clear")!;
    expect(after.executor?.pid).toBe(process.pid);
    expect(readBinding(config, "before-clear")!.executor).toBeNull();
    expect(after.coreSessionId).not.toBe(before.coreSessionId);
    expect(after.clearedFrom).toBeUndefined();
    expect(store.getSession(after.coreSessionId!)!.projectId).toBe(before.projectId);
  } finally {
    await coordinator.shutdown("test"); store.close(); identity.mockRestore();
    directoryExclusions.excluded = undefined; rmSync(stateDir, { recursive: true, force: true });
  }
});

test("2026-09-28, 102: '需要保留当前这一轮的情况', '会话钩子只用来补投递' and, on Pi's framing, '可以' — the block, framed as Pi frames a compaction summary, ends with the trigger, and the hooks add nothing after it", async () => {
  const config = resolveCcHostConfig({ dbPath: join(directory, "cc102.sqlite"), stateDir: join(directory, "cc102-state"), baseline: "2025-01-01T00:00:00.000Z" });
  const transcript = join(directory, "cc102.jsonl"), nativeId = "ruled-compaction";
  const row = (value: Record<string, unknown>) => `${JSON.stringify({ timestamp: time, ...value })}\n`;
  writeFileSync(transcript, row({ uuid: "u", parentUuid: null, type: "user", promptId: "p", promptSource: "sdk", message: { role: "user", content: "earlier" } }) +
    row({ uuid: "a", parentUuid: "u", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "answered" }] } }) +
    row({ uuid: "t", parentUuid: "a", type: "user", promptId: "p2", promptSource: "sdk", message: { role: "user", content: "the pending task" } }));
  const importer = new CcImporter(config, await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: nativeId, transcript_path: transcript }, time));
  const store = new Store(config.dbPath);
  try {
    const core = (await importer.reconcile()).coreSessionId!;
    const seed = seedSession(store, store.getSession(core)!.projectId, "seed");
    const turn = store.appendTurn({ sessionId: seed.id, kind: "turn", userPrompt: "rule", startedAt: time });
    const source = seedEntry(store, seed.id, turn.id, "rule", "user");
    const fact = legacyFacts(store, { kind: "manual", sessionId: seed.id, createdAt: time }, [{ sources: [{ entry: source,
      address: `T${turn.id}#E${source.entryOrdinal}` }], text: "rule", category: "decision", actor: "user", createdAt: time }]).facts[0]!;
    const rule = seedKnowledge(store, { sessionId: seed.id, headTurnId: turn.id }, "global", "constraint", [fact.id], "Use pnpm.").commit;
    const built = (await ccCompaction(config, { session_id: nativeId, trigger: "t" }))!;
    const visible = { db: databaseIdentity(config.dbPath), nativeSession: nativeId, coreSession: core };
    // Pi's own framing of a compaction summary around the carrier, which still decodes.
    expect(convertToLlm([{ role: "compactionSummary", summary: "S", tokensBefore: 0, timestamp: 0 }])[0]!.content)
      .toEqual([{ type: "text", text: `${COMPACTION_SUMMARY_PREFIX}S${COMPACTION_SUMMARY_SUFFIX}` }]);
    expect(built.text.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
    expect(built.text.endsWith(COMPACTION_SUMMARY_SUFFIX)).toBe(true);
    expect(decodeCcInjection(built.text.slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length), visible)!.commits).toEqual([rule]);
    // No original message is kept: the pending prompt is the block's newest Raw.
    expect(built.text.split("\n").filter(line => /^\[T\d+#E\d+@/.test(line)).at(-1)).toMatch(/@user\] user: the pending task$/);
    appendFileSync(transcript, row({ uuid: "b", parentUuid: null, logicalParentUuid: "t", type: "system", subtype: "compact_boundary" }) +
      row({ uuid: "block", parentUuid: "b", type: "user", promptId: "p2", message: { role: "user", content: built.text } }));
    const next = await ccDeltaInjection(config, { session_id: nativeId, transcript_path: transcript }, { kind: "prompt", promptId: "p3" },
      (output, binding) => sliceCcInjection(binding, output?.transportItems ?? [], undefined, output?.transportKnowledgeAllowance));
    expect(next.filter(Boolean)).toEqual([]);
  } finally { importer.close(); store.close(); }
});

test("2026-09-28, 102: on the paid Haiku check, proposed 'after an automatic compaction only, end the message with Claude Code's own instruction to continue the last task; and investigate the missing results', the maintainer answered '1. 可以 2. 查一下' — an automatic compaction's block ends with it after the framing, a manual one never does, and both still decode", async () => {
  const config = resolveCcHostConfig({ dbPath: join(directory, "cc102b.sqlite"), stateDir: join(directory, "cc102b-state"), baseline: "2025-01-01T00:00:00.000Z" });
  const transcript = join(directory, "cc102b.jsonl"), nativeId = "ruled-continue";
  const row = (value: Record<string, unknown>) => `${JSON.stringify({ timestamp: time, ...value })}\n`;
  writeFileSync(transcript, row({ uuid: "u", parentUuid: null, type: "user", promptId: "p", promptSource: "sdk", message: { role: "user", content: "earlier" } }) +
    row({ uuid: "a", parentUuid: "u", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "answered" }] } }) +
    row({ uuid: "t", parentUuid: "a", type: "user", promptId: "p2", promptSource: "sdk", message: { role: "user", content: "the pending task" } }));
  const importer = new CcImporter(config, await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: nativeId, transcript_path: transcript }, time));
  const store = new Store(config.dbPath);
  try {
    const core = (await importer.reconcile()).coreSessionId!;
    const seed = seedSession(store, store.getSession(core)!.projectId, "seed");
    const turn = store.appendTurn({ sessionId: seed.id, kind: "turn", userPrompt: "rule", startedAt: time });
    const source = seedEntry(store, seed.id, turn.id, "rule", "user");
    const fact = legacyFacts(store, { kind: "manual", sessionId: seed.id, createdAt: time }, [{ sources: [{ entry: source,
      address: `T${turn.id}#E${source.entryOrdinal}` }], text: "rule", category: "decision", actor: "user", createdAt: time }]).facts[0]!;
    seedKnowledge(store, { sessionId: seed.id, headTurnId: turn.id }, "global", "constraint", [fact.id], "Use pnpm.");
    const visible = { db: databaseIdentity(config.dbPath), nativeSession: nativeId, coreSession: core };
    // Structure only, never a whole-text snapshot: the sentence's presence/absence and the carrier's
    // continued decodability, not the sentence's literal wording (which the transcript.ts constant
    // cites and carries).
    const auto = (await ccCompaction(config, { session_id: nativeId, trigger: "t", auto: true }))!;
    const manual = (await ccCompaction(config, { session_id: nativeId, trigger: "t" }))!;
    expect(auto.text.endsWith(CC_AUTO_CONTINUE_SUFFIX)).toBe(true);
    expect(manual.text.endsWith(CC_AUTO_CONTINUE_SUFFIX)).toBe(false);
    // Unchanged: both still end with Pi's own framing once the optional sentence is stripped, and the
    // carrier inside still decodes — the classifier and `/trace` recognise the message either way.
    expect(manual.text.endsWith(COMPACTION_SUMMARY_SUFFIX)).toBe(true);
    expect(ccStripAutoContinue(auto.text).endsWith(COMPACTION_SUMMARY_SUFFIX)).toBe(true);
    for (const built of [auto, manual]) {
      const carrier = ccStripAutoContinue(built.text).slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length);
      expect(decodeCcInjection(carrier, visible)).not.toBeNull();
    }
  } finally { importer.close(); store.close(); }
});

test("2026-09-07: the estimate is segment-based, superseding the Q12 two-weight formula, and Chinese is still never priced as ASCII", () => {
  // Q12 ruled 0.75 per CJK character and 0.25 per other; measurement against a real tokenizer put that
  // 28% low on Chinese and 46% high on English prose, so the user ruled for per-segment pricing.
  expect(tokens("abcd")).toBe(1);
  expect(tokens("地形值")).toBe(3);
  expect(tokens("mapC 地形")).toBe(3);
  // The point Q12 protected still holds: 40 Chinese characters are 35 tokens, not the 10 that four
  // characters per token would give.
  expect(tokens("一".repeat(40))).toBe(35);
  // Characters, not UTF-16 code units: four astral emoji are four characters, not eight.
  expect(tokens("😀😀😀😀")).toBe(5);
  // A run of horizontal whitespace costs the one token o200k holds for it, whatever its width.
  expect(tokens("a b")).toBe(tokens("ab") + 1);
  expect(tokens(`a${" ".repeat(64)}b`)).toBe(tokens("a  b"));
});

test("Q12 + render budgets: cuts are measured with the same estimate, so Chinese output is cut at its token cap, not at four characters per token", () => {
  const { s, t } = session();
  const han = "一".repeat(400), ascii = "a".repeat(400);
  const call = (command: string) => memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: JSON.stringify({ command }), result: JSON.stringify({ stdout: "" }), status: "success" });
  call(han); call(ascii);
  const rendered = memory.trace(`S${s.id}/T${t.id}`);
  // 23c renders the arguments under one half of `B`; the cap is the same estimate either way.
  expect(rendered).not.toContain(han);   // 348 tokens over a 150-token arguments share: cut.
  expect(rendered).toContain(ascii);     // 58 tokens of the same 400 characters: kept whole.
  expect(rendered).toMatch(/command="一+"\[\.\.\. \d+ characters truncated\]"一+"/);
});

test("19b 2026-09-08 for ruling 08:53: core freezes one material; the parts an inherited run needs are the head reply and the source index", async () => {
  const { s, t } = session();
  // 17c 2026-09-08 supersedes concurrent sibling admission. A failed input probe leaves the
  // same evidence pending for the subagent comparison; exact branch bytes remain the ruling.
  const probe = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    calls.push(raw as NotingAgentInput); return { ...ok([]), outcome: "failure" };
  });
  const seen = visibleTarget(probe, s.id, "main", t.id);
  try { await probe.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork", visible: seen }); }
  finally { probe.close(); }
  await memory.noting({ sessionId: s.id, branch: "b2", headTurnId: t.id, mode: "subagent" });
  const [branch, subagent] = calls;
  expect(branch!.mode).toBe("fork");
  // This older fixture ends with a result: its earlier assistant text is not a missing head reply.
  expect(branch!.material.head).toBeNull();
  expect(branch!.material.sources).toEqual([
    `[T${t.id}#E1@user] user`,
    `[T${t.id}#E2@assistant] assistant`,
    `[T${t.id}#E3@assistant] assistant`,
    `[T${t.id}#E4@observation] toolResult`]);
  // 29b: one builder, not one material. The frozen target is the same in both modes; the parts differ
  // by exactly what the child could already see, so the fresh child gets the Raw and no repair parts.
  expect(subagent!.material.head).toBe(null);
  expect(subagent!.material.sources).toEqual([]);
  expect(subagent!.material.entries.map(e => e.id)).toEqual(branch!.entryIds);
  expect(branch!.material.entries).toEqual([]);
  expect(branch!.entryIds).toEqual(subagent!.entryIds);
  // No field of the material is a provider message, and the block layout is core's own since 20a
  // (pinned in core/render/material.test.ts).
  expect(Object.values(branch!.material).some(part => typeof part === "string" && part.includes("Range: "))).toBe(false);
  expect(branch!.prompt).toContain("already in this conversation");
  expect(subagent!.text).toContain("用 pnpm，不要 npm");
});

/** Knowledge to lead the block with: one manually written fact, consolidated by hand into K1. */
function seededKnowledge(sessionId: number, turnId: number) {
  const tools = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: turnId });
  const entry = hydrate(memory.store.listSourceEntries(sessionId, turnId), memory.store).find(value => value.role === "user")!;
  expect(seedFact(memory, { sessionId, branch: "main", headTurnId: turnId }, "Package manager decision", [{ entry, text: "Use pnpm" }]).id).toBe(1);
  expect(tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] })).toContain("committed");
}

// User ruling 2026-09-08 (ticket 20 "Solution"): this explicitly revises 19b's ban on core-composed
// domain text, without restoring core-owned provider conversations or a custom model loop. The 19b
// pin "no core module builds a message sequence or a provider body, and no host receives composed
// domain text" is superseded by: core builds no provider message or body; core owns the domain text.
test("20a 2026-09-08: core owns the host-neutral domain text and still builds no provider message or body", async () => {
  const { s, t } = session();
  seededKnowledge(s.id, t.id);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const input = calls[0]!;
  // Domain text, from core, in core's own order — instructions stay their own field, not a system message.
  expect(input.text).toContain(input.material.entries[0]!.view);
  expect(input.text).toContain("The project uses pnpm"); // 92 §6: a seeded, visible knowledge body is actually supplied
  expect(input.text).toContain(memory.inject(s.id).split("\n\nReceipts:")[0]!);
  expect(input.prompt).toContain("Noting (facts and knowledge)");
  expect(input.text).not.toContain(input.prompt);
  // What core still does not build: a message sequence, a system slot, a provider body.
  const record = input as unknown as Record<string, unknown>;
  for (const key of ["messages", "system", "conversation", "body", "subagentInput"]) expect(key in record).toBe(false);
  expect(Array.isArray(record.input)).toBe(false);
  // The recorded provider request is the host's own object; core never produced it.
  expect(JSON.parse(memory.store.listRuns(s.id).at(-1)!.request!)).toEqual({ fake: true });
});

// Ticket 20 "Inherited context": core exposes the full task material and the domain increment
// required when context is inherited, both from the same frozen task; the host picks one.
test("20a 2026-09-08: the full text and the inherited increment come from one frozen task, and the writable range is identical in both modes", async () => {
  const { s, t } = session();
  // A failed probe run leaves the same evidence pending, so the second mode freezes the same task.
  const probe = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    calls.push(raw as NotingAgentInput); return { ...ok([]), outcome: "failure" };
  });
  const seen = visibleTarget(probe, s.id, "main", t.id);
  try { await probe.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork", visible: seen }); }
  finally { probe.close(); }
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const [fork, fresh] = calls;
  expect(fork!.mode).toBe("fork"); expect(fresh!.mode).toBe("subagent");
  expect(fork!.entryIds).toEqual(fresh!.entryIds); // one writable range, whatever the execution mode
  expect(fork!.range).toEqual(fresh!.range);
  expect(fork).not.toHaveProperty("readKnowledgeCommits");
  expect(fresh).not.toHaveProperty("readKnowledgeCommits");
  // 29b: one builder over one frozen task, two initial states. What the fork does not send is exactly
  // what its own context already holds, and it is never a second copy of the full text.
  expect(fork!.text).not.toEqual(fresh!.text);
  expect(fork!.text).not.toContain(fresh!.material.entries[0]!.view);
  expect(fresh!.text).not.toContain(fork!.text);
});

// 92 §6 supersedes 25a's N exclusion: one seeded Knowledge body uses the same leading renderer
// for foreground injection, compact and fresh N; target-specific framing stays outside that block.
test("20a/92: fresh N shares the leading Knowledge block without copying task framing into it", async () => {
  const { s, t } = session();
  seededKnowledge(s.id, t.id);
  const block = memory.inject(s.id);
  expect(block).toContain("The project uses pnpm");
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const input = calls[0]!;
  expect(input.text).toContain(block);
  expect(input.text).toContain(`Range: ${input.range.from}..${input.range.to}`);
  expect(compacted(memory.compact(s.id, "main", t.id)).startsWith(`${block}\n\n<episodic>`)).toBe(true);
  expect(block).not.toContain("Range: ");
  expect(block).not.toContain("[entry ");
  expect(block).not.toContain("omitted");
  for (const line of input.material.facts) expect(block).not.toContain(line);
  expect(block).not.toMatch(/\bR\d+\b/);
  expect(block).not.toContain(memory.store.getTurn(t.id)!.startedAt);
});

test("09:43: trace accepts both T<n> and S<n>/T<n>; a mismatched session does not resolve", () => {
  const { s, t } = session();
  const plain = memory.trace(`T${t.id}`);
  expect(memory.trace(`S${s.id}/T${t.id}`)).toBe(plain);
  expect(() => memory.trace(`S${s.id + 1}/T${t.id}`)).toThrow("does not exist");
});

// 09:43 "sessions of one project integrate separately": pinned in core/api/consolidation.test.ts,
// "each session settles only its own branch facts and shares already-settled context".

// User, 2026-09-07: four tools: trace, search, facts and knowledge writers; main agents may use them but have no memory duty.
// User, 2026-09-07: the writer tool names are note and memory.
test("2026-09-07: four tools, no other model-facing surface", () => {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  expect(tools.map(t => t.name)).toEqual(["trace", "search", "note", "memory"]);
  for (const tool of tools) { expect(tool.parameters.type).toBe("object"); expect(typeof tool.execute).toBe("function"); }
  expect(tools[2]!.description).toContain("Both note and memory are required in N");
  expect(tools[3]!.description).toContain("Manual writers may create/archive only");
  expect(tools[3]!.execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion." }, { op: "archive", kind: "budget", reason: "Retired: the cited evidence withdraws this conclusion." }], skipped: [] })).toContain("rejected:");
});

// “if any fails, the result lists each item's outcome in order ... and nothing is written.”
test("2026-09-07: a rejected item writes nothing", () => {
  const { s, t } = session();
  const note = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[2]!;
  const fact = { title: "Package manager decision", sources: [{ address: `T${t.id}#E1`, text: "Use pnpm" }] };
  const rejected = JSON.parse(note.execute({ facts: [fact, { ...fact, actor: "tool" }] }));
  expect(rejected.results[0]).toBe("ok"); expect(rejected.results[1]).toContain("rejected:");
  expect(memory.store.listSessionFacts(s.id)).toEqual([]);
  const corrected = JSON.parse(note.execute({ facts: [fact, { ...fact, support: [["$1", "strong"]] }] }));
  expect(corrected.results).toEqual(["ok: F1", "ok: F2"]);
  expect(memory.trace("F2")).toContain("support F1 strong");
});

// One publication per run still holds; 92 moves it after all held edits and normal termination.
test("2026-09-07 / 92: one terminal publication per run, not one immediate tool submission", async () => {
  const { s, t } = session(); memory.close();
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ round: 1 });
    const note = input.tools[2]!;
    const fact = { title: "Package manager decision", sources: [{ address: `T${t.id}#E1`, text: "Use pnpm" }] };
    expect(note.execute({ facts: [fact] })).toContain("held: $1");
    expect(memory.store.listSessionFacts(s.id)).toEqual([]);
    expect(memory.store.listRuns(s.id).some(run => run.outcome === "success")).toBe(false);
    const entries = memory.store.sourcePath(s.id, "main", t.id);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(entry => memory.store.entryNoted(entry.id))).toBe(false);
    expect(note.execute({ facts: [{ slot: "$1", ...fact, sources: [{ address: `T${t.id}#E1`, text: "Use pnpm, not npm" }] }] })).toContain("held: $1");
    expect(input.tools[3]!.execute({ operations: [], skipped: [] })).not.toContain("rejected:");
    expect(memory.store.listSessionFacts(s.id)).toEqual([]);
    return { outcome: "success", output: "Done", request: { round: 2 } };
  });
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(memory.store.listSessionFacts(s.id)).toMatchObject([{ text: "Use pnpm, not npm" }]);
  expect(memory.store.sourcePath(s.id, "main", t.id).every(entry => memory.store.entryNoted(entry.id))).toBe(true);
  const run = memory.store.listRuns(s.id).at(-1)!;
  expect(run.outcome).toBe("success");
  expect(JSON.parse(run.request!)).toEqual({ round: 2 });
  expect(JSON.parse(run.response!).toolCalls.map((c: { result: string }) => c.result)).toHaveLength(3);
});

// “a run whose last submission was rejected and never corrected ... is bounced ... watermark does not move”.
test("2026-09-07: bounced is not empty", async () => {
  const { s, t } = session(); memory.close();
  let reject = true;
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    input.tools[2]!.execute({ facts: reject ? [{ category: "invalid" }] : [] });
    input.tools[3]!.execute({ operations: [], skipped: [] });
    return { outcome: "success", output: "No more text", request: {} };
  });
  const input = { sessionId: s.id, branch: "main", headTurnId: t.id };
  expect((await memory.noting(input)).outcome).toBe("bounced");
  expect(memory.store.getRun(1)?.outcome).toBe("bounced");
  expect(JSON.parse(memory.store.getRun(1)!.response!).toolCalls[0].input).toEqual({ facts: [{ category: "invalid" }] });
  expect(hydrate(memory.store.listSourceEntries(s.id), memory.store).some(e => memory.store.entryNoted(e.id))).toBe(false);
  reject = false;
  expect(await memory.noting(input)).toMatchObject({ outcome: "success", facts: [] });
  expect(hydrate(memory.store.sourcePath(s.id, "main", t.id), memory.store).length).toBeGreaterThan(0);
  expect(hydrate(memory.store.sourcePath(s.id, "main", t.id), memory.store).every(e => memory.store.entryNoted(e.id))).toBe(true);
});

function memoryWriter() {
  const { s, t } = session();
  const entries = hydrate(memory.store.sourcePath(s.id, "main", t.id), memory.store);
  memory.selectEntries(s.id, "main", entries.map(entry => entry.id));
  const path = { sessionId: s.id, branch: "main", headTurnId: t.id, triggerEntryId: entries.at(-1)!.id };
  const tools = memory.tools({ kind: "manual", ...path, currentTurnId: t.id });
  expect(seedFacts(memory, path, ["Use pnpm", "Do not use npm"].map(text => ({
    title: "Package manager decision", sources: [{ entry: entries[0]!, text }],
  })))).toHaveLength(2);
  const create = { op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"] };
  const write = (operations: any[]) => JSON.parse(tools[3]!.execute({ operations, skipped: [] }));
  return { s, t, path, tools, write, create };
}

test("2026-09-28, 99: archive kind is required; budget retains parent while invalidation records grounds", () => {
  const { s, path, tools, write, create } = memoryWriter();
  const budgetBase = write([create]).committed[0];
  const invalidBase = write([{ ...create, text: "Old unique guidance" }]).committed[0];
  const budgetId = budgetBase.knowledgeId, invalidId = invalidBase.knowledgeId;
  const budgetTag = tagged(budgetId, commitOf(budgetBase));
  const invalidTag = tagged(invalidId, commitOf(invalidBase));
  const attempted = (id: string, extra: Record<string, unknown>) => write([{ op: "archive", id, supports: ["F1"], reason: "archival decision", ...extra }]);
  expect(attempted(budgetTag, {}).results[0]).toContain("archive kind must be budget or invalid");
  expect(attempted(invalidTag, { kind: "invalid", text: "obsolete" }).results[0]).toContain("substantive statement");
  expect(attempted(invalidTag, { kind: "invalid", text: "The rule no longer holds: the user corrected its basis; another rule replaces it." }).committed).toHaveLength(1);
  expect(attempted(budgetTag, { kind: "budget" }).committed).toHaveLength(1);
  const invalid = memory.store.currentCommit(invalidId, path)[0]!, budget = memory.store.currentCommit(budgetId, path)[0]!;
  expect(invalid).toMatchObject({ op: "archive", archiveKind: "invalid", category: "constraint", scope: "project", topics: [] });
  expect(invalid.text).toContain("no longer holds");
  expect(budget).toMatchObject({ op: "archive", archiveKind: "budget", text: create.text,
    category: "constraint", scope: "project", topics: [] });
  expect(memory.store.currentKnowledge(path)).toEqual([]);
  expect(memory.inject(s.id)).not.toContain("Old unique guidance");
  const trace = tools[0]!, search = tools[1]!;
  expect(trace.execute({ address: history(invalidId, invalid.id) })).toContain("status: archive (invalid)");
  expect(trace.execute({ address: history(budgetId, budget.id) })).toContain("status: archive (budget)");
  const found = search.execute({ query: "Old unique guidance", layer: "knowledge", versions: "history" });
  expect(found).toContain(`[K${invalidId}@v1]`);
  expect(found).toContain("archived on this path (historical version)");
});

test("2026-09-28, 101: 'grep 直接搜完整原文' — grep reaches Raw beyond its compressed and fact-projected views", () => {
  const { s, t } = session();
  memory.store.appendToolCall({ turnId: t.id, name: "Read", input: JSON.stringify({ path: "notes.md" }), status: "success",
    result: `${"filler ".repeat(2_000)}hashline-deep-in-raw${" tail".repeat(50)}` });
  const { path } = memoryWriter();
  recorded(memory, s.id, "main", t.id);
  const found = api.memoryFiles(memory, path).grep("hashline-deep-in-raw", `/tm/S${s.id}`).lines;
  expect(found).toHaveLength(1);
  const [, entryOrdinal] = /\/E(\d+)$/.exec(found[0]!)!;
  expect(found[0]).toBe(`/tm/S${s.id}/T${t.id}/E${entryOrdinal}`);
  // Neither the Turn's fact projection nor the entry's compressed view holds the text.
  expect(memory.trace(`S${s.id}/T${t.id}`, { ...path, pageBudget: null })).not.toContain("hashline-deep-in-raw");
  expect(memory.trace(`T${t.id}#E${entryOrdinal}`, { ...path, pageBudget: null })).not.toContain("hashline-deep-in-raw");
});

test("2026-09-28, 101: '1-2. 可以' (1) — an archive written before 99 lists and searches with its parent's body; its own version stays empty", () => {
  const { path, write, create } = memoryWriter();
  const base = write([{ ...create, text: "Legacy okapi guidance" }]).committed[0];
  const commit = legacyArchive(memory.store, path, base.knowledgeId, commitOf(base), [1]);
  const files = api.memoryFiles(memory, path);
  expect(files.read("/tm/knowledge-all").lines.find(line => line.startsWith(`/tm/K${base.knowledgeId}@`)))
    .toBe(`/tm/K${base.knowledgeId}@v2  [constraint/project p] (archived at v2) Legacy okapi guidance`);
  expect(files.grep("okapi", "/tm/knowledge-all").lines).toEqual([`/tm/K${base.knowledgeId}@v1 (historical; latest v2, archived)`,
    `/tm/K${base.knowledgeId}@v2 (archived)`]);
  expect(memory.store.getKnowledgeRevision(base.knowledgeId, commit)!.text).toBe("");
  expect(files.read(`/tm/K${base.knowledgeId}@v2`).lines.join("\n")).not.toContain("okapi");
});

test("2026-09-28, 101: '1-2. 可以' (2); 2026-09-29: '只加虚拟地址相关提示，不撤，由模型判断哪个方便用哪个' — the injected knowledge notice names the session, /tm/S<n>/knowledge and the /tm files", () => {
  const { s, t } = session();
  seededKnowledge(s.id, t.id);
  const line = `Session S${s.id}: a subagent inherits this session's knowledge by reading /tm/S${s.id}/knowledge.`;
  expect(memory.inject(s.id).split("\n").slice(0, 4)).toEqual(["<knowledge>", KNOWLEDGE_RECENCY_NOTICE, line, MEMORY_FILES_NOTICE]);
  expect(compacted(memory.compact(s.id, "main", t.id))).toContain(`${KNOWLEDGE_RECENCY_NOTICE}\n${line}\n${MEMORY_FILES_NOTICE}\n`);
  const cc = sliceCcInjection({ db: "db", nativeSession: "native", coreSession: s.id }, memory.injection(s.id, undefined, true).transportItems!)
    .filter(Boolean).map(slice => slice!.hookSpecificOutput.additionalContext).join("\n");
  expect(cc).toContain(`${line}\n${MEMORY_FILES_NOTICE}`);
  expect(memory.inject({ projectId: memory.store.getSession(s.id)!.projectId })).not.toContain("Session S");
});

test("2026-09-28, 104: '可以让总量超过20 + 10 就可以触发' — a session is due on knowledge overflow or summed pending, not per pool", () => {
  const { path, create, write } = memoryWriter();
  const body = "Durable user constraint ".repeat(150);
  expect(write([{ ...create, text: body }, { ...create, scope: "global", text: `Global ${body}` }]).committed).toHaveLength(2);
  const due = () => memory.taskEligibility("dreaming", path).due;
  const [global, project] = memory.store.knowledgePools(path);
  const weight = (pool: typeof global) => pool!.pending.reduce((sum, value) => sum + value.tokens, 0);
  // Pending: the weight summed across the session's pools reaches the trigger where neither pool alone does.
  memory.config.dreaming.triggerTokens = weight(global) + weight(project);
  expect(Math.max(weight(global), weight(project))).toBeLessThan(memory.config.dreaming.triggerTokens);
  expect(due()).toBe(true);
  memory.config.dreaming.triggerTokens++;
  expect(due()).toBe(false);
  // Overflow: with pending still below the trigger, the knowledge total exceeding the injection base
  // plus the shared allowance is due; a pool over its own budget within that window is not.
  memory.setKnowledgeBudget("global", 0);
  memory.setKnowledgeBudget("project", project!.tokens);
  memory.setKnowledgeBudget("session", 0);
  memory.config.compaction.sharedAllowanceTokens = global!.tokens;
  expect(due()).toBe(false);
  memory.config.compaction.sharedAllowanceTokens = global!.tokens - 1;
  expect(due()).toBe(true);
  expect(memory.store.duePools(path, memory.config.dreaming.triggerTokens, memory.config.compaction.sharedAllowanceTokens))
    .toEqual([expect.objectContaining({ pool: "global" })]);
});

test("92 §§6–8: a D range excludes a later version from this run's material and processing", async () => {
  const { path, write, create } = memoryWriter();
  const trigger = createDreamerTrigger(memory, path, 1, 1);
  const pool = `project:${memory.store.getSession(path.sessionId)!.projectId}`;
  let lateCommit = 0;
  const result = await admittedScenarios.run(memory, path, input => {
    input.acknowledgeRequest();
    const frozen = suppliedHandles(input.material.changed);
    expect(frozen).toContain(history(trigger.knowledgeId, trigger.commit));
    const late = write([{ ...create, text: "Later knowledge that did not exist at D admission" }]).committed[0];
    lateCommit = commitOf(late);
    expect(input.material.changed).not.toContain("Later knowledge that did not exist at D admission");
    expect(frozen).not.toContain(history(late.knowledgeId, lateCommit));
    expect(input.tools.find(tool => tool.name === "memory")!.execute({ operations: [],
      skipped: frozen.map(knowledge => ({ knowledge, because: "Reviewed only frozen versions" })) })).toContain("committed");
    return ok([]);
  });
  expect(result.outcome).toBe("success");
  expect(memory.store.getClaim(path.sessionId, "dreaming")).toBeNull();
  expect(memory.store.openDreamingRange(path.sessionId, path.branch)).toBeNull();
  expect(memory.store.pendingVersions(pool, path).map(item => item.revisionId)).toContain(lateCommit);
});

test("2026-09-07: one operation shape, inapplicable fields rejected", () => {
  const { create, write } = memoryWriter();
  write([create]);
  const update = { ...create, op: "update", reason: "Substantive correction of the recorded conclusion.", id: "K1" };
  const archive = { op: "archive", kind: "budget", reason: "Retired: the cited evidence withdraws this conclusion.", id: "K1", supports: ["F1"] };
  for (const operation of [create, update, { ...update, op: "merge", reason: "Merged duplicate knowledge into the survivor.", absorb: ["K2"] }, archive]) {
    for (const required of ["reason", "supports"]) {
      const missing = { ...operation } as Record<string, unknown>; delete missing[required];
      expect(write([missing]).results[0]).toContain("rejected:");
    }
  }
  const wrong = [{ ...create, id: "K1" }, { ...create, absorb: ["K1"] }, { ...update, absorb: ["K2"] },
    ...["text", "category", "scope", "absorb"].map(key => ({ ...archive, [key]: key === "absorb" ? [] : "x" })),
    { ...create, handle: "$e1" }, { ...create, status: "active" }];
  for (const operation of wrong) {
    const result = write([operation]);
    expect(result.results[0]).toContain("inapplicable field");
  }
  for (const key of ["text", "category", "scope", "supports"]) {
    const incomplete = { ...update } as Record<string, unknown>; delete incomplete[key];
    expect(write([incomplete]).results[0]).toContain("rejected:");
  }
});

test("2026-09-07: supports replaces, history keeps the old set", async () => {
  const { create, write, path, s } = memoryWriter();
  const created = write([create]);
  expect(created.results).toEqual(["ok"]);
  expect(memory.store.getKnowledgeRevision(1, 1)).toMatchObject({ supports: [1], reason: "Initial admission of this conclusion." });
  const trigger = createDreamerTrigger(memory, path, 2, 1);
  const updated = await admittedWrite({ ...path, fact: "F2" }, trigger, [{ ...create, op: "update",
    reason: "Substantive correction of the recorded conclusion.", id: tagged(1, 1), text: "Avoid npm", supports: ["F2"] }]);
  const commit = commitOf(updated.committed[0]);
  expect(memory.store.getKnowledgeRevision(1, commit)).toMatchObject({ supports: [2], reason: "Substantive correction of the recorded conclusion." });
  expect(memory.store.getKnowledgeRevision(1, 1)?.supports).toEqual([1]);
  expect(memory.trace(`K1@v1..v${memory.store.versionOrdinal(1, commit)}`)).toContain("F2");
  const runs = memory.store.listRuns(s.id);
  expect(runs.at(-1)).toMatchObject({ kind: "dreaming", branch: "main" });
  expect(runs.at(-1)!.id).toBe(memory.store.getKnowledgeRevision(1, commit)!.runId);
});

test("2026-09-07: merge atomic", async () => {
  const { create, write, path } = memoryWriter();
  const created = (write([create, { ...create, text: "Avoid npm", supports: ["F2"] }]).committed as Array<{ knowledgeId: number; version: string }>)
    .map(item => ({ ...item, commit: commitOf(item) }));
  const first = created[0], second = created[1];
  if (!first || !second) throw new Error(`merge fixture needs two identities: ${JSON.stringify(created)}`);
  const trigger = createDreamerTrigger(memory, path, 2, 1);
  const request = { fixture: "merge atomic" };
  let merged: { results: string[]; committed: Array<{ knowledgeId: number; version: string }> } | undefined;
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request); const trace = input.tools[0]!, writeTool = input.tools.find(tool => tool.name === "memory")!;
    for (const item of [first, second]) completeToolRead(trace, item.version);
    const merge = { ...create, op: "merge", reason: "Merged duplicate knowledge into the survivor.",
      id: tagged(first.knowledgeId, first.commit), absorb: [tagged(second.knowledgeId, second.commit)], supports: ["F1", "F2"] };
    expect(JSON.parse(writeTool.execute({ operations: [merge, { op: "archive", kind: "budget", reason: "Retired: the cited evidence withdraws this conclusion.",
      id: "K999", supports: [] }], skipped: [] })).results[1]).toContain("rejected:");
    expect(memory.store.currentCommit(first.knowledgeId)[0]?.id).toBe(first.commit);
    expect(memory.store.currentCommit(second.knowledgeId)[0]?.op).toBe("create");
    expect(memory.store.listKnowledgeLinks(second.knowledgeId)).toEqual([]);
    const triggerAddress = tagged(trigger.knowledgeId, trigger.commit);
    completeToolRead(trace, triggerAddress);
    merged = JSON.parse(writeTool.execute({ operations: [merge, { op: "archive", kind: "budget", id: triggerAddress, supports: ["F2"],
      reason: "Retire the explicit fixture trigger." }], skipped: [] }));
    return { outcome: "success", output: "merged", request };
  });
  expect(result.outcome).toBe("success");
  if (!merged) throw new Error(`merge fixture did not submit: ${JSON.stringify(result)}`);
  expect(merged.results).toEqual(["ok", "ok"]);
  const mergedIdentity = merged.committed[0];
  if (!mergedIdentity) throw new Error(`merge fixture committed nothing: ${JSON.stringify(merged)}`);
  const mergeCommit = commitOf(mergedIdentity);
  expect(memory.store.currentCommit(second.knowledgeId)).toEqual([]);
  expect(memory.store.getKnowledge(second.knowledgeId)).toMatchObject({ id: second.knowledgeId });
  expect(memory.store.listKnowledgeLinks(second.knowledgeId)).toEqual([{ fromKnowledge: second.knowledgeId,
    fromCommit: second.commit, kind: "merged_into", toKnowledge: first.knowledgeId, toCommit: mergeCommit }]);
  expect(memory.trace(history(second.knowledgeId, second.commit))).toContain("Avoid npm");
  expect(memory.trace(`K${second.knowledgeId}`)).toContain(`K${first.knowledgeId}@${mergeCommit}`);
});



test.each(["success", "failure"] as const)("92: invalid knowledge slot is corrected but terminal %s decides joint publication and preserves audit", async outcome => {
  const { s, t } = session(); memory.close();
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    const note = input.tools.find(tool => tool.name === "note")!;
    const tool = input.tools.find(tool => tool.name === "memory")!;
    input.reportRequest({ messages: ["invalid"] });
    expect(note.execute({ facts: [{ title: "Package manager choice", sources: [{ address: `T${t.id}#E1`, text: "The user chose pnpm" }] }] })).toContain("held: $1");
    const create = { op: "create", topics: [], reason: "User choice", text: "Use pnpm", category: "constraint", scope: "project", supports: ["$1"] };
    expect(tool.execute({ operations: [{ ...create, id: "K1" }], skipped: [] })).toContain("rejected: M1");
    expect(memory.store.listSessionFacts(s.id)).toEqual([]);
    expect(memory.store.currentKnowledge()).toEqual([]);
    input.reportRequest({ messages: ["corrected"] });
    expect(tool.execute({ operations: [{ ...create, slot: "M1" }], skipped: [] })).toContain("held: M1");
    expect(JSON.parse(tool.execute({ operations: [], skipped: [] })).held).toContain("M1");
    expect(memory.store.listSessionFacts(s.id)).toEqual([]);
    expect(memory.store.currentKnowledge()).toEqual([]);
    expect(memory.store.sourcePath(s.id, "main", t.id).every(entry => !memory.store.entryNoted(entry.id))).toBe(true);
    return { outcome, output: outcome === "failure" ? "provider failed after correction" : "completed", request: { messages: ["last"] } };
  });
  const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  expect(result.outcome).toBe(outcome);
  if (!("runId" in result) || result.runId === undefined) throw new Error("missing run audit");
  const run = memory.store.getRun(result.runId)!;
  expect(run.outcome).toBe(outcome);
  expect(JSON.parse(run.request!)).toEqual({ messages: ["last"] });
  const audit = JSON.parse(run.response!);
  expect(audit.problems).toEqual(outcome === "failure" ? ["provider failed after correction"] : []);
  expect(audit.toolCalls).toHaveLength(4); // note plus three memory calls, including rejection and correction
  expect(audit.toolCalls.map((call: { result: string }) => call.result)).toEqual(expect.arrayContaining([expect.stringContaining("rejected: M1"), expect.stringContaining("held: M1")]));
  expect(memory.store.listSessionFacts(s.id).map(fact => fact.text)).toEqual(outcome === "success" ? ["The user chose pnpm"] : []);
  expect(memory.store.currentKnowledge().map(item => item.revision.text)).toEqual(outcome === "success" ? ["Use pnpm"] : []);
  for (const entry of memory.store.sourcePath(s.id, "main", t.id))
    expect(memory.store.entryNoted(entry.id)).toBe(outcome === "success");
});


test("2026-09-07: branch input premise repair appends the missing final reply and source index", async () => {
  const { s } = session();
  const first = memory.store.appendTurn({ sessionId: s.id, parentTurnId: null, kind: "turn",
    userPrompt: "0123456789".repeat(6) + " PRIVATE USER TAIL", assistantText: "Earlier reply", startedAt: time });
  const head = memory.store.appendTurn({ sessionId: s.id, parentTurnId: first.id, kind: "turn",
    userPrompt: "Check it", assistantText: "Final-only finding: " + "result ".repeat(10) + "verified.", startedAt: time });
  memory.store.appendToolCall({ turnId: head.id, name: "Bash", input: '{"command":"check"}', result: "PRIVATE TOOL RESULT", status: "success" });
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: head.id, mode: "fork",
    visible: visibleTarget(memory, s.id, "main", head.id) });
  const input = calls[0]!;
  expect(input.mode).toBe("fork");
  expect(input.material.head).toBeNull(); // The last native entry is a result, not E2's earlier reply.
  expect(input.material.sources).toEqual([
    `[T2#E1@user] user`,
    `[T2#E2@assistant] assistant`,
    `[T3#E1@user] user`,
    `[T3#E2@assistant] assistant`,
    `[T3#E3@assistant] assistant`,
    `[T3#E4@observation] toolResult`]);
  expect(input.text).not.toContain("PRIVATE USER TAIL");
  expect(input.material.sources.join("\n")).not.toContain("PRIVATE TOOL RESULT");
});

test("33: a branch source index uses shared identities, not a separate body preview",  async () => {
  const { s } = session();
  const t = memory.store.appendTurn({ sessionId: s.id, parentTurnId: null, kind: "turn",
    userPrompt: "😀".repeat(59) + "\nTAIL", assistantText: null, startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: "x".repeat(60) + "\nTAIL", result: null, status: "attempted" });
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork",
    visible: visibleTarget(memory, s.id, "main", t.id) });
  expect(calls[0]!.material.head).toContain("[T2#E2@assistant] Bash(");
  expect(calls[0]!.material.sources).toEqual([
    "[T2#E1@user] user",
    "[T2#E2@assistant] assistant"]);
  expect(calls[0]!.material.sources.join("\n")).not.toContain("TAIL");
});

// 93 replaces the retired #user/#assistant/#call selector with a whole entry and checked role.
test.each([{ ordinal: 1, role: "user", text: "用 pnpm，不要 npm" },
  { ordinal: 2, role: "assistant", text: "好的。" },
  { ordinal: 4, role: "observation", text: 'Bash success: {"stdout":"done","stderr":""}' }] as const)
("93: entry E%s checks @%s and reads the whole entry", ({ ordinal, role, text }) => {
  const { s, t } = session();
  const tool = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[0]!;
  for (const base of [`T${t.id}`, `S${s.id}/T${t.id}`]) {
    const address = `${base}#E${ordinal}@${role}`;
    expect(memory.trace(address)).toContain(text);
    expect(tool.execute({ address })).toContain(text);
  }
  expect(() => memory.trace(`S${s.id + 1}/T${t.id}#E${ordinal}@${role}`)).toThrow("does not exist");
  expect(() => memory.trace(`T${t.id}#E${ordinal}@${role === "user" ? "assistant" : "user"}`)).toThrow(/role/);
});

test("93: whole result entry keeps standard cuts unless full", () => {
  const { t } = session();
  const output = "hidden evidence ".repeat(300);
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: '{"command":"second"}', result: output, status: "success" });
  const cut = memory.trace(`T${t.id}#E6`);
  expect(cut).toMatch(/\[\.\.\. \d+ characters truncated\]/); // 23c: the entry view's one marker family
  expect(cut).not.toContain(output);
  expect(cut).not.toContain("#t1");
  // 17a preserves the full argument object, including fields beyond command.
  const full = memory.trace(`T${t.id}#E6`, { full: true });
  expect(full).toBe(`[T${t.id}#E6@observation] Bash success: ${output}`);
  expect(memory.trace(`T${t.id}#E5`, { full: true })).toContain('Bash(command="second")');
  expect(() => memory.trace(`T${t.id}#E6`, { tool: 1 } as never)).toThrow("tool parameter is removed");
});

// 93 retires block selectors, not the missing-entry and scope rejection guarantees.
test("93: trace rejects missing whole entries and retired selectors", () => {
  const { s } = session();
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: null, assistantText: null, startedAt: time });
  const tool = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[0]!;
  for (const base of [`T${t.id}`, `S${s.id}/T${t.id}`]) {
    expect(() => memory.trace(`${base}#E1@user`)).toThrow(/does not exist/);
    expect(tool.execute({ address: `${base}#E1@user` })).toContain("does not exist");
    for (const retired of ["#user", "#assistant", "#t1", "#E1@text"]) {
      expect(() => memory.trace(`${base}${retired}`)).toThrow("invalid public trace address");
      expect(tool.execute({ address: `${base}${retired}` })).toContain("invalid public trace address");
    }
  }
});

// Knowledge commits (rulings A/B, 2026-09-07): all writes go through the host façade.
function commitPaths() {
  const { s, t } = session();
  const selectNativeAncestry = (sessionId: number, headTurnId: number, branch: string) => {
    const turns = memory.store.pathTurns({ sessionId, headTurnId });
    const entries = hydrate(memory.store.listSourceEntries(sessionId), memory.store).filter(entry => turns.has(entry.turnId));
    memory.selectEntries(sessionId, branch, entries.map(entry => entry.id));
    return entries.at(-1)!.id;
  };
  const node = (sessionId: number, parentTurnId: number | null, branch: string) => {
    const turn = memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: branch, startedAt: time });
    return writer(sessionId, turn.id, branch, selectNativeAncestry(sessionId, turn.id, branch));
  };
  const writer = (sessionId: number, headTurnId: number, branch: string, triggerEntryId: number) => {
    const tools = memory.tools({ kind: "manual", sessionId, currentTurnId: headTurnId, branch, triggerEntryId });
    const entry = hydrate(memory.store.listSourceEntries(sessionId, headTurnId), memory.store).find(value => value.role === "user")!;
    const fact = `F${seedFact(memory, { sessionId, branch, headTurnId }, "Branch decision", [{ entry, text: branch }]).id}`;
    return { sessionId, headTurnId, branch, triggerEntryId, fact, tools,
      read: (address = "K1") => readHandle(tools, address),
      write: (operations: any[]) => {
        const receipt = JSON.parse(tools[3]!.execute({ operations, skipped: [] }));
        // The scenario's internal graph assertions use global database keys, not public addresses.
        if (receipt.committed) receipt.committed = receipt.committed.map((item: { knowledgeId: number; version: string }) => ({ ...item, commit: commitOf(item) }));
        return receipt;
      } };
  };
  const root = writer(s.id, t.id, "main", selectNativeAncestry(s.id, t.id, "main"));
  const publish = (who: typeof root) => memory.store.setCurrentPath(who.sessionId, who.branch, who.headTurnId, "test-lineage");
  publish(root);
  const content = (fact: string, text = "Use blue tiles") => ({ text, category: "constraint", scope: "project", supports: [fact] });
  expect(root.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact) }]).committed[0].version).toBe("K1@v1");
  const c = node(s.id, t.id, "C"), d = node(s.id, t.id, "D");
  const edit = async (who: typeof root, text: string, trigger: { knowledgeId: number; commit: number }, fact = who.fact) => {
    publish(who);
    const current = memory.store.currentCommit(1, who).at(-1)!;
    return admittedWrite(who, trigger, [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
      id: tagged(1, current.id), ...content(fact, text) }]);
  };
  const tips = (path: { sessionId: number; headTurnId: number }) => memory.store.currentCommit(1, path).map(r => r.id);
  const peer = (projectId = s.projectId) => {
    const other = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId, startedAt: time, firstReplyAt: time });
    return node(other.id, null, "main");
  };
  return { root, c, d, node, peer, content, edit, tips, publish };
}

async function admittedWrite(
  path: { sessionId: number; headTurnId: number; branch: string; fact: string },
  trigger: { knowledgeId: number; commit: number }, operations: any[], skipped: string[] = [],
) {
  const request = { fixture: "rulings admitted maintenance", trigger: history(trigger.knowledgeId, trigger.commit) };
  let receipt: any;
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!;
    const write = input.tools.find(tool => tool.name === "memory")!;
    const exact = new Set<string>();
    for (const operation of operations) {
      if (typeof operation.id === "string" && /^K\d+#[a-z]+$/.test(operation.id)) exact.add(operation.id);
      for (const parent of operation.absorb ?? []) if (/^K\d+#[a-z]+$/.test(parent)) exact.add(parent);
    }
    for (const address of exact) completeToolRead(trace, address);
    const triggerAddress = tagged(trigger.knowledgeId, trigger.commit);
    completeToolRead(trace, triggerAddress);
    receipt = JSON.parse(write.execute({ operations: [...operations, { op: "archive", kind: "budget", id: triggerAddress,
      supports: [path.fact], reason: "Retire the explicit fixture trigger." }],
      skipped: skipped.map(knowledge => ({ knowledge, because: "This supplied identity is unrelated to the asserted maintenance." })) }));
    return { outcome: "success", output: "maintenance complete", request };
  });
  if (result.outcome !== "success" || !receipt?.committed) throw new Error(JSON.stringify({ result, receipt }));
  return { ...receipt, committed: receipt.committed.map((item: { knowledgeId: number; version: string }) => ({ ...item, commit: commitOf(item) })) };
}

test("2026-09-07 A: sibling-branch facts are readable but supports requires an adoption fact on this path", () => {
  const { c, d, content } = commitPaths();
  expect(c.tools[0]!.execute({ address: d.fact })).toContain(d.fact);
  for (const scope of ["session", "project", "global"]) {
    const rejected = c.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(c.fact), scope, supports: [d.fact] }]);
    expect(rejected.results[0]).toContain("record an adoption fact on this path first");
    expect(memory.store.getKnowledge(2)).toBeNull();
  }
  const entry = hydrate(memory.store.listSourceEntries(c.sessionId, c.headTurnId), memory.store).find(value => value.role === "user")!;
  const adopted = { factIds: [seedFact(memory, { sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId },
    "Sibling branch adoption", [{ entry, text: `Adopt the other branch's rule 「${d.fact}」` }]).id] };
  expect(c.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(`F${adopted.factIds[0]}`) }]).committed).toHaveLength(1);
});

test("2026-09-07: supports obeys the session/project/global scope table", () => {
  const { c, peer, content } = commitPaths();
  const same = peer();
  const outside = peer(memory.store.createProject({ name: "outside", declaredBy: "mark" }).id);
  for (const scope of ["session", "project", "global"]) for (const origin of [c, same, outside]) {
    const allowed = origin === c || scope === "global" || (scope === "project" && origin === same);
    const result = c.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(c.fact), scope, supports: [origin.fact] }]);
    expect(!!result.committed).toBe(allowed);
  }
  expect(c.tools[0]!.execute({ address: outside.fact })).toContain(outside.fact);
});

// Footer progress retains `knowledge` as the applicable-current total in `currentKnowledge`'s
// counting unit. The display partitions those exact versions into unprocessed and processed; two
// divergent tips remain two items. Consolidation membership is exact over the same path.
// Deferred to 64c: processed/unprocessed knowledge partitions and certification counters are removed there.
test.skip("footer progress retains total current-tip semantics while exposing its exact-version split", async () => {
  const { c, d, peer, edit, tips } = commitPaths();
  await edit(c, "C version", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1));
  await edit(d, "D version", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2));
  const third = peer();
  expect(tips(third)).toEqual([2, 3]); // two divergent tips of K1 on this path
  const counted = memory.progress(third.sessionId, third.branch, third.headTurnId);
  expect(counted).toMatchObject({ knowledge: 2, changedKnowledge: 2 });
  expect(counted.knowledge).toBe(memory.store.currentKnowledge({ sessionId: third.sessionId, headTurnId: third.headTurnId, branch: third.branch }).length);
  expect(counted).toMatchObject({ facts: 1 });
  expect(counted.entries).toBe(hydrate(memory.pendingEntries(third.sessionId, third.branch, third.headTurnId), memory.store).length);
  const after = memory.progress(third.sessionId, third.branch, third.headTurnId);
  expect(after).toMatchObject({ facts: 1, knowledge: 2, changedKnowledge: 2 });
  // The root path sees one tip of the same identity: the count follows the path, not the knowledge row.
  expect(memory.progress(1, "main", 1).knowledge).toBe(1);
});

test("2026-09-07 B: store rechecks every base inside the transaction and rolls back an earlier create", async () => {
  const { root, content, edit } = commitPaths();
  const trigger = createDreamerTrigger(memory, root, Number(root.fact.slice(1)), 1);
  const updated = await edit(root, "Use blue tiles", trigger);
  const successor = commitOf(updated.committed[0]);
  const origin = memory.store.triggerOrigin(root, root.triggerEntryId);
  const run = memory.store.bindRunOrigin({ kind: "manual", sessionId: root.sessionId, createdAt: time }, origin);
  const result = memory.store.commitConsolidationRun({ path: root, run, operations: [
    { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "test", text: "Must roll back", category: "goal", scope: "project", supports: [1], createdAt: time },
    { op: "archive", kind: "budget", reason: "Retired: the cited evidence withdraws this conclusion.", knowledgeId: 1, baseCommit: 1, supports: [1], createdAt: time },
  ] });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("stale batch committed");
  expect(result.problems.join(" ")).toContain(`K1@${successor}`);
  expect(memory.store.getKnowledge(trigger.knowledgeId + 1)).toBeNull();
  expect(memory.store.listKnowledgeRevisions(1)).toHaveLength(2);
});

test("2026-09-07 B: reading a historical commit never refreshes the base to an unread successor", async () => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  const path = { sessionId: other.sessionId, branch: other.branch, headTurnId: other.headTurnId };
  const trigger = createDreamerTrigger(memory, path, Number(other.fact.slice(1)), 1);
  const request = { fixture: "historical exact-read scenario" };
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!;
    const memoryTool = input.tools.find(tool => tool.name === "memory")!;
    expect(completeToolRead(trace, "K1@v1")).not.toContain("Unread successor");
    const first = JSON.parse(memoryTool.execute({ operations: [{ op: "update", id: tagged(1, 1), topics: [],
      reason: "Substantive correction of the recorded conclusion.", ...content(root.fact, "Unread successor") }], skipped: [] }));
    const successor = first.committed[0];
    expect(memoryTool.execute({ operations: [{ op: "update", id: tagged(1, 1), topics: [],
      reason: "Substantive correction of the recorded conclusion.", ...content(other.fact) }], skipped: [] })).toContain(`current: ${successor.version}`);
    expect(completeToolRead(trace, successor.version)).toContain("Unread successor");
    const corrected = JSON.parse(memoryTool.execute({ operations: [{ op: "update", id: tagged(1, commitOf(successor)), topics: [],
      reason: "Substantive correction of the recorded conclusion.", ...content(other.fact) }, { op: "archive", kind: "budget",
      id: tagged(trigger.knowledgeId, trigger.commit), supports: [other.fact], reason: "Retire the explicit fixture trigger." }], skipped: [] }));
    expect(corrected.committed[0].knowledgeId).toBe(1);
    return { outcome: "success", output: "scenario complete", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  expect(memory.store.currentCommit(1, path)[0]!.text).toBe("Use blue tiles");
  expect(memory.store.listKnowledgeRevisions(1).at(-1)!.text).toBe("Use blue tiles");
});

test("92: search previews and cursor fragments conceal tags and cannot make a stale base current", async () => {
  const { root, peer, content } = commitPaths();
  const other = peer(), path = { sessionId: other.sessionId, branch: other.branch, headTurnId: other.headTurnId };
  const trigger = createDreamerTrigger(memory, path, Number(other.fact.slice(1)), 1);
  const request = { fixture: "search previews and tagged bases" };
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, search = input.tools.find(tool => tool.name === "search")!;
    const write = input.tools.find(tool => tool.name === "memory")!;
    completeToolRead(trace, "K1@v1");
    const first = JSON.parse(write.execute({ operations: [{ op: "update", id: tagged(1, 1), topics: [], reason: "A substantive correction.",
      ...content(root.fact, `Unread successor ${"中文😀".repeat(350)}`) }], skipped: [] }));
    const successor = first.committed[0];
    const successorTag = tagged(1, commitOf(successor));
    const edit = (id = tagged(1, 1)) => JSON.parse(write.execute({ operations: [{ op: "update", topics: [], reason: "A substantive correction.", id,
      ...content(other.fact) }], skipped: [] }));
    let page = search.execute({ query: "Unread successor", layer: "knowledge", maxTokens: 256 });
    expect(page).not.toContain("rejected:"); expect(page).not.toMatch(/K\d+#[a-z]+/);
    expect(edit().results[0]).toContain(`current: ${successor.version}`);
    let count = 0;
    for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
      page = trace.execute({ address: "K1", cursor }); expect(page).not.toContain("rejected:");
      expect(page).not.toMatch(/K\d+#[a-z]+/); expect(++count).toBeLessThan(100);
    }
    expect(edit().results[0]).toContain(`current: ${successor.version}`);
    expect(page).not.toMatch(/K\d+#[a-z]+/);
    page = trace.execute({ address: "K1", full: true, pageBudget: 256 });
    expect(page).toContain("cursor=");
    for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
      expect(tokens(page)).toBeLessThanOrEqual(256); expect(page).not.toContain(successorTag);
      expect(edit().results[0]).toContain(`current: ${successor.version}`);
      page = trace.execute({ address: `cursor=${cursor}` });
    }
    expect(tokens(page)).toBeLessThanOrEqual(256);
    expect(page).toContain(successorTag);
    const done = edit(successorTag); expect(done.committed[0].knowledgeId).toBe(1);
    completeToolRead(trace, history(trigger.knowledgeId, trigger.commit));
    expect(JSON.parse(write.execute({ operations: [{ op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit),
      supports: [other.fact], reason: "Retire the explicit fixture trigger." }], skipped: [] })).committed).toHaveLength(1);
    return { outcome: "success", output: "scenario complete", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
});

test("92: trace K1 cap=1 exposes the complete body's tag without refreshing a stale base", async () => {
  const { root, peer, content } = commitPaths();
  const other = peer(), path = { sessionId: other.sessionId, branch: other.branch, headTurnId: other.headTurnId };
  const trigger = createDreamerTrigger(memory, path, Number(other.fact.slice(1)), 1), request = { fixture: "trace cap tagged base" };
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request); const trace = input.tools[0]!, write = input.tools.find(tool => tool.name === "memory")!;
    const successor = JSON.parse(write.execute({ operations: [{ op: "update", topics: [], reason: "New version.", id: tagged(1, 1),
      ...content(root.fact) }], skipped: [] })).committed[0];
    const edit = (id: string) => JSON.parse(write.execute({ operations: [{ op: "update", topics: [], reason: "Correct rule.", id,
      ...content(other.fact) }], skipped: [] }));
    let page = trace.execute({ address: "K1", cap: 1 }), count = 0;
    const pages = [page]; expect(page).toContain("cursor=");
    for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
      expect(edit(tagged(1, 1)).results[0]).toContain(`current: ${successor.version}`);
      page = trace.execute({ address: `cursor=${cursor}` }); expect(page).not.toContain("rejected:"); expect(++count).toBeLessThan(100); pages.push(page);
    }
    expect(pages.join("\n")).toContain(tagged(1, commitOf(successor)));
    expect(edit(tagged(1, 1)).results[0]).toContain(`current: ${successor.version}`);
    expect(edit(tagged(1, commitOf(successor))).committed[0].knowledgeId).toBe(1);
    expect(JSON.parse(write.execute({ operations: [{ op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit), supports: [other.fact],
      reason: "Retire the explicit fixture trigger." }], skipped: [] })).committed).toHaveLength(1);
    return { outcome: "success", output: "scenario complete", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
});

test.each([false, true])("trace cap=1 completes the frozen K read through actual cursors (address form=%s)", async addressForm => {
  const { root, peer, content } = commitPaths(); const other = peer();
  const created = root.write([{ op: "create", topics: [], reason: "New rule.", ...content(root.fact, "Second knowledge") }]).committed[0];
  const path = { sessionId: other.sessionId, branch: other.branch, headTurnId: other.headTurnId };
  const trigger = createDreamerTrigger(memory, path, Number(other.fact.slice(1)), Number(addressForm) + 1);
  const request = { fixture: "trace cursor completion", addressForm };
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request); const trace = input.tools[0]!, write = input.tools.find(tool => tool.name === "memory")!;
    const exact = tagged(created.knowledgeId, created.commit);
    const edit = () => JSON.parse(write.execute({ operations: [{ op: "update", topics: [], reason: "Correct rule.",
      id: exact, ...content(other.fact) }], skipped: [] }));
    let page = trace.execute({ address: `K${created.knowledgeId}`, cap: 1 }), count = 0, committed = false;
    while (true) {
      expect(page).not.toContain("rejected:"); const cursor = /cursor=(\S+)/.exec(page)?.[1]; if (!cursor) break;
      if (!committed && page.includes(exact)) {
        const attempt = edit();
        expect(attempt.committed[0].knowledgeId).toBe(created.knowledgeId); committed = true;
      }
      page = trace.execute(addressForm ? { address: `cursor=${cursor}` } : { address: "K1", cursor }); expect(++count).toBeLessThan(100);
    }
    expect(count).toBeGreaterThan(1);
    if (!committed) { expect(page).toContain(exact); expect(edit().committed[0].knowledgeId).toBe(created.knowledgeId); }
    const retired = JSON.parse(write.execute({ operations: [{ op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit), supports: [other.fact],
      reason: "Retire the explicit fixture trigger." }], skipped: [{ knowledge: "K1@v1", because: "Unrelated fixture base needs no maintenance." }] }));
    expect(retired.committed).toHaveLength(1);
    return { outcome: "success", output: "scenario complete", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
});

test("92: a mixed multi-K read exposes exact body tags; abandoned cursors expire without affecting write authority", async () => {
  const { root, peer, content } = commitPaths(); const other = peer();
  const created = root.write([2, 3].map(id => ({ op: "create", topics: [], reason: "New rule.", ...content(root.fact, `Rule ${id}`) }))).committed;
  const path = { sessionId: other.sessionId, branch: other.branch, headTurnId: other.headTurnId };
  const trigger = createDreamerTrigger(memory, path, Number(other.fact.slice(1)), 1), request = { fixture: "mixed paged tags" };
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request); const trace = input.tools[0]!, write = input.tools.find(tool => tool.name === "memory")!;
    const successor = JSON.parse(write.execute({ operations: [{ op: "update", topics: [], reason: "Unrelated new rule", id: tagged(1, 1),
      ...content(root.fact, "Unrelated new rule") }], skipped: [] })).committed[0];
    const operation = (id: string) => ({ op: "update", topics: [], reason: "Correct rule.", id, ...content(other.fact) });
    const submit = (operations: unknown[]) => JSON.parse(write.execute({ operations, skipped: [] }));
    const abandoned = trace.execute({ address: "K1", cap: 1 }), abandonedCursor = /cursor=(\S+)/.exec(abandoned)![1];
    for (let i = 0; i < 16; i++) trace.execute({ address: `K${created[0].knowledgeId}`, cap: 1 });
    expect(trace.execute({ address: `cursor=${abandonedCursor}` })).toContain("unknown or expired cursor");
    let page = trace.execute({ address: `K${created[0].knowledgeId},F1,F2,${created[1].version}`, cap: 1 }), count = 0;
    expect(page).toContain("cursor=");
    const maintained = new Set<number>();
    for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
      expect(++count).toBeLessThan(100);
      for (const item of created) if (!maintained.has(item.knowledgeId) && page.includes(tagged(item.knowledgeId, item.commit))) {
        expect(submit([operation(tagged(item.knowledgeId, item.commit))]).committed).toHaveLength(1);
        maintained.add(item.knowledgeId);
      }
      page = trace.execute({ address: "K1", cursor }); expect(page).not.toContain("rejected:");
    }
    expect(submit([operation(tagged(1, 1))]).results[0]).toContain(`current: ${successor.version}`);
    const remaining = created.filter((item: { knowledgeId: number }) => !maintained.has(item.knowledgeId));
    if (remaining.length) {
      for (const item of remaining) expect(page).toContain(tagged(item.knowledgeId, item.commit));
      const receipt = submit(remaining.map((item: { knowledgeId: number; commit: number }) => operation(tagged(item.knowledgeId, item.commit))));
      expect(receipt.committed).toHaveLength(remaining.length); for (const item of remaining) maintained.add(item.knowledgeId);
    }
    expect(maintained.size).toBe(2);
    const retired = JSON.parse(write.execute({ operations: [{ op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit), supports: [other.fact],
      reason: "Retire the explicit fixture trigger." }], skipped: [] }));
    expect(retired.committed).toHaveLength(1);
    return { outcome: "success", output: "scenario complete", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
});

// 93 retires fact intervals; comma lists still preserve the frozen mixed read.
test.each(["K2", "K2@v1", "K2,F1,F2,K1", "F1,F2,K2@v1,K1,K2"])("paged %s exposes the frozen old tag, never the later successor", async address => {
  const { root, peer, content } = commitPaths(); const other = peer();
  const created = root.write([{ op: "create", topics: [], reason: "New rule.", ...content(root.fact, "FROZEN-SECOND") }]).committed[0];
  const path = { sessionId: other.sessionId, branch: other.branch, headTurnId: other.headTurnId };
  const trigger = createDreamerTrigger(memory, path, Number(other.fact.slice(1)), 1), request = { fixture: "frozen paged read", address };
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request); const trace = input.tools[0]!, write = input.tools.find(tool => tool.name === "memory")!;
    const submit = (id: string, text = "Use blue tiles") => JSON.parse(write.execute({ operations: [{ op: "update", topics: [],
      reason: "Correct rule.", id, ...content(other.fact, text) }], skipped: [] }));
    let page = trace.execute({ address, cap: 1 }); expect(page).toContain("cursor=");
    const oldTag = tagged(created.knowledgeId, created.commit);
    const latest = submit(oldTag, "UNREAD-LATEST").committed[0];
    const latestTag = tagged(created.knowledgeId, commitOf(latest));
    const pages = [page];
    for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
      page = trace.execute({ address: `cursor=${cursor}` }); expect(page).not.toContain("rejected:");
      pages.push(page); expect(pages.length).toBeLessThan(100);
    }
    expect(pages.length).toBeGreaterThan(2); expect(pages.join("\n")).toContain("FROZEN-SECOND");
    expect(pages.join("\n")).not.toContain("UNREAD-LATEST");
    expect(pages.join("\n")).toContain(oldTag); expect(pages.join("\n")).not.toContain(latestTag);
    expect(submit(oldTag).results[0]).toContain(`current: ${latest.version}`);
    expect(submit(`K${created.knowledgeId}`).results[0]).toContain("supply an exact K#tag version");
    // The known exact tag works without another read; pagination holds no grant ledger.
    expect(submit(latestTag).committed[0].knowledgeId).toBe(created.knowledgeId);
    const retired = JSON.parse(write.execute({ operations: [{ op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit),
      supports: [other.fact], reason: "Retire the explicit fixture trigger." }],
      skipped: [{ knowledge: "K1@v1", because: "Unrelated fixture base needs no maintenance." }] }));
    expect(retired.committed).toHaveLength(1);
    return { outcome: "success", output: "scenario complete", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
});

test("41a: project/current defaults, version expansion and exact addresses preserve read scope", async () => {
  const { c, d, edit, publish } = commitPaths();
  const cTrigger = createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1);
  const cCommit = (await edit(c, "FILTER-C", cTrigger)).committed[0].commit as number;
  const dTrigger = createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2);
  const dCommit = (await edit(d, "FILTER-D", dTrigger)).committed[0].commit as number;
  publish(c);
  const current = memory.search("FILTER", "knowledge", c);
  expect(current).toContain(`[K1@${cCommit}]`);
  expect(current).not.toContain(`[K1@${dCommit}]`);
  expect(current).toContain("searched: project sessions; global/project/session knowledge, current versions");
  const historicalResults = memory.search("", "knowledge", { ...c, versions: "history" });
  expect(historicalResults).not.toContain("[K1@1]"); expect(historicalResults).toContain(`[K1@${cCommit}]`); expect(historicalResults).not.toContain(`[K1@${dCommit}]`);
  const all = memory.search("", "knowledge", { ...c, versions: "all" });
  expect(all).toContain(`[K1@${cCommit}]`);
  for (const commit of [1, dCommit]) expect(all).not.toContain(`[K1@${commit}]`);
  const trace = memory.trace("K1", c);
  expect(trace).toContain(`K1 path current: K1@${cCommit}`);
  expect(trace).not.toContain("Applicable history on this path:");
  expect(memory.trace("K1", { ...c, versions: "history" })).toContain("Applicable history on this path:");
  expect(memory.trace("K1", { ...c, versions: "all" })).toContain("Other branches' tips:");
  expect(memory.trace(history(1, dCommit), c)).toContain("FILTER-D");
  expect(memory.trace(`K1@v${memory.store.versionOrdinal(1, cCommit)}..v${memory.store.versionOrdinal(1, dCommit)}`, c)).toContain("FILTER-[-C-]{+D+}");
});

test("41a: category and unified scope filter candidates and cursor options are frozen", () => {
  const { root, c, peer } = commitPaths();
  const sameProject = peer(), foreign = peer(memory.store.createProject({ name: "foreign-41a", declaredBy: "mark" }).id);
  const create = (who: typeof root, text: string, category: "open" | "reference", scope: "project" | "global") =>
    who.write([{ op: "create", text, category, scope, supports: [who.fact], reason: "41a fixture", topics: [] }]).committed[0];
  const shared = create(sameProject, "SAME-PROJECT-41A", "open", "project");
  const global = create(foreign, "FOREIGN-GLOBAL-41A", "reference", "global");
  const search = c.tools.find(tool => tool.name === "search")!;
  const facts = search.execute({ query: "main", layer: "facts" });
  expect(facts).toContain(`[F${sameProject.fact.slice(1)}]`);
  expect(facts).not.toContain(`[F${foreign.fact.slice(1)}]`);
  expect(search.execute({ query: "main", layer: "facts", scope: "global" })).toContain(`[F${foreign.fact.slice(1)}]`);
  expect(search.execute({ query: "41A", category: "open" })).toContain(`[${shared.version}]`);
  expect(search.execute({ query: "41A", category: "open" })).not.toContain(`[${global.version}]`);
  expect(search.execute({ query: "FOREIGN-GLOBAL", layer: "knowledge" })).toContain(`[${global.version}]`);
  expect(search.execute({ query: "FOREIGN-GLOBAL", layer: "knowledge", scope: "session" })).not.toContain(`[${global.version}]`);
  expect(search.execute({ query: "41A", layer: "facts", category: "open" })).toContain("rejected: category filter requires layer knowledge");
  let page = search.execute({ query: "", layer: "knowledge", versions: "all", cap: 1 });
  const cursor = /cursor=(\S+)/.exec(page)![1]!;
  expect(search.execute({ query: "", cursor, versions: "history" })).toContain("rejected: cursor versions is frozen");
  page = search.execute({ query: "", cursor, versions: "all" });
  expect(page).not.toContain("rejected:");
});

test("41b: search previews budget text independently of long fact evidence metadata", () => {
  const { c } = commitPaths();
  const entry = memory.store.listSourceEntries(c.sessionId, c.headTurnId)[0]!;
  const receipt = legacyFacts(memory.store, { kind: "noting", sessionId: c.sessionId, branch: c.branch, createdAt: time }, [{
    sources: [{ entry, address: `T${c.headTurnId}#user` }], category: "observation", actor: "user",
    text: "PREVIEW-FACT " + "word ".repeat(300), quote: "quote ".repeat(2000), createdAt: time,
  }]);
  const factId = receipt.facts[0]!.id;
  const search = c.tools.find(tool => tool.name === "search")!;
  const preview = search.execute({ query: "PREVIEW-FACT", layer: "facts" });
  expect(preview).toContain(`[F${factId}] [observation/user]`);
  expect(preview).toContain("characters truncated");
  expect(preview).not.toContain("quote:"); expect(preview).not.toContain("source:");
  expect(preview).toContain("preview: text only");
  expect(preview.split("\n").filter((line: string) => line.startsWith(`[F${factId}]`))).toHaveLength(1);
  const tiny = search.execute({ query: "PREVIEW-FACT", layer: "facts", itemBudget: 1 });
  expect(tiny).toContain(`[F${factId}] [observation/user] [...`);
});

test("41 review: fact and knowledge previews are one physical line with head-only Unicode-safe cuts", () => {
  const { c, publish } = commitPaths();
  publish(c);
  const longFactText = "FACT-LONG-41 " + "alpha 😀 ".repeat(180) + "\nFACT-LONG-TAIL";
  const entry = memory.store.listSourceEntries(c.sessionId, c.headTurnId)[0]!;
  const factReceipt = legacyFacts(memory.store, { kind: "noting", sessionId: c.sessionId, branch: c.branch, createdAt: time }, [{
    sources: [{ entry, address: `T${c.headTurnId}#user` }], category: "observation", actor: "user",
    text: longFactText, createdAt: time,
  }]);
  const factId = factReceipt.facts[0]!.id;
  const longKnowledgeText = "KNOWLEDGE-LONG-41 " + "beta 🚀 ".repeat(180) + "\nKNOWLEDGE-LONG-TAIL";
  const created = c.write([{ op: "create", text: longKnowledgeText, category: "reference", scope: "project",
    supports: [c.fact], topics: ["metadata\nline"], reason: "reason\nline" }]).committed[0];
  const search = c.tools.find(tool => tool.name === "search")!;
  const hit = (result: string) => result.split("\n\nReceipts:")[0]!;

  const fact = hit(search.execute({ query: "FACT-LONG-41", layer: "facts" }));
  expect(fact).not.toContain("\n"); expect(fact).toContain("characters truncated"); expect(fact).not.toContain("FACT-LONG-TAIL");
  const knowledge = hit(search.execute({ query: "KNOWLEDGE-LONG-41", layer: "knowledge" }));
  expect(knowledge).not.toContain("\n"); expect(knowledge).toContain("characters truncated"); expect(knowledge).not.toContain("KNOWLEDGE-LONG-TAIL");

  const fullFact = hit(search.execute({ query: "FACT-LONG-41", layer: "facts", itemBudget: null }));
  expect(fullFact).not.toContain("\n"); expect(fullFact).toContain(" ⏎ FACT-LONG-TAIL"); expect(fullFact).toContain("😀");
  const fullKnowledge = hit(search.execute({ query: "KNOWLEDGE-LONG-41", layer: "knowledge", versions: "history",
    itemBudget: null, fields: ["text", "topics", "reason", "status"] }));
  expect(fullKnowledge).not.toContain("\n"); expect(fullKnowledge).toContain(" ⏎ KNOWLEDGE-LONG-TAIL");
  expect(fullKnowledge).toContain('topics: ["metadata\\nline"]'); expect(fullKnowledge).toContain("reason: reason ⏎ line");
  expect(hit(search.execute({ query: "FACT-LONG-41", layer: "facts", itemBudget: 1 }))).toMatch(/^\[F\d+\] \[observation\/user\] \[\.\.\. \d+ characters truncated\]$/);
  expect(hit(search.execute({ query: "KNOWLEDGE-LONG-41", layer: "knowledge", itemBudget: 1 }))).toMatch(/^\[K\d+@v\d+\] \[reference\/project\] \[\.\.\. \d+ characters truncated\]$/);

  expect(memory.trace(`F${factId}`, { itemBudget: null, pageBudget: null })).toContain(longFactText);
  expect(memory.trace(history(created.knowledgeId, created.commit), { itemBudget: null, pageBudget: null })).toContain(longKnowledgeText);
});

test("41b/92: fields control tag display, while a known exact tag needs no read ledger", async () => {
  const { root, peer, content } = commitPaths(); const other = peer();
  const path = { sessionId: other.sessionId, branch: other.branch, headTurnId: other.headTurnId };
  const trigger = createDreamerTrigger(memory, path, Number(other.fact.slice(1)), 1), request = { fixture: "fields select tag display" };
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request); const trace = input.tools[0]!, search = input.tools[1]!, write = input.tools.find(tool => tool.name === "memory")!;
    const update = (id: string, text: string) => JSON.parse(write.execute({ operations: [{ op: "update", id,
      ...content(other.fact, text), topics: [], reason: "41b update" }], skipped: [] }));
    const successor = update(tagged(1, 1), "BASE-SUCCESSOR").committed[0];
    const exact = tagged(1, commitOf(successor));
    const noText = trace.execute({ address: exact, fields: ["supports", "reason"] });
    expect(noText).toContain("change supports"); expect(noText).not.toContain("BASE-SUCCESSOR"); expect(noText).not.toContain("reason:");
    expect(noText).not.toMatch(/K\d+#[a-z]+/);
    const preview = search.execute({ query: "BASE-SUCCESSOR", layer: "knowledge", itemBudget: null, fields: ["text", "supports"] });
    expect(preview).toContain("BASE-SUCCESSOR"); expect(preview).not.toMatch(/K\d+#[a-z]+/);
    // The receipt is tagless, but scope and the exact tag, not read history, authorize this write.
    const finite = update(exact, "FINITE-COMPLETE").committed[0];
    const finiteTag = tagged(1, commitOf(finite));
    expect(trace.execute({ address: finite.version, full: true })).toContain(finiteTag);
    expect(update(finiteTag, "FULL-COMPLETE").committed[0].knowledgeId).toBe(1);
    write.execute({ operations: [{ op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit), supports: [other.fact],
      reason: "Retire the explicit fixture trigger." }], skipped: [] });
    return { outcome: "success", output: "scenario complete", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  expect(root.tools[0]!.execute({ address: "K1@v1", versions: "all", fields: ["reason"] })).not.toContain("reason:");
  expect(root.tools[0]!.execute({ address: "K1", versions: "history", fields: ["reason"] })).toContain("reason:");
});

test("41 review: search history defaults show existing statuses while current and explicit fields stay compact", async () => {
  const { c, d, publish } = commitPaths();
  publish(c);
  const cReceipt = await admittedWrite(c, createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1), [{ op: "update", id: tagged(1, 1),
    text: "SEARCH-STATUS-C", category: "constraint", scope: "project", supports: [c.fact], topics: [], reason: "Search status C." }]);
  const cRevision = cReceipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1)!;
  publish(d);
  const dReceipt = await admittedWrite(d, createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2), [{ op: "update", id: tagged(1, 1),
    text: "SEARCH-STATUS-D", category: "constraint", scope: "project", supports: [d.fact], topics: [], reason: "Search status D." }]);
  const dRevision = dReceipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1)!;
  publish(c);
  const path = { sessionId: c.sessionId, headTurnId: c.headTurnId, branch: c.branch };
  const hits = (result: string) => result.split("\n\nReceipts:")[0]!;

  const current = memory.search("", "knowledge", path);
  expect(current).toContain(`[K1@${cRevision!.commit}]`); expect(current).not.toContain("status:");
  expect(current).toContain("preview: text only");
  const history = memory.search("", "knowledge", { ...path, versions: "history" });
  expect(history).not.toContain("[K1@1]");
  expect(memory.search("Use blue tiles", "knowledge", { ...path, versions: "history" })).toContain(`status: superseded on this path by K1@${cRevision!.commit}`);
  expect(history).toContain(`[K1@${cRevision!.commit}]`); expect(history).toContain("status: current on this path");
  expect(history).toContain("preview: fields text, status");
  const all = memory.search("", "knowledge", { ...path, versions: "all" });
  expect(all).not.toContain(`[K1@${dRevision!.commit}]`);
  expect(memory.search("SEARCH-STATUS-D", "knowledge", { ...path, versions: "all" })).toContain("status: another branch");

  const textOnly = memory.search("", "knowledge", { ...path, versions: "all", fields: ["text"] });
  expect(textOnly).not.toContain("status:"); expect(textOnly).toContain("preview: text only");
  const identityOnly = memory.search("SEARCH-STATUS-C", "knowledge", { ...path, versions: "all", fields: [] });
  expect(hits(identityOnly)).toBe(`[K1@${cRevision!.commit}] [constraint/project]`);
  expect(identityOnly).toContain("preview: identity only"); expect(identityOnly).toMatch(/omitted fields: .*status/);

  const secondStatus = c.write([{ op: "create", text: "SECOND-STATUS", category: "reference", scope: "project", supports: [c.fact], topics: [], reason: "Cursor fixture." }]).committed[0];
  const first = memory.search("", "knowledge", { ...path, versions: "all", cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  expect(memory.search("", "knowledge", { ...path, cursor, fields: ["text", "status"], cap: 1 })).not.toContain("unknown or expired cursor");
  const changed = memory.search("", "knowledge", { ...path, versions: "all", cap: 1 });
  const changedCursor = /cursor=(\S+)/.exec(changed)![1]!;
  expect(() => memory.search("", "knowledge", { ...path, cursor: changedCursor, fields: ["text"], cap: 1 })).toThrow("cursor fields is frozen");
  expect(memory.search("", "knowledge", { ...path, cursor: changedCursor, cap: 1 })).not.toContain("unknown or expired cursor");

  const factCurrent = hits(memory.search("C", "facts", path));
  expect(hits(memory.search("C", "facts", { ...path, versions: "all" }))).toBe(factCurrent);
  const rawCurrent = hits(memory.search("C", "raw", path));
  expect(hits(memory.search("C", "raw", { ...path, versions: "all" }))).toBe(rawCurrent);

  const archived = c.write([{ op: "create", text: "ARCHIVE-STATUS", category: "constraint", scope: "project",
    supports: [c.fact], topics: [], reason: "Archive status fixture." }]).committed[0];
  await admittedWrite(c, createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 3), [{ op: "archive", kind: "budget",
    id: tagged(archived.knowledgeId, archived.commit), supports: [c.fact], reason: "Archive status fixture." }],
    [secondStatus.version]);
  expect(memory.search("ARCHIVE-STATUS", "knowledge", { ...path, versions: "history" })).toContain("status: archived on this path");

  const searchFields = (toolDefinitions.find(tool => tool.name === "search")!.parameters.properties as Record<string, any>).fields;
  expect(searchFields).not.toHaveProperty("default");
});

test("41 review: history defaults include reasons and partition applicable from other branches", async () => {
  const { root, c, d, edit, content, publish } = commitPaths();
  const cCommit = (await edit(c, "HISTORY-C", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1))).committed[0].commit as number;
  const dCommit = (await edit(d, "HISTORY-D", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2))).committed[0].commit as number;
  publish(c);
  const linear = root.write([{ op: "create", ...content(root.fact, "LINEAR-HISTORY"), topics: [], reason: "Linear reason." }]).committed[0];
  const path = { sessionId: c.sessionId, headTurnId: c.headTurnId, branch: c.branch };

  expect(memory.trace("K1", path)).not.toContain("reason:");
  expect(memory.trace("K1@v1", { ...path, versions: "history" })).not.toContain("reason:");
  const history = memory.trace("K1", { ...path, versions: "history" });
  expect(history.match(/^  K1@\d+ .* reason: /gm)).toHaveLength(2);
  const all = memory.trace("K1", { ...path, versions: "all" });
  expect(all).toContain(`[K1@${cCommit}] [constraint/project] HISTORY-C`);
  expect(all).not.toContain("All branch commits:");
  expect(all).toContain("Other branches' commits:");
  const applicableSection = all.split("Applicable history on this path:")[1]!.split("Other branches' tips:")[0]!;
  const otherSection = all.split("Other branches' commits:")[1]!;
  const commits = (section: string, knowledgeId = 1) => [...section.matchAll(new RegExp(`^  K${knowledgeId}@(\\d+)`, "gm"))].map(match => Number(match[1]));
  const applicable = commits(applicableSection), other = commits(otherSection);
  expect(applicable).toEqual([1, cCommit]); expect(other).toEqual([dCommit]);
  expect(new Set([...applicable, ...other])).toEqual(new Set([1, cCommit, dCommit]));
  expect(applicable.some(commit => other.includes(commit))).toBe(false);

  const noOtherBranch = memory.trace(`K${linear.knowledgeId}`, { ...path, versions: "all" });
  expect(commits(noOtherBranch.split("Applicable history on this path:")[1]!.split("Other branches' tips:")[0]!, linear.knowledgeId)).toEqual([linear.commit]);
  expect(commits(noOtherBranch.split("Other branches' commits:")[1]!, linear.knowledgeId)).toEqual([]);
  expect(noOtherBranch.match(new RegExp(`^  K${linear.knowledgeId}@${linear.commit}`, "gm"))).toHaveLength(1);

  expect(memory.trace("K1", { ...path, versions: "history", fields: ["text"] })).not.toContain("reason:");
  expect(memory.trace("K1", { ...path, versions: "history", fields: ["reason"] })).toContain("reason:");
  expect(memory.trace("K1", { ...path, versions: "all", fields: ["text"] })).not.toContain("reason:");
  expect(memory.trace("K1", { ...path, versions: "all" }).match(/^  K1@\d+ .* reason: /gm)).toHaveLength(3);

  const first = memory.trace("K1", { ...path, versions: "history", cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  const defaults = ["text", "supports", "topics", "status", "links", "reason"] as const;
  expect(memory.trace(`cursor=${cursor}`, { ...path, versions: "history", fields: defaults, cap: 1 })).not.toContain("unknown or expired cursor");
  const changed = memory.trace("K1", { ...path, versions: "history", cap: 1 });
  const changedCursor = /cursor=(\S+)/.exec(changed)![1]!;
  expect(() => memory.trace(`cursor=${changedCursor}`, { ...path, fields: defaults.slice(0, -1), cap: 1 })).toThrow("cursor fields is frozen");
  expect(memory.trace(`cursor=${changedCursor}`, { ...path, cap: 1 })).not.toContain("unknown or expired cursor");
  const traceFields = (toolDefinitions.find(tool => tool.name === "trace")!.parameters.properties as Record<string, any>).fields;
  expect(traceFields).not.toHaveProperty("default");
});

test("41 repair: knowledge search shows requested reasons only for history and all previews", async () => {
  const { c, d, edit, publish } = commitPaths();
  await edit(c, "REASON-TEXT-C", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1));
  await edit(d, "REASON-TEXT-D", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2));
  publish(c);
  const current = memory.search("", "knowledge", { ...c, fields: ["reason"] });
  expect(current).not.toContain("reason:");
  expect(current).toContain("preview: identity only");
  expect(current).toMatch(/omitted fields: .*reason/);

  const history = memory.search("REASON-TEXT-C", "knowledge", { ...c, versions: "history", fields: ["reason"] });
  expect(history).not.toContain("reason: Initial admission of this conclusion.");
  expect(memory.search("Use blue tiles", "knowledge", { ...c, versions: "history", fields: ["reason"] })).toContain("reason: Initial admission of this conclusion.");
  expect(history).toContain("reason: Substantive correction of the recorded conclusion.");
  expect(history).not.toContain("REASON-TEXT-C");
  expect(history).toContain("preview: fields reason; omitted fields:");
  expect(history.match(/reason:/g)).toHaveLength(1);

  const mixed = memory.search("", "knowledge", { ...c, versions: "all", fields: ["text", "reason"] });
  expect(mixed).toContain("REASON-TEXT-C");
  expect(mixed).not.toContain("REASON-TEXT-D");
  expect(mixed.match(/reason: Substantive correction of the recorded conclusion\./g)).toHaveLength(1);
  expect(memory.search("REASON-TEXT-D", "knowledge", { ...c, versions: "all", fields: ["reason"] })).toContain("reason: Substantive correction of the recorded conclusion.");
  expect(mixed).toContain("preview: fields text, reason; omitted fields:");

  const longReason = "because ".repeat(200).trim();
  c.write([{ op: "create", ...{ text: "LONG-REASON-TEXT", category: "constraint", scope: "project", supports: [c.fact] },
    topics: [], reason: longReason }]);
  const long = memory.search("LONG-REASON-TEXT", "knowledge", { ...c, versions: "history", fields: ["text", "reason"] });
  expect(long).toContain("characters truncated");
  expect(long).toContain(`reason: ${longReason}`);
});

test("41b: fields and budgets freeze across pages; public pages cap at 8000 while internal null remains", () => {
  const { c, content } = commitPaths();
  c.write(["SECOND-41B", "THIRD-41B"].map(text => ({ op: "create", ...content(c.fact, text), topics: [], reason: "41b fixture" })));
  const search = c.tools.find(tool => tool.name === "search")!, trace = c.tools.find(tool => tool.name === "trace")!;
  expect(search.execute({ query: "", layer: "knowledge", maxTokens: 8001 })).toContain("rejected: maxTokens");
  expect(trace.execute({ address: "K1", pageBudget: 8001 })).toContain("rejected: pageBudget");
  const searchProperties = search.parameters.properties as Record<string, unknown>, traceProperties = trace.parameters.properties as Record<string, unknown>;
  expect(searchProperties.maxTokens).toMatchObject({ maximum: 8000, default: 2000 });
  expect(traceProperties.pageBudget).toMatchObject({ maximum: 8000, default: 2000 });
  let page = search.execute({ query: "", layer: "knowledge", versions: "all", fields: ["text", "supports"], itemBudget: 20, cap: 1 });
  const cursor = /cursor=(\S+)/.exec(page)![1]!;
  expect(search.execute({ query: "", cursor, fields: ["text"] })).toContain("rejected: cursor fields is frozen");
  expect(search.execute({ query: "", cursor, itemBudget: 21 })).toContain("rejected: cursor itemBudget is frozen");
  page = search.execute({ query: "", cursor });
  expect(page).not.toContain("rejected:");
  expect(memory.trace("K1@v1", { pageBudget: null })).toContain("[K1@1]");
});

test("64b/34a: global current scope hides the identity without visible fallback", async () => {
  const { root, peer, content, publish } = commitPaths();
  publish(root);
  const maintain = async (text: string, scope: "global" | "project" | "session", sequence: number) => {
    const current = memory.store.currentCommit(1, root)[0]!;
    const trigger = createDreamerTrigger(memory, root, Number(root.fact.slice(1)), sequence, current.scope);
    const receipt = await admittedWrite(root, trigger, [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
      id: tagged(1, current.id), ...content(root.fact, text), scope }]);
    return receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1).commit as number;
  };
  await maintain("Shared globally", "global", 1);
  const outsideProject = memory.store.createProject({ name: "outside", declaredBy: "mark" });
  const outside = peer(outsideProject.id);
  const projectCommit = await maintain("Project only", "project", 2);
  expect(memory.inject({ projectId: outsideProject.id })).not.toMatch(/K1[#@]/);
  expect(memory.trace("K1", outside).split("\n")[0]).toBe("K1 path current: none");
  const sessionCommit = await maintain("Session only", "session", 3);
  const ownProject = memory.store.getSession(root.sessionId)!.projectId;
  expect(memory.inject({ projectId: ownProject })).not.toContain(tagged(1, projectCommit));
  expect(memory.inject({ projectId: ownProject })).not.toContain(tagged(1, sessionCommit));
  expect(memory.inject({ projectId: outsideProject.id })).not.toMatch(/K1[#@]/);
  expect(memory.inject(root)).toContain(tagged(1, sessionCommit));
});

test("2026-09-07: commit schema removes mutable heads and binds parents and links to global ids", () => {
  const { root, content } = commitPaths();
  root.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact, "Another identity") }]);
  const columns = (table: string) => memory.store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  expect(columns("knowledge")).not.toContain("status"); expect(columns("knowledge")).not.toContain("current_revision");
  expect(columns("knowledge_revisions")).not.toContain("rev"); expect(columns("knowledge_revisions")).toContain("parent_id");
  expect(memory.store.getKnowledgeRevision(2, 2)?.id).toBe(2); expect(memory.store.getKnowledgeRevision(2, 1)).toBeNull();
  for (const sql of [
    "INSERT INTO knowledge_links VALUES (1, 2, 'merged_into', 1, 1)",
    "INSERT INTO knowledge_links VALUES (1, 1, 'merged_into', 1, 2)",
    "UPDATE knowledge_revisions SET parent_id = 999 WHERE id = 1",
  ]) expect(() => memory.store.db.exec(sql)).toThrow(/FOREIGN KEY/);
});

test("64b: stale absorbed bases name the surviving current commit across merge links", async () => {
  const { root, peer, content, publish } = commitPaths();
  const second = root.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact) }]).committed[0];
  const other = peer(); other.read(second.version);
  publish(root);
  const mergeTrigger = createDreamerTrigger(memory, root, Number(root.fact.slice(1)), 1);
  const mergedReceipt = await admittedWrite(root, mergeTrigger, [{ op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.",
    id: tagged(1, 1), absorb: [tagged(second.knowledgeId, second.commit)], ...content(root.fact) }]);
  const merged = mergedReceipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1)!;
  const updateTrigger = createDreamerTrigger(memory, root, Number(root.fact.slice(1)), 2);
  const updatedReceipt = await admittedWrite(root, updateTrigger, [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
    id: tagged(1, merged.commit), ...content(root.fact, "Surviving current conclusion") }]);
  const survivor = updatedReceipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1)!;
  publish(other);
  const staleTrigger = createDreamerTrigger(memory, other, Number(other.fact.slice(1)), 3);
  const request = { fixture: "absorbed stale handle" }; let rejected = "";
  const result = await admittedScenarios.run(memory, other, input => {
    input.reportRequest(request); const trace = input.tools[0]!, write = input.tools.find(tool => tool.name === "memory")!;
    completeToolRead(trace, second.version);
    completeToolRead(trace, history(staleTrigger.knowledgeId, staleTrigger.commit));
    rejected = write.execute({ operations: [{ op: "update", id: tagged(second.knowledgeId, second.commit), topics: [],
      reason: "Substantive correction of the recorded conclusion.", ...content(other.fact, "Invalid absorbed edit") }], skipped: [] });
    expect(rejected).toContain(`current: ${survivor.version}`);
    const supplied = suppliedHandles(input.material.changed)
      .filter((knowledge: string) => knowledge !== history(staleTrigger.knowledgeId, staleTrigger.commit))
      .map((knowledge: string) => ({ knowledge, because: "The stale absorbed edit was correctly refused." }));
    write.execute({ operations: [{ op: "archive", kind: "budget", id: tagged(staleTrigger.knowledgeId, staleTrigger.commit), supports: [other.fact],
      reason: "Retire explicit trigger." }], skipped: supplied });
    return { outcome: "success", output: "stale absorbed handle checked", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  expect(memory.store.getKnowledge(second.knowledgeId)).not.toBeNull();
  expect(memory.store.currentCommit(second.knowledgeId, other)).toEqual([]);
});

test("16b: path trace separates applicable history, parents, children and sibling tips", async () => {
  const { root, c, d, edit, publish } = commitPaths();
  const cCommit = (await edit(c, "C version", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1))).committed[0].commit as number;
  const dCommit = (await edit(d, "D version", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2))).committed[0].commit as number;
  publish(c);
  const trace = memory.trace("K1", { ...c, versions: "all" });
  expect(trace).toContain(`K1 path current: K1@${cCommit}`);
  expect(trace).toContain("parents: K1@1");
  const [history, others] = trace.split("Applicable history on this path:")[1]!.split("Other branches' tips:");
  expect(history).toContain("K1@1 create"); expect(history).toContain(`K1@${cCommit} update`); expect(history).not.toContain(`K1@${dCommit}`);
  expect(others).toContain(`K1@${dCommit}`);
  publish(root);
  expect(memory.trace("K1", root)).toContain("K1 path current: K1@1");
  const tree = memory.trace("K1", { versions: "all" });
  expect(tree).toContain(`children: K1@${cCommit}, K1@${dCommit}`);
  for (const id of [1, cCommit, dCommit]) expect(tree).toContain(`K1@${id}`);
  expect(memory.trace("K1").split("\n")[0]).not.toMatch(/current/i);
  expect(memory.trace("K1@v1")).toContain(`children: K1@${cCommit}, K1@${dCommit}`);
});

// 93 removes commit-address diffs and K.. public history, but keeps per-identity ordinal ranges.
test("93: numbered version ranges compare siblings in both directions, reject missing versions", async () => {
  const { c, d, edit } = commitPaths();
  const cCommit = (await edit(c, "C version", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1))).committed[0].commit as number;
  const dCommit = (await edit(d, "D version", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2))).committed[0].commit as number;
  const cVersion = memory.store.versionOrdinal(1, cCommit), dVersion = memory.store.versionOrdinal(1, dCommit);
  expect(memory.trace(`K1@v${cVersion}..v${dVersion}`)).toContain("[-C-]{+D+} version");
  expect(memory.trace(`K1@v${dVersion}..v${cVersion}`)).toContain("[-D-]{+C+} version");
  expect(memory.trace(`K1@v${cVersion}..v${cVersion}`)).toContain("History: none");
  expect(c.tools[0]!.execute({ address: "K1@v57" })).toContain("unknown knowledge history K1@v57");
  expect(c.tools[0]!.execute({ address: `K1@v${cVersion}..v57` })).toContain("unknown knowledge history K1@v57");
  expect(() => memory.trace(`K1@v${cVersion}..K2@v${dVersion}`)).toThrow("invalid public trace address");
});


test("16b: search notes describe the supplied path, including archives and unrestricted siblings", async () => {
  const { root, c, d, edit, publish } = commitPaths();
  const cCommit = (await edit(c, "C version", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1))).committed[0].commit as number;
  await edit(d, "D version", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2));
  publish(c);
  const hits = memory.search("", "knowledge", { ...c, versions: "all", fields: ["text", "status"] }).split("\n");
  expect(memory.search("Use blue tiles", "knowledge", { ...c, versions: "all" })).toContain(`superseded on this path by K1@${cCommit}`);
  expect(hits.find(l => l.startsWith(`[K1@${cCommit}]`))).toContain("current on this path");
  expect(memory.search("D version", "knowledge", { ...c, versions: "all" })).toContain("another branch");
  expect(memory.search("C version", "knowledge", { ...root, versions: "all", fields: ["text", "status"] })).toContain("current on this path");
  expect(c.tools[0]!.execute({ address: "K1" })).toContain("C version");
  const archiveTrigger = createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 3);
  const archived = await admittedWrite(c, archiveTrigger, [{ op: "archive", kind: "budget", reason: "Retired: the cited evidence withdraws this conclusion.",
    id: tagged(1, cCommit), supports: [c.fact] }]);
  expect(archived.committed[0].knowledgeId).toBe(1);
  expect(memory.search("C version", "knowledge", { ...c, versions: "history", fields: ["text", "status"] })).toContain("archived on this path");
  expect(memory.search("D version", "knowledge", { ...d, fields: ["text", "status"] })).not.toContain("current on this path");
  publish(d);
  expect(memory.search("D version", "knowledge", { ...c, fields: ["text", "status"] })).toContain("current on this path");
});

test("64b: compaction follows the owner's published foreground across a branch switch", async () => {
  const { c, d, edit, publish } = commitPaths();
  const cCommit = (await edit(c, "C version", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1))).committed[0].commit as number;
  const dCommit = (await edit(d, "D version", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2))).committed[0].commit as number;
  publish(c);
  const onC = compacted(memory.compact(c.sessionId, c.branch, c.headTurnId));
  expect(onC).toContain(`[${tagged(1, cCommit)}]`); expect(onC).not.toContain(`[${tagged(1, dCommit)}]`);
  publish(d);
  const afterSwitch = compacted(memory.compact(c.sessionId, c.branch, c.headTurnId));
  expect(afterSwitch).toContain(`[${tagged(1, dCommit)}]`); expect(afterSwitch).not.toContain(`[${tagged(1, cCommit)}]`);
});

test("16b: branch carry fixture uses evidence ancestry, includes commits and raw; tags delimit and lines stay byte for byte", async () => {
  const { c, d, node, edit, publish } = commitPaths();
  const cCommit = (await edit(c, "C version", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1))).committed[0].commit as number;
  const dCommit = (await edit(d, "D version", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2))).committed[0].commit as number;
  publish(c);
  recorded(memory, c.sessionId, c.branch, c.headTurnId);
  const tail = memory.store.appendTurn({ sessionId: c.sessionId, parentTurnId: c.headTurnId, kind: "turn", userPrompt: "Unrecorded <work> & more", assistantText: "Pending", startedAt: time });
  node(c.sessionId, tail.id, c.branch); // Same branch label, but after the leaving position.
  const carry = memory.branchSummary(c.sessionId, c.branch, tail.id);
  expect(carry.match(/<branch_carry>/g)).toHaveLength(1);
  expect(carry.match(/<\/branch_carry>/g)).toHaveLength(1);
  expect(carry).toContain("Unrecorded <work> & more"); // never escaped (ruling 15:14)
  expect(carry).not.toContain(`[${tagged(1, dCommit)}]`);
  expect(carry).toContain(`[${tagged(1, 1)}]`); expect(carry).toContain(`[${tagged(1, cCommit)}]`);
});

test("16b: a fact whose only source is an injected compaction message lacks a raw source", () => {
  const { root, c, d } = commitPaths();
  const injected = memory.store.appendTurn({ sessionId: c.sessionId, parentTurnId: c.headTurnId, kind: "compaction", assistantText: "<knowledge>Only injected: violet tiles</knowledge>", startedAt: time });
  const tools = memory.tools({ kind: "manual", sessionId: c.sessionId, branch: c.branch, currentTurnId: injected.id });
  const before = memory.store.listSessionFacts(c.sessionId);
  const fact = { title: "Injected-only text", sources: [{ address: `T${injected.id}#E1`, text: "Only injected: violet tiles" }] };
  expect(memory.store.listSourceEntries(c.sessionId, injected.id)).toEqual([]);
  expect(tools[2]!.execute({ facts: [fact] })).toContain(`invalid source T${injected.id}#E1; expected admissible Raw in the eligible entry set`);
  expect(tools[2]!.execute({ facts: [{ ...fact, sources: [] }] })).toContain("rejected:");
  expect(tools[2]!.execute({ facts: [{ ...fact, sources: [{ address: `T${d.headTurnId}#E1`, text: "Only injected: violet tiles" }] }] })).toContain(`invalid source T${d.headTurnId}#E1; expected admissible Raw in the eligible entry set`);
  expect(memory.store.listSessionFacts(c.sessionId)).toEqual(before);
  expect(tools[2]!.execute({ facts: [{ ...fact, sources: [{ address: `T${root.headTurnId}#E1`, text: "User required pnpm" }] }] })).toContain("ok: F");
});

test("64b/16b: every raw source of a multi-source fact constrains carry, current and citations", async () => {
  const { root, c, d, content, publish } = commitPaths();
  memory.store.updateTurn(c.headTurnId, { assistantText: "Use violet tiles" });
  const turns = memory.store.pathTurns(c);
  const entries = hydrate(memory.store.listSourceEntries(c.sessionId), memory.store).filter(entry => turns.has(entry.turnId));
  memory.selectEntries(c.sessionId, c.branch, entries.map(entry => entry.id));
  const tools = memory.tools({ kind: "manual", sessionId: c.sessionId, branch: c.branch,
    currentTurnId: c.headTurnId, triggerEntryId: entries.at(-1)!.id });
  const fact = JSON.parse(tools[2]!.execute({ facts: [{ title: "Violet tile decision", sources: [
    { address: `T${root.headTurnId}#E1`, text: "Initial tile rule" },
    { address: `T${c.headTurnId}#E2`, text: "Use violet tiles" },
  ] }] })).factIds[0] as number;
  publish(c);
  const trigger = createDreamerTrigger(memory, c, fact, 1);
  const updated = await admittedWrite(c, trigger, [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
    id: tagged(1, 1), ...content(`F${fact}`, "Use violet tiles") }]);
  const commit = updated.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1).commit;
  for (const path of [root, d]) {
    publish(path);
    expect(memory.branchSummary(path.sessionId, path.branch, path.headTurnId)).not.toContain(`[F${fact}]`);
    expect(memory.inject(path)).toContain(`[${tagged(1, 1)}]`); expect(memory.inject(path)).not.toContain(`[${tagged(1, commit)}]`);
    expect(path.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(`F${fact}`) }]).results[0])
      .toContain("record an adoption fact on this path first");
  }
  publish(c);
  expect(memory.branchSummary(c.sessionId, c.branch, c.headTurnId)).toContain(`[F${fact}]`);
  expect(memory.inject(c)).toContain(`[${tagged(1, commit)}]`);
});

test("2026-09-07: R<n> renders a run as a summary, full adds tool rounds and raw previews, a missing run is rejected", async () => {
  const { s, t } = session();
  calls.length = 0;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const run = memory.store.listRuns(s.id).at(-1)!;
  const summary = memory.trace(`R${run.id}`);
  expect(summary.split("\n")[0]).toBe(`R${run.id} noting ${run.outcome} ${run.createdAt}`);
  expect(summary).toContain(`S${s.id} / branch main`); expect(summary).toContain("usage:"); expect(summary).toContain("problems:");
  expect(summary).not.toContain("request (preview");
  const full = memory.trace(`R${run.id}`, { full: true });
  expect(full).toContain("request (preview"); expect(full).toContain("response (preview");
  expect(() => memory.trace("R999")).toThrow("does not exist");
});

test("2026-09-07: R<n> shows the rejection reason of a manual write instead of claiming no problems", () => {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  tools[2]!.execute({ facts: [{ text: "bad source", source: ["T999#E1"] }] });
  const run = memory.store.listRuns(s.id).at(-1)!;
  expect(run.outcome).toBe("bounced");
  const summary = memory.trace(`R${run.id}`);
  expect(summary).not.toContain("problems: none");
  expect(summary).toMatch(/problems: .*(invalid source|rejected)/);
});

// ---- 20b 2026-09-08: three earlier rulings are superseded, recorded here by their own names ----

// 17b, 2026-09-08: "noting.batchTokens defaults to 50,000 compressed-view tokens". Superseded by
// ticket 20 on 2026-09-08: the Noting trigger and the batch ceiling are both 10,000 normal-view
// tokens. Ticket 20 also made that ceiling compact's inner Raw cap, and ticket 25 amendment 3
// (2026-09-09, 25c) supersedes that second half: a foreground backlog is not a Noter batch, so
// compact measures pending Raw against the shared episodic envelope alone. The 10,000 ceiling itself
// stands, for the phase it was always about.
test("20b 2026-09-08, second half superseded by 25c: the Noting batch ceiling is 10,000 and compact no longer shares it", async () => {
  expect(DEFAULT_CONFIG.noting.batchTokens).toBe(10_000);
  expect(DEFAULT_CONFIG.noting.triggerTokens).toBe(10_000);
  const { s, t } = session();
  const big = (id: string) => memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: id, turnId: t.id,
    role: "assistant", text: `${id} ` + "word ".repeat(4000), raw: "", calls: [] });
  for (const id of ["a", "b", "c", "d", "e", "f"]) big(id);
  // Over 12,000 view tokens (30: each entry is worth at most `render.entryTokens`, 2,000): over
  // `noting.batchTokens`, inside the compaction envelope. Before 25c this escalated on the inner
  // cap; the bounded views keep every entry, and the Noter's ceiling is not a knob compact reads at
  // all — moving it changes nothing here.
  expect(tokens(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).map(e => renderEntry(e, memory.config.render).content).join("\n\n")))
    .toBeGreaterThan(DEFAULT_CONFIG.noting.batchTokens);
  expect("native" in memory.compact(s.id, "main", t.id)).toBe(false);
  memory.config.noting.batchTokens = 50;
  expect("native" in memory.compact(s.id, "main", t.id)).toBe(false);
  memory.config.noting.batchTokens = DEFAULT_CONFIG.noting.batchTokens;
  // The budgets compact still answers to are its three windows and the shared allowance (73): below
  // the same Raw it is missed, and compact truncates to the newest span instead of delegating.
  compactionWindows(1_000, 100, 100);
  const tight = memory.compact(s.id, "main", t.id);
  expect("native" in tight).toBe(false);
  if (!("native" in tight)) expect(tight.truncated?.raw).toBeTruthy();
  defaultWindows();
  // Noting is unchanged: its batch still stops at 10,000 and leaves the rest pending.
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const views = calls[0]!.material.entries.map(e => e.view);
  expect(tokens(views.join("\n\n"))).toBeLessThanOrEqual(DEFAULT_CONFIG.noting.batchTokens);
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).length).toBeGreaterThan(0); // the rest waits; 50,000 would have taken it
});

// 25c, 2026-09-09: "compaction's two budgets are the knowledge cap and one shared 20,000-token
// episodic envelope, and nothing else". Superseded by ticket 28a (three material windows with
// 20k/10k/10k default baselines, 32a/35d) and then by ticket 73: the shared allowance is a fourth,
// fixed configuration value (default 10,000) rather than derived, knowledge borrows it first, and
// Facts/Raw borrow only for material Noting/Consolidation has not processed yet.
// `render.episodicBlockTokens` is not retired; it stayed the Noter's history envelope, and compaction
// no longer reads it. Nothing is required any more: every window truncates instead of trimming to a
// second rendering or delegating.
test("73: three windows plus the shared allowance — pending material first, truncated newest-first, never delegated", () => {
  expect(DEFAULT_CONFIG.compaction).toEqual({ factsTokens: 10_000, rawTokens: 10_000, sharedAllowanceTokens: 10_000 });
  expect(memory.knowledgeBudgets().injection).toBe(20_000);
  expect(DEFAULT_CONFIG.render.episodicBlockTokens).toBe(20_000); // untouched, and the Noter's
  expect(REMOVED_SETTINGS["render.episodicBlockTokens"]).toBeUndefined(); // nothing was retired here
  const { s, t } = session();
  // Pending facts and pending Raw of one path, plus one consolidated fact and one extracted entry.
  const write = (text: string, turnId = t.id) => {
    const tools = memory.tools({ kind: "manual", sessionId: s.id, currentTurnId: turnId, branch: "main" });
    return JSON.parse(tools[2]!.execute({ facts: [{ title: "Material window fact", sources: [{ address: `T${turnId}#E1`, text }] }] })).factIds[0] as number;
  };
  // Padding gives the two items the tight-window case below must drop a size it can reliably
  // exclude, while the substrings the assertions look for stay intact.
  const pad = "word ".repeat(500);
  write(`OLDER FACT ${pad}`);
  write("RECENT FACT");
  const extracted = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "done", turnId: t.id, role: "assistant", text: `EXTRACTED RAW ${pad}`, raw: "", calls: [] });
  expect(memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    facts: [], entryIds: hydrate(memory.store.sourcePath(s.id, "main", t.id), memory.store).map(e => e.id) }).ok).toBe(true);
  const open = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "open", turnId: t.id, role: "assistant", text: "PENDING RAW", raw: "", calls: [] });

  // Everything fits: pending material and both refills, inside the 50,000-token envelope.
  const full = memory.compact(s.id, "main", t.id);
  const text = compacted(full), windows = charged(full);
  expect(windows.envelope).toBe(50_000);
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
  expect(text).toContain("OLDER FACT"); // manual write has no frozen source set to prove completeness
  for (const marker of ["RECENT FACT", "PENDING RAW", "EXTRACTED RAW"]) expect(text).toContain(marker);
  // The Noter's envelope is not compact's: moving it changes not one byte here.
  memory.config.render.episodicBlockTokens = 40;
  expect(compacted(memory.compact(s.id, "main", t.id))).toBe(text);
  memory.config.render.episodicBlockTokens = DEFAULT_CONFIG.render.episodicBlockTokens;

  // No spare and no allowance: the refills (both processed and padded large) are gone, and the
  // newest pending material (short, unpadded) is untouched.
  compactionWindows(Math.max(1, windows.knowledge), 150, 150);
  const required = compacted(memory.compact(s.id, "main", t.id));
  expect(required).toContain("RECENT FACT"); expect(required).toContain("PENDING RAW");
  expect(required).not.toContain("OLDER FACT"); expect(required).not.toContain("EXTRACTED RAW");
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).map(e => e.id)).toEqual([open.id]);
  expect(memory.store.entryNoted(extracted.id)).toBe(true); // no processing was reset by any of it

  // 73: no fallback. Pending material that does not fit even at its own base is omitted and
  // receipted — never delegated, and never processed or erased to force a fit (28b's recovery is gone).
  compactionWindows(10, 1, 1);
  const squeezed = memory.compact(s.id, "main", t.id);
  expect("native" in squeezed).toBe(false);
  if ("native" in squeezed) throw new Error("unreachable");
  expect(compacted(squeezed)).not.toContain("RECENT FACT");
  expect(compacted(squeezed)).not.toContain("PENDING RAW");
  expect(squeezed.truncated?.facts?.count).toBeUndefined(); // 92 §6: retired C pending warning is gone
  expect(squeezed.truncated?.raw?.entries).toBe(1);
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).map(e => e.id)).toEqual([open.id]);
  expect(calls).toHaveLength(0);
  defaultWindows();
});

// 92 §8 replaces C's database-derived capacity with D's K window; the old C-only
// knowledgeTokens override is retired, not mapped onto either N or D.
test("45/92: D freezes the database-owned K capacity; later Settings edits cannot reprice an admitted run", async () => {
  const { path } = memoryWriter();
  createDreamerTrigger(memory, path, 1, 1);
  for (const override of [{ render: { knowledgeBlockTokens: 10_000 } }, { consolidation: { knowledgeTokens: 10_000 } }])
    expect(() => api.validateConfig(override as never)).toThrow(/Removed setting .*knowledge.*Tokens/);
  expect(Object.hasOwn(memory.config, "consolidation")).toBe(false);
  setKnowledgeCapacity(memory, 10_000);
  let frozenCap = 0, frozenMaterial = "";
  const result = await admittedScenarios.run(memory, path, task => {
    frozenCap = task.admittedProcessedInputCap + tokens(task.material.changed) + 1;
    frozenMaterial = task.text;
    expect(frozenCap).toBe(10_000);
    expect(tokens([task.material.processed, task.material.changed].join("\n\n"))).toBeLessThanOrEqual(frozenCap);
    setKnowledgeCapacity(memory, 20_000);
    expect(task.admittedProcessedInputCap + tokens(task.material.changed) + 1).toBe(10_000);
    expect(task.text).toBe(frozenMaterial);
    return { outcome: "failure", output: "retain the pending range", request: { fake: true } };
  });
  expect(result.outcome).toBe("failure");
  expect(frozenCap).toBe(10_000);
  expect(memory.config.compaction.sharedAllowanceTokens).toBe(20_000);
});

// ---- 20c 2026-09-08: the compaction rule is superseded, recorded here by its own name ----

// The specification's "Compaction is instant and never calls a model" (spec.md; user story 6).
// Superseded by ticket 20 on 2026-09-08, and superseded ONLY by the native fallback: core still calls
// no model, and there is no summarizer inside core. When no complete representation of every selected
// entry fits, compact returns an explicit request for native compaction, and Pi's own compaction —
// which may call a model, and may fail or be cancelled — runs under Pi's outcome handling. Neither
// the bounded views nor any summary becomes a source, a fact or a receipt.
test("73: 'compaction never calls a model' — over budget it truncates locally, and core calls none", async () => {
  const { s, t } = session();
  const sources = hydrate(memory.store.listSourceEntries(s.id), memory.store).length;
  const pending = hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).map(e => e.id);
  expect("native" in memory.compact(s.id, "main", t.id)).toBe(false);
  // Still local, deterministic work with more Raw: every entry is bounded by `render.entryTokens`.
  for (const id of ["a", "b", "c"]) memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: id, turnId: t.id,
    role: "assistant", text: `${id} ` + "word ".repeat(8000), raw: "", calls: [] });
  expect("native" in memory.compact(s.id, "main", t.id)).toBe(false);
  // 73: no fallback, in either host. Over the Raw window plus its (zeroed) allowance, compact keeps
  // the newest contiguous span that fits and omits the rest with a receipt — still no model call.
  compactionWindows(1_000, 10, 10);
  const truncated = memory.compact(s.id, "main", t.id);
  expect("native" in truncated).toBe(false);
  if ("native" in truncated) throw new Error("unreachable");
  expect(truncated.truncated?.raw).toBeTruthy();
  expect(calls).toHaveLength(0); // nothing reached this façade's runAgent at all
  // Nothing changed the sources, the facts or the processing progress it read.
  expect(hydrate(memory.store.listSourceEntries(s.id), memory.store).length).toBe(sources + 3);
  expect(memory.store.listSessionFacts(s.id)).toHaveLength(0);
  expect(pending.length).toBeGreaterThan(0);
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).map(e => e.id)).toEqual(expect.arrayContaining(pending));
  // Normal Noter input keeps using the same bounded views; the compact-only view exists nowhere else.
  defaultWindows();
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.material.entries.every(e => !e.view.includes("compact-only"))).toBe(true);
  expect(calls[0]!.text).not.toContain("compact-only");
});

// ---- 23 2026-09-09: the entry view's rulings, each recorded by the name it supersedes ----

// 17a, 2026-09-08: "arguments and result permanently reserve half each" of one call budget `B`. Ticket
// 23a superseded it with a quarter and three quarters; 23c (user, 2026-09-09) restored the halves.
// Ticket 30 supersedes the shared budget itself: a call part and a result part have independent
// allowances, `render.toolInputTokens` (`C`) and `render.toolResultTokens` (`R`), and neither is ever
// borrowed, swapped or averaged with the other. `render.entryTokens` (`E`) still binds the whole
// entry, however many parts it has.
test("30: one Raw entry view — C and R are independent, E binds the whole entry", () => {
  const { s, t } = session();
  const long = JSON.stringify({ command: "echo " + "a".repeat(20_000) });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: long, result: "b".repeat(20_000), status: "success" });
  const entries = hydrate(memory.store.listSourceEntries(s.id), memory.store);
  const of = (role: string) => entries.filter(e => e.role === role && e.calls.length).at(-1)!;
  const size = (role: string, profile: api.EntryProfile) => tokens(renderEntry(of(role), profile, memory.resultText).content);
  const profile = (entryTokens: number, toolInputTokens: number, toolResultTokens: number): api.EntryProfile =>
    ({ entryTokens, toolInputTokens, toolResultTokens });
  // The shipped profile gives each part its own 100, not two halves of one budget.
  expect([DEFAULT_CONFIG.render.toolInputTokens, DEFAULT_CONFIG.render.toolResultTokens]).toEqual([100, 100]);
  for (const role of ["assistant", "toolResult"]) {
    const filled = size(role, DEFAULT_CONFIG.render);
    expect([role, filled <= 100 && filled > 95]).toEqual([role, true]);
  }
  // Asymmetric budgets: what the other side does not use never enlarges this one.
  for (const [c, r] of [[50, 100], [100, 50], [1_000, 100], [100, 1_000]] as const) {
    const p = profile(2_000, c, r);
    expect([c, r, size("assistant", p) <= c && size("assistant", p) > c - 5]).toEqual([c, r, true]);
    expect([c, r, size("toolResult", p) <= r && size("toolResult", p) > r - 5]).toEqual([c, r, true]);
  }
  // `E` binds the whole entry: a tighter `E` cuts the same parts further, and every part still fits
  // its own cap. `C` and `R` are maxima inside `E`, never additions to it.
  for (const entryTokens of [60, 200, 2_000]) {
    for (const role of ["assistant", "toolResult"]) {
      const rendered = renderEntry(of(role), profile(entryTokens, 1_000, 1_000), memory.resultText).content;
      expect([entryTokens, role, tokens(rendered) <= entryTokens]).toEqual([entryTokens, role, true]);
    }
  }
});

// 17a, 2026-09-08: `toolCallTokens` defaulted to 1,000; ticket 23 made it 300 with 1,000 as a hard
// ceiling and kept `entryTokens` at 10,000. Superseded by ticket 30: the profile is `entryTokens`
// 2,000, `toolInputTokens` 100 and `toolResultTokens` 100, the ceiling still applies to each part
// budget, and the three retired keys fail by name with guidance instead of acquiring new meanings.
test("30: the shipped profile is 2,000/100/100 and the retired B and secondary keys fail by name", () => {
  expect(DEFAULT_CONFIG.render).toMatchObject({ entryTokens: 2_000, toolInputTokens: 100, toolResultTokens: 100 });
  expect(Object.keys(DEFAULT_CONFIG.render)).not.toContain("toolCallTokens");
  const open = (render: Record<string, number>) => sourceSeededMemory(join(directory, "ceiling.sqlite"), async () => ok([]), { render });
  expect(() => open({ toolInputTokens: 1_001 })).toThrow("Invalid render.toolInputTokens: at most 1000");
  expect(() => open({ toolResultTokens: 1_001 })).toThrow("Invalid render.toolResultTokens: at most 1000");
  const ceiling = open({ toolInputTokens: 1_000 });
  try { expect(ceiling.config.render.toolInputTokens).toBe(1_000); } finally { ceiling.close(); }
  for (const key of ["toolCallTokens", "secondaryToolCallTokens", "secondaryEntryTokens"]) {
    expect(REMOVED_SETTINGS[`render.${key}`]).toBeTruthy();
    expect(() => open({ [key]: 100 })).toThrow(`Removed setting render.${key}`);
  }
  // An explicitly configured `E` is honoured as written: nothing is halved, ignored or rewritten.
  expect(() => open({ entryTokens: 2_001 })).toThrow("Invalid render.entryTokens: at most 2000");
  const explicit = open({ entryTokens: 2_000 });
  try { expect(explicit.config.render.entryTokens).toBe(2_000); } finally { explicit.close(); }
  // 30 (GPT ruling 2026-09-10): the smaller views change no phase limit. The trigger, the batch
  // ceilings and target limits keep their values. 92 removes only lexical review here.
  expect(DEFAULT_CONFIG.noting).toEqual({ forkModeDefault: false, batchTokens: 10_000, triggerTokens: 10_000, maxToolRounds: 0 });
  for (const retired of [0, 1, -0.001, 1.001, Infinity, Number.NaN])
    expect(() => api.validateConfig({ noting: { nearThreshold: retired } } as never)).toThrow("Removed setting noting.nearThreshold");
});

// 28a "Windows": the two new compaction keys are ordinary token settings — the same finite positive
// integer validation, the same unknown-key rejection by name — and nothing existing was reinterpreted
// or silently retired to make room for them.
test("28a configuration: compaction.factsTokens and compaction.rawTokens are validated like every other token key", () => {
  const open = (compaction: Record<string, number>) => sourceSeededMemory(join(directory, "windows.sqlite"), async () => ok([]), { compaction } as never);
  expect(DEFAULT_CONFIG.compaction).toEqual({ factsTokens: 10_000, rawTokens: 10_000, sharedAllowanceTokens: 10_000 });
  for (const key of ["factsTokens", "rawTokens"] as const) {
    expect(() => open({ [key]: 0 })).toThrow(`Invalid compaction.${key}: expected a positive safe integer`);
    expect(() => open({ [key]: 1.5 })).toThrow(`Invalid compaction.${key}: expected a positive safe integer`);
    const set = open({ [key]: 4_321 });
    try { expect(set.config.compaction[key]).toBe(4_321); } finally { set.close(); }
  }
  expect(() => open({ overflowTokens: 100 })).toThrow("Removed setting compaction.overflowTokens");
  expect(() => open({ episodicBlockTokens: 100 })).toThrow("Unknown setting compaction.episodicBlockTokens");
  // Nothing lost a meaning here, so nothing joined the removed list; `render.episodicBlockTokens` is
  // still a live setting, now read only by the Noter's history envelope.
  expect(REMOVED_SETTINGS["render.episodicBlockTokens"]).toBeUndefined();
  expect(REMOVED_SETTINGS["compaction.factsTokens"]).toBeUndefined();
  const noter = sourceSeededMemory(join(directory, "noter.sqlite"), async () => ok([]), { render: { episodicBlockTokens: 12_345 } });
  try { expect(noter.config.render.episodicBlockTokens).toBe(12_345); } finally { noter.close(); }
});

// 20c, 2026-09-08: compaction's second tier was a separate compact-only renderer with its own version
// and its own excerpt rules; ticket 23 made it the one entry renderer under a tier-2 profile.
// Superseded by ticket 30: there is no second tier at all. Compaction renders the one bounded view of
// every selected entry, and a set that still does not fit delegates to the host's native compaction
// (28 amendment 9: no recovery worker here).
test("30/73: 23's tier-2 profile is superseded; compaction has one bounded view and truncates instead of delegating", () => {
  const { s, t } = session();
  for (const id of ["a", "b", "c"]) memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: id, turnId: t.id,
    role: "assistant", text: `${id} ` + "word ".repeat(8000), raw: "", calls: [] });
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result).toBe(false);
  const text = compacted(result);
  for (const entry of hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store)) expect(text).toContain(renderEntry(entry, memory.config.render, memory.resultText).content);
  expect(text).toContain("\nRaw:\n");
  expect(text).not.toContain("tier-2 entry views"); // one view, one title
  expect(text).not.toContain("compact-only");
  expect("SECONDARY_VIEW_VERSION" in api).toBe(false); // the version constant went with the renderer
  expect("secondaryRawTitle" in api).toBe(false); // and the tier-2 block title went with the tier
  // 73: the remaining escalation is truncation, not delegation — the newest span survives, receipted.
  compactionWindows(1_000, 100, 100);
  const truncated = memory.compact(s.id, "main", t.id);
  expect("native" in truncated).toBe(false);
  if ("native" in truncated) throw new Error("unreachable");
  expect(truncated.truncated?.raw).toBeTruthy();
  expect(compacted(truncated)).toContain("earlier entries omitted from the Raw window");
});

// 29a, 2026-09-10: a tier-2 compact view established no coverage, so `visibleView` recorded only
// tier-1 views. Superseded by ticket 30 "Visibility and fork": a marked compressed view is visible
// Raw whether or not it was truncated, and a retained view is never compared with the current
// profile to demand a richer replacement. Unmarked material still counts for nothing.
test("30: a marked compressed view is visible Raw; a budget change adds no richness gate", () => {
  const binding = { db: "db", session: 7, pi: "pi-1" };
  const carrier = (entries: { id?: number; nativeId?: string; view?: string; tier?: number }[]) => ({ id: "c", type: "compaction",
    summary: "Raw:\n" + entries.map(entry => `[T1#E${entry.id}@text] user: bounded view ${entry.nativeId}`).join("\n"),
    details: { traceMemory: { ...binding, supplied: { entries, factIds: [], knowledgeCommitIds: [] } } } });
  // The one representation new writers emit, and both legacy tiers, are all visible Raw.
  const view = visibleView([carrier([
    { id: 1, nativeId: "e1", view: "bounded" },
    { id: 2, nativeId: "e2", tier: 1 },
    { id: 3, nativeId: "e3", tier: 2 },
  ])], binding);
  expect([...view.raw.keys()].sort()).toEqual(["e1", "e2", "e3"]);
  expect([...new Set(view.raw.values())]).toEqual(["view"]);
  // No richness gate: the same carrier counts under two legal profiles, because
  // nothing compares what it holds with what the current configuration would render.
  for (const render of [{ entryTokens: 40, toolInputTokens: 1, toolResultTokens: 1 }, { entryTokens: 2_000, toolInputTokens: 1_000, toolResultTokens: 1_000 }]) {
    const m = sourceSeededMemory(join(directory, "richness.sqlite"), async () => ok([]), { render });
    try { expect([...visibleView([carrier([{ id: 1, nativeId: "e1", view: "bounded" }])], binding).raw.keys()]).toEqual(["e1"]); }
    finally { m.close(); }
  }
  // Unmarked material still establishes nothing: a bare id, an unknown representation, a foreign
  // database's carrier, and a native compaction's own details.
  expect(visibleView([carrier([{ id: 4, nativeId: "e4" }, { nativeId: "e5", view: "bounded" }])], binding).raw.has("e4")).toBe(false);
  expect(visibleView([carrier([{ id: 6, nativeId: "e6", tier: 3 }])], binding).raw.has("e6")).toBe(false);
  expect(visibleView([{ id: "c", type: "compaction", details: { traceMemory: { db: "other", session: 7, pi: "pi-1",
    supplied: { entries: [{ id: 7, nativeId: "e7", view: "bounded" }], factIds: [], knowledgeCommitIds: [] } } } }], binding).raw.size).toBe(0);
  expect(visibleView([{ id: "c", type: "compaction", details: { readFiles: [], modifiedFiles: [] } }], binding).raw.size).toBe(0);
});


// 92 §8's "C删掉" supersedes the independent 5k fact-queue trigger and batch.
// N's 10k Raw trigger and oldest whole-entry prefix remain pinned by 20b above.

// 17b, 2026-09-08: the knowledge budget was a soft cap — constraints, open items and disputes were
// exempt from it. Superseded by ticket 20 and confirmed by the user on 2026-09-08: the cap is hard,
// omitted items remain stored and traceable. 64c changes selection to newest commits first.
test("64c: the knowledge cap remains hard and recency, not category, selects whole items", () => {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  expect(tools.find(tool => tool.name === "note")!.execute({ facts: [{ title: "Package manager decision", sources: [{ address: `T${t.id}#E1`, text: "Use pnpm" }] }] })).toContain("ok: F1");
  const write = (category: string, text: string) => expect(tools.find(tool => tool.name === "memory")!
    .execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text, category, scope: "project", supports: ["F1"] }], skipped: [] })).toContain('"committed"');
  for (let i = 0; i < 6; i++) write("constraint", `constraint ${i} ` + "word ".repeat(1_000));
  write("reference", "reference tail");
  const cap = 5_000;
  setKnowledgeCapacity(memory, cap);
  const injected = memory.inject(s.id);
  expect(injected).toContain("[constraint/project]"); // newer constraints fit beside the latest reference
  expect(injected).toContain("reference tail");
  expect(tokens(injected)).toBeLessThanOrEqual(cap); // the exemption is gone: no category bypasses it
  expect(injected).toContain("Receipts:");
  expect(injected).not.toContain("constraint 0");
  expect(memory.trace("K1")).toContain("[K1@"); // omitted is not deleted
  expect(t.id).toBeGreaterThan(0);
});

// 92 §8's “C删掉” retires C's independent fact queue. N's oldest contiguous Raw prefix across Turns
// remains pinned by 20b above and boundary.test.ts's two-Turn capacity/membership cases.

// 92 §8's “C删掉” retires C's separate fact-processing marks: late facts no longer create a C queue.
// The frozen-N late-entry fence stays in 18b; D late-version processing is pinned above.

test("18b 2026-09-08: a frozen manual boundary excludes entries and facts added after it was captured, even though they are on-path", async () => {
  const { s, t } = session();
  const entry1 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u1", turnId: t.id, role: "user", text: "first", raw: "first", calls: [] });
  memory.selectEntries(s.id, "main", [entry1.id]);
  const boundary = { maxEntryId: entry1.id }; // frozen before the second entry exists
  const t2 = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t.id, kind: "turn", userPrompt: "second", startedAt: time });
  const entry2 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u2", turnId: t2.id, role: "user", text: "second", raw: "second", calls: [] });
  memory.selectEntries(s.id, "main", [entry1.id, entry2.id]);
  const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t2.id, mode: "subagent", boundary });
  expect(result.outcome).toBe("success");
  expect(calls[0]!.entryIds).toEqual([entry1.id]); // the later on-path entry stays outside the frozen target
  expect(hydrate(memory.pendingEntries(s.id, "main", t2.id), memory.store).map(e => e.id)).toEqual([entry2.id]); // it remains pending

  // 92 §8's “C删掉” replaces C's frozen fact-id set with N's exact entry boundary above; the
  // independently frozen D revision range is exercised by the late-version case above.
});

// ---- 19c: the execution mode is fork; branch remains the evidence path (ticket 19 "Naming and compatibility") ----

test("19c 2026-09-08: the legacy branchModeDefault spelling is accepted, mapped onto forkModeDefault, and not kept", () => {
  const legacy = sourceSeededMemory(join(directory, "alias.sqlite"), async () => ok([]), { noting: { branchModeDefault: false } });
  try {
    expect(legacy.config.noting.forkModeDefault).toBe(false);              // the old key still selects the mode
    expect(Object.hasOwn(legacy.config.noting, "branchModeDefault")).toBe(false); // only the canonical key survives
  } finally { legacy.close(); }
  // Both spellings supplied and agreeing: the canonical one wins, silently.
  const agreeing = sourceSeededMemory(join(directory, "agreeing.sqlite"), async () => ok([]), { noting: { branchModeDefault: false, forkModeDefault: false } });
  try { expect(agreeing.config.noting.forkModeDefault).toBe(false); } finally { agreeing.close(); }
});

test("19c 2026-09-08: both execution-mode spellings with different values fail the load naming both keys", () => {
  const load = () => sourceSeededMemory(join(directory, "conflict.sqlite"), async () => ok([]), { noting: { branchModeDefault: true, forkModeDefault: false } });
  expect(load).toThrow(/noting\.branchModeDefault/);
  expect(load).toThrow(/noting\.forkModeDefault/);
  expect(load).toThrow(/Conflicting settings/);
});

test("24 amendment 2 2026-09-09, as 29e left it: configure replaces each phase's execution-mode default, validated like the load path, and nothing else", async () => {
  // 92 §7: only the N mode preference survives; D is subagent-only.
  expect(memory.config.noting.forkModeDefault).toBe(false);
  memory.configure({ noting: { forkModeDefault: true } });
  expect(memory.config.noting.forkModeDefault).toBe(true);
  memory.configure({ noting: { forkModeDefault: false } });
  expect(memory.config.noting.forkModeDefault).toBe(false);
  expect(memory.config.noting.batchTokens).toBe(DEFAULT_CONFIG.noting.batchTokens); // nothing else moved
  // A task admitted after the call runs in the new mode; the run record keeps what it was launched with.
  const { s, t } = session();
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("subagent");
  expect(memory.store.listRuns(s.id).at(-1)!.mode).toBe("subagent");
  // The load path's own rules: the legacy spelling is accepted and mapped, a bad type, a removed key
  // and any other section or key are refused by name — and a refusal changes nothing.
  memory.configure({ noting: { branchModeDefault: true } });
  expect(memory.config.noting.forkModeDefault).toBe(true);
  expect(() => memory.configure({ noting: { forkModeDefault: 1 as unknown as boolean } })).toThrow("Invalid noting.forkModeDefault");
  expect(() => memory.configure({ noting: { branchModeDefault: false, forkModeDefault: true } })).toThrow("Conflicting settings");
  expect(() => memory.configure({ noting: { batchTokens: 5 } })).toThrow("noting.batchTokens is not reconfigurable at runtime");
  expect(() => memory.configure({ render: { entryTokens: 5 } })).toThrow("Unknown setting render");
  expect(() => memory.configure({ consolidation: { triggerUnconsolidatedFacts: 5 } } as never)).toThrow("Removed setting");
  expect(() => memory.configure({ noting: { nearThreshold: 0.5 } } as never)).toThrow("Removed setting noting.nearThreshold");
  expect(memory.config.noting.forkModeDefault).toBe(true);
  expect(memory.config.render.entryTokens).toBe(DEFAULT_CONFIG.render.entryTokens);
});

// ---- 25 amendment 2 2026-09-09, as 29e superseded it: Consolidation has two execution modes again ----

test("25b/92: retired C mode is not a live setting or a Noter alias", () => {
  const message = "Removed setting consolidation.subagentModeDefault: Consolidation is retired; remove this key";
  expect(REMOVED_SETTINGS["consolidation.subagentModeDefault"]).toBe("Consolidation is retired; remove this key");
  for (const saved of [true, false]) {
    expect(() => sourceSeededMemory(join(directory, `saved-${saved}.sqlite`), async () => ok([]),
      { consolidation: { subagentModeDefault: saved } } as never)).toThrow(message);
    expect(() => canonicalFlatConfig({ "consolidation.subagentModeDefault": saved })).toThrow(message);
    expect(() => memory.configure({ consolidation: { subagentModeDefault: saved } } as never)).toThrow(message);
  }
  expect(Object.hasOwn(DEFAULT_CONFIG, "consolidation")).toBe(false);
  expect(DEFAULT_CONFIG.noting.forkModeDefault).toBe(false); // no C mode is mapped into N
});


// 92 §8 retires C's fork, fact-queue borrowing and catchup mode. N's corresponding live
// mode contract uses actual Raw entries and retains the configured/requested audit.
test("92: N explicit/default modes, frozen configuration, borrowed and catchup subagent", async () => {
  const { s, t } = session();
  const next = (parent: number, text: string) => memory.store.appendTurn({ sessionId: s.id, parentTurnId: parent,
    kind: "turn", userPrompt: text, assistantText: "acknowledged", startedAt: time });
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork" })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).at(-1)).toMatchObject({ kind: "noting", mode: "fork" });
  const second = next(t.id, "Keep vitest");
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: second.id })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("subagent");
  expect(JSON.parse(memory.store.listRuns(s.id).at(-1)!.response!).requestedMode).toBe("subagent");

  memory.configure({ noting: { forkModeDefault: true } });
  const third = next(second.id, "Keep sqlite");
  const before = calls.length;
  memory.close();
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const task = raw as NotingAgentInput;
    calls.push(task);
    if (calls.length === before + 1) memory.configure({ noting: { forkModeDefault: false } });
    task.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    task.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    return ok([]);
  }, { noting: { forkModeDefault: true } });
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: third.id })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).at(-1)!.mode).toBe("fork");
  expect(memory.config.noting.forkModeDefault).toBe(false); // only future admission observes the edit
  memory.configure({ noting: { forkModeDefault: true } });

  const tail = memory.store.createSession({ enrollmentChoice: true, host: "pi:borrowed", startedAt: time,
    firstReplyAt: time, projectId: memory.store.getSession(s.id)!.projectId });
  const tailTurn = memory.store.appendTurn({ sessionId: tail.id, kind: "turn", userPrompt: "closed tail", assistantText: "ok", startedAt: time });
  memory.store.closeSession(tail.id);
  expect((await memory.noting({ sessionId: tail.id, branch: "main", headTurnId: tailTurn.id,
    borrowed: true, executorSessionId: s.id })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("subagent");
  const fourth = next(third.id, "Keep node:sqlite");
  const frozen = memory.store.pendingEntryIds(s.id, "main", fourth.id);
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: fourth.id,
    mode: "subagent", boundary: { exactEntryIds: frozen } })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("subagent");
  expect(calls.at(-1)!.entryIds).toEqual(frozen);
});

test("25 amendment 2 2026-09-09: a stored fork-mode Consolidation run keeps its recorded mode and is never rewritten", async () => {
  const { s, t } = session();
  // A run this database recorded before the mode was retired, exactly as it was written then.
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, branch: "main", mode: "fork", model: "old/model",
    rangeFrom: "F1", rangeTo: "F1", createdAt: time }, operations: [] });
  const historical = memory.store.listRuns(s.id).at(-1)!.id;
  expect(memory.trace(`R${historical}`)).toContain("mode fork"); // read back as what it was, not relabelled
  // New work in the same database records the one mode and leaves the old row alone.
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ text: "Keep pnpm", source: [`T${t.id}#E1`] }] });
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(memory.store.getRun(historical)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).filter(r => r.kind === "consolidation").map(r => r.mode)).toEqual(["fork"]);
  expect(memory.store.listRuns(s.id).at(-1)!.kind).toBe("noting");
});

test("19c 2026-09-08: new work records the canonical fork spelling, in the task input and in the run record", async () => {
  const { s, t } = session();
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork" })).outcome).toBe("success"); // explicit task override
  expect(calls.at(-1)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).at(-1)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).some(r => r.mode === "branch")).toBe(false);
});

test("19c 2026-09-08: a stored branch-mode run reads as legacy request-copy execution and is never rewritten", async () => {
  const seed = (m: ReturnType<typeof sourceSeededMemory>) => {
    const project = m.store.createProject({ name: "historical", declaredBy: "mark" });
    const s = m.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
    const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "用 pnpm，不要 npm", assistantText: "好的。", startedAt: time });
    return { s, t };
  };
  const path = join(directory, "historical.sqlite");
  const before = sourceSeededMemory(path, async raw => { calls.push(raw as NotingAgentInput); return ok([]); });
  const { s, t } = seed(before);
  // A pre-rename row, exactly as the deleted request-copy runner wrote it. No migration touches it.
  before.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", mode: "branch", model: "old/model",
    rangeFrom: `S${s.id}/T${t.id}`, rangeTo: `S${s.id}/T${t.id}`, createdAt: time }, facts: [] });
  const legacy = before.store.listRuns(s.id).at(-1)!.id;
  before.close();
  const after = sourceSeededMemory(path, async raw => { const input = raw as NotingAgentInput; calls.push(input);
    input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] }); return ok([]); });
  try {
    expect(after.store.getRun(legacy)!.mode).toBe("branch");   // reopening the database migrates nothing
    expect(after.trace(`R${legacy}`)).toContain("mode legacy request-copy execution (branch)");
    expect(after.trace(`R${legacy}`)).not.toContain("mode fork"); // an old run is never described as a native fork
    expect(runMode("fork")).toBe("fork"); expect(runMode("subagent")).toBe("subagent"); // new modes read as themselves
    // Reading it, and running new work in the same database afterwards, leave the stored value alone.
    expect((await after.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
    expect(after.trace(`R${legacy}`)).toContain("legacy request-copy execution");
    expect(after.store.getRun(legacy)!.mode).toBe("branch");
    expect(after.store.listRuns(s.id).map(r => r.mode)).toEqual(["branch", "subagent"]);
  } finally { after.close(); }
});

// ---- 21a 2026-09-08: three earlier rulings are superseded, recorded here by their own names ----

// User, 2026-09-07: "every operation has one shape: op, id, absorb, text, category, scope, supports,
// because; because is always required" and "archive carries only op, id, because". Superseded by
// ticket 21 on 2026-09-08: one `supports` list is the commit's evidence for every operation, archive
// included, and `reason` is its commit message. The commit-level `because` array is removed from new
// write input and rejected by name; `skipped[].because` is untouched.
// User, 2026-09-07: "an archive commit has empty supports". Superseded the same day: an archive keeps
// the evidence it cites, so its applicability is read from the same field as every other commit.
// User, 2026-09-07: "supports proves only the new text". Superseded: supports supplies the commit's
// evidence, including the complete result's basis and the correction or withdrawal that justified it.
test("21a 2026-09-08: the two-array write shape and the empty-supports archive are superseded by supports plus reason", async () => {
  const { create, write, path } = memoryWriter();
  const operation = toolDefinitions.find(t => t.name === "memory")!.parameters.properties as Record<string, any>;
  const schema = operation.operations.items;
  expect(schema.required).toEqual(["op", "supports", "reason"]);
  expect(schema.properties).not.toHaveProperty("because");
  expect(schema.properties.reason).toEqual({ type: "string", minLength: 1 });
  expect(operation.skipped.items.properties.because).toEqual({ type: "string", minLength: 1 }); // unchanged protocol
  const factSchema = (toolDefinitions.find(t => t.name === "note")!.parameters.properties as Record<string, any>).facts.items;
  expect(factSchema.properties).not.toHaveProperty("reason"); // facts gain no commit metadata and the surface stays four tools
  expect(write([create]).committed).toHaveLength(1);
  const trigger = createDreamerTrigger(memory, path, 1, 1);
  const archived = await admittedWrite({ ...path, fact: "F1" }, trigger,
    [{ op: "archive", kind: "budget", id: tagged(1, 1), supports: ["F1"], reason: "Withdrawn by the user." }]);
  const archiveCommit = archived.committed[0].commit as number;
  expect(memory.store.getKnowledgeRevision(1, archiveCommit)?.supports).toEqual([1]); // no longer cleared
});

// Ticket 21 "Applicability" and "Branch scenario", scenario 5: one citation rule for every commit.
test("64b/21a: an archive's supports face the same session/project/global table as any other commit", async () => {
  const { c, peer, content, publish } = commitPaths();
  const same = peer(), outside = peer(memory.store.createProject({ name: "outside 21a", declaredBy: "mark" }).id);
  let sequence = 0;
  for (const scope of ["session", "project", "global"] as const) for (const origin of [c, same, outside]) {
    publish(c);
    const created = c.write([{ op: "create", topics: [], ...content(c.fact), scope, reason: "Admitted for the archive scope check." }]).committed[0];
    const address = tagged(created.knowledgeId, created.commit);
    const trigger = createDreamerTrigger(memory, c, Number(c.fact.slice(1)), ++sequence, scope);
    const allowed = origin === c || scope === "global" || (scope === "project" && origin === same);
    const request = { fixture: "archive scope table", scope, origin: origin.sessionId }; let first = "";
    const result = await admittedScenarios.run(memory, c, input => {
      input.reportRequest(request); const trace = input.tools[0]!, write = input.tools.find(tool => tool.name === "memory")!;
      const triggerAddress = tagged(trigger.knowledgeId, trigger.commit);
      completeToolRead(trace, address); completeToolRead(trace, triggerAddress);
      const otherSupplied = suppliedHandles(input.material.changed)
        .filter((knowledge: string) => knowledge !== created.version && knowledge !== history(trigger.knowledgeId, trigger.commit))
        .map((knowledge: string) => ({ knowledge, because: "Unrelated current knowledge is unchanged by the archive scope check." }));
      first = write.execute({ operations: [{ op: "archive", kind: "budget", id: address, supports: [origin.fact], reason: `Retired on ${origin.branch} evidence.` },
        { op: "archive", kind: "budget", id: triggerAddress, supports: [c.fact], reason: "Retire explicit trigger." }], skipped: otherSupplied });
      if (allowed) return { outcome: "success", output: "archived", request };
      expect(first).toContain("rejected:");
      const corrected = write.execute({ operations: [{ op: "archive", kind: "budget", id: triggerAddress,
        supports: [c.fact], reason: "Retire explicit trigger." }], skipped: [{ knowledge: created.version, because: "Foreign support is outside this archive's scope." }, ...otherSupplied] });
      expect(corrected).toContain('"committed"');
      return { outcome: "success", output: "scope refusal checked", request };
    });
    expect(result.outcome, JSON.stringify(result)).toBe("success");
    expect(first.includes('"committed"')).toBe(allowed);
  }
  const created = c.write([{ op: "create", topics: [], ...content(c.fact), scope: "session", reason: "Admitted for the reason-bypass check." }]).committed[0];
  const trigger = createDreamerTrigger(memory, c, Number(c.fact.slice(1)), ++sequence, "session");
  const request = { fixture: "archive reason is not adoption" }; let rejected = "";
  const result = await admittedScenarios.run(memory, c, input => {
    input.reportRequest(request); const trace = input.tools[0]!, write = input.tools.find(tool => tool.name === "memory")!;
    const address = tagged(created.knowledgeId, created.commit), triggerAddress = tagged(trigger.knowledgeId, trigger.commit);
    completeToolRead(trace, address); completeToolRead(trace, triggerAddress);
    const otherSupplied = suppliedHandles(input.material.changed)
      .filter((knowledge: string) => knowledge !== created.version && knowledge !== history(trigger.knowledgeId, trigger.commit))
      .map((knowledge: string) => ({ knowledge, because: "Unrelated current knowledge is unchanged by the reason-bypass check." }));
    rejected = write.execute({ operations: [{ op: "archive", kind: "budget", id: address, supports: [outside.fact],
      reason: `The user adopted ${outside.fact} on this path.` }], skipped: [] });
    expect(rejected).toContain("rejected:");
    write.execute({ operations: [{ op: "archive", kind: "budget", id: triggerAddress, supports: [c.fact], reason: "Retire explicit trigger." }],
      skipped: [{ knowledge: created.version, because: "Reason prose cannot adopt a foreign fact." }, ...otherSupplied] });
    return { outcome: "success", output: "reason refusal checked", request };
  });
  expect(result.outcome).toBe("success");
});

// ---- 21b 2026-09-08: topics classify revisions and change nothing else ----

// Ticket 21 "History and scope", scenario 14: a shared label is not a shared status.
test("64b/21b: a shared label changes no applicability and follows the owner's published foreground", async () => {
  const { c, d, peer, content, tips, publish } = commitPaths();
  const third = peer();
  const label = (who: typeof c, text: string, trigger: { knowledgeId: number; commit: number }) => {
    publish(who);
    return admittedWrite(who, trigger,
      [{ op: "update", id: tagged(1, 1), topics: ["tiling"], reason: "Substantive correction, filed under its subject.", ...content(who.fact, text) }]);
  };
  const cCommit = (await label(c, "C version", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1))).committed[0].commit as number;
  const dCommit = (await label(d, "D version", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2))).committed[0].commit as number;
  expect(tips(third)).toEqual([dCommit]);
  const groups = (who: { sessionId: number; headTurnId: number; branch: string }) => memory.topicGroups(who.sessionId, who.headTurnId, who.branch);
  expect(groups(third).topics).toEqual([{ topic: "tiling", commits: [{ knowledgeId: 1, commit: dCommit }] }]);
  expect(groups(c).topics).toEqual(groups(third).topics);
  publish(c);
  expect(groups(third).topics).toEqual([{ topic: "tiling", commits: [{ knowledgeId: 1, commit: cCommit }] }]);
  // An archive inherits the label; explicit search keeps its history labels, automatic material drops it.
  const archiveTrigger = createDreamerTrigger(memory, third, Number(third.fact.slice(1)), 3);
  const request = { fixture: "topic archive tagged base" }; let archiveCommit = 0, topicReceipt: any;
  const archiveRun = await admittedScenarios.run(memory, third, input => {
    input.reportRequest(request); const trace = input.tools[0]!, write = input.tools.find(tool => tool.name === "memory")!;
    const op = { op: "archive", kind: "budget", id: tagged(1, cCommit), supports: [third.fact], reason: "Retired on this path." };
    // Read the globally selected base; labels do not grant write authority.
    completeToolRead(trace, history(1, cCommit));
    completeToolRead(trace, history(archiveTrigger.knowledgeId, archiveTrigger.commit));
    const receipt = topicReceipt = JSON.parse(write.execute({ operations: [op, { op: "archive", kind: "budget", id: tagged(archiveTrigger.knowledgeId, archiveTrigger.commit),
      supports: [third.fact], reason: "Retire the explicit fixture trigger." }], skipped: [] }));
    const archived = receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1);
    if (!archived) throw new Error(`topic archive did not commit: ${JSON.stringify(receipt)}`);
    return { outcome: "success", output: "archived", request };
  });
  if (!topicReceipt) throw new Error(`topic archive was not admitted: ${JSON.stringify(archiveRun)}`);
  expect(topicReceipt.committed.some((item: { knowledgeId: number }) => item.knowledgeId === archiveTrigger.knowledgeId), JSON.stringify(topicReceipt)).toBe(true);
  expect(memory.store.currentCommit(archiveTrigger.knowledgeId, third).at(-1)?.op, JSON.stringify(topicReceipt)).toBe("archive");
  const archiveRevision = memory.store.listKnowledgeRevisions(1).find(revision => revision.op === "archive")!;
  archiveCommit = archiveRevision.id;
  expect(archiveRevision.topics).toEqual(["tiling"]);
  const hits = memory.search("tiling", "knowledge", { versions: "all", fields: ["text", "status"] }).split("\n").filter(l => l.startsWith("[K"));
  expect(hits).toHaveLength(1); // One K: equal topic scores choose the newest current candidate (archive).
  expect(hits[0]).toContain(`[K1@${archiveCommit}]`);
  expect(hits[0]).toContain("status: archived");
  expect(memory.search("C version", "knowledge", { versions: "all" })).toContain("status: archived");
  publish(d);
  // The archive cites the independent peer's fact, not C's. Switching C/D therefore leaves the
  // later archive applicable; sharing a topic cannot revive D or inherit the archive parent's path.
  expect(tips(third)).toEqual([archiveCommit]);
  const dHistory = memory.search("D version", "knowledge", { versions: "all" });
  expect(dHistory).toContain(`[K1@${dCommit}]`);
  expect(dHistory).toContain("status: archived");
  expect(dHistory).not.toContain("superseded by none");
  expect(groups(third).topics).toEqual([]);
  expect(groups(c).topics).toEqual(groups(third).topics);
  expect(memory.inject(third)).not.toContain(`[${tagged(1, dCommit)}]`);
  expect(memory.inject(third)).not.toContain(`[${tagged(1, archiveCommit)}]`);
  // The label is metadata beside the conclusion, never new factual prose inside it.
  expect(memory.store.getKnowledgeRevision(1, dCommit)!.text).toBe("D version");
});

// Ticket 21 "Out of Scope" and scenario 17: no registry, no catalog, no fifth tool, no new duty.
test("21b 2026-09-08: topics are revision metadata only — no fact or note field, no fifth tool and no injected catalog", () => {
  const { create, write, s } = memoryWriter();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: 1 });
  expect(tools.map(t => t.name)).toEqual(["trace", "search", "note", "memory"]);
  const factSchema = (toolDefinitions.find(t => t.name === "note")!.parameters.properties as Record<string, any>).facts.items;
  expect(factSchema.properties).not.toHaveProperty("topics");
  expect(tools[2]!.execute({ facts: [{ text: "Labelled fact", source: ["T1#E1"], topics: ["packaging"] }] })).toContain("rejected:");
  const schema = (toolDefinitions.find(t => t.name === "memory")!.parameters.properties as Record<string, any>).operations.items;
  expect(schema.properties.topics).toEqual({ type: "array", items: { type: "string", minLength: 1 } });
  // Topics stay inherited on archives; the archive branch requires an explicit kind.
  expect(schema.allOf.at(-1).then.required).toContain("kind");
  expect(schema.allOf.at(-1).then.allOf[0].not.anyOf).toContainEqual({ required: ["topics"] });
  expect(schema.allOf.at(-1).else.required).toContain("topics");
  expect(schema.required).toEqual(["op", "supports", "reason"]);
  // A label is written by the ordinary batch, with no model call and no independent catalog block.
  expect(write([{ ...create, topics: ["packaging"] }]).committed).toHaveLength(1);
  const injected = memory.inject(s.id);
  expect(injected).toContain('· topics: ["packaging"]');
  expect(injected.match(/topics:/g)).toHaveLength(1); // the label rides its own knowledge line, nothing more
  expect(injected).not.toContain("<topics>");
  expect(calls).toEqual([]); // storing a label calls no model
});

test("26a/92: a Noter requires both tools; silence or note alone is not zero-fact success", async () => {
  const { s, t } = session(); memory.close();
  let submit = false, submitKnowledge = false;
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    if (submit) input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    if (submitKnowledge) input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    return { outcome: "success", output: "I answered a question and wrote nothing.", request: { fake: true }, usage: { tokens: 3 } };
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  // R20's failure mode: a run that submits nothing must not advance its 96 selected entries.
  expect(await memory.noting(target)).toMatchObject({ outcome: "failure", problems: [api.NOTING_INCOMPLETE] });
  expect(memory.store.getRun(1)!.outcome).toBe("failure"); // the existing outcome value; no new one, no schema change
  expect(hydrate(memory.store.listSourceEntries(s.id), memory.store).some(e => memory.store.entryNoted(e.id))).toBe(false);
  // The prompt says what the runner enforces.
  const prompt = loadPrompt("noting.md");
  expect(prompt).toContain("note({facts: []})");
  expect(prompt).not.toContain("Stopping without submitting is a normal zero-fact success");
  // One tool is insufficient; both explicit empty submissions complete without a delivery intent.
  submit = true;
  expect(await memory.noting(target)).toMatchObject({ outcome: "failure" });
  expect(hydrate(memory.store.listSourceEntries(s.id), memory.store).some(e => memory.store.entryNoted(e.id))).toBe(false);
  submitKnowledge = true;
  expect(await memory.noting(target)).toMatchObject({ outcome: "success", facts: [] });
  expect(hydrate(memory.store.sourcePath(s.id, "main", t.id), memory.store).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending_deliveries'").all()).toEqual([]);
});

/** 26 amendment 2 (26c design §1, defect D3): one shared prefix and two children — a fact on the
 * prefix, a fact on the selected child, a fact on its sibling. Each manual fact has a real entry
 * binding; applicability is checked against the selected source path. */
function pathFacts() {
  const { s, t } = session();
  const write = (headTurnId: number, branch: string, text: string): number => {
    const entry = hydrate(memory.store.listSourceEntries(s.id, headTurnId), memory.store).find(value => value.role === "user")!;
    return seedFact(memory, { sessionId: s.id, branch, headTurnId }, "Branch fact", [{ entry, text }]).id;
  };
  const child = (branch: string, parentTurnId: number, prompt: string) =>
    memory.store.appendTurn({ sessionId: s.id, parentTurnId, kind: "turn", userPrompt: prompt, assistantText: `${branch} reply`, startedAt: time });
  const shared = write(t.id, "main", "SHARED PREFIX");
  const selected = child("C", t.id, "C prompt"), sibling = child("D", t.id, "D prompt");
  return { s, t, selected, sibling, shared, child,
    onPath: write(selected.id, "C", "ON PATH"), siblingOnly: write(sibling.id, "D", "SIBLING ONLY") };
}

test("26 amendment 2: compaction and the Noter's history take only path-applicable facts", async () => {
  const { s, selected, shared, onPath, siblingOnly, child } = pathFacts();
  const path = { sessionId: s.id, branch: "C", headTurnId: selected.id };
  const store = memory.store;
  // The list both consumers read, and the list they must read: `listSessionFacts`' freshness order
  // (`source_time DESC, id DESC`) with the sibling's fact removed — filtered, never re-queried through
  // `listBranchFacts`, which orders by fact id ascending and would reverse what `budgetFacts` selects.
  expect(store.listSessionFacts(s.id).map(f => f.id)).toEqual([siblingOnly, onPath, shared]);
  expect(store.listSessionFacts(s.id).filter(f => store.factOnPath(f, path)).map(f => f.id)).toEqual([onPath, shared]);
  expect(store.listBranchFacts(s.id, "C", selected.id).map(f => f.id)).toEqual([shared, onPath]);

  // --- compaction: the applicable facts are carried, the sibling's is not, and the whole operation
  // answers membership from one snapshot rather than rebuilding it per fact.
  const snapshots = countPathSnapshots();
  const measure = (run: () => string) => { snapshots.reset(); const text = run(); return { text, snapshots: snapshots.snapshots() }; };
  const small = measure(() => compacted(memory.compact(s.id, "C", selected.id)));
  expect(small.snapshots).toBe(1);
  expect(small.text).toContain(`[F${shared}]`); expect(small.text).toContain(`[F${onPath}]`);
  expect(small.text).not.toContain(`[F${siblingOnly}]`); expect(small.text).not.toContain("SIBLING ONLY");

  // --- the same with a long Raw backlog, each entry cut to `render.entryTokens`: same membership,
  // still one snapshot (30: there is no second rendering pass to charge a second one to).
  const body = "word ".repeat(12_000);
  let head = selected.id;
  for (const i of [1, 2, 3]) head = child("C", head, `FILLER_${i} ${body}`).id;
  const long = measure(() => {
    const result = memory.compact(s.id, "C", head);
    expect("native" in result).toBe(false);
    return compacted(result);
  });
  expect(long.snapshots).toBe(1);
  expect(long.text).toContain(`[F${shared}]`); expect(long.text).toContain(`[F${onPath}]`);
  expect(long.text).not.toContain(`[F${siblingOnly}]`); expect(long.text).not.toContain("SIBLING ONLY");

  // 92 §6: facts never borrow the allowance; the receipt orders omitted path facts newest first.
  const measured = charged(memory.compact(s.id, "C", selected.id));
  compactionWindows(Math.max(1, measured.knowledge), 40, measured.raw);
  const squeezed = compacted(memory.compact(s.id, "C", selected.id));
  expect(squeezed).not.toContain(`[F${onPath}]`); expect(squeezed).not.toContain(`[F${shared}]`);
  expect(squeezed).toContain(`omitted 2 older facts; expand: F${onPath}, F${shared}`); // manual bindings remain eligible
  defaultWindows();

  // 92 uses distinct full-path selection and exact-entry material scopes. This legacy fixture
  // counts wrappers; ticket92material pins native cold/warm builds, metadata and Raw work.
  const target = { sessionId: s.id, branch: "C", headTurnId: selected.id, mode: "subagent" as const };
  snapshots.reset();
  const scopes = vi.spyOn(store, "pathSnapshot");
  const frozen = freezeNoting(store, target, memory.config);
  expect(scopes.mock.calls.map(([path, endpoint]) => ({ path, endpoint }))).toEqual([
    { path, endpoint: undefined }, { path, endpoint: frozen.entries.at(-1)!.id },
  ]);
  expect(snapshots.snapshots()).toBe(2);
  scopes.mockRestore();
  snapshots.restore();
  expect(frozen.prepared!.supplied.factIds).toEqual([onPath, shared]);

  // --- and the history block the subagent actually receives.
  calls.length = 0;
  expect(await memory.noting(target)).toMatchObject({ outcome: "success" });
  const material = calls[0] as NotingAgentInput;
  const history = material.material.facts.join("\n");
  expect(history).toContain(`[F${shared}] `); expect(history).toContain(`[F${onPath}] `);
  expect(history).not.toContain(`[F${siblingOnly}]`); expect(history).not.toContain("SIBLING ONLY");
  expect(material.text).not.toContain("SIBLING ONLY");
});

// ---- 27 review 2026-09-10: one run record per attempt, exact membership, the cancellation fence ----

test("27 review: each attempt is its own run record", async () => {
  // User ruling 2026-09-10, superseding 27c's "one run record for both attempts" (ticket text, never
  // a ruling): a refused attempt that sent a request is finalized by core before the refusal goes
  // back to the host, and the run the re-admission makes charges only itself.
  const { s, t } = session(); memory.close();
  const sent: (string | undefined)[] = [];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    sent.push(input.fallbackReason);
    if (sent.length === 1) return { outcome: "failure", output: "context overflow: prompt is too long", mode: "fork",
      request: { fork: true }, usage: { input: 1234, output: 7 }, retries: [{ attempt: 1, error: "overloaded" }],
      nativeLog: "/tmp/fork-attempt.jsonl", refused: { reason: "context overflow: prompt is too long" } };
    input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    return { outcome: "success", output: "done", mode: "subagent", request: { fresh: true }, usage: { input: 5, output: 1 }, fallbackReason: input.fallbackReason };
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const first = await memory.noting({ ...target, mode: "fork" }) as { outcome: string; refused?: { reason: string }; runId?: number };
  expect(first.outcome).toBe("dropped");
  expect(first.runId).toBe(1); // the attempt that sent a request has a record, and the host is told which
  const attempt = memory.store.getRun(1)!;
  expect(attempt.mode).toBe("fork");
  expect(attempt.outcome).toBe("failure");
  expect(attempt.request).toBe(JSON.stringify({ fork: true }));
  const attemptBody = JSON.parse(attempt.response!);
  expect(attemptBody.requestedMode).toBe("fork");
  expect(attemptBody.usage).toEqual({ input: 1234, output: 7 });
  expect(attemptBody.retries).toEqual([{ attempt: 1, error: "overloaded" }]);
  expect(attemptBody.nativeLog).toBe("/tmp/fork-attempt.jsonl");
  expect(attemptBody.problems).toEqual(["context overflow: prompt is too long"]);
  expect(attemptBody.fallbackReason).toBeUndefined(); // the reason belongs to the run that fell back
  expect(hydrate(memory.store.listSourceEntries(s.id), memory.store).some(e => memory.store.entryNoted(e.id))).toBe(false);

  // The re-admission, as the host makes it: the reason names the first record, and the run records
  // only its own spend — never the attempt's 1234 tokens a second time.
  const reason = `${first.refused!.reason} (fork attempt recorded as R${first.runId})`;
  const second = await memory.noting({ ...target, mode: "fork", effectiveMode: "subagent", fallbackReason: reason, forkAttempt: first.refused });
  expect(second.outcome).toBe("success");
  const run = memory.store.getRun(2)!;
  expect(run.mode).toBe("subagent");
  const body = JSON.parse(run.response!);
  expect(body.usage).toEqual({ input: 5, output: 1 });
  expect(body.fallbackReason).toBe(reason);
  expect(memory.store.listRuns(s.id).filter(r => r.kind === "noting").map(r => r.mode)).toEqual(["fork", "subagent"]);
});

test("27 amendment 6: frozen membership survives fallback or the task stays pending", async () => {
  // The frozen batch is taken whole or not at all. A capacity that holds only its oldest entry used
  // to pop the newer one and report success on the subset; now the batch waits.
  const { s, t } = session();
  const e1 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u1", turnId: t.id, role: "user", text: "first evidence", raw: "first evidence", calls: [] });
  const t2 = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t.id, kind: "turn", userPrompt: "second", startedAt: time });
  const e2 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u2", turnId: t2.id, role: "user", text: "second evidence", raw: "second evidence", calls: [] });
  memory.selectEntries(s.id, "main", [e1.id, e2.id]);
  const target = { sessionId: s.id, branch: "main", headTurnId: t2.id, mode: "subagent" as const };
  // What the batch really costs, priced the way the freeze prices it: instructions, tool definitions
  // and the prepared fresh text. The oldest entry's own price is the allowance that fits one, not two.
  const instructions = loadPrompt("noting.md");
  const priced = (exactEntryIds: number[]) => {
    const frozen = freezeNoting(memory.store, { ...target, boundary: { exactEntryIds } }, memory.config);
    return tokens(instructions) + tokens(JSON.stringify(toolDefinitions)) + tokens(frozen.prepared!.text);
  };
  const capacity = { inputTokens: priced([e1.id]), prefixTokens: 0 };
  expect(priced([e1.id, e2.id])).toBeGreaterThan(capacity.inputTokens);
  await expect(memory.noting({ ...target, boundary: { exactEntryIds: [e1.id, e2.id] }, capacity }))
    .rejects.toThrow(api.NOTING_CAPACITY);
  expect(calls).toEqual([]); // nothing ran on a smaller batch
  expect(hydrate(memory.pendingEntries(s.id, "main", t2.id), memory.store).map(e => e.id)).toEqual([e1.id, e2.id]);

  // With room, the same boundary runs on exactly those entries, and the audit says so.
  const ran = await memory.noting({ ...target, boundary: { exactEntryIds: [e1.id, e2.id] } });
  expect(ran.outcome).toBe("success");
  expect(calls[0]!.entryIds).toEqual([e1.id, e2.id]);
  expect(calls[0]!.entryAudit.entries.map(e => e.id)).toEqual([e1.id, e2.id]);

  // A member another executor already processed drops the task with its reason, and re-processes
  // nothing: this is the claim fence a fresh freeze would otherwise walk straight past.
  const t3 = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t2.id, kind: "turn", userPrompt: "third", startedAt: time });
  const e3 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u3", turnId: t3.id, role: "user", text: "third evidence", raw: "third evidence", calls: [] });
  memory.selectEntries(s.id, "main", [e1.id, e2.id, e3.id]);
  const before = calls.length;
  const dropped = await memory.noting({ ...target, headTurnId: t3.id, boundary: { exactEntryIds: [e2.id, e3.id] } }) as { outcome: string; reason?: string };
  expect(dropped.outcome).toBe("dropped");
  expect(dropped.reason).toContain(api.NOTING_MEMBERSHIP);
  expect(dropped.reason).toContain(`entries ${e2.id} of the frozen batch`);
  expect(calls).toHaveLength(before); // no model call, and no run
  expect(hydrate(memory.pendingEntries(s.id, "main", t3.id), memory.store).map(e => e.id)).toEqual([e3.id]);
});

/** Ticket 29 "One material-selection mechanism" (2026-09-10), as 29b implements it. A task has two
 * different sets: the processing target, frozen regardless of what the child can see, and the material
 * that must be newly supplied — the target minus what the view proves visible at the same identity and
 * the same representation, and only then the injection budget. Never a budget-limited prefix with
 * visibility subtracted afterwards. */
test("29: one material builder — filter visible, then budget", async () => {
  const { s, t } = session();
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ text: "Recorded earlier", source: [`T${t.id}#E1`] }] });
  const entries = hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store);
  // A failing probe leaves the same evidence pending, so every view below freezes the same task.
  const probe = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    calls.push(raw as NotingAgentInput); return { ...ok([]), outcome: "failure" };
  });
  const view = (raw: Map<string, "source" | "view">, factIds: number[] = []) =>
    ({ raw, factIds: new Set(factIds), knowledgeCommitIds: new Set<number>(), injection: false, suppliedGeneration: 0 });
  const freeze = async (visible: ReturnType<typeof view>) => {
    calls.length = 0;
    await probe.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork", visible });
    return calls[0]!;
  };
  try {
    const none = await freeze(view(new Map()));
    const carried = await freeze(view(new Map(entries.map(e => [e.nativeId, "view" as const]))));
    const factSeen = await freeze(view(new Map(entries.map(e => [e.nativeId, "source" as const])), [1]));
    // The processing target is frozen regardless of visibility: three views, one target.
    expect(carried.entryIds).toEqual(none.entryIds);
    expect(factSeen.entryIds).toEqual(none.entryIds);
    // Same identity, permitted representation: a tier-1 carrier view withholds the body exactly as a
    // retained source entry does, and an empty data delta keeps the mandatory framing.
    expect(none.material.entries.map(e => e.id)).toEqual(none.entryIds);
    expect(carried.material.entries).toEqual([]);
    expect(carried.text).toContain(`Range: ${carried.range.from}..${carried.range.to}`);
    expect(carried.material.sources.length).toBeGreaterThan(0);
    // 92 §6: fork inherits its parent and never adds a historical-fact supplement,
    // irrespective of a fact marker in the visible view. The shared compact path's
    // actual filtering-before-budgeting remains pinned by 26 amendment 2 above.
    expect(none.material.facts).toEqual([]);
    expect(carried.material.facts).toEqual([]);
    expect(factSeen.material.facts).toEqual([]);
    // What the text really carries is what a carrier may state — never what the task considered.
    expect(none.supplied.entries.map(e => e.id)).toEqual(none.entryIds);
    expect(none.supplied.factIds).toEqual([]);
    expect(carried.supplied.entries).toEqual([]);
    expect(factSeen.supplied.factIds).toEqual([]);
  } finally { probe.close(); }
});

test("27: cancellation between refusal and re-admission launches no fallback", async () => {
  // Parent 27 line 83: "User cancellation, stop, shutdown, claim loss or disabled enrollment must
  // not launch fallback work." The refused attempt carries the generation it was admitted under;
  // `cancelTasks()` advances it, with or without stopping, and the re-admission drops.
  const { s, t } = session(); memory.close();
  const generations: unknown[] = [];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput & { cancellation?: number };
    generations.push(input.cancellation);
    if (generations.length === 1) return { outcome: "failure", output: "context overflow", request: null, refused: { reason: "context overflow" } };
    input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    return ok([]);
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const first = await memory.noting({ ...target, mode: "fork" }) as { outcome: string; refused?: unknown };
  expect(first.outcome).toBe("dropped");
  expect(memory.store.listRuns(s.id)).toEqual([]); // this refusal sent nothing, so it recorded nothing
  const frozen = generations[0] as number;

  memory.cancelTasks(); // /trace stop, between the refusal and the re-admission — no stopping flag
  const dropped = await memory.noting({ ...target, mode: "fork", effectiveMode: "subagent",
    fallbackReason: "context overflow", forkAttempt: first.refused, cancellation: frozen });
  expect(dropped).toEqual({ outcome: "dropped", reason: api.CANCELLED_BEFORE_FALLBACK });
  expect(generations).toHaveLength(1); // no fresh request
  expect(memory.store.listRuns(s.id)).toEqual([]);
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).length).toBeGreaterThan(0);

  // The cancellation stopped this executor's pending fallback, not the executor: a task admitted
  // after it carries the current generation and runs.
  expect((await memory.noting({ ...target, mode: "subagent" })).outcome).toBe("success");
  expect(generations).toHaveLength(2);
});

test("28 amendment 3: cancellation is a signal — the signalled task's tools close and its claim goes, and no other task is touched", async () => {
  // "Admission accepts this compaction's `AbortSignal`; core wires it into its existing task
  // cancellation so that only this task's tools close and only its claim is invalidated." The
  // executor-wide `cancelTasks` is untouched: what follows uses neither it nor `stopping`.
  const { s, t } = session(); memory.close();
  let releaseNoting = () => {}, releaseDreaming = () => {};
  const heldNoting = new Promise<void>(resolve => { releaseNoting = resolve; });
  const heldDreaming = new Promise<void>(resolve => { releaseDreaming = resolve; });
  let enteredDreaming = () => {};
  const dreamingStarted = new Promise<void>(resolve => { enteredDreaming = resolve; });
  const submissions: unknown[] = [];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    if ((raw as { kind: string }).kind === "dreaming") {
      const task = raw as import("../../../src/core/api/index.ts").DreamingAgentInput;
      task.acknowledgeRequest();
      enteredDreaming();
      await heldDreaming;
      const skipped = suppliedHandles(task.material.changed).map(knowledge => ({ knowledge, because: "Reviewed unchanged" }));
      expect(task.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped })).toContain("committed");
      return ok([]);
    }
    const input = raw as NotingAgentInput;
    await heldNoting; // still in flight when the signal fires
    submissions.push(input.tools.find(tool => tool.name === "note")!.execute({ facts: [
      { text: "a fact this cancelled run tries to commit", source: [`T${t.id}#E1`] }] }));
    return ok([]);
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const fact = JSON.parse(memory.tools({ kind: "manual", ...target, currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ title: "Independent evidence", sources: [{ address: `T${t.id}#E1`, text: "D's independent evidence" }] }] })).factIds[0] as number;
  const trigger = createDreamerTrigger(memory, target, fact, 1);
  const controller = new AbortController();
  const cancelled = memory.noting({ ...target, mode: "subagent", signal: controller.signal });
  const untouched = memory.dream(target);
  await dreamingStarted;
  expect(memory.store.getClaim(s.id, "noting")).not.toBeNull();
  const dreamClaim = memory.store.getClaim(s.id, "dreaming");
  const dreamRange = memory.store.openDreamingRange(s.id, "main");
  expect(dreamClaim).not.toBeNull();
  expect(dreamRange).not.toBeNull();

  controller.abort();
  releaseNoting();
  const result = await cancelled;
  // N's late write is rejected while the independent D run keeps its claim and frozen range.
  expect(String(submissions[0])).toContain("rejected: run has finished");
  expect(memory.store.listSessionFacts(s.id).map(f => f.text)).toEqual(["D's independent evidence"]);
  expect(result.outcome).not.toBe("success");
  expect(memory.store.getClaim(s.id, "noting")).toBeNull();
  expect(memory.store.getClaim(s.id, "dreaming")).toEqual(dreamClaim);
  expect(memory.store.openDreamingRange(s.id, "main")).toEqual(dreamRange);
  releaseDreaming();
  expect((await untouched).outcome).toBe("success");
  expect(memory.store.getClaim(s.id, "dreaming")).toBeNull();
  expect(memory.store.pendingVersions(`project:${memory.store.getSession(s.id)!.projectId}`, target).map(item => item.revisionId)).not.toContain(trigger.commit);
  expect(memory.taskEligibility("noting", target)).toBeDefined();
});

test("28 amendment 3: a signal already aborted at admission cancels that task before its first request", async () => {
  const { s, t } = session(); memory.close();
  const requests: unknown[] = [];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    requests.push(raw); (raw as NotingAgentInput).tools.find(tool => tool.name === "note")!.execute({ facts: [] }); return ok([]);
  });
  const controller = new AbortController(); controller.abort();
  const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent", signal: controller.signal });
  expect(result.outcome).not.toBe("success");
  expect(requests).toEqual([]);
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).length).toBeGreaterThan(0); // nothing advanced
});

// 92 §8's “C删掉” retires the C fact target and C fork fallback. The live exact Raw entry
// membership/capacity fence remains in 27 amendment 6 above; D uses revision ranges.

// 92 §8's “C删掉” retires C's fallback. N's cancelled refusal/re-admission fence remains
// in 27: cancellation between refusal and re-admission above.


test("64b/29/31: archived divergent history follows the owner's shared foreground", async () => {
  const { c, d, peer, edit, publish } = commitPaths();
  const cCommit = (await edit(c, "C version", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1))).committed[0].commit as number;
  const dCommit = (await edit(d, "D version", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2))).committed[0].commit as number;
  publish(c);
  const archived = await admittedWrite(c, createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 3),
    [{ op: "archive", kind: "budget", id: tagged(1, cCommit), reason: "Withdraw C only.", supports: [c.fact] }]);
  expect(archived.committed[0].knowledgeId).toBe(1);
  publish(d);
  const selected = peer();
  const current = memory.store.currentKnowledge(selected);
  expect(current.map(k => k.revision.id)).toEqual([dCommit]);
  expect(knowledgeStatusNotes(memory.store, current, [cCommit], selected)).toEqual([`K1@${cCommit} no longer applies`]);
  expect(knowledgeStatusNotes(memory.store, current, [1], selected)).toEqual([
    `K1@1 is shown as K1@${dCommit}`,
  ]);
  const seen = { raw: new Map<string, "source" | "view">(), factIds: new Set<number>(),
    knowledgeCommitIds: new Set([cCommit]), injection: true, suppliedGeneration: 0 };
  const injected = memory.injection(selected, seen).text;
  expect(injected).toContain(`${history(1, cCommit)} no longer applies`);
  expect(injected).not.toContain(tagged(1, cCommit));
});

test("64b/29/31: an identity disappearance is noticed again after restore and rewind", () => {
  const { root, c, content, publish } = commitPaths();
  publish(c);
  const created = c.write([{ op: "create", topics: [], reason: "Branch-only knowledge.", ...content(c.fact, "C-only rule") }]);
  const commit = created.committed[0].commit as number;
  const status = () => knowledgeStatusNotes(memory.store, memory.store.currentKnowledge(root), [commit], root);

  publish(root);
  expect(status()).toEqual(["K2 no longer applies"]);
  const visible = { raw: new Map<string, "source" | "view">(), factIds: new Set<number>(),
    knowledgeCommitIds: new Set([commit]), injection: true, suppliedGeneration: 0 };
  expect(memory.injection(root, visible).text).toContain("K2 no longer applies");

  publish(c);
  expect(memory.store.currentKnowledge(c).map(item => item.revision.id)).toContain(commit);
  expect(knowledgeStatusNotes(memory.store, memory.store.currentKnowledge(c), [commit], c)).toEqual([]);

  publish(root);
  expect(status()).toEqual(["K2 no longer applies"]);
  expect(memory.injection(root, visible).text).toContain("K2 no longer applies");
});

/** Ticket 40 N0 (2026-09-14): a correction keeps the object's identity. The Sol replay read the
 * id-in-text rejection as "delete" and dropped K213@271 and five other audited objects on
 * resubmission; the prompt and the rejection reason now both say where the span goes. */
test("40 N0/92: the verbatim object span stays inside the episode in corner quotes", () => {
  const { s, t } = session();
  const note = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!;
  const fact = (text: string) => ({ title: "Audited object", sources: [{ address: `T${t.id}#E1`, text }] });
  const rejected = JSON.parse(note.execute({ facts: [fact("K213@271 names its object in the text instead of the quote.")] }));
  expect(rejected.results[0]).toContain("rejected:");
  expect(rejected.results[0]).toContain("sources[0].text: must not embed a fact or knowledge id");
  expect(memory.store.listSessionFacts(s.id)).toEqual([]);
  const accepted = JSON.parse(note.execute({ facts: [fact("The audited item was named as 「K213@271」.")] }));
  expect(accepted.results[0]).toMatch(/^ok:/);
  expect(memory.store.getFact(accepted.factIds[0])!.quote).toBeNull();
  expect(memory.store.getFact(accepted.factIds[0])!.text).toContain("「K213@271」");
});







test("59: every supplied item is accounted for by an operation or a skip; New items search history once, in a batch", () => {
  const prompt = loadPrompt("dreaming.md");
  // The loop's opening: a deliberated item ends the round in an operation or a reasoned skip; a skip never mutates it.
  // 64c: the material also carries the pool's references; only what the round took up is accounted for.
  expect(prompt).toContain("Every `New` and `Changed` item, and every other item the round took through A–D, ends in an operation or in a skip with a reason. Pool references the round did not take up need no skip.");
  // Step B, before the first New item: one batched history search; a hit is read in full before the revival decision.
  expect(prompt).toContain("Before the first `New` item, run one `search` with `queries`, `layer: knowledge`, `versions: history`, `cap: 3`. One query per New item: the shortest common noun of its object, the word an older body would use, never the item's own phrase.");
  // The memory call names the skip shape; the empty-skip literal is gone.
  expect(prompt).toContain('`memory({operations, skipped})`; a skip is `{knowledge: "K12@v3", because}` for a deliberated item left without an operation.');
  expect(prompt).not.toContain("skipped: []");
  // The check tool's receipt and the memory tool's description carry the same contract.
  expect(dreamingToolDefinitions().find(tool => tool.name === "memory")!.description).toContain("skipped uses an exact untagged K@vN history address");
});

test("47: read-version descriptions name current, history and all without making inapplicable revisions write bases", () => {
  const trace = toolDefinitions.find(tool => tool.name === "trace")!;
  const search = toolDefinitions.find(tool => tool.name === "search")!;
  const versions = (trace.parameters.properties as Record<string, { description?: string }>).versions!.description!;
  expect(versions).toContain("current = active current tips applicable on this path");
  expect(versions).toContain("history = additionally applicable superseded and archived revisions");
  expect(versions).toContain("all = additionally other branches' revisions within the selected scope, including their history and archives");
  expect(versions).toContain("never write bases here");
  expect(trace.description).toContain("versions=all additionally adds other branches' revisions, including their history and archives");
  expect(trace.description).toContain("revisions not applicable here are never write bases");
  expect(search.description).toContain("history additionally includes applicable superseded and archived revisions");
  expect(search.description).toContain("all additionally includes other branches' revisions in scope, including their history and archives");
  expect(search.description).toContain("reading never bypasses write validation");
});










// The maintainer's current principle note supersedes 61/92's sentence pins. Semantic alignment is
// reviewed against the frozen note with the change; keep composition and stage authority here.
test("N and D compose shared definitions and principles with their permitted maintenance operations", () => {
  const block = (name: string) => readFileSync(new URL(`../../../src/core/prompts/shared/${name}.md`, import.meta.url), "utf8").trimEnd();
  const shared = ["model", "facts", "knowledge", "common", "admission", "division", "citations", "writing", "maintenance", "archiving", "examples"];
  for (const file of STAGE_PROMPTS) {
    const composed = loadPrompt(file);
    for (const name of shared) expect(composed, `${file}: ${name}`).toContain(block(name));
    expect(composed).not.toContain("<!-- include:");
  }
  const noting = loadPrompt("noting.md"), dreaming = loadPrompt("dreaming.md");
  for (const principle of ["- **Update**:", "- **Archive**:"]) {
    expect(noting).toContain(principle);
    expect(dreaming).toContain(principle);
  }
  for (const principle of ["- **Split**:", "- **Merge**:"]) {
    expect(noting).not.toContain(principle);
    expect(dreaming).toContain(principle);
  }
  expect(dreaming).toContain("Comparison is within one scope; items of different scopes are never merged.");
  expect(dreaming).toContain("A merge may omit `text`: the later parent's body then becomes the survivor's next version verbatim.");
});



// 61 (2026-09-19): the prompts are written to one standard — shared memory-model blocks, per-stage judgment,
// short imperative sentences, no internal references, defined vocabulary only.
const STAGE_PROMPTS = ["noting.md", "dreaming.md"] as const;
const promptSentences = (text: string) => {
  const body = text.replace(/```[\s\S]*?```/g, "");
  const sentences: string[] = [];
  for (const paragraph of body.split(/\n\s*\n/)) {
    if (paragraph.trim().startsWith("#")) continue;
    for (const raw of paragraph.split("\n")) {
      const line = raw.replace(/^\s*(?:[-*>]|\d+\.)\s+/, "").trim();
      const parts = line.split(/(?<=[.!?:])\s+(?=[A-Z`"(*\[])/).filter(part => part.split(/\s+/).length >= 2);
      sentences.push(...parts);
      if (parts.length > 4) sentences.push(`WALL:${line.slice(0, 60)}`);
    }
  }
  return sentences;
};

test("61: every stage prompt is composed from the shared blocks in one section order, with a numbered procedure", () => {
  const order = ["## Role", "## Definitions", "## Principles", "## Inputs", "## Procedure", "## Output"];
  for (const file of STAGE_PROMPTS) {
    const raw = readFileSync(new URL(`../../../src/core/prompts/${file}`, import.meta.url), "utf8");
    let last = -1;
    for (const heading of order) {
      const at = raw.indexOf(`\n${heading}\n`);
      expect(at, `${file}: ${heading}`).toBeGreaterThan(last);
      last = at;
    }
    expect(raw).toMatch(/\n## Procedure\n\n1\. /);
    expect(raw).toMatch(/## Definitions\n\n<!-- include: model -->/);
    expect(raw).toMatch(/## Inputs\n\n<!-- include: formats -->/);
    expect(raw).toMatch(/## Principles\n\n(<!-- include: |### )/);
    expect(loadPrompt(file)).not.toContain("<!-- include:");
  }
});

test("61: sentences are short, paragraphs are not walls, and no internal reference or internal vocabulary leaks into the prompts", () => {
  const banned = [/\bv1\.\d\b/, /\b\d\d[a-z]?'s\b/, /\bticket\s+\d+/, /\bcase \d\b/, /\buncertified\b/, /\bcertificate\b/, /\bneutral conflict\b/, /\bpost-freeze\b/,
    /\beffective grounding\b/, /\bfrozen family\b/, /\bfamily\b/, /\bCONTEXT\.md\b/];
  for (const file of STAGE_PROMPTS) {
    const prompt = loadPrompt(file);
    const sentences = promptSentences(prompt);
    const walls = sentences.filter(s => s.startsWith("WALL:"));
    expect(walls, `${file}: paragraphs over four sentences`).toEqual([]);
    const lengths = sentences.filter(s => !s.startsWith("WALL:")).map(s => s.split(/\s+/).length);
    const longest = sentences.filter(s => s.split(/\s+/).length > 35);
    expect(longest, `${file}: sentences over 35 words`).toEqual([]);
    expect(lengths.reduce((a, b) => a + b, 0) / lengths.length, `${file}: mean sentence length`).toBeLessThanOrEqual(18);
    for (const pattern of banned) expect(prompt.match(pattern), `${file}: ${pattern}`).toBeNull();
    expect(prompt).not.toMatch(/[一-鿿]/);
  }
});

test("61: every backticked category, kind or field word used in a stage file is defined in the shared blocks", () => {
  const shared = ["model", "facts", "knowledge", "admission", "division", "writing", "citations", "formats", "live"]
    .map(name => readFileSync(new URL(`../../../src/core/prompts/shared/${name}.md`, import.meta.url), "utf8")).join("\n");
  const defined = new Set(["goal", "constraint", "understanding", "reference", "open", "observation", "user", "assistant", "role",
    "session", "project", "global", "trace", "search", "supports", "reason", "topics", "text", "title", "sources", "address",
    "category", "scope", "inbound", "support", "negate", "strong", "weak"]);
  for (const word of defined) expect(shared, `shared blocks define ${word}`).toMatch(new RegExp("`" + word + "`|\\*\\*" + word + "\\*\\*"));
  for (const file of STAGE_PROMPTS) {
    const raw = readFileSync(new URL(`../../../src/core/prompts/${file}`, import.meta.url), "utf8").replace(/```[\s\S]*?```/g, "");
    for (const match of raw.matchAll(/`([a-z]+)`/g)) {
      const word = match[1]!;
      if (["note", "memory", "check", "create", "update", "merge", "split", "archive", "op", "id", "skipped", "operations", "queries", "layer", "versions", "cap", "history", "full", "ok", "absorb", "source", "slot", "drop"].includes(word)) continue; // stage tools and operation fields, defined in the stage's Contract
      expect(defined.has(word), `${file}: \`${word}\` is not a defined term`).toBe(true);
    }
  }
});

// 79 item 1: sourcePath, pendingEntries and listSourceEntries return source-entry metadata read from
// the hot table alone; no list read touches the payload table (source_entry_raw). Pinned with
// statement capture against a path long enough that a regression back to per-row hydration would be
// unmistakable in the captured SQL, not just in timing.
test("79 item 1: sourcePath, pendingEntries and listSourceEntries never touch source_entry_raw", () => {
  const memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model"); });
  try {
    const project = memory.store.createProject({ name: "list-shape", declaredBy: "marker" });
    const session = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: project.id, startedAt: "t", firstReplyAt: "t" });
    // `sourceSeededMemory`'s appendTurn wrapper auto-seeds one completed user entry per Turn from
    // `userPrompt` (the fixture shape "20a: the core cases written before source entries were their
    // own record" documents above), so each iteration below owns exactly one source entry.
    let parent: number | null = null;
    const ids: number[] = [];
    for (let i = 0; i < 60; i++) {
      const turn = memory.store.appendTurn({ sessionId: session.id, parentTurnId: parent, kind: "turn", startedAt: "t", userPrompt: `q${i} ${"word ".repeat(200)}` });
      ids.push(memory.store.listSourceEntries(session.id, turn.id)[0]!.id);
      parent = turn.id;
    }
    memory.store.selectSourcePath(session.id, "main", ids);
    const original = memory.store.db.prepare.bind(memory.store.db);
    const statements: string[] = [];
    (memory.store.db as unknown as { prepare: typeof memory.store.db.prepare }).prepare =
      ((sql: string) => { statements.push(sql); return original(sql); }) as typeof memory.store.db.prepare;
    try {
      expect(memory.store.sourcePath(session.id, "main", parent!)).toHaveLength(60);
      expect(memory.store.pendingEntries(session.id, "main", parent!)).toHaveLength(60);
      expect(memory.store.listSourceEntries(session.id)).toHaveLength(60);
    } finally { (memory.store.db as unknown as { prepare: typeof memory.store.db.prepare }).prepare = original; }
    expect(statements.some(sql => sql.includes("source_entry_raw"))).toBe(false);
    expect(statements.some(sql => /\bcontent\b/.test(sql) || /\bblocks\b/.test(sql))).toBe(false);
  } finally { memory.close(); }
});

test("86 rule 2: '必须等该会话无 N C D 运行且未达到任意触发阈值'", () => {
  const { s, t } = session(), path = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const held = memory.store.acquireClaim(path, "noting", "busy-session")!;
  expect(() => memory.declareProject(s.id, "cannot-move", "mark", path)).toThrow(/noting has a live claim/);
  expect(memory.store.findProjectByName("cannot-move")).toBeNull();
  memory.store.releaseClaim(held);
  memory.config.noting.triggerTokens = Number.MAX_SAFE_INTEGER;
  expect(memory.declareProject(s.id, "can-move", "mark", path)).toContain("can-move");
});

test("86 rule 3: '超出一批处理上限的，都应该按序先处理旧的'", () => {
  const { s, t } = session();
  memory.config.noting.batchTokens = 1;
  const selected = memory.notingBatch({ sessionId: s.id, branch: "main", headTurnId: t.id });
  expect(selected).toEqual([]); // 92 §6: no oldest-item overflow beyond the Raw batch window
});

test("86 rule 4: '单条事实/知识不能超过1k'", () => {
  const { s, t } = session();
  const oversized = "x ".repeat(1001);
  expect(tokens(oversized)).toBe(1001);
  const rejected = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, createdAt: time }, facts: [
    { turnId: t.id, text: oversized, category: "decision", actor: "user", source: [`T${t.id}#user`], createdAt: time },
  ] });
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.problems.join(" ")).toContain("1000-token limit: 1001 tokens");
  expect(memory.store.listTurnFacts(t.id)).toEqual([]);
});

/** 97 (2026-09-28): delivery is the database's job, recorded per node at emission. */
async function deliveryFixture(texts: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "rulings-97-"));
  const transcriptPath = join(dir, "native.jsonl"), native = "native-97";
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z" });
  const record = (uuid: string, parentUuid: string | null, type: "user" | "assistant", promptId?: string) => JSON.stringify(type === "user"
    ? { uuid, parentUuid, type, timestamp: time, promptSource: "typed", promptId, message: { role: "user", content: uuid } }
    : { uuid, parentUuid, type, timestamp: time, message: { role: "assistant", content: [{ type: "text", text: uuid }] } }) + "\n";
  writeFileSync(transcriptPath, record("u1", null, "user", "p1") + record("a1", "u1", "assistant"));
  const importer = new CcImporter(config, await recordSessionStart(config, { hook_event_name: "SessionStart", source: "startup",
    session_id: native, transcript_path: transcriptPath }, time));
  const imported = await importer.reconcile();
  const store = importer.memory.store;
  const seed = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: store.getSession(imported.coreSessionId!)!.projectId, startedAt: time, firstReplyAt: time });
  const turn = store.appendTurn({ sessionId: seed.id, kind: "turn", userPrompt: "rule", startedAt: time });
  const source = store.appendSourceEntry({ sessionId: seed.id, turnId: turn.id, nativeLineage: "seed", nativeId: "rule", role: "user", text: "rule", raw: "rule", calls: [] });
  const evidence = legacyFacts(store, { kind: "manual", sessionId: seed.id, createdAt: time }, [{ sources: [{ entry: source,
    address: `T${turn.id}#E${source.entryOrdinal}` }], text: "rule", category: "decision", actor: "user", createdAt: time }]).facts[0]!;
  const committed = store.commitConsolidationRun({ path: { sessionId: seed.id, headTurnId: turn.id }, run: { kind: "manual", sessionId: seed.id, createdAt: time },
    operations: texts.map((text, index) => ({ op: "create" as const, handle: `$${index + 1}`, author: "fixture", text, category: "constraint" as const,
      scope: "global" as const, supports: [evidence.id], topics: [], reason: "fixture", createdAt: time })) });
  if (!committed.ok) throw new Error(committed.problems.join());
  const { ccDeltaInjection } = await import("../../../src/hosts/cc/injection.ts");
  const { sliceCcInjection } = await import("../../../src/hosts/cc/slices.ts");
  const prompt = (promptId: string) => ccDeltaInjection(config, { session_id: native, transcript_path: transcriptPath }, { kind: "prompt", promptId },
    (output, visible) => sliceCcInjection(visible, output?.transportItems ?? [], undefined, output?.transportKnowledgeAllowance));
  return { dir, store, importer, transcriptPath, record, prompt, commits: committed.committed.map(item => item.commit),
    rows: () => store.db.prepare("SELECT node_key AS prompt, commits, knowledge_tokens FROM knowledge_deliveries ORDER BY id").all() as
      { prompt: string; commits: string; knowledge_tokens: number }[],
    dispose: () => { importer.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("97 \"只要投过就算成功\" (2026-09-28): an emitted part is delivered even when Claude Code persists it to a file", async () => {
  const f = await deliveryFixture(["Use pnpm."]);
  try {
    expect((await f.prompt("p2")).filter(Boolean)).toHaveLength(1);
    // Claude Code kept only a file reference and a preview; nothing confirms or refutes delivery.
    writeFileSync(f.transcriptPath, readFileSync(f.transcriptPath, "utf8") + f.record("u2", "a1", "user", "p2")
      + JSON.stringify({ uuid: "h2", parentUuid: "u2", type: "attachment", attachment: { type: "hook_additional_context",
        hookEvent: "UserPromptSubmit", content: ["<persisted-output>\nOutput too large (12KB). Full output saved to: /tmp/x.txt\n</persisted-output>"] } }) + "\n");
    await f.importer.reconcile();
    expect((await f.prompt("p3")).filter(Boolean)).toEqual([]);
  } finally { f.dispose(); }
});

test("97 \"暂存成功就算全部已投递\" (2026-09-28): every part of a staged publication counts in the staging transaction", async () => {
  const f = await deliveryFixture(Array.from({ length: 4 }, (_, n) => `Rule ${n}: ${"word ".repeat(1600)}`));
  try {
    const slices = (await f.prompt("p2")).filter(Boolean);
    expect(slices.length).toBeGreaterThan(1);
    // Recorded before any slot printed: one row per part, each with its own render-time cost.
    const rows = f.rows();
    expect(rows).toHaveLength(slices.length);
    expect(rows.flatMap(row => JSON.parse(row.commits)).sort((a: number, b: number) => a - b)).toEqual(f.commits);
    expect(new Set(rows.map(row => row.prompt))).toEqual(new Set(["p2"]));
  } finally { f.dispose(); }
});

test("97 \"所有计算应该都可以统一基于缓存算\" (2026-09-28): a node's delivered state is its parent's plus its own; a compaction restarts it", () => {
  const project = memory.store.createProject({ name: "p97", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "cc:r97", projectId: project.id, startedAt: time, firstReplyAt: time });
  const t1 = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "one", startedAt: time });
  const t2 = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t1.id, kind: "turn", userPrompt: "two", startedAt: time });
  const t3 = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t1.id, kind: "compaction", startedAt: time, endedAt: time });
  const t4 = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t3.id, kind: "turn", userPrompt: "four", startedAt: time });
  const part = (tokens: number) => ({ knowledgeCommitIds: [], knowledgeStates: [], knowledgeTokens: tokens });
  memory.store.recordKnowledgeDelivery({ owner: "cc:r97", turnId: t1.id }, [part(1)]);
  memory.store.recordKnowledgeDelivery({ owner: "cc:r97", turnId: t2.id }, [part(10)]);
  memory.store.recordKnowledgeDelivery({ owner: "cc:r97", turnId: t3.id }, [part(100)]);
  memory.store.recordKnowledgeDelivery({ owner: "cc:r97", turnId: t4.id }, [part(1000)]);
  const at = (headTurnId: number) => memory.store.deliveredKnowledge({ owner: "cc:r97", sessionId: s.id, headTurnId }).knowledgeTokens;
  expect([at(t1.id), at(t2.id), at(t3.id), at(t4.id)]).toEqual([1, 11, 100, 1100]);
});
