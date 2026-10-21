import { readHandle } from "../../read-handle-fixture.ts";
import { dreamerWrite, skipRest, suppliedHandles } from "../../dreaming-skips.ts";
import { knowledgeStatusNotes } from "../../../src/core/api/read.ts";
import { compacted, recorded } from "../../source-fixture.ts";
// Ruling test points: each test pins a user ruling that an implementation could silently deviate
// from. Names identify the ruling and its conversation date.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { DEFAULT_WRITING_LIMITS, renderLimits } from "../../../src/core/prompts/limits.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, REMOVED_SETTINGS, sourceSeededMemory, canonicalFlatConfig, renderEntry, runMode, toolDefinitions, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { TraceMemory as createMemory } from "../../../src/core/api/index.ts";
import * as api from "../../source-fixture.ts";
import { tokens, hydrate } from "../../source-fixture.ts";
import { countPathSnapshots } from "../../perf/fixture.ts";
import { dreamingToolDefinitions, pricedToolDefinitions } from "../../../src/core/api/tools.ts";
import type { MemoryReceipt } from "../../../src/core/knowledge-write/bind.ts";
import { canonicalToolNames, renderToolNames } from "../../../src/core/prompts/tool-names.ts";
import { ccPluginToolNames } from "../../../src/hosts/cc/tool-names.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { setKnowledgeCapacity, setKnowledgeInjection } from "../../knowledge-budget-fixture.ts";
import { visibleView } from "../../../src/hosts/pi/visible.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { CcTaskScheduler } from "../../../src/hosts/cc/scheduler.ts";
import { receiptCommit } from "../../support/seed.ts";
import { block as workspaceBlock, workspaceBatch } from "../../support/workspace.ts";
import { applyWorkspace, checkWorkspace } from "../../../src/core/workspace/index.ts";
import { resolveCcHostConfig } from "../../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../../src/hosts/cc/binding.ts";
import { CcCoordinator, recordCcSessionEnd } from "../../../src/hosts/cc/lifecycle.ts";
import { handleCcHook } from "../../../src/hosts/cc/index.ts";
import * as ccNative from "../../../src/hosts/cc/native-session.ts";
import { CcImporter } from "../../../src/hosts/cc/importer.ts";
import { Store } from "../../../src/core/store/index.ts";
import { entry as seedEntry, fact as seedFact, facts as seedFacts, knowledge as seedKnowledge, legacyArchive, legacyFacts, legacyKnowledge, session as seedSession } from "../../support/seed.ts";
import { ccCompaction, ccDeltaInjection, databaseIdentity, decodeCcInjection } from "../../../src/hosts/cc/injection.ts";
import { sliceCcInjection } from "../../../src/hosts/cc/slices.ts";
import { KNOWLEDGE_RECENCY_NOTICE } from "../../../src/core/render/index.ts";
import { readingGuide } from "../../../src/core/render/reading-guide.ts";
import { memoryFiles } from "../../../src/core/api/files.ts";
import { CC_AUTO_CONTINUE_SUFFIX, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, ccStripAutoContinue } from "../../../src/hosts/cc/transcript.ts";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { DirectoryOptions } from "../../../src/core/project/directory.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";
import { rawWindowTokens } from "../../../src/core/render/material.ts";

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
/** Resolve the shared receipt's exact committed version for database assertions. */
const commitOf = (item: { knowledgeId: number; version: string }): number => {
  return receiptCommit(memory.store, item);
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-rulings-"));
  calls = [];
  // 26a/92: a successful Noter script explicitly submits both empty layers.
  const fallback = async (raw: unknown) => { const input = raw as NotingAgentInput; calls.push(input);
    if (input.kind === "noting") {
      input.tools.find(t => t.name === "note")!.execute({});
      input.tools.find(t => t.name === "memory")!.execute({});
    }
    return ok([]); };
  admittedScenarios = new AdmittedDreamerScenarios(fallback);
  // Items here are sized in thousands of tokens, as items written before the caps (ticket 144) are; the caps are lifted for this file, and its own cap ruling restores them.
  memory = sourceSeededMemory(join(directory, "test.sqlite"), admittedScenarios.agent, { writing: { bodyTokens: 1_000_000 } });
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

/** Tight-budget cases bound both independent allowances explicitly; no window can borrow a base. */
const compactionWindows = (knowledge: number, facts: number, raw: number, allowance = 0, temporary = 0) => {
  setKnowledgeInjection(memory, Math.max(0, knowledge));
  memory.config.compaction.factsTokens = facts;
  memory.config.compaction.rawTokens = raw;
  memory.config.compaction.sharedAllowanceTokens = allowance;
  memory.config.compaction.temporaryTokens = temporary;
};
const defaultWindows = () => compactionWindows(memory.knowledgeBudgets().injection,
  DEFAULT_CONFIG.compaction.factsTokens, DEFAULT_CONFIG.compaction.rawTokens, DEFAULT_CONFIG.compaction.sharedAllowanceTokens,
  DEFAULT_CONFIG.compaction.temporaryTokens);
/** The per-window accounting of one custom replacement (28a item 6). */
const charged = (result: ReturnType<typeof memory.compact>) => {
  if ("native" in result) throw new Error(`expected a custom replacement, got: ${result.reason}`);
  return result.charged!;
};

function session() {
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "pi:fixture", startedAt: time, firstReplyAt: time, projectId: project.id });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "用 pnpm，不要 npm", assistantText: "好的。", startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: JSON.stringify({ command: "pnpm install" }), result: JSON.stringify({ stdout: "done", stderr: "" }), status: "success" });
  return { s, t };
}

test("thinking-only entries are processed without Noting material", async () => {
  const m = sourceSeededMemory(join(directory, "thinking.sqlite"), admittedScenarios.agent, {}, undefined, piSourceBlocks);
  try {
    const project = m.store.createProject({ name: "thinking", declaredBy: "mark" });
    const s = seedSession(m.store, project.id, "pi:fixture");
    const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: time });
    const privateEntries = ["first-private", "last-private"].map(id => seedEntry(m.store, s.id, t.id, id, "assistant", "",
      JSON.stringify({ role: "assistant", content: [{ type: "thinking", thinking: id }] })));
    const first = privateEntries[0]!, last = privateEntries[1]!;
    const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
    m.selectEntries(s.id, "main", [first.id]);
    expect(m.pendingTokens("noting", target).tokens).toBe(0);
    const publicEntry = seedEntry(m.store, s.id, t.id, "answer", "assistant", "Public answer",
      JSON.stringify({ role: "assistant", content: [{ type: "thinking", thinking: "mixed-private" }, { type: "text", text: "Public answer" }] }));
    m.selectEntries(s.id, "main", [publicEntry.id]);
    const baseline = freezeNoting(m.store, { ...target }, m.config);
    const publicView = renderEntry(publicEntry, m.config.render);
    m.config.noting.batchTokens = rawWindowTokens([publicView.content], publicView.receipts);
    m.selectEntries(s.id, "main", [first.id, publicEntry.id, last.id]);
    expect(m.pendingTokens("noting", target).tokens).toBe(tokens(renderEntry(publicEntry, m.config.render).content));
    const frozen = freezeNoting(m.store, { ...target }, m.config);
    expect(frozen.entries.map(entry => entry.id)).toEqual([first.id, publicEntry.id, last.id]);
    expect(frozen.prepared!.material.entries.map(entry => entry.id)).toEqual([publicEntry.id]);
    for (const entry of [first, last]) expect(frozen.prepared!.text).not.toContain(`T${t.id}#E${entry.entryOrdinal}`);
    expect(frozen.prepared!.text).not.toContain("[thinking omitted]");
    expect(frozen.prepared!.text).not.toContain("mixed-private");
    expect(frozen.prepared!.supplied.entries.map(entry => entry.id)).toEqual([publicEntry.id]);
    const price = tokens(baseline.prompt!) + tokens(JSON.stringify(pricedToolDefinitions(toolDefinitions, canonicalToolNames)))
      + tokens(baseline.prepared!.text);
    expect(freezeNoting(m.store, { ...target, boundary: { exactEntryIds: [first.id, publicEntry.id, last.id] },
      capacity: { inputTokens: price, prefixTokens: 0 } }, m.config).entries.map(entry => entry.id))
      .toEqual([first.id, publicEntry.id, last.id]);
    expect(await m.noting({ ...target })).toMatchObject({ outcome: "success" });
    expect(calls[0]!.entryIds).toEqual([first.id, publicEntry.id, last.id]);
    expect(m.pendingEntries(s.id, "main", t.id)).toEqual([]);
    for (const entry of [first, last]) expect(m.store.entryNoted(entry.id)).toBe(true);
    expect(m.pendingTokens("noting", target).tokens).toBe(0);
  } finally { m.close(); }
});

test("pending counts stay exact as mixed batches publish and only thinking remains", async () => {
  const m = sourceSeededMemory(join(directory, "pending-thinking.sqlite"), admittedScenarios.agent, {}, undefined, piSourceBlocks);
  try {
    const project = m.store.createProject({ name: "thinking", declaredBy: "mark" });
    const s = seedSession(m.store, project.id, "pi:fixture");
    const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: time });
    const entries = ["first answer", "", "second answer", ""].map((text, index) => seedEntry(m.store, s.id, t.id,
      `entry-${index}`, "assistant", text, JSON.stringify({ role: "assistant", content: text
        ? [{ type: "text", text }] : [{ type: "thinking", thinking: `private-${index}` }] })));
    const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
    m.selectEntries(s.id, "main", entries.map(entry => entry.id));
    const publicEntries = [entries[0]!, entries[2]!];
    expect(m.pendingTokens("noting", target).tokens).toBe(tokens(publicEntries.map(entry => renderEntry(entry, m.config.render).content).join("\n\n")));
    for (const entry of publicEntries) {
      expect(await m.noting({ ...target, boundary: { maxEntryId: entry.id } })).toMatchObject({ outcome: "success" });
      const remaining = publicEntries.filter(candidate => candidate.id > entry.id);
      expect(m.pendingTokens("noting", target).tokens).toBe(tokens(remaining.map(candidate => renderEntry(candidate, m.config.render).content).join("\n\n")));
    }
    expect(m.pendingEntries(s.id, "main", t.id).map(entry => entry.id)).toEqual([entries[3]!.id]);
    m.config.noting.batchTokens = 0;
    expect(await m.noting({ ...target })).toMatchObject({ outcome: "success" });
    expect(calls.at(-1)!.material.entries).toEqual([]);
    expect(calls.at(-1)!.text).not.toContain("[thinking omitted]");
    expect(m.pendingEntries(s.id, "main", t.id)).toEqual([]);
  } finally { m.close(); }
});

test("2026-10-01, 117: every normal Noter pass gets one held-state review before atomic publication", async () => {
  const seen: string[] = [];
  const fresh = sourceSeededMemory(join(directory, "review.sqlite"), async raw => {
    const task = raw as NotingAgentInput;
    const first = task.passEnd();
    seen.push(first);
    expect(first).toContain("Blockers:\n");
    expect(first).toContain("Knowledge changes held in this run:\nNone.");
    expect(first).toContain(`${canonicalToolNames.note} not called`);
    task.tools.find(tool => tool.name === "note")!.execute({});
    task.tools.find(tool => tool.name === "memory")!.execute({});
    expect(task.passEnd()).toContain("Blockers:\nNone.");
    return ok("finished");
  });
  try {
    const project = fresh.store.createProject({ name: "review", declaredBy: "mark" });
    const owner = fresh.store.createSession({ projectId: project.id, enrollmentChoice: true, host: "pi:fixture", startedAt: time, firstReplyAt: time });
    const turn = fresh.store.appendTurn({ sessionId: owner.id, kind: "turn", userPrompt: "rule", assistantText: "ack", startedAt: time });
    expect((await fresh.noting({ sessionId: owner.id, branch: "main", headTurnId: turn.id })).outcome).toBe("success");
    expect(seen).toHaveLength(1);
    expect(fresh.store.pendingEntries(owner.id, "main", turn.id)).toEqual([]);
  } finally { fresh.close(); }
});

test("2026-10-17, 141: entry ends retry failed automatic work; completion schedules nothing and three failures disable memory", async () => {
  const attempts: number[][] = [];
  const fresh = createMemory(":memory:", async raw => {
    const task = raw as NotingAgentInput;
    attempts.push([...task.entryIds]);
    return { outcome: "failure", output: "persistent provider failure", request: { fixture: true } };
  }, { noting: { triggerTokens: 1 } });
  const project = fresh.store.createProject({ name: "entry-retry", declaredBy: "mark" });
  const owner = seedSession(fresh.store, project.id, "cc:entries");
  const turn = fresh.store.appendTurn({ sessionId: owner.id, kind: "turn", startedAt: time, userPrompt: "pending" });
  const worker = resolveCcHostConfig({ dbPath: join(directory, "unused.sqlite"), stateDir: directory,
    notingModel: "synthetic", notingThinking: "medium", "dreaming.model": "synthetic", "dreaming.thinking": "medium",
    worker: { cwd: directory, claudeExecutable: "/missing/claude", contextWindows: { synthetic: 200_000 } } }).worker;
  const scheduler = new CcTaskScheduler(fresh, worker, () => {});
  const selected: number[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const source = seedEntry(fresh.store, owner.id, turn.id, `entry-${i}`, "assistant", "word ".repeat(100));
      selected.push(source.id); fresh.selectEntries(owner.id, "main", selected);
      scheduler.reconcile({ state: "ready", coreSessionId: owner.id, branch: "main", headTurnId: turn.id,
        selectedEntryIds: selected, selectedCount: selected.length, selectedTailId: source.id,
        selectedAppendedEntryIds: [source.id], appendedEntryIds: [source.id], problems: [], snapshot: {} as never });
      await scheduler.settle();
      expect(attempts).toHaveLength(i + 1);
      expect(fresh.store.entryNoted(selected[0]!)).toBe(false);
    }
    expect(fresh.store.listRuns(owner.id).map(run => run.outcome)).toEqual(["failure", "failure", "failure"]);
    expect(fresh.store.enabled(owner.id)).toBe(false);
  } finally { scheduler.stop(); await scheduler.settle(); fresh.close(); }
});

test("2026-09-24, 86: 'catchup 选A' and '任务失败后不检查' — retry the failed phase before checking other phases", async () => {
  let attempts = 0;
  const retryMemory = sourceSeededMemory(":memory:", async raw => {
    const task = raw as NotingAgentInput;
    attempts++;
    expect(task.kind).toBe("noting");
    if (attempts === 1) return { outcome: "failure", request: { fake: true }, output: "first attempt failed" };
    expect(checks.mock.calls.map(([phase]) => phase)).toEqual(["dreaming"]);
    expect(retryMemory.store.taskFailures(target.sessionId).some(row => row.count === 1)).toBe(true);
    task.tools.find(tool => tool.name === "note")!.execute({});
    task.tools.find(tool => tool.name === "memory")!.execute({});
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
  const stateDir = mkdtempSync(join(tmpdir(), "tm102r-")), cwd = join(directory, "repository");
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
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(config, "before-clear", message => diagnostics.push(message));
  const store = new Store(config.dbPath);
  try {
    await coordinator.start();
    expect(diagnostics.filter(message => message.includes("reconciliation failed"))).toEqual([]);
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
  const rendered = memoryFiles(memory, { sessionId: s.id, branch: "main", headTurnId: t.id }).read(`trace://raw/S${s.id}/T${t.id}`).content;
  // 23c renders the arguments under one half of `B`; the cap is the same estimate either way.
  expect(rendered).not.toContain(han);   // 348 tokens over a 150-token arguments share: cut.
  expect(rendered).toContain(ascii);     // 58 tokens of the same 400 characters: kept whole.
  expect(rendered).toMatch(/command="一+"\[\.\.\. \d+ characters truncated\]"一+"/);
});

/** Knowledge to lead the block with: one manually written fact, consolidated by hand into K1. */
/** Fresh N alone shows each body's token count after the category tag; everything else in the block is the shared layout. */
const withSize = (block: string) => block.replace("[constraint/project] Fixture title", `[constraint/project] (${tokens("The project uses pnpm")}/${memory.config.writing.bodyTokens} tokens) Fixture title`);
function seededKnowledge(sessionId: number, turnId: number) {
  const tools = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: turnId });
  const entry = hydrate(memory.store.listSourceEntries(sessionId, turnId), memory.store).find(value => value.role === "user")!;
  expect(seedFact(memory, { sessionId, branch: "main", headTurnId: turnId }, "Package manager decision", [{ entry, text: "Use pnpm" }]).id).toBe(1);
  expect(tools.find(tool => tool.name === "memory")!.execute({ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"] })).toContain("committed");
}

// User ruling 2026-09-08 (ticket 20 "Solution"): this explicitly revises 19b's ban on core-composed
// domain text, without restoring core-owned provider conversations or a custom model loop. The 19b
// pin "no core module builds a message sequence or a provider body, and no host receives composed
// domain text" is superseded by: core builds no provider message or body; core owns the domain text.
test("20a 2026-09-08: core owns the host-neutral domain text and still builds no provider message or body", async () => {
  const { s, t } = session();
  seededKnowledge(s.id, t.id);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const input = calls[0]!;
  // Domain text, from core, in core's own order — instructions stay their own field, not a system message.
  expect(input.text).toContain(input.material.entries[0]!.view);
  expect(input.text).toContain("The project uses pnpm"); // 92 §6: a seeded, visible knowledge body is actually supplied
  expect(input.text).toContain(withSize(memory.inject(s.id)).split("\n\nReceipts:")[0]!);
  expect(input.prompt).toContain("Noting (facts and knowledge)");
  expect(input.text).not.toContain(input.prompt);
  // What core still does not build: a message sequence, a system slot, a provider body.
  const record = input as unknown as Record<string, unknown>;
  for (const key of ["messages", "system", "conversation", "body", "subagentInput"]) expect(key in record).toBe(false);
  expect(Array.isArray(record.input)).toBe(false);
  // The recorded provider request is the host's own object; core never produced it.
  expect(JSON.parse(memory.store.listRuns(s.id).at(-1)!.request!)).toEqual({ fake: true });
});

// 92 §6 supersedes 25a's N exclusion: one seeded Knowledge body uses the same leading renderer
// for foreground injection, compact and fresh N; target-specific framing stays outside that block.
test("20a/92: fresh N shares the leading Knowledge block without copying task framing into it", async () => {
  const { s, t } = session();
  seededKnowledge(s.id, t.id);
  const block = memory.inject(s.id);
  expect(block).toContain("The project uses pnpm");
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const input = calls[0]!;
  expect(input.text).toContain(withSize(block));
  expect(input.text).toContain(`Range: ${input.range.from}..${input.range.to}`);
  expect(compacted(memory.compact(s.id, "main", t.id)).startsWith(`${block}\n\n<episodic>`)).toBe(true);
  expect(block).not.toContain("Range: ");
  expect(block).not.toContain("[entry ");
  expect(block).not.toContain("omitted");
  for (const line of input.material.facts) expect(block).not.toContain(line);
  expect(block).not.toMatch(/\bR\d+\b/);
  expect(block).not.toContain(memory.store.getTurn(t.id)!.startedAt);
});

test("118: explicit session/Turn paths reject mismatched sessions", () => {
  const { s, t } = session();
  const files = memoryFiles(memory, { sessionId: s.id, branch: "main", headTurnId: t.id });
  expect(files.read(`trace://raw/S${s.id}/T${t.id}`).content).toContain(`T${t.id}#E1`);
  expect(() => files.read(`trace://raw/S${s.id + 1}/T${t.id}`)).toThrow("does not exist");
});

// 09:43 "sessions of one project integrate separately": pinned in core/api/consolidation.test.ts,
// "each session settles only its own branch facts and shares already-settled context".

// Ticket 118 ruling 11 removes the public trace tool; search and both writers remain.
test("2026-10-02: only search and writers are model-facing Core tools", () => {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  expect(tools.map(tool => tool.name)).toEqual(["search", "note", "memory"]);
  for (const tool of tools) { expect(tool.parameters.type).toBe("object"); expect(typeof tool.execute).toBe("function"); }
  expect(tools.find(tool => tool.name === "note")!.description).toContain("Both note and memory are required in N");
  expect(tools.find(tool => tool.name === "memory")!.description).toContain("Manual writers may create/update/archive");
  expect(tools.find(tool => tool.name === "memory")!.execute({ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion." })).toContain("rejected:");
});

// Ticket 116 supersedes the manual batch ruling: valid calls commit independently of later refusals.
test("2026-10-01, 116: a rejected manual item cannot undo its committed sibling", () => {
  const { s, t } = session();
  const note = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!;
  const fact = { title: "Package manager decision", sources: `[T${t.id}#E1] Use pnpm` };
  expect(JSON.parse(note.execute(fact)).factIds).toEqual([1]);
  expect(note.execute({ ...fact, actor: "tool" })).toContain("rejected:");
  expect(memory.store.listSessionFacts(s.id)).toHaveLength(1);
  expect(JSON.parse(note.execute({ ...fact, support: [["F1", "strong"]] })).factIds).toEqual([2]);
  expect(memoryFiles(memory, { sessionId: s.id, branch: "main", headTurnId: t.id }).read("trace://F2").content).toContain("support F1 strong");
});

// One publication per run still holds; 92 moves it after all held edits and normal termination.
test("2026-09-07 / 92: one terminal publication per run, not one immediate tool submission", async () => {
  const { s, t } = session(); memory.close();
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    const fact = { title: "Package manager decision", sources: `[T${t.id}#E1] Use pnpm` };
    expect(note.execute(fact)).toContain("held: $1");
    expect(memory.store.listSessionFacts(s.id)).toEqual([]);
    expect(memory.store.listRuns(s.id).some(run => run.outcome === "success")).toBe(false);
    const entries = memory.store.sourcePath(s.id, "main", t.id);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(entry => memory.store.entryNoted(entry.id))).toBe(false);
    expect(note.execute({ slot: "$1", ...fact, sources: `[T${t.id}#E1] Use pnpm, not npm` })).toContain("held: $1");
    expect(input.tools.find(tool => tool.name === "memory")!.execute({})).not.toContain("rejected:");
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
    input.tools.find(tool => tool.name === "note")!.execute(reject ? { title: "Invalid source", sources: "[T999#E1] Absent" } : {});
    input.tools.find(tool => tool.name === "memory")!.execute({});
    return { outcome: "success", output: "No more text", request: {} };
  });
  const input = { sessionId: s.id, branch: "main", headTurnId: t.id };
  expect((await memory.noting(input)).outcome).toBe("bounced");
  expect(memory.store.getRun(1)?.outcome).toBe("bounced");
  expect(JSON.parse(memory.store.getRun(1)!.response!).toolCalls[0].input).toEqual({ title: "Invalid source", sources: "[T999#E1] Absent" });
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
  const create = { op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"] };
  const write = (operations: any[]) => {
    const writer = tools.find(tool => tool.name === "memory")!;
    const receipts = operations.map(operation => JSON.parse(writer.execute(operation)));
    return { results: receipts.flatMap(receipt => receipt.results), committed: receipts.flatMap(receipt => receipt.committed ?? []) };
  };
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
  const files = memoryFiles(memory, path), search = tools.find(tool => tool.name === "search")!;
  expect(files.read(`trace://${history(invalidId, invalid.id)}`).content).toContain("status: archive (invalid)");
  expect(files.read(`trace://${history(budgetId, budget.id)}`).content).toContain("status: archive (budget)");
  // 136: every version is searched. The old body is found through the superseded parent; the archive is marked.
  expect(search.execute({ query: "Old unique guidance", layer: "knowledge" })).toContain(`[K${invalidId}@v1] (superseded)`);
  expect(search.execute({ query: "no longer holds", layer: "knowledge" })).toContain(`[K${invalidId}@v2] (archived)`);
});

test("2026-09-28, 101: 'grep 直接搜完整原文' — grep reaches Raw beyond its compressed and fact-projected views", () => {
  const { s, t } = session();
  memory.store.appendToolCall({ turnId: t.id, name: "Read", input: JSON.stringify({ path: "notes.md" }), status: "success",
    result: `${"filler ".repeat(2_000)}hashline-deep-in-raw${" tail".repeat(50)}` });
  const { path } = memoryWriter();
  recorded(memory, s.id, "main", t.id);
  const files = api.memoryFiles(memory, path);
  const found = [...files.grep("hashline-deep-in-raw", `trace://S${s.id}`)].map(hit => hit.path);
  expect(found).toHaveLength(1);
  const [, entryOrdinal] = /#E(\d+)$/.exec(found[0]!)!;
  expect(found[0]).toBe(`trace://raw/S${s.id}/T${t.id}#E${entryOrdinal}`);
  // Neither the Turn's fact projection nor the compressed Raw overview holds the text.
  expect(files.read(`trace://facts/S${s.id}/T${t.id}`).content).not.toContain("hashline-deep-in-raw");
  expect(files.read(`trace://raw/S${s.id}/T${t.id}`).content).not.toContain("hashline-deep-in-raw");
});

test("2026-09-28, 101: '1-2. 可以' (1) — an archive written before 99 lists and searches with its parent's body; its own version stays empty", () => {
  const { path, write, create } = memoryWriter();
  const base = write([{ ...create, text: "Legacy okapi guidance" }]).committed[0];
  const commit = legacyArchive(memory.store, path, base.knowledgeId, commitOf(base), [1]);
  const files = api.memoryFiles(memory, path);
  expect(files.read("trace://knowledge-all").content.split("\n").find(line => line.startsWith(`trace://K${base.knowledgeId}@`)))
    .toBe(`trace://K${base.knowledgeId}@v2  [constraint/project p] (archived at v2) Legacy okapi guidance`);
  expect([...files.grep("okapi", "trace://knowledge-all")].map(hit => `${hit.path}${hit.mark ?? ""}`)).toEqual([`trace://K${base.knowledgeId}@v1 (historical; latest v2, archived)`,
    `trace://K${base.knowledgeId}@v2 (archived)`]);
  expect(memory.store.getKnowledgeRevision(base.knowledgeId, commit)!.text).toBe("");
  expect(files.read(`trace://K${base.knowledgeId}@v2`).content).not.toContain("okapi");
});

test("118: one identical reading guide per injection and compaction, independent of knowledge count", () => {
  const { s, t } = session();
  seededKnowledge(s.id, t.id);
  const guide = readingGuide(s.id, canonicalToolNames);
  const once = (text: string, needle: string) => expect(text.split(needle)).toHaveLength(2);
  once(memory.inject(s.id), guide);
  expect(memory.inject(s.id)).toContain(KNOWLEDGE_RECENCY_NOTICE);
  once(compacted(memory.compact(s.id, "main", t.id)), guide);
  const ccGuide = readingGuide(s.id, ccPluginToolNames);
  const cc = sliceCcInjection({ db: "db", nativeSession: "native", coreSession: s.id }, memory.injection(s.id, undefined, true, ccPluginToolNames).transportItems!)
    .filter(Boolean).map(slice => slice!.hookSpecificOutput.additionalContext).join("\n");
  once(cc, ccGuide);
  once(compacted(memory.compact(s.id, "main", t.id, [], false, { toolNames: ccPluginToolNames })), ccGuide);
  expect(memory.inject({ projectId: memory.store.getSession(s.id)!.projectId })).not.toContain(`trace://knowledge/S${s.id}`);
});

test("2026-10-09, 132: '注入知识改为按类别分组' — foreground, compaction and CC parts group the same knowledge by category", () => {
  const { write, create, path } = memoryWriter();
  expect(write([{ ...create, category: "reference", text: "Docs live in docs/" }, { ...create, category: "constraint", text: "Use pnpm" }]).committed).toHaveLength(2);
  const headers = (text: string) => [...text.matchAll(/^## .*$/gm)].map(match => match[0]);
  const expected = ["## constraint (1)", "## reference (1)"];
  expect(headers(memory.inject(path.sessionId))).toEqual(expected);
  expect(headers(compacted(memory.compact(path.sessionId, "main", path.headTurnId)))).toEqual(expected);
  const cc = sliceCcInjection({ db: "db", nativeSession: "native", coreSession: path.sessionId }, memory.injection(path.sessionId, undefined, true, ccPluginToolNames).transportItems!)
    .filter(Boolean).map(slice => slice!.hookSpecificOutput.additionalContext).join("\n");
  expect(headers(cc)).toEqual(expected);
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
});

test("Dreaming's frozen budget excludes later manual knowledge, which cannot be used as a maintenance base", async () => {
  const { path, write, create } = memoryWriter();
  memory.config.dreaming.triggerTokens = 1;
  write([{ ...create, text: "freeze-time rule" }]);
  const before = memory.store.poolSizes(path);
  memory.setKnowledgeBudget("project", before.find(value => value.pool.startsWith("project:"))!.tokens);
  let later = 0, finished = false;
  const result = await admittedScenarios.run(memory, path, input => {
    const created = write([{ ...create, text: "later manual knowledge ".repeat(500) }]).committed[0]!;
    later = commitOf(created);
    const memoryTool = input.tools.find(tool => tool.name === "memory")!;
    const refused = memoryTool.execute({ op: "update", id: tagged(created.knowledgeId, later), text: "not this run's work",
      category: "constraint", scope: "project", topics: [], supports: [], reason: "probe scope" });
    expect(refused).toContain("rejected: M1:");
    expect(refused).toContain(history(created.knowledgeId, later));
    expect(refused).toContain("after this run's freeze");
    expect(refused).toContain("next Dreaming run");
    expect(memoryTool.execute({ drop: "M1" })).toContain("dropped: M1");
    skipRest(input);
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    finished = true;
    return ok([]);
  });
  expect(finished, JSON.stringify(result)).toBe(true);
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  if (!("runId" in result)) throw new Error("missing run id");
  const checked = JSON.parse(memory.store.getRun(result.runId)!.response!).check;
  expect(checked.pendingRevisionIds).toEqual([later]);
  for (const value of before) expect(checked.totals.find((item: { pool: string }) => item.pool === value.pool).tokens).toBe(value.tokens);
  expect(memory.store.poolSizes(path).find(value => value.pool.startsWith("project:"))!.tokens).toBeGreaterThan(memory.knowledgeBudgets().project);
});

test.each(["pending", "overflow"] as const)("2026-10-05, 126: '两个阈值中任意一个触发，成功执行后应该都是待处理减少10k、知识在20k之内' — a run due by %s ends with every pool within its budget and its frozen pending processed; pending beyond 10k stays pending", async trigger => {
  const { path, write, create } = memoryWriter();
  const item = (scope: "global" | "project" | "session", label: string, words: number) =>
    write([{ ...create, scope, text: `${label} ${"word ".repeat(words)}` }]).committed[0];
  const pools = () => memory.store.knowledgePools(path);
  const pendingIds = () => pools().flatMap(pool => pool.pending.map(value => value.revisionId)).sort((a, b) => a - b);
  const defaults = () => { for (const [field, value] of [["global", 4_000], ["project", 15_000], ["session", 1_000]] as const) memory.setKnowledgeBudget(field, value); };
  memory.config.compaction.sharedAllowanceTokens = 10_000;
  if (trigger === "overflow") {
    // Already-processed knowledge: 4.8k global and 20k project, deliberated by setup runs under roomy budgets.
    item("global", "Processed global A", 2_400); item("global", "Processed global B", 2_400);
    for (let i = 0; i < 10; i++) item("project", `Processed project ${i}`, 2_000);
    for (const field of ["global", "project", "session"] as const) memory.setKnowledgeBudget(field, 100_000);
    memory.config.dreaming.triggerTokens = 1;
    while (pendingIds().length) expect((await admittedScenarios.run(memory, path, input => {
      input.acknowledgeRequest(); skipRest(input); return ok([]); })).outcome).toBe("success");
    defaults();
    memory.config.dreaming.triggerTokens = 50_000; // pending stays below the trigger: overflow alone makes the run due
    for (let i = 0; i < 9; i++) item("project", `Pending project ${i}`, 1_400);
  } else {
    memory.config.dreaming.triggerTokens = 10_000;
    item("global", "Pending global A", 1_500); item("global", "Pending global B", 1_500);
    for (let i = 0; i < 8; i++) item("project", `Pending project ${i}`, 1_400);
    item("session", "Pending session", 300);
    defaults();
    memory.setKnowledgeBudget("global", pools()[0]!.tokens - 1); // a pool over budget the run must also bring back
  }
  const state = memory.dreamingPending(path);
  if (state.state !== "known") throw new Error("dreaming state unavailable");
  expect(state.pending.tokens >= state.pending.trigger).toBe(trigger === "pending");
  expect(state.knowledge.tokens > state.knowledge.window).toBe(trigger === "overflow");
  expect(memory.taskEligibility("dreaming", path).due).toBe(true);
  const before = pendingIds();
  const material = new Map(pools().flatMap(pool => pool.pending.map(value => [value.revisionId, value.material] as const)));

  let frozen: number[] = [], changedTokens = 0;
  const result = await admittedScenarios.run(memory, path, input => {
    input.acknowledgeRequest();
    const handles = suppliedHandles(input.material.changed);
    frozen = handles.map(handle => { const [, id, ordinal] = /^K(\d+)@v(\d+)$/.exec(handle)!; return memory.store.resolveVersionOrdinal(Number(id), Number(ordinal)); });
    changedTokens = tokens(input.material.changed);
    const memoryTool = input.tools.find(tool => tool.name === "memory")!, consumed: string[] = [];
    // Scripted budget reduction: archive each over-budget pool's oldest item until every pool fits.
    for (let over = pools().find(pool => pool.tokens > pool.budget); over; over = pools().find(pool => pool.tokens > pool.budget)) {
      const oldest = [...over.versions].sort((a, b) => a.revision.id - b.revision.id)[0]!.revision;
      expect(dreamerWrite(memoryTool, { operations: [{ op: "archive", kind: "budget", id: tagged(oldest.knowledgeId, oldest.id), supports: [],
        reason: "Over budget: the oldest item is retired." }], skipped: [] })).toContain("committed");
      consumed.push(history(oldest.knowledgeId, oldest.id));
    }
    expect(skipRest(input, consumed)).toContain("committed");
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return ok([]);
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  for (const pool of pools()) expect(pool.tokens, pool.pool).toBeLessThanOrEqual(pool.budget);
  expect(changedTokens).toBeLessThanOrEqual(10_000);
  expect(frozen).toEqual(before.slice(0, frozen.length)); // the oldest pending first, across pools
  // A full slice: the next pending version would have crossed 10,000 rendered tokens.
  expect(tokens(["Pending current knowledge:", ...[...frozen, before[frozen.length]!].map(id => material.get(id)!)].join("\n"))).toBeGreaterThan(10_000);
  expect(pendingIds()).toEqual(before.slice(frozen.length)); // every frozen version processed; the rest stays pending
  expect(pendingIds().length).toBeGreaterThan(0);
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
    expect(dreamerWrite(input.tools.find(tool => tool.name === "memory")!, { operations: [],
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
  expect(memoryFiles(memory, path).read(`trace://K1@v${memory.store.versionOrdinal(1, commit)}`).content).toContain("F2");
  const runs = memory.store.listRuns(s.id);
  expect(runs.at(-1)).toMatchObject({ kind: "dreaming", branch: "main" });
  expect(runs.at(-1)!.id).toBe(memory.store.getKnowledgeRevision(1, commit)!.runId);
});

// 127 lifts 116's 「D 先不改」: the Dreamer's memory takes one item per call, like the Noter's.
test("2026-10-06, 127: '为什么不能分成并行的一批工具调用' and '每条跳过也是一次单独的调用' — one Dreamer memory call is one operation or one skip", () => {
  const schema = dreamingToolDefinitions().find(tool => tool.name === "memory")!.parameters as Record<string, any>;
  for (const batch of ["operations", "skipped"]) expect(schema.properties).not.toHaveProperty(batch);
  expect(schema.else.then.required).toEqual(["skip", "because"]);
  expect(schema.else.else.required).toEqual(["op", "supports", "reason"]);
});

test("2026-10-06, 127: '每次操作最多9个工具调用' — the Dreamer prompt limits one response to 9 tool calls of every kind", () => {
  expect(loadPrompt("dreaming.md")).toMatch(/one response carries at most 9 tool calls in total, counting every tool/);
});

test("2026-10-06, 127: 'A，你派工' — a refused Dreamer operation still blocks after a later sibling commits, until slot resubmits it", async () => {
  const { create, write, path } = memoryWriter();
  const created = write([create]).committed[0];
  const trigger = createDreamerTrigger(memory, path, 1, 1);
  const request = { fixture: "127 option A" };
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request);
    const tool = input.tools.find(item => item.name === "memory")!, check = () => input.tools.find(item => item.name === "check")!.execute({});
    const update = { ...create, op: "update", id: tagged(created.knowledgeId, commitOf(created)), reason: "Clarify the rule." };
    expect(tool.execute({ ...update, id: `K${created.knowledgeId}#zzzz` })).toContain("rejected: M1: ");
    expect(tool.execute({ op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit), supports: [], reason: "Retire the trigger." })).toContain('"committed"');
    expect(check()).toMatch(/\nBlockers: M1: /);
    expect(tool.execute({ slot: "M1", ...update })).toContain('"committed"');
    expect(check()).toContain("Blockers: none");
    return { outcome: "success", output: "resolved", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
});

// 144 supersedes 86's 1,000-token cap on N and D writes and 135's unlimited manual writes.
test("2026-10-21, 144: '更新旧条目仍然受限，手写也一样，不要维护两套标准' — one title and body limit for the manual tools and the Dreamer, set in configuration, with updates of old items inside it", async () => {
  expect(DEFAULT_CONFIG.writing).toEqual({ titleTokens: 20, bodyTokens: 200 });
  memory.config.writing.bodyTokens = DEFAULT_CONFIG.writing.bodyTokens; // this file lifts the body cap for its large fixtures
  const { create, write, path, tools } = memoryWriter();
  const note = tools.find(tool => tool.name === "note")!;
  const long = "word ".repeat(300).trim(), oldTitle = "word ".repeat(30).trim();
  // Manual writes obey the limits the Noter's and Dreamer's do.
  expect(note.execute({ title: oldTitle, sources: `[T${path.headTurnId}#E1] evidence` })).toContain("over the 20-token limit");
  expect(note.execute({ title: "Long evidence", sources: `[T${path.headTurnId}#E1] ${long}` })).toContain("over the 200-token limit");
  expect(write([{ ...create, text: long }]).results[0]).toContain("over the 200-token limit");
  expect(write([{ ...create, title: oldTitle }]).results[0]).toContain("over the 20-token limit");
  const created = write([create]).committed[0];
  // An update of an existing item is held to the same limit: an old body that stays long is refused.
  memory.config.writing.bodyTokens = 1_000_000;
  const old = write([{ ...create, text: long }]).committed[0];
  memory.config.writing.bodyTokens = DEFAULT_CONFIG.writing.bodyTokens;
  const update = (item: { knowledgeId: number; version: string }, body: object) => ({ op: "update", id: tagged(item.knowledgeId, commitOf(item)), title: "Old rule",
    supports: ["F1"], reason: "Touch an old item", ...body });
  expect(write([update(old, { edits: [{ old: "word", new: "rule" }] })]).results[0]).toContain("over the 200-token limit");
  expect(write([update(old, { text: "Use pnpm", category: "constraint", scope: "project", topics: [] })]).committed).toHaveLength(1);
  // The Dreamer is checked at its write call by the same limits.
  const trigger = createDreamerTrigger(memory, path, 1, 1);
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest({ fixture: "144 one standard" });
    const tool = input.tools.find(item => item.name === "memory")!;
    const refused = JSON.parse(tool.execute({ ...update(created, { text: long, category: "constraint", scope: "project", topics: [] }), supports: [] }));
    expect(refused.rejected.M1).toContain("over the 200-token limit");
    tool.execute({ drop: "M1" });
    expect(tool.execute({ op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit), supports: [], reason: "Retire the trigger." })).toContain('"committed"');
    skipRest(input, [`K${trigger.knowledgeId}@v1`], "Reviewed unchanged");
    return { outcome: "success", output: "limits held", request: { fixture: "144 one standard" } };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  // The limits are configuration, not constants.
  memory.config.writing.bodyTokens = 1_000;
  expect(write([{ ...create, text: long }]).results[0]).toBe("ok");
});

// A merge that omits its title inherits it from the primary it names, whichever of the two is older; an untitled
// legacy primary requires one (2026-10-22: the named primary keeps its identity, no older-survivor rule, no swap).
test("144/2026-10-22: a merge without a title takes the named primary's title, the newer item included; an untitled legacy primary is refused", async () => {
  const { create, write, path } = memoryWriter();
  const committed = (title: string, text: string) => write([{ ...create, title, text }]).committed[0] as { knowledgeId: number; version: string };
  const older = committed("Older rule", "Use pnpm"), newer = committed("Newer rule", "Avoid npm");
  const survivor = committed("Survivor rule", "Pin the Node version");
  const legacy = legacyKnowledge(memory.store, path, { text: "Legacy rule body", category: "constraint", scope: "project", supports: [1] });
  const trigger = createDreamerTrigger(memory, path, 2, 1);
  let merged: Pick<MemoryReceipt, "results" | "committed"> | undefined;
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest({ fixture: "merge title" });
    const writeTool = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, input.reader!);
    const addresses = [older, newer, survivor].map(item => `K${item.knowledgeId}#${memory.store.versionTag(item.knowledgeId, commitOf(item))}`);
    const legacyAddress = tagged(legacy.knowledgeId, legacy.commit);
    for (const address of [...addresses, legacyAddress, tagged(trigger.knowledgeId, trigger.commit)]) readHandle(file => files.read(file).content, address);
    const { title: _title, ...untitled } = create;
    const withoutTitle = (id: string, absorb: string) => ({ ...untitled, op: "merge", reason: "Merged duplicate knowledge.", id, absorb: [absorb], supports: ["F1", "F2"] });
    merged = JSON.parse(dreamerWrite(writeTool, { operations: [
      withoutTitle(addresses[1]!, addresses[0]!),             // names the newer one: it keeps its identity and its title
      withoutTitle(legacyAddress, addresses[2]!),             // names an untitled legacy primary: a title is required
      { op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit), supports: ["F2"], reason: "Retire the explicit fixture trigger." }], skipped: [] }));
    return { outcome: "success", output: "merged", request: { fixture: "merge title" } };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("failure");
  expect(merged?.results[0], JSON.stringify(merged)).toBe("ok");
  expect(merged?.results[1]).toContain("the base version has no title");
  const titleOf = (item: { knowledgeId: number }) => memory.store.currentCommit(item.knowledgeId).map(revision => revision.title);
  expect(titleOf(newer)).toEqual(["Newer rule"]);
  expect(titleOf(older)).toEqual([]);
});

// 2026-10-22 (supersedes tickets 44 and 135): the primary a merge names keeps its identity, newer or not.
test("2026-10-22: a merge keeps the identity of the primary it names even when that is the newer item", async () => {
  const { create, write, path } = memoryWriter();
  const created = (write([create, { ...create, text: "Avoid npm", supports: ["F2"] }]).committed as Array<{ knowledgeId: number; version: string }>)
    .map(item => ({ ...item, commit: commitOf(item) }));
  const first = created[0], second = created[1];
  if (!first || !second) throw new Error(`merge fixture needs two identities: ${JSON.stringify(created)}`);
  const trigger = createDreamerTrigger(memory, path, 2, 1);
  const request = { fixture: "merge primary" };
  let merged: Pick<MemoryReceipt, "results" | "committed"> | undefined;
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request); const writeTool = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, input.reader!);
    for (const item of [first, second]) readHandle(file => files.read(file).content, item.version);
    const merge = { ...create, op: "merge", reason: "Merged duplicate knowledge into the primary.",
      id: tagged(second.knowledgeId, second.commit), absorb: [tagged(first.knowledgeId, first.commit)], supports: ["F1", "F2"] };
    const triggerAddress = tagged(trigger.knowledgeId, trigger.commit);
    readHandle(file => files.read(file).content, triggerAddress);
    merged = JSON.parse(dreamerWrite(writeTool, { operations: [merge, { op: "archive", kind: "budget", id: triggerAddress, supports: ["F2"],
      reason: "Retire the explicit fixture trigger." }], skipped: [] }));
    return { outcome: "success", output: "merged", request };
  });
  expect(result.outcome).toBe("success");
  if (!merged) throw new Error(`merge fixture did not submit: ${JSON.stringify(result)}`);
  expect(merged.results).toEqual(["ok", "ok"]);
  const primary = merged.committed[0];
  if (!primary) throw new Error(`merge fixture committed nothing: ${JSON.stringify(merged)}`);
  expect(primary).toMatchObject({ knowledgeId: second.knowledgeId });
  expect(primary).not.toHaveProperty("swappedFrom");
  const mergeCommit = commitOf(primary);
  expect(memory.store.currentCommit(first.knowledgeId)).toEqual([]);
  expect(memory.store.listKnowledgeLinks(first.knowledgeId)).toEqual([{ fromKnowledge: first.knowledgeId,
    fromCommit: first.commit, kind: "merged_into", toKnowledge: second.knowledgeId, toCommit: mergeCommit }]);
  const files = memoryFiles(memory, path);
  expect(files.read(`trace://K${first.knowledgeId}`).content).toContain(`merged_into: ${history(second.knowledgeId, mergeCommit)}`);
});

// 2026-10-22: a split keeps the item as its primary part; only the children are new identities.
test("2026-10-22: a split keeps the original identity as the primary part, creates the children and does not archive the original", async () => {
  const { create, write, path } = memoryWriter();
  const original = (write([{ ...create, text: "Use pnpm and keep the lockfile" }]).committed as Array<{ knowledgeId: number; version: string }>)
    .map(item => ({ ...item, commit: commitOf(item) }))[0]!;
  const trigger = createDreamerTrigger(memory, path, 2, 1);
  const request = { fixture: "split primary" };
  let split: Pick<MemoryReceipt, "results" | "committed"> | undefined;
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request); const writeTool = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, input.reader!);
    const triggerAddress = tagged(trigger.knowledgeId, trigger.commit);
    for (const address of [original.version, triggerAddress]) readHandle(file => files.read(file).content, address);
    split = JSON.parse(dreamerWrite(writeTool, { operations: [{ op: "split", id: tagged(original.knowledgeId, original.commit),
      text: "Use pnpm", category: "constraint", scope: "project", topics: [], supports: ["F1"], reason: "Two independent rules.",
      children: [{ title: "Lockfile", text: "Keep the lockfile", category: "reference", topics: [] }, { title: "Registry", text: "Use the mirror", category: "goal", topics: [] }] },
      { op: "archive", kind: "budget", id: triggerAddress, supports: ["F2"], reason: "Retire the explicit fixture trigger." }], skipped: [] }));
    return { outcome: "success", output: "split", request };
  });
  expect(result.outcome).toBe("success");
  if (!split) throw new Error(`split fixture did not submit: ${JSON.stringify(result)}`);
  const [primary, ...children] = split.committed.filter(item => item.knowledgeId !== trigger.knowledgeId);
  expect(primary).toMatchObject({ op: "split", knowledgeId: original.knowledgeId });
  expect(children.map(child => child.knowledgeId)).not.toContain(original.knowledgeId);
  expect(children).toHaveLength(2);
  // The original is not archived: it continues with the primary part's text, and only the children are new.
  expect(memory.store.currentCommit(original.knowledgeId).map(revision => [revision.op, revision.text])).toEqual([["split", "Use pnpm"]]);
  expect(children.map(child => memory.store.currentCommit(child.knowledgeId)[0]!.category)).toEqual(["reference", "goal"]);
  expect(memory.store.listKnowledgeLinks(original.knowledgeId).map(link => [link.kind, link.fromCommit, link.toKnowledge]))
    .toEqual(children.map(child => ["split_from", original.commit, child.knowledgeId]));
  expect(memory.store.listKnowledgeRevisions(original.knowledgeId).some(revision => revision.op === "archive")).toBe(false);
});

test.each(["success", "failure"] as const)("92: invalid knowledge slot is corrected but terminal %s decides joint publication and preserves audit", async outcome => {
  const { s, t } = session(); memory.close();
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    const note = input.tools.find(tool => tool.name === "note")!;
    const tool = input.tools.find(tool => tool.name === "memory")!;
    input.reportRequest({ messages: ["invalid"] });
    expect(note.execute({ title: "Package manager choice", sources: `[T${t.id}#E1] The user chose pnpm` })).toContain("held: $1");
    const create = { op: "create", title: "Fixture title", topics: [], reason: "User choice", text: "Use pnpm", category: "constraint", scope: "project", supports: ["$1"] };
    expect(tool.execute({ ...create, id: "K1" })).toContain("rejected: M1");
    expect(memory.store.listSessionFacts(s.id)).toEqual([]);
    expect(memory.store.currentKnowledge()).toEqual([]);
    input.reportRequest({ messages: ["corrected"] });
    expect(tool.execute({ ...create, slot: "M1" })).toContain("held: M1");
    expect(JSON.parse(tool.execute({})).held).toContain("M1");
    expect(memory.store.listSessionFacts(s.id)).toEqual([]);
    expect(memory.store.currentKnowledge()).toEqual([]);
    expect(memory.store.sourcePath(s.id, "main", t.id).every(entry => !memory.store.entryNoted(entry.id))).toBe(true);
    return { outcome, output: outcome === "failure" ? "provider failed after correction" : "completed", request: { messages: ["last"] } };
  });
  const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
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


// 93 replaces the retired #user/#assistant/#call selector with a whole entry and checked role.
test.each([{ ordinal: 1, role: "user", text: "用 pnpm，不要 npm" },
  { ordinal: 2, role: "assistant", text: "好的。" },
  { ordinal: 4, role: "observation", text: 'Bash success: {"stdout":"done","stderr":""}' }] as const)
("93: entry E%s checks @%s and reads the whole entry", ({ ordinal, role, text }) => {
  const { s, t } = session();
  const files = memoryFiles(memory, { sessionId: s.id, branch: "main", headTurnId: t.id });
  expect(files.read(`trace://raw/S${s.id}/T${t.id}#E${ordinal}@${role}`).content).toContain(text);
  expect(() => files.read(`trace://raw/S${s.id + 1}/T${t.id}#E${ordinal}@${role}`)).toThrow("no such path");
  expect(() => files.read(`trace://raw/S${s.id}/T${t.id}#E${ordinal}@${role === "user" ? "assistant" : "user"}`)).toThrow(/role/);
});

test("118: full Raw entry is unbounded while the Turn overview is compressed", () => {
  const { s, t } = session();
  const output = "hidden evidence ".repeat(300);
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: '{"command":"second"}', result: output, status: "success" });
  const files = memoryFiles(memory, { sessionId: s.id, branch: "main", headTurnId: t.id });
  const overview = files.read(`trace://raw/S${s.id}/T${t.id}`).content;
  expect(overview).toMatch(/\[\.\.\. \d+ characters truncated\]/);
  expect(overview).not.toContain(output);
  const full = files.read(`trace://raw/S${s.id}/T${t.id}#E6`);
  expect(full.unbounded).toBe(true);
  expect(full.content).toBe(`[T${t.id}#E6@observation] Bash success: ${output}`);
  expect(files.read(`trace://raw/S${s.id}/T${t.id}#E5`).content).toContain('Bash(command="second")');
});

// 93 retires block selectors, not the missing-entry and scope rejection guarantees.
test("118: missing Raw entries and retired selectors are rejected by path", () => {
  const { s } = session();
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: null, assistantText: null, startedAt: time });
  const files = memoryFiles(memory, { sessionId: s.id, branch: "main", headTurnId: t.id });
  const base = `trace://raw/S${s.id}/T${t.id}`;
  expect(() => files.read(`${base}#E1@user`)).toThrow(/no such path/);
  for (const retired of ["#user", "#assistant", "#t1", "#E1@text"])
    expect(() => files.read(`${base}${retired}`)).toThrow(/no such path/);
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
    const write = (operations: any[]) => {
      const writer = tools.find(tool => tool.name === "memory")!;
      const receipts = operations.map(operation => JSON.parse(writer.execute(operation)));
      // The scenario's internal graph assertions use global database keys, not public addresses.
      return { results: receipts.flatMap(row => row.results),
        ...(receipts.some(row => row.committed) ? { committed: receipts.flatMap(row => row.committed ?? []).map((item: { knowledgeId: number; version: string }) => ({ ...item, commit: commitOf(item) })) } : {}) };
    };
    return { sessionId, headTurnId, branch, triggerEntryId, fact, tools,
      read: (address = "K1") => memoryFiles(memory, { sessionId, branch, headTurnId }).read(`trace://${address}`).content, write,
      writeCommitted: (operations: any[]) => {
        const receipt = write(operations);
        if (!receipt.committed?.length) throw new Error(`expected a committed manual write: ${JSON.stringify(receipt)}`);
        return receipt.committed;
      } };
  };
  const root = writer(s.id, t.id, "main", selectNativeAncestry(s.id, t.id, "main"));
  const publish = (who: typeof root) => memory.store.setCurrentPath(who.sessionId, who.branch, who.headTurnId, "test-lineage");
  publish(root);
  const content = (fact: string, text = "Use blue tiles") => ({ text, category: "constraint", scope: "project", supports: [fact] });
  expect(root.writeCommitted([{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact) }])[0]!.version).toBe("K1@v1");
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
    const files = memoryFiles(memory, input.reader!);
    const write = input.tools.find(tool => tool.name === "memory")!;
    const exact = new Set<string>();
    for (const operation of operations) {
      if (typeof operation.id === "string" && /^K\d+#[a-z]+$/.test(operation.id)) exact.add(operation.id);
      for (const parent of operation.absorb ?? []) if (/^K\d+#[a-z]+$/.test(parent)) exact.add(parent);
    }
    for (const address of exact) readHandle(file => files.read(file).content, address);
    const triggerAddress = tagged(trigger.knowledgeId, trigger.commit);
    readHandle(file => files.read(file).content, triggerAddress);
    receipt = JSON.parse(dreamerWrite(write, { operations: [...operations, { op: "archive", kind: "budget", id: triggerAddress,
      supports: [path.fact], reason: "Retire the explicit fixture trigger." }],
      skipped: skipped.map(knowledge => ({ knowledge, because: "This supplied identity is unrelated to the asserted maintenance." })) }));
    return { outcome: "success", output: "maintenance complete", request };
  });
  if (result.outcome !== "success" || !receipt?.committed) throw new Error(JSON.stringify({ result, receipt }));
  return { ...receipt, committed: receipt.committed.map((item: { knowledgeId: number; version: string }) => ({ ...item, commit: commitOf(item) })) };
}

test("2026-09-07 A: sibling-branch facts are readable but supports requires an adoption fact on this path", () => {
  const { c, d, content } = commitPaths();
  expect(memoryFiles(memory, c).read(`trace://${d.fact}`).content).toContain(d.fact);
  for (const scope of ["session", "project", "global"]) {
    const rejected = c.write([{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", ...content(c.fact), scope, supports: [d.fact] }]);
    expect(rejected.results[0]).toContain("record an adoption fact on this path first");
    expect(memory.store.getKnowledge(2)).toBeNull();
  }
  const entry = hydrate(memory.store.listSourceEntries(c.sessionId, c.headTurnId), memory.store).find(value => value.role === "user")!;
  const adopted = { factIds: [seedFact(memory, { sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId },
    "Sibling branch adoption", [{ entry, text: `Adopt the other branch's rule 「${d.fact}」` }]).id] };
  expect(c.write([{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", ...content(`F${adopted.factIds[0]}`) }]).committed).toHaveLength(1);
});

test("2026-09-07: supports obeys the session/project/global scope table", () => {
  const { c, peer, content } = commitPaths();
  const same = peer();
  const outside = peer(memory.store.createProject({ name: "outside", declaredBy: "mark" }).id);
  for (const scope of ["session", "project", "global"]) for (const origin of [c, same, outside]) {
    const allowed = origin === c || scope === "global" || (scope === "project" && origin === same);
    const result = c.write([{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", ...content(c.fact), scope, supports: [origin.fact] }]);
    expect(!!result.committed).toBe(allowed);
  }
  expect(memoryFiles(memory, c).read(`trace://${outside.fact}`).content).toContain(outside.fact);
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
    { op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "test", text: "Must roll back", category: "goal", scope: "project", supports: [1], createdAt: time },
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
    const files = memoryFiles(memory, input.reader!);
    const memoryTool = input.tools.find(tool => tool.name === "memory")!;
    expect(files.read("trace://K1@v1").content).not.toContain("Unread successor");
    const first = JSON.parse(dreamerWrite(memoryTool, { operations: [{ op: "update", id: tagged(1, 1), topics: [],
      reason: "Substantive correction of the recorded conclusion.", ...content(root.fact, "Unread successor") }], skipped: [] }));
    const successor = first.committed[0];
    expect(dreamerWrite(memoryTool, { operations: [{ op: "update", id: tagged(1, 1), topics: [],
      reason: "Substantive correction of the recorded conclusion.", ...content(other.fact) }], skipped: [] })).toContain(`current: ${history(successor.knowledgeId, commitOf(successor))}`);
    expect(files.read(`trace://${successor.version}`).content).toContain("Unread successor");
    const corrected = JSON.parse(dreamerWrite(memoryTool, { operations: [{ slot: "M1", op: "update", id: tagged(1, commitOf(successor)), topics: [],
      reason: "Substantive correction of the recorded conclusion.", ...content(other.fact) }, { op: "archive", kind: "budget",
      id: tagged(trigger.knowledgeId, trigger.commit), supports: [other.fact], reason: "Retire the explicit fixture trigger." }], skipped: [] }));
    expect(corrected.committed[0].knowledgeId).toBe(1);
    return { outcome: "success", output: "scenario complete", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  expect(memory.store.currentCommit(1, path)[0]!.text).toBe("Use blue tiles");
  expect(memory.store.listKnowledgeRevisions(1).at(-1)!.text).toBe("Use blue tiles");
});

test("92/118: search previews are tagless and do not authorize a stale base", async () => {
  const { root, peer, content } = commitPaths();
  const other = peer(), path = { sessionId: other.sessionId, branch: other.branch, headTurnId: other.headTurnId };
  const trigger = createDreamerTrigger(memory, path, Number(other.fact.slice(1)), 1);
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest({ fixture: "search previews and tagged bases" });
    const search = input.tools.find(tool => tool.name === "search")!;
    const write = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, input.reader!);
    readHandle(file => files.read(file).content, "K1@v1");
    const successor = JSON.parse(dreamerWrite(write, { operations: [{ op: "update", id: tagged(1, 1), topics: [], reason: "A substantive correction.",
      ...content(root.fact, `Unread successor ${"中文😀".repeat(350)}`) }], skipped: [] })).committed[0];
    const preview = search.execute({ query: "Unread successor", layer: "knowledge" });
    expect(preview).not.toContain("rejected:"); expect(preview).not.toMatch(/K\d+#[a-z]+/);
    const edit = (id: string, slot?: string) => JSON.parse(dreamerWrite(write, { operations: [{ ...slot ? { slot } : {}, op: "update", topics: [], reason: "A substantive correction.", id,
      ...content(other.fact) }], skipped: [] }));
    expect(edit(tagged(1, 1)).results[0]).toContain(`current: ${history(1, commitOf(successor))}`);
    const successorTag = tagged(1, commitOf(successor));
    expect(readHandle(file => files.read(file).content, successor.version)).toContain(successorTag);
    expect(edit(successorTag, "M1").committed[0].knowledgeId).toBe(1);
    readHandle(file => files.read(file).content, history(trigger.knowledgeId, trigger.commit));
    expect(JSON.parse(dreamerWrite(write, { operations: [{ op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit),
      supports: [other.fact], reason: "Retire the explicit fixture trigger." }], skipped: [] })).committed).toHaveLength(1);
    return { outcome: "success", output: "scenario complete", request: { fixture: "search previews and tagged bases" } };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
});

test("41a/118: search lists the versions applicable on the reader's path, and exact trace:// versions preserve read scope", async () => {
  const { c, d, edit, publish } = commitPaths();
  const cTrigger = createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1);
  const cCommit = (await edit(c, "FILTER-C", cTrigger)).committed[0].commit as number;
  const dTrigger = createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2);
  const dCommit = (await edit(d, "FILTER-D", dTrigger)).committed[0].commit as number;
  publish(c);
  const current = memory.search("FILTER", "knowledge", c);
  expect(current).toContain(`[${history(1, cCommit)}]`);
  expect(current).not.toContain(`[${history(1, dCommit)}]`); // another branch's version is not applicable here
  const listed = memory.search("", "knowledge", { ...c, topk: 100 }) as string;
  expect(listed).toContain(`[${history(1, 1)}] (superseded)`); // the parent is still a candidate, marked
  expect(listed).toContain(`[${history(1, cCommit)}]`); expect(listed).not.toContain(`[${history(1, dCommit)}]`);
  const files = memoryFiles(memory, c);
  expect(files.read("trace://K1").content).toContain(`[${tagged(1, cCommit)}] [${history(1, cCommit)}] [constraint/project] Fixture title\nFILTER-C`);
  const exactHistory = files.read("trace://K1.history").content;
  for (const commit of [1, cCommit, dCommit]) expect(exactHistory).toContain(`[${history(1, commit)}]`);
  expect(exactHistory).toContain("FILTER-C");
  expect(exactHistory).toContain("FILTER-D");
  expect(files.read(`trace://${history(1, dCommit)}`).content).toContain("FILTER-D");
});

test("41a: the unified scope filters candidates", () => {
  const { root, c, peer } = commitPaths();
  const sameProject = peer(), foreign = peer(memory.store.createProject({ name: "foreign-41a", declaredBy: "mark" }).id);
  const create = (who: typeof root, text: string, category: "open" | "reference", scope: "project" | "global") =>
    who.writeCommitted([{ op: "create", title: "Fixture title", text, category, scope, supports: [who.fact], reason: "41a fixture", topics: [] }])[0]!;
  const shared = create(sameProject, "SAME-PROJECT-41A", "open", "project");
  const global = create(foreign, "FOREIGN-GLOBAL-41A", "reference", "global");
  const search = c.tools.find(tool => tool.name === "search")!;
  const facts = search.execute({ query: "main", layer: "facts" });
  expect(facts).toContain(`[F${sameProject.fact.slice(1)}]`);
  expect(facts).not.toContain(`[F${foreign.fact.slice(1)}]`);
  expect(search.execute({ query: "main", layer: "facts", scope: "global" })).toContain(`[F${foreign.fact.slice(1)}]`);
  expect(search.execute({ query: "41A", layer: "knowledge" })).toContain(`[${shared.version}]`);
  expect(search.execute({ query: "FOREIGN-GLOBAL", layer: "knowledge" })).toContain(`[${global.version}]`);
  expect(search.execute({ query: "FOREIGN-GLOBAL", layer: "knowledge", scope: "session" })).not.toContain(`[${global.version}]`);
});

test("41b: a fact preview is one line of its text, without the long evidence metadata", () => {
  const { c } = commitPaths();
  const entry = memory.store.listSourceEntries(c.sessionId, c.headTurnId)[0]!;
  const receipt = legacyFacts(memory.store, { kind: "noting", sessionId: c.sessionId, branch: c.branch, createdAt: time }, [{
    sources: [{ entry, address: `T${c.headTurnId}#user` }], category: "observation", actor: "user",
    text: "PREVIEW-FACT " + "word ".repeat(300), quote: "quote ".repeat(2000), createdAt: time,
  }]);
  const factId = receipt.facts[0]!.id;
  const search = c.tools.find(tool => tool.name === "search")!;
  const preview = search.execute({ query: "PREVIEW-FACT", layer: "facts" }) as string;
  expect(preview).toContain(`[F${factId}] [observation/user]`);
  // 136 ruling 3: a fact hit is the shared centred snippet of about 200 characters, cut with an ellipsis.
  expect(preview).toMatch(/^\[F\d+\] \[observation\/user\] PREVIEW-FACT .*…$/); expect(preview.length).toBeLessThan(260);
  expect(preview).not.toContain("quote:"); expect(preview).not.toContain("source:");
  expect(preview.split("\n").filter((line: string) => line.startsWith(`[F${factId}]`))).toHaveLength(1);
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
  const created = c.writeCommitted([{ op: "create", title: "Fixture title", text: longKnowledgeText, category: "reference", scope: "project",
    supports: [c.fact], topics: ["metadata\nline"], reason: "reason\nline" }])[0]!;
  const search = c.tools.find(tool => tool.name === "search")!;

  const fact = search.execute({ query: "FACT-LONG-41", layer: "facts" }) as string;
  // 136 ruling 3: a fact hit is the shared centred snippet of about 200 characters, cut with an ellipsis.
  expect(fact).not.toContain("\n"); expect(fact).toMatch(/^\[F\d+\] \[observation\/user\] FACT-LONG-41 .*…$/); expect(fact).not.toContain("FACT-LONG-TAIL");
  expect(fact.length).toBeLessThan(260);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(fact)).toBe(false);
  // 136: a knowledge hit is one line of about 200 characters centred on the match, cut with an ellipsis.
  const knowledge = search.execute({ query: "KNOWLEDGE-LONG-41", layer: "knowledge" }) as string;
  expect(knowledge).not.toContain("\n"); expect(knowledge).toMatch(/^\[K\d+@v\d+\] \[reference\/project\] Fixture title — KNOWLEDGE-LONG-41 .*…$/);
  expect(knowledge).not.toContain("KNOWLEDGE-LONG-TAIL");
  expect(knowledge.length).toBeLessThan(260);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(knowledge)).toBe(false); // cut on code points
  const tail = search.execute({ query: "KNOWLEDGE-LONG-TAIL", layer: "knowledge" }) as string;
  expect(tail).not.toContain("\n"); expect(tail).toMatch(/^\[K\d+@v\d+\] \[reference\/project\] Fixture title — …/); expect(tail).toContain("KNOWLEDGE-LONG-TAIL");

  const files = memoryFiles(memory, c);
  expect(files.read(`trace://F${factId}`).content).toContain(longFactText);
  expect(files.read(`trace://${history(created.knowledgeId, created.commit)}`).content).toContain(longKnowledgeText);
});

test("41b/92/118: search previews omit tags, while exact tags need no read ledger", async () => {
  const { peer, content } = commitPaths(); const other = peer();
  const path = { sessionId: other.sessionId, branch: other.branch, headTurnId: other.headTurnId };
  const trigger = createDreamerTrigger(memory, path, Number(other.fact.slice(1)), 1), request = { fixture: "fields select tag display" };
  const result = await admittedScenarios.run(memory, path, input => {
    input.reportRequest(request); const search = input.tools.find(tool => tool.name === "search")!;
    const write = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, input.reader!);
    const update = (id: string, text: string) => JSON.parse(dreamerWrite(write, { operations: [{ op: "update", id,
      ...content(other.fact, text), topics: [], reason: "41b update" }], skipped: [] }));
    const successor = update(tagged(1, 1), "BASE-SUCCESSOR").committed[0];
    const exact = tagged(1, commitOf(successor));
    const preview = search.execute({ query: "BASE-SUCCESSOR", layer: "knowledge" });
    expect(preview).toContain("BASE-SUCCESSOR"); expect(preview).not.toMatch(/K\d+#[a-z]+/);
    // The search preview is tagless; exact base and scope, not read history, authorize this write.
    const finite = update(exact, "FINITE-COMPLETE").committed[0];
    const finiteTag = tagged(1, commitOf(finite));
    expect(readHandle(file => files.read(file).content, finite.version)).toContain(finiteTag);
    expect(update(finiteTag, "FULL-COMPLETE").committed[0].knowledgeId).toBe(1);
    dreamerWrite(write, { operations: [{ op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit), supports: [other.fact],
      reason: "Retire the explicit fixture trigger." }], skipped: [] });
    return { outcome: "success", output: "scenario complete", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
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
  expect(memoryFiles(memory, outside).read("trace://K1").content.split("\n")[0]).toBe("K1 path current: none");
  const sessionCommit = await maintain("Session only", "session", 3);
  const ownProject = memory.store.getSession(root.sessionId)!.projectId;
  expect(memory.inject({ projectId: ownProject })).not.toContain(tagged(1, projectCommit));
  expect(memory.inject({ projectId: ownProject })).not.toContain(tagged(1, sessionCommit));
  expect(memory.inject({ projectId: outsideProject.id })).not.toMatch(/K1[#@]/);
  expect(memory.inject(root)).toContain(tagged(1, sessionCommit));
});

test("2026-09-07: commit schema removes mutable heads and binds parents and links to global ids", () => {
  const { root, content } = commitPaths();
  root.write([{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact, "Another identity") }]);
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
  const second = root.writeCommitted([{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact) }])[0]!;
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
    input.reportRequest(request); const write = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, input.reader!);
    readHandle(file => files.read(file).content, second.version);
    readHandle(file => files.read(file).content, history(staleTrigger.knowledgeId, staleTrigger.commit));
    rejected = dreamerWrite(write, { operations: [{ op: "update", id: tagged(second.knowledgeId, second.commit), topics: [],
      reason: "Substantive correction of the recorded conclusion.", ...content(other.fact, "Invalid absorbed edit") }], skipped: [] });
    expect(rejected).toContain(`current: ${history(survivor.knowledgeId, commitOf(survivor))}`);
    expect(write.execute({ drop: "M1" })).toContain("dropped: M1"); // 127: a refusal blocks until withdrawn
    const supplied = suppliedHandles(input.material.changed)
      .filter((knowledge: string) => knowledge !== history(staleTrigger.knowledgeId, staleTrigger.commit))
      .map((knowledge: string) => ({ knowledge, because: "The stale absorbed edit was correctly refused." }));
    dreamerWrite(write, { operations: [{ op: "archive", kind: "budget", id: tagged(staleTrigger.knowledgeId, staleTrigger.commit), supports: [other.fact],
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


test("16b: search marks versions against the supplied path, including archives and unrestricted siblings", async () => {
  const { root, c, d, edit, publish } = commitPaths();
  const cCommit = (await edit(c, "C version", createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 1))).committed[0].commit as number;
  const dCommit = (await edit(d, "D version", createDreamerTrigger(memory, d, Number(d.fact.slice(1)), 2))).committed[0].commit as number;
  publish(c);
  const line = (result: unknown, label: string) => (result as string).split("\n").find(l => l.startsWith(`[${label}]`));
  expect(line(memory.search("Use blue tiles", "knowledge", c), history(1, 1))).toContain("(superseded)");
  expect(line(memory.search("C version", "knowledge", c), history(1, cCommit))).not.toContain("(");
  expect(memory.search("D version", "knowledge", c)).not.toContain("D version"); // another branch's version is not applicable here
  expect(line(memory.search("C version", "knowledge", root), history(1, cCommit))).toBeDefined();
  expect(c.read("K1")).toContain("C version");
  const archiveTrigger = createDreamerTrigger(memory, c, Number(c.fact.slice(1)), 3);
  const archived = await admittedWrite(c, archiveTrigger, [{ op: "archive", kind: "budget", reason: "Retired: the cited evidence withdraws this conclusion.",
    id: tagged(1, cCommit), supports: [c.fact] }]);
  expect(archived.committed[0].knowledgeId).toBe(1);
  expect(memory.search("C version", "knowledge", c)).toContain("(archived)");
  expect(memory.search("D version", "knowledge", d)).not.toContain("[K1@v1]");
  publish(d);
  expect(line(memory.search("D version", "knowledge", c), history(1, dCommit))).toBeDefined();
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
  const note = tools.find(tool => tool.name === "note")!;
  const before = memory.store.listSessionFacts(c.sessionId);
  const fact = { title: "Injected-only text", sources: `[T${injected.id}#E1] Only injected: violet tiles` };
  expect(memory.store.listSourceEntries(c.sessionId, injected.id)).toEqual([]);
  expect(note.execute(fact)).toContain(`invalid source T${injected.id}#E1; expected admissible Raw in the eligible entry set`);
  expect(note.execute({ ...fact, sources: "" })).toContain("rejected:");
  expect(note.execute({ ...fact, sources: `[T${d.headTurnId}#E1] Only injected: violet tiles` })).toContain(`invalid source T${d.headTurnId}#E1; expected admissible Raw in the eligible entry set`);
  expect(memory.store.listSessionFacts(c.sessionId)).toEqual(before);
  expect(note.execute({ ...fact, sources: `[T${root.headTurnId}#E1] User required pnpm` })).toContain("ok: F");
});

test("64b/16b: every raw source of a multi-source fact constrains carry, current and citations", async () => {
  const { root, c, d, content, publish } = commitPaths();
  memory.store.updateTurn(c.headTurnId, { assistantText: "Use violet tiles" });
  const turns = memory.store.pathTurns(c);
  const entries = hydrate(memory.store.listSourceEntries(c.sessionId), memory.store).filter(entry => turns.has(entry.turnId));
  memory.selectEntries(c.sessionId, c.branch, entries.map(entry => entry.id));
  const tools = memory.tools({ kind: "manual", sessionId: c.sessionId, branch: c.branch,
    currentTurnId: c.headTurnId, triggerEntryId: entries.at(-1)!.id });
  const fact = JSON.parse(tools.find(tool => tool.name === "note")!.execute({ title: "Violet tile decision", sources: `[T${root.headTurnId}#E1] Initial tile rule\n[T${c.headTurnId}#E2] Use violet tiles` })).factIds[0] as number;
  publish(c);
  const trigger = createDreamerTrigger(memory, c, fact, 1);
  const updated = await admittedWrite(c, trigger, [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
    id: tagged(1, 1), ...content(`F${fact}`, "Use violet tiles") }]);
  const commit = updated.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1).commit;
  for (const path of [root, d]) {
    publish(path);
    expect(memory.branchSummary(path.sessionId, path.branch, path.headTurnId)).not.toContain(`[F${fact}]`);
    expect(memory.inject(path)).toContain(`[${tagged(1, 1)}]`); expect(memory.inject(path)).not.toContain(`[${tagged(1, commit)}]`);
    expect(path.write([{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", ...content(`F${fact}`) }]).results[0])
      .toContain("record an adoption fact on this path first");
  }
  publish(c);
  expect(memory.branchSummary(c.sessionId, c.branch, c.headTurnId)).toContain(`[F${fact}]`);
  expect(memory.inject(c)).toContain(`[${tagged(1, commit)}]`);
});

test("2026-09-07: R<n> renders a run as a summary, full adds tool rounds and raw previews, a missing run is rejected", async () => {
  const { s, t } = session();
  calls.length = 0;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
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
  tools.find(tool => tool.name === "note")!.execute({ text: "bad source", source: ["T999#E1"] });
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
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const views = calls[0]!.material.entries.map(e => e.view);
  expect(tokens(views.join("\n\n"))).toBeLessThanOrEqual(DEFAULT_CONFIG.noting.batchTokens);
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).length).toBeGreaterThan(0); // the rest waits; 50,000 would have taken it
});

// 133 changes the borrowing pool, not the core trace view's windows or processing invariants.
// R1 delegates at the host boundary; this read-only allocator still reports pending omissions.
test("73/133: core material uses independent windows, truncates newest-first and changes no progress", () => {
  expect(memory.knowledgeBudgets().injection).toBe(20_000);
  expect(DEFAULT_CONFIG.render.episodicBlockTokens).toBe(20_000);
  expect(REMOVED_SETTINGS["render.episodicBlockTokens"]).toBeUndefined();
  const { s, t } = session();
  const write = (text: string, turnId = t.id) => {
    const tools = memory.tools({ kind: "manual", sessionId: s.id, currentTurnId: turnId, branch: "main" });
    return JSON.parse(tools.find(tool => tool.name === "note")!.execute({ title: "Material window fact", sources: `[T${turnId}#E1] ${text}` })).factIds[0] as number;
  };
  const pad = "word ".repeat(500);
  write(`OLDER FACT ${pad}`);
  write("RECENT FACT");
  const extracted = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "done", turnId: t.id,
    role: "assistant", text: `EXTRACTED RAW ${pad}`, raw: "", calls: [] });
  expect(memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    facts: [], entryIds: hydrate(memory.store.sourcePath(s.id, "main", t.id), memory.store).map(e => e.id) }).ok).toBe(true);
  const open = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "open", turnId: t.id,
    role: "assistant", text: "PENDING RAW", raw: "", calls: [] });
  const full = memory.compact(s.id, "main", t.id);
  const text = compacted(full), windows = charged(full);
  expect(windows.envelope).toBe(60_000);
  expect(windows.knowledge + windows.facts + windows.raw + windows.temporary).toBeLessThanOrEqual(windows.envelope);
  for (const marker of ["OLDER FACT", "RECENT FACT", "PENDING RAW", "EXTRACTED RAW"]) expect(text).toContain(marker);
  memory.config.render.episodicBlockTokens = 40;
  expect(compacted(memory.compact(s.id, "main", t.id))).toBe(text);
  memory.config.render.episodicBlockTokens = DEFAULT_CONFIG.render.episodicBlockTokens;
  compactionWindows(Math.max(1, windows.knowledge), 150, 150);
  const required = compacted(memory.compact(s.id, "main", t.id));
  expect(required).toContain("RECENT FACT"); expect(required).toContain("PENDING RAW");
  expect(required).not.toContain("OLDER FACT"); expect(required).not.toContain("EXTRACTED RAW");
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).map(e => e.id)).toEqual([open.id]);
  expect(memory.store.entryNoted(extracted.id)).toBe(true);
  compactionWindows(10, 1, 1);
  const squeezed = memory.compact(s.id, "main", t.id);
  if ("native" in squeezed) throw new Error(squeezed.reason);
  expect(squeezed.text).not.toContain("RECENT FACT");
  expect(squeezed.text).not.toContain("PENDING RAW");
  expect(squeezed.truncated?.facts?.count).toBeUndefined();
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
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
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
  expect(DEFAULT_CONFIG.noting).toEqual({ batchTokens: 10_000, triggerTokens: 10_000, maxToolRounds: 0 });
  for (const retired of [0, 1, -0.001, 1.001, Infinity, Number.NaN])
    expect(() => api.validateConfig({ noting: { nearThreshold: retired } } as never)).toThrow("Removed setting noting.nearThreshold");
});

// 28a "Windows": the two new compaction keys are ordinary token settings — the same finite positive
// integer validation, the same unknown-key rejection by name — and nothing existing was reinterpreted
// or silently retired to make room for them.
test("133 configuration: compaction bases and temporary allowance settings use positive safe-integer validation", () => {
  const open = (compaction: Record<string, number>) => sourceSeededMemory(join(directory, "windows.sqlite"), async () => ok([]), { compaction } as never);
  for (const key of ["factsTokens", "rawTokens", "temporaryTokens", "userTurns", "titleTurns", "userEntryTokens"] as const) {
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
  expect(tools.find(tool => tool.name === "note")!.execute({ title: "Package manager decision", sources: `[T${t.id}#E1] Use pnpm` })).toContain("ok: F1");
  const write = (category: string, text: string) => expect(tools.find(tool => tool.name === "memory")!
    .execute({ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", text, category, scope: "project", supports: ["F1"] })).toContain('"committed"');
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
  expect(memoryFiles(memory, { sessionId: s.id, branch: "main", headTurnId: t.id }).read("trace://K1").content).toContain("[K1@"); // omitted is not deleted
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
  const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t2.id, boundary });
  expect(result.outcome).toBe("success");
  expect(calls[0]!.entryIds).toEqual([entry1.id]); // the later on-path entry stays outside the frozen target
  expect(hydrate(memory.pendingEntries(s.id, "main", t2.id), memory.store).map(e => e.id)).toEqual([entry2.id]); // it remains pending

  // 92 §8's “C删掉” replaces C's frozen fact-id set with N's exact entry boundary above; the
  // independently frozen D revision range is exercised by the late-version case above.
});

// ---- 19c: branch remains the evidence path; the Noter's execution mode is always fresh (ticket 19 "Naming and compatibility") ----

// Ruling 2026-10-22 (supersedes 19c/29e's fork mode for the Noter): a fork's prefix is the main
// conversation, not the compaction memory the Noter starts from, so the Noter runs fresh only.
test("2026-10-22: the Noter runs fresh only", async () => {
  // Configuration refuses the fork setting under both spellings, at the load and at runtime.
  for (const key of ["forkModeDefault", "branchModeDefault"] as const) {
    const message = `Removed setting noting.${key}: the Noter runs fresh only; remove this key`;
    for (const saved of [true, false]) {
      expect(() => sourceSeededMemory(join(directory, `fork-${key}-${saved}.sqlite`), async () => ok([]), { noting: { [key]: saved } } as never)).toThrow(message);
      expect(() => canonicalFlatConfig({ [`noting.${key}`]: saved })).toThrow(message);
      expect(() => memory.configure({ noting: { [key]: saved } } as never)).toThrow(message);
    }
  }
  expect(Object.hasOwn(DEFAULT_CONFIG.noting, "forkModeDefault")).toBe(false);
  // Admission never selects fork: every task, ordinary, borrowed or bounded, is a fresh child and its run says so.
  const { s, t } = session();
  const next = (parent: number, text: string) => memory.store.appendTurn({ sessionId: s.id, parentTurnId: parent,
    kind: "turn", userPrompt: text, assistantText: "acknowledged", startedAt: time });
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  const second = next(t.id, "Keep vitest");
  const tail = memory.store.createSession({ enrollmentChoice: true, host: "pi:borrowed", startedAt: time,
    firstReplyAt: time, projectId: memory.store.getSession(s.id)!.projectId });
  const tailTurn = memory.store.appendTurn({ sessionId: tail.id, kind: "turn", userPrompt: "closed tail", assistantText: "ok", startedAt: time });
  memory.store.closeSession(tail.id);
  expect((await memory.noting({ sessionId: tail.id, branch: "main", headTurnId: tailTurn.id,
    borrowed: true, executorSessionId: s.id })).outcome).toBe("success");
  const frozen = memory.store.pendingEntryIds(s.id, "main", second.id);
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: second.id,
    boundary: { exactEntryIds: frozen } })).outcome).toBe("success");
  expect(calls.at(-1)!.entryIds).toEqual(frozen);
  const runs = memory.store.listRuns(s.id).filter(r => r.kind === "noting");
  expect(runs).toHaveLength(2);
  for (const run of [...runs, ...memory.store.listRuns(tail.id).filter(r => r.kind === "noting")]) {
    expect(run.mode).toBe("subagent");
    expect(JSON.parse(run.response!).requestedMode).toBe("subagent");
  }
});

test("24 amendment 2 2026-09-09, as 2026-10-22 left it: configure replaces the borrowing scope, validated like the load path, and nothing else", async () => {
  expect(memory.config.closedSessionScope).toBe("project");
  memory.configure({ closedSessionScope: "global" });
  expect(memory.config.closedSessionScope).toBe("global");
  expect(memory.config.noting.batchTokens).toBe(DEFAULT_CONFIG.noting.batchTokens); // nothing else moved
  // The load path's own rules: a bad value, a removed key and any other section or key are refused by
  // name — and a refusal changes nothing.
  expect(() => memory.configure({ closedSessionScope: "everywhere" as never })).toThrow("Invalid closedSessionScope");
  expect(() => memory.configure({ noting: { batchTokens: 5 } })).toThrow("Unknown setting noting");
  expect(() => memory.configure({ render: { entryTokens: 5 } })).toThrow("Unknown setting render");
  expect(() => memory.configure({ consolidation: { triggerUnconsolidatedFacts: 5 } } as never)).toThrow("Removed setting");
  expect(() => memory.configure({ noting: { nearThreshold: 0.5 } } as never)).toThrow("Removed setting noting.nearThreshold");
  expect(memory.config.closedSessionScope).toBe("global");
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
  expect(Object.hasOwn(DEFAULT_CONFIG.noting, "forkModeDefault")).toBe(false); // no C mode is mapped into N
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
    .execute({ text: "Keep pnpm", source: [`T${t.id}#E1`] });
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(memory.store.getRun(historical)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).filter(r => r.kind === "consolidation").map(r => r.mode)).toEqual(["fork"]);
  expect(memory.store.listRuns(s.id).at(-1)!.kind).toBe("noting");
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
    input.tools.find(tool => tool.name === "note")!.execute({});
    input.tools.find(tool => tool.name === "memory")!.execute({}); return ok([]); });
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
test("21a/116/127: single-item write keeps supports and reason; a Dreamer skip keeps because", async () => {
  const { create, write, path } = memoryWriter();
  const operation = toolDefinitions.find(t => t.name === "memory")!.parameters.properties as Record<string, any>;
  expect(operation.op.enum).toEqual(["create", "update", "archive"]);
  expect(operation).not.toHaveProperty("because");
  expect(operation.reason).toEqual({ type: "string", minLength: 1 });
  expect(operation).not.toHaveProperty("skipped");
  const dream = dreamingToolDefinitions().find(t => t.name === "memory")!.parameters.properties as Record<string, any>;
  expect(dream.because).toEqual({ type: "string", minLength: 1 });
  const factSchema = toolDefinitions.find(t => t.name === "note")!.parameters.properties as Record<string, any>;
  expect(factSchema).not.toHaveProperty("reason"); // facts gain no commit metadata and the surface stays four tools
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
    const created = c.writeCommitted([{ op: "create", title: "Fixture title", topics: [], ...content(c.fact), scope, reason: "Admitted for the archive scope check." }])[0]!;
    const address = tagged(created.knowledgeId, created.commit);
    const trigger = createDreamerTrigger(memory, c, Number(c.fact.slice(1)), ++sequence, scope);
    const allowed = origin === c || scope === "global" || (scope === "project" && origin === same);
    const request = { fixture: "archive scope table", scope, origin: origin.sessionId }; let first = "";
    const result = await admittedScenarios.run(memory, c, input => {
      input.reportRequest(request); const write = input.tools.find(tool => tool.name === "memory")!;
      const files = memoryFiles(memory, input.reader!);
      const triggerAddress = tagged(trigger.knowledgeId, trigger.commit);
      readHandle(file => files.read(file).content, address); readHandle(file => files.read(file).content, triggerAddress);
      const otherSupplied = suppliedHandles(input.material.changed)
        .filter((knowledge: string) => knowledge !== created.version && knowledge !== history(trigger.knowledgeId, trigger.commit))
        .map((knowledge: string) => ({ knowledge, because: "Unrelated current knowledge is unchanged by the archive scope check." }));
      first = dreamerWrite(write, { operations: [{ op: "archive", kind: "budget", id: address, supports: [origin.fact], reason: `Retired on ${origin.branch} evidence.` },
        { op: "archive", kind: "budget", id: triggerAddress, supports: [c.fact], reason: "Retire explicit trigger." }], skipped: otherSupplied });
      if (allowed) return { outcome: "success", output: "archived", request };
      expect(first).toContain("rejected: M1");
      // 127: the trigger archive and the skips were their own calls and committed; only the refused archive is withdrawn.
      expect(write.execute({ drop: "M1" })).toContain("dropped: M1");
      const corrected = dreamerWrite(write, { skipped: [{ knowledge: created.version, because: "Foreign support is outside this archive's scope." }] });
      expect(corrected).toContain('"committed"');
      return { outcome: "success", output: "scope refusal checked", request };
    });
    expect(result.outcome, JSON.stringify(result)).toBe("success");
    expect(first.includes('"committed"')).toBe(allowed);
  }
  const created = c.writeCommitted([{ op: "create", title: "Fixture title", topics: [], ...content(c.fact), scope: "session", reason: "Admitted for the reason-bypass check." }])[0]!;
  const trigger = createDreamerTrigger(memory, c, Number(c.fact.slice(1)), ++sequence, "session");
  const request = { fixture: "archive reason is not adoption" }; let rejected = "";
  const result = await admittedScenarios.run(memory, c, input => {
    input.reportRequest(request); const write = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, input.reader!);
    const address = tagged(created.knowledgeId, created.commit), triggerAddress = tagged(trigger.knowledgeId, trigger.commit);
    readHandle(file => files.read(file).content, address); readHandle(file => files.read(file).content, triggerAddress);
    const otherSupplied = suppliedHandles(input.material.changed)
      .filter((knowledge: string) => knowledge !== created.version && knowledge !== history(trigger.knowledgeId, trigger.commit))
      .map((knowledge: string) => ({ knowledge, because: "Unrelated current knowledge is unchanged by the reason-bypass check." }));
    rejected = dreamerWrite(write, { operations: [{ op: "archive", kind: "budget", id: address, supports: [outside.fact],
      reason: `The user adopted ${outside.fact} on this path.` }], skipped: [] });
    expect(rejected).toContain("rejected:");
    expect(write.execute({ drop: "M1" })).toContain("dropped: M1");
    dreamerWrite(write, { operations: [{ op: "archive", kind: "budget", id: triggerAddress, supports: [c.fact], reason: "Retire explicit trigger." }],
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
    input.reportRequest(request); const write = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, input.reader!);
    const op = { op: "archive", kind: "budget", id: tagged(1, cCommit), supports: [third.fact], reason: "Retired on this path." };
    // Read the globally selected base; labels do not grant write authority.
    readHandle(file => files.read(file).content, history(1, cCommit));
    readHandle(file => files.read(file).content, history(archiveTrigger.knowledgeId, archiveTrigger.commit));
    const receipt = topicReceipt = JSON.parse(dreamerWrite(write, { operations: [op, { op: "archive", kind: "budget", id: tagged(archiveTrigger.knowledgeId, archiveTrigger.commit),
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
  const hits = (memory.search("tiling", "knowledge", { topk: 100 }) as string).split("\n").filter(l => l.startsWith("[K"));
  // The archive inherits the label, so it is found by it, and every version is marked against the latest one.
  expect(hits.find(l => l.startsWith(`[${history(1, archiveCommit)}]`))).toContain("(archived)");
  expect(memory.search("C version", "knowledge")).toContain("(superseded)");
  publish(d);
  // The archive cites the independent peer's fact, not C's. Switching C/D therefore leaves the
  // later archive applicable; sharing a topic cannot revive D or inherit the archive parent's path.
  expect(tips(third)).toEqual([archiveCommit]);
  const dHistory = memory.search("D version", "knowledge");
  expect(dHistory).toContain(`[${history(1, dCommit)}] (superseded)`);
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
  expect(tools.map(t => t.name)).toEqual(["search", "note", "memory"]); // Ticket 118 removes the public trace tool.
  const factSchema = toolDefinitions.find(t => t.name === "note")!.parameters.properties as Record<string, any>;
  expect(factSchema).not.toHaveProperty("topics");
  expect(tools.find(tool => tool.name === "note")!.execute({ text: "Labelled fact", source: ["T1#E1"], topics: ["packaging"] })).toContain("rejected:");
  const schema = toolDefinitions.find(t => t.name === "memory")!.parameters.properties as Record<string, any>;
  expect(schema.topics).toEqual({ type: "array", items: { type: "string", minLength: 1 } });
  // Topics stay inherited on archives; the archive branch requires an explicit kind.
  const dreamSchema = (dreamingToolDefinitions().find(t => t.name === "memory")!.parameters as Record<string, any>).else.else; // 127: the operation branch
  expect(dreamSchema.allOf[2].then.required).toContain("kind");
  expect(dreamSchema.allOf[2].then.allOf[0].not.anyOf).toContainEqual({ required: ["topics"] });
  expect(dreamSchema.allOf[2].else).toHaveProperty("not", { required: ["kind"] });
  expect(schema.reason).toEqual({ type: "string", minLength: 1 });
  // A label is written by the ordinary manual call, with no model call and no independent catalog block.
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
    if (submit) input.tools.find(tool => tool.name === "note")!.execute({});
    if (submitKnowledge) input.tools.find(tool => tool.name === "memory")!.execute({});
    return { outcome: "success", output: "I answered a question and wrote nothing.", request: { fake: true }, usage: { tokens: 3 } };
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  // R20's failure mode: a run that submits nothing must not advance its 96 selected entries.
  expect(await memory.noting(target)).toMatchObject({ outcome: "failure", problems: [api.NOTING_INCOMPLETE] });
  expect(memory.store.getRun(1)!.outcome).toBe("failure"); // the existing outcome value; no new one, no schema change
  expect(hydrate(memory.store.listSourceEntries(s.id), memory.store).some(e => memory.store.entryNoted(e.id))).toBe(false);
  // The prompt says what the runner enforces.
  const prompt = loadPrompt("noting.md");
  expect(prompt).toContain("note({})");
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
  expect(squeezed).toContain(`omitted 2 older facts; expand: trace://F${onPath}, trace://F${shared}`); // manual bindings remain eligible
  defaultWindows();

  // 92 uses distinct full-path selection and exact-entry material scopes. This legacy fixture
  // counts wrappers; ticket92material pins native cold/warm builds, metadata and Raw work.
  const target = { sessionId: s.id, branch: "C", headTurnId: selected.id };
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

test("27 amendment 6: frozen membership survives fallback or the task stays pending", async () => {
  // The frozen batch is taken whole or not at all. A capacity that holds only its oldest entry used
  // to pop the newer one and report success on the subset; now the batch waits.
  const { s, t } = session();
  const e1 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u1", turnId: t.id, role: "user", text: "first evidence", raw: "first evidence", calls: [] });
  const t2 = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t.id, kind: "turn", userPrompt: "second", startedAt: time });
  const e2 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u2", turnId: t2.id, role: "user", text: "second evidence", raw: "second evidence", calls: [] });
  memory.selectEntries(s.id, "main", [e1.id, e2.id]);
  const target = { sessionId: s.id, branch: "main", headTurnId: t2.id };
  // What the batch really costs, priced the way the freeze prices it: instructions, tool definitions
  // and the prepared fresh text. The oldest entry's own price is the allowance that fits one, not two.
  const instructions = loadPrompt("noting.md");
  const priced = (exactEntryIds: number[]) => {
    const frozen = freezeNoting(memory.store, { ...target, boundary: { exactEntryIds } }, memory.config);
    return tokens(instructions) + tokens(JSON.stringify(pricedToolDefinitions(toolDefinitions, canonicalToolNames))) + tokens(frozen.prepared!.text);
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
      expect(dreamerWrite(task.tools.find(tool => tool.name === "memory")!, { operations: [], skipped })).toContain("committed");
      return ok([]);
    }
    const input = raw as NotingAgentInput;
    await heldNoting; // still in flight when the signal fires
    submissions.push(input.tools.find(tool => tool.name === "note")!.execute({ text: "a fact this cancelled run tries to commit", source: [`T${t.id}#E1`] }));
    return ok([]);
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const fact = JSON.parse(memory.tools({ kind: "manual", ...target, currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ title: "Independent evidence", sources: `[T${t.id}#E1] D's independent evidence` })).factIds[0] as number;
  const trigger = createDreamerTrigger(memory, target, fact, 1);
  const controller = new AbortController();
  const cancelled = memory.noting({ ...target, signal: controller.signal });
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
    requests.push(raw); (raw as NotingAgentInput).tools.find(tool => tool.name === "note")!.execute({}); return ok([]);
  });
  const controller = new AbortController(); controller.abort();
  const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, signal: controller.signal });
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
  const created = c.writeCommitted([{ op: "create", title: "Fixture title", topics: [], reason: "Branch-only knowledge.", ...content(c.fact, "C-only rule") }]);
  const commit = created[0]!.commit as number;
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

/** User, 2026-10-01: the embedded-id check on source text is removed (supersedes 40 N0). It could not
 * tell Trace Memory ids from a conversation's own, rejecting a project's cognition records K01–K14, and
 * N rewrote them into vaguer prose to get past it. */
test("source text may name F- and K-shaped ids", () => {
  const { s, t } = session();
  const note = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!;
  const accepted = JSON.parse(note.execute({ title: "Annotation records",
    sources: `[T${t.id}#E1] K14 gets a placeholder source and F101 is unchanged.` }));
  expect(accepted.results[0]).toMatch(/^ok:/);
  expect(memory.store.getFact(accepted.factIds[0])!.text).toContain("K14 gets a placeholder source and F101 is unchanged.");
});







test("59: every supplied item is accounted for by an operation or a skip; New items search every version once, with code", () => {
  const prompt = loadPrompt("dreaming.md");
  // The loop's opening: a deliberated item ends the round in an operation or a reasoned skip; a skip never mutates it.
  // 64c: the material also carries the pool's references; only what the round took up is accounted for.
  expect(prompt).toContain("Every `New` and `Changed` item, and every other item the round took through A–D, ends in an operation or in a skip with a reason. Pool references the round did not take up need no skip.");
  // Step 1, before the first New item: one search over every knowledge version, filtered by code; a hit is read in full before the revival decision.
  expect(prompt).toContain("Before the first `New` item, run one `search` with `layer: knowledge` and a `code` that prints, for each `New` item's word, the superseded and archived hits whose `text` contains it");
  expect(prompt).toContain("; give it no query and no topk, which would drop versions. One word per New item");
  expect(prompt).toContain("One word per New item: the shortest common noun of its object, the word an older body would use, never the item's own phrase.");
  for (const retired of ["queries", "versions: history", "cap: 3"]) expect(prompt).not.toContain(retired);
  // The empty-skip literal is gone; 127 owns the skip call's shape.
  expect(prompt).not.toContain("skipped: []");
});

test("47/118: search reads every version without bypassing write validation", () => {
  const search = toolDefinitions.find(tool => tool.name === "search")!;
  expect(search.description).toContain("every version");
  expect(search.description).toContain("superseded");
});

// The maintainer's current principle note supersedes 61/92's sentence pins. Semantic alignment is
// reviewed against the frozen note with the change; keep composition and stage authority here.
test("N and D compose shared definitions and principles with their permitted maintenance operations", () => {
  const block = (name: string) => renderLimits(readFileSync(new URL(`../../../src/core/prompts/shared/${name}.md`, import.meta.url), "utf8").trimEnd(), DEFAULT_WRITING_LIMITS);
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
  expect(dreaming).toContain("A merge may omit `text`: the latest parent's body then becomes the primary's next version verbatim.");
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
  const shared = renderToolNames(["model", "facts", "knowledge", "admission", "division", "writing", "citations", "formats"]
    .map(name => readFileSync(new URL(`../../../src/core/prompts/shared/${name}.md`, import.meta.url), "utf8")).join("\n"), canonicalToolNames);
  const defined = new Set(["goal", "constraint", "understanding", "reference", "open", "observation", "user", "assistant", "role",
    "session", "project", "global", "search", "supports", "reason", "topics", "text", "title", "sources", "address",
    "category", "scope", "inbound", "support", "negate", "strong", "weak"]);
  for (const word of defined) expect(shared, `shared blocks define ${word}`).toMatch(new RegExp("`" + word + "`|\\*\\*" + word + "\\*\\*"));
  for (const file of STAGE_PROMPTS) {
    const raw = readFileSync(new URL(`../../../src/core/prompts/${file}`, import.meta.url), "utf8").replace(/```[\s\S]*?```/g, "");
    for (const match of raw.matchAll(/`([a-z]+)`/g)) {
      const word = match[1]!;
      if (["note", "memory", "check", "create", "update", "merge", "split", "archive", "op", "id", "skip", "skipped", "operations", "layer", "code", "full", "ok", "absorb", "edits", "source", "slot", "drop", "budget"].includes(word)) continue; // stage tools and operation fields, defined in the stage's Contract
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
    operations: texts.map((text, index) => ({ op: "create" as const, title: "Fixture title", handle: `$${index + 1}`, author: "fixture", text, category: "constraint" as const,
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

/** User, 2026-10-01: the id check on knowledge text is removed, as it was for source text. It could not tell
 * Trace Memory ids from a conversation's own, such as a project's cognition records K01–K14. */
test("knowledge text, split child text and invalid-archive text may name F- and K-shaped ids", () => {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  const note = tools.find(tool => tool.name === "note")!, mem = tools.find(tool => tool.name === "memory")!;
  const noted = JSON.parse(note.execute({ title: "Rule", sources: `[T${t.id}#E1] rule` }));
  const fact = `F${noted.factIds[0]}`;
  const create = (text: string) => ({ op: "create", title: "Fixture title", text, category: "constraint", scope: "project", supports: [fact], topics: [], reason: "test" });
  expect(mem.execute(create("K14 stays as written; F101 is unrelated."))).toContain("committed");
  expect(mem.execute(create("Second item."))).toContain("committed");
  const [a, b] = memory.store.currentKnowledge(memory.store.knowledgePath(s.id)).map(v => `K${v.knowledge.id}#${memory.store.versionTag(v.knowledge.id, v.revision.id)}`);
  // Split is Dreamer-only, so manual memory still rejects it, but for that reason alone: the ids in the child text add no error.
  const split = JSON.parse(mem.execute({ op: "split", id: a, supports: [fact], reason: "test", text: "Primary part.", category: "constraint", scope: "project", topics: [],
    children: [{ title: "Fixture child", text: "Part K14 of it.", category: "constraint", topics: [] }, { title: "Fixture child", text: "Part F2 of it.", category: "constraint", topics: [] }] }));
  expect(split.results).toEqual(["rejected: split belongs to the Dreamer and is not available to manual memory"]);
  const archive = JSON.parse(mem.execute({ op: "archive", id: b, kind: "invalid", supports: [fact], reason: "test",
    text: "K7 was based on a misreading of F1, which says the opposite in the quoted source." }));
  expect(archive.results[0]).not.toContain("rejected");
});

// 133 supersedes 73's single shared allowance for episodic borrowing.
test("133: pending Raw uses only the temporary allowance; unused Knowledge allowance cannot hold it", () => {
  const project = memory.store.createProject({ name: "temporary", declaredBy: "marker" });
  const s = memory.store.createSession({ host: "fake", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
  const turn = memory.store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: time, userPrompt: "pending ".repeat(100) });
  Object.assign(memory.config.compaction, { rawTokens: 30, temporaryTokens: 1, sharedAllowanceTokens: 1000 });
  const small = memory.compact(s.id, "main", turn.id);
  if ("native" in small) throw new Error("native");
  expect(small.supplied.entries).toEqual([]);
  expect(small.truncated?.raw).toEqual({ entries: 1 });
  memory.config.compaction.temporaryTokens = 400;
  const large = memory.compact(s.id, "main", turn.id);
  if ("native" in large) throw new Error("native");
  expect(large.supplied.entries.map(e => e.id)).toEqual(memory.store.sourcePath(s.id, "main", turn.id).map(e => e.id));
  expect(large.material!.earlierUsers).toEqual([]);
  expect(large.charged!.temporary).toBeGreaterThan(0);
  expect(large.charged!.temporary).toBeLessThanOrEqual(400);
  expect(large.knowledgeAllowance).toBe(small.knowledgeAllowance);
  expect(large.charged!.knowledge + large.charged!.facts + large.charged!.raw + large.charged!.temporary).toBeLessThanOrEqual(large.charged!.envelope);
});


// Ticket 144, Stage 2: the workspace file contract. Each ruling it implements has a named test.
const workspaceCurate = (b: ReturnType<typeof workspaceBatch>, text: string) =>
  ({ kind: "curate" as const, sessionId: b.session.id, path: b.path, file: { name: "curate.md", text } });

test("2026-10-21/22: a file holds at most one record per knowledge item, an absorbed item included", () => {
  const b = workspaceBatch();
  try {
    const [primary, absorbed] = [b.item("Rule p"), b.item("Rule a")];
    const twice = `${workspaceBlock(`update ${primary.ref}`, { reason: "one" }, "One.")}\n${workspaceBlock(`update ${primary.ref}`, { reason: "two" }, "Two.")}`;
    expect(checkWorkspace(b.store, workspaceCurate(b, twice)).problems.join("\n")).toContain(`K${primary.knowledgeId} already has a record in this file`);
    const absorbedTwice = `${workspaceBlock(`merge ${primary.ref}`, { absorb: absorbed.ref, reason: "same" }, "Merged.")}\n${workspaceBlock(`update ${absorbed.ref}`, { reason: "again" }, "Again.")}`;
    expect(checkWorkspace(b.store, workspaceCurate(b, absorbedTwice)).problems.join("\n")).toContain(`K${absorbed.knowledgeId} already has a record in this file`);
  } finally { b.memory.close(); }
});

// The rule is enforced where every merge passes: the Dreamer's `memory` tool and a workspace file both reach it.
test("2026-10-21: merged items share one category and scope, through the memory tool and through a workspace file", async () => {
  const { create, write, path } = memoryWriter();
  const item = (over: Record<string, unknown>) => (write([{ ...create, text: `Rule ${Object.values(over).join(" ")}`, ...over }]).committed as Array<{ knowledgeId: number; version: string }>)[0]!;
  const primary = item({ category: "constraint" }), sameKind = item({ category: "constraint", topics: ["same"] }),
    otherCategory = item({ category: "reference" }), otherScope = item({ scope: "global" });
  const trigger = createDreamerTrigger(memory, path, 2, 1);
  let merged: Pick<MemoryReceipt, "results" | "committed"> | undefined;
  await admittedScenarios.run(memory, path, input => {
    input.reportRequest({ fixture: "merge sameness" });
    const writeTool = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, input.reader!);
    const address = (found: { knowledgeId: number; version: string }) => tagged(found.knowledgeId, commitOf(found));
    for (const found of [primary, sameKind, otherCategory, otherScope]) readHandle(file => files.read(file).content, found.version);
    readHandle(file => files.read(file).content, tagged(trigger.knowledgeId, trigger.commit));
    const merge = (other: { knowledgeId: number; version: string }) => ({ ...create, op: "merge", reason: "Merged.", id: address(primary), absorb: [address(other)], supports: ["F1"] });
    merged = JSON.parse(dreamerWrite(writeTool, { operations: [merge(otherCategory), merge(otherScope), merge(sameKind),
      { op: "archive", kind: "budget", id: tagged(trigger.knowledgeId, trigger.commit), supports: ["F2"], reason: "Retire the explicit fixture trigger." }], skipped: [] }));
    return { outcome: "success", output: "merged", request: { fixture: "merge sameness" } };
  });
  expect(merged?.results[0], JSON.stringify(merged)).toContain("merge parents and result must share one category");
  expect(merged?.results[1]).toContain("merge parents and result must share one scope");
  expect(merged?.results[2]).toBe("ok");
  expect(memory.store.currentCommit(otherCategory.knowledgeId)).toHaveLength(1);

  const b = workspaceBatch();
  try {
    const first = b.item("Rule p", { category: "constraint", scope: "project" });
    const merge = (other: { ref: string }) => checkWorkspace(b.store, workspaceCurate(b, workspaceBlock(`merge ${first.ref}`, { absorb: other.ref, reason: "same" }, "Merged.")));
    expect(merge(b.item("Rule a", { category: "constraint", scope: "project" })).problems).toEqual([]);
    expect(merge(b.item("Rule b", { category: "reference", scope: "project" })).problems.join("\n")).toContain("merged items share one category");
    expect(merge(b.item("Rule c", { category: "constraint", scope: "global" })).problems.join("\n")).toContain("merged items share one scope");
  } finally { b.memory.close(); }
});

test("2026-10-21/22: update keeps the identity and adds a version; create makes a new identity", () => {
  const b = workspaceBatch();
  try {
    const item = b.item("Rule one");
    const created = { title: "Fresh rule", category: "constraint", scope: "project", topics: "", supports: `F${item.supports[0]}`, reason: "new" };
    const result = applyWorkspace(b.store, workspaceCurate(b, `${workspaceBlock(`update ${item.ref}`, { reason: "tidy" }, "Rule one, tidied.")}\n${workspaceBlock("create", created, "A fresh rule.")}`));
    if (!result.ok) throw new Error(result.problems.join("\n"));
    expect(result.blocks[0]!.versions).toEqual([`K${item.knowledgeId}@v2`]);
    expect(Number(result.blocks[1]!.versions[0]!.match(/^K(\d+)/)![1])).toBeGreaterThan(item.knowledgeId);
  } finally { b.memory.close(); }
});

test("2026-10-22: split children may take their own category", () => {
  const b = workspaceBatch();
  try {
    const item = b.item("Rule one and rule two", { category: "open" });
    const child = (category: string) => `\n### child\ntitle: Child ${category}\ncategory: ${category}\nscope: project\ntopics:\nsupports: F${item.supports[0]}\nreason: split out\n\nChild body.\n`;
    const text = workspaceBlock(`split ${item.ref}`, { reason: "mixed" }, "The open question.") + child("constraint") + child("reference");
    expect(checkWorkspace(b.store, workspaceCurate(b, text))).toMatchObject({ ok: true });
    const result = applyWorkspace(b.store, workspaceCurate(b, text));
    if (!result.ok) throw new Error(result.problems.join("\n"));
    const [, ...children] = result.blocks[0]!.versions.map(version => Number(version.match(/^K(\d+)/)![1]));
    expect(children.map(id => b.store.currentCommit(id, b.path)[0]!.category)).toEqual(["constraint", "reference"]);
    expect(b.store.currentCommit(item.knowledgeId, b.path)[0]!.category).toBe("open");
  } finally { b.memory.close(); }
});

test("2026-10-21: a verify correction without evidence is refused", () => {
  const b = workspaceBatch();
  try {
    const item = b.item("Rule one");
    const verify = (fields: Record<string, string>) => checkWorkspace(b.store, { kind: "verify", sessionId: b.session.id, file: { name: "verify.md",
      text: workspaceBlock(`update ${item.ref}`, { reason: "attribution", ...fields }, "Rule one, corrected.") } });
    expect(verify({}).problems.join("\n")).toContain("missing required field `evidence`");
    expect(verify({ evidence: `trace://F${item.supports[0]}` }).problems).toEqual([]);
  } finally { b.memory.close(); }
});

test("2026-10-21/22: the Noter writes no parents, merge, split or archive", () => {
  const b = workspaceBatch();
  try {
    const item = b.item("Rule one");
    const facts = { name: "facts.md", text: workspaceBlock("fact f1", { title: "pnpm chosen" }, b.source(0, "User asked to use pnpm")) };
    const knowledge = (text: string) => checkWorkspace(b.store, { kind: "noting-knowledge", scope: b.scope, file: { name: "knowledge.md", text }, facts }).problems.join("\n");
    const create = { title: "Use pnpm", category: "constraint", scope: "project", topics: "", supports: "f1", reason: "choice" };
    expect(knowledge(workspaceBlock("create", create, "Use pnpm."))).toBe("");
    expect(knowledge(workspaceBlock("create", { ...create, parents: item.ref }, "Use pnpm."))).toContain("field `parents` is not allowed here");
    for (const op of ["merge", "split", "archive"]) expect(knowledge(workspaceBlock(`${op} ${item.ref}`, { reason: "r" }, "Body."))).toContain(`\`## ${op}\` is not allowed in a noting-knowledge file`);
  } finally { b.memory.close(); }
});
