import { readHandle } from "../../read-handle-fixture.ts";
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
import { pricedToolDefinitions, notingToolDefinitions } from "../../../src/core/api/tools.ts";
import type { MemoryReceipt } from "../../../src/core/knowledge-write/bind.ts";
import { canonicalToolNames, renderToolNames } from "../../../src/core/prompts/tool-names.ts";
import { ccPluginToolNames } from "../../../src/hosts/cc/tool-names.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { setKnowledgeCapacity, setKnowledgeInjection } from "../../knowledge-budget-fixture.ts";
import { visibleView } from "../../../src/hosts/pi/visible.ts";
import { dreamerFixture as makeDreamerFixture, scriptedDreamer, writeCurateBatch, type DreamerScript } from "../../support/dreamer.ts";
import { CcTaskScheduler } from "../../../src/hosts/cc/scheduler.ts";
import { receiptCommit, scoreAll } from "../../support/seed.ts";
import { block as workspaceBlock, workspaceBatch } from "../../support/workspace.ts";
import { applyWorkspace, checkWorkspace } from "../../../src/core/workspace/index.ts";
import { resolveCcHostConfig } from "../../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../../src/hosts/cc/binding.ts";
import { CcCoordinator, recordCcSessionEnd } from "../../../src/hosts/cc/lifecycle.ts";
import { handleCcHook } from "../../../src/hosts/cc/index.ts";
import * as ccNative from "../../../src/hosts/cc/native-session.ts";
import { CcImporter } from "../../../src/hosts/cc/importer.ts";
import { Store } from "../../../src/core/store/index.ts";
import { knowledgeBatch, updateKnowledge } from "../../support/seed.ts";
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
import { scriptedNoter, submit, submitEmpty, verifyUnchanged } from "../../support/noter.ts";

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
let agent: (raw: unknown) => Promise<RunAgentResult>;
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
  // A successful Noter script writes `## none` to both files; only a batch's write task is counted in `calls`.
  const fallback = async (raw: unknown) => { const input = raw as NotingAgentInput;
    if (!(input.kind === "noting" && input.task === "verify")) calls.push(input);
    if (input.kind === "noting") {
      submitEmpty(input);
    }
    return ok([]); };
  agent = fallback;
  // Items here are sized in thousands of tokens, as items written before the caps (ticket 144) are; the caps are lifted for this file, and its own cap ruling restores them.
  memory = sourceSeededMemory(join(directory, "test.sqlite"), agent, { writing: { bodyTokens: 1_000_000 } });
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

/** Tight-budget cases bound the one temporary allowance explicitly; no window can borrow a base. */
const compactionWindows = (knowledge: number, facts: number, raw: number, temporary = 0) => {
  setKnowledgeInjection(memory, Math.max(0, knowledge));
  memory.config.compaction.factsTokens = facts;
  memory.config.compaction.rawTokens = raw;
  memory.config.compaction.temporaryTokens = temporary;
};
const defaultWindows = () => compactionWindows(memory.knowledgeBudgets().injection,
  DEFAULT_CONFIG.compaction.factsTokens, DEFAULT_CONFIG.compaction.rawTokens, DEFAULT_CONFIG.compaction.temporaryTokens);
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
  const m = sourceSeededMemory(join(directory, "thinking.sqlite"), agent, {}, undefined, piSourceBlocks);
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
      capacity: { inputTokens: price } }, m.config).entries.map(entry => entry.id))
      .toEqual([first.id, publicEntry.id, last.id]);
    expect(await m.noting({ ...target })).toMatchObject({ outcome: "success" });
    expect(calls[0]!.entryIds).toEqual([first.id, publicEntry.id, last.id]);
    expect(m.pendingEntries(s.id, "main", t.id)).toEqual([]);
    for (const entry of [first, last]) expect(m.store.entryNoted(entry.id)).toBe(true);
    expect(m.pendingTokens("noting", target).tokens).toBe(0);
  } finally { m.close(); }
});

test("pending counts stay exact as mixed batches publish and only thinking remains", async () => {
  const m = sourceSeededMemory(join(directory, "pending-thinking.sqlite"), agent, {}, undefined, piSourceBlocks);
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
    worker: { cwd: directory, claudeExecutable: "/missing/claude", contextWindows: { synthetic: 200_000, sonnet: 200_000 } } }).worker;
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
    if (task.task === "verify") { submitEmpty(task); return ok([]); }
    attempts++;
    expect(task.kind).toBe("noting");
    if (attempts === 1) return { outcome: "failure", request: { fake: true }, output: "first attempt failed" };
    expect(checks.mock.calls.map(([phase]) => phase)).toEqual(["dreaming"]);
    expect(retryMemory.store.taskFailures(target.sessionId).some(row => row.count === 1)).toBe(true);
    submitEmpty(task);
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
    worker: { cwd: directory, claudeExecutable: "/missing/claude", contextWindows: { synthetic: 200_000, sonnet: 200_000 } } }).worker;
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
  expect(tools.find(tool => tool.name === "note")!.description).toContain("Each call commits one fact immediately");
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
    if (input.task === "verify") return verifyUnchanged(input, { request: { round: 2 } });
    input.reportRequest({ round: 1 });
    const fact = { title: "Package manager decision", sources: `[T${t.id}#E1] Use pnpm` };
    expect(await submit(input, memory, { noteInput: [fact], memoryInput: {} })).toBeUndefined();
    expect(memory.store.listSessionFacts(s.id)).toEqual([]);
    expect(memory.store.listRuns(s.id).some(run => run.outcome === "success")).toBe(false);
    const entries = memory.store.sourcePath(s.id, "main", t.id);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(entry => memory.store.entryNoted(entry.id))).toBe(false);
    // The model may rewrite its file before it stops; only the final file is published.
    await submit(input, memory, { noteInput: [{ ...fact, sources: `[T${t.id}#E1] Use pnpm, not npm` }], memoryInput: {} });
    expect(memory.store.listSessionFacts(s.id)).toEqual([]);
    return { outcome: "success", output: "Done", request: { round: 1 } };
  });
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(memory.store.listSessionFacts(s.id)).toMatchObject([{ text: "Use pnpm, not npm" }]);
  expect(memory.store.sourcePath(s.id, "main", t.id).every(entry => memory.store.entryNoted(entry.id))).toBe(true);
  const run = memory.store.listRuns(s.id).at(-1)!;
  expect(run.outcome).toBe("success");
  expect(JSON.parse(run.request!)).toEqual({ round: 2 });
  expect(JSON.parse(run.response!).toolCalls.map((c: { name: string }) => c.name)).toEqual(["check"]);
});

// “a run whose last submission was rejected and never corrected ... is bounced ... watermark does not move”: since 2026-10-22 the
// files' check decides, and a run whose files fail it is a failure that moves nothing.
test("2026-09-07: a refused submission is not an empty one", async () => {
  const { s, t } = session(); memory.close();
  let reject = true;
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    if (input.task === "verify") return verifyUnchanged(input, { request: {} });
    await submit(input, memory, { noteInput: reject ? [{ title: "Invalid source", sources: "[T999#E1] Absent" }] : [], memoryInput: {} });
    return { outcome: "success", output: "No more text", request: {} };
  });
  const input = { sessionId: s.id, branch: "main", headTurnId: t.id };
  expect((await memory.noting(input)).outcome).toBe("failure");
  expect(memory.store.getRun(1)?.outcome).toBe("failure");
  expect(JSON.parse(memory.store.getRun(1)!.response!).files.facts).toContain("[T999#E1] Absent");
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

test("2026-09-28, 99: archive kind is required and invalidation records grounds; 2026-10-22: the budget kind is retired", () => {
  const { s, path, tools, write, create } = memoryWriter();
  const budgetBase = write([create]).committed[0];
  const invalidBase = write([{ ...create, text: "Old unique guidance" }]).committed[0];
  const budgetId = budgetBase.knowledgeId, invalidId = invalidBase.knowledgeId;
  const budgetTag = tagged(budgetId, commitOf(budgetBase));
  const invalidTag = tagged(invalidId, commitOf(invalidBase));
  const attempted = (id: string, extra: Record<string, unknown>) => write([{ op: "archive", id, supports: ["F1"], reason: "archival decision", ...extra }]);
  expect(attempted(budgetTag, {}).results[0]).toContain("archive kind must be invalid or inadmissible");
  expect(attempted(budgetTag, { kind: "budget" }).results[0]).toContain("archive kind must be invalid or inadmissible"); // no new budget archive can be written
  expect(attempted(invalidTag, { kind: "invalid", text: "obsolete" }).results[0]).toContain("substantive statement");
  expect(attempted(invalidTag, { kind: "invalid", text: "The rule no longer holds: the user corrected its basis; another rule replaces it." }).committed).toHaveLength(1);
  const invalid = memory.store.currentCommit(invalidId, path)[0]!;
  expect(invalid).toMatchObject({ op: "archive", archiveKind: "invalid", category: "constraint", scope: "project", topics: [] });
  expect(invalid.text).toContain("no longer holds");
  expect(memory.store.currentKnowledge(path).map(item => item.knowledge.id)).toEqual([budgetId]); // the refused archive left its item current
  expect(memory.inject(s.id)).not.toContain("Old unique guidance");
  const files = memoryFiles(memory, path), search = tools.find(tool => tool.name === "search")!;
  expect(files.read(`trace://${history(invalidId, invalid.id)}`).content).toContain("status: archive (invalid)");
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

test("2026-09-07: supports replaces, history keeps the old set", () => {
  const { create, write, path, s } = memoryWriter();
  const created = write([create]);
  expect(created.results).toEqual(["ok"]);
  expect(memory.store.getKnowledgeRevision(1, 1)).toMatchObject({ supports: [1], reason: "Initial admission of this conclusion." });
  const updated = curateWrite(path, [{ ...create, op: "update", reason: "Substantive correction of the recorded conclusion.", id: tagged(1, 1), text: "Avoid npm", supports: ["F2"] }]);
  const commit = commitOf(updated.committed[0]);
  expect(memory.store.getKnowledgeRevision(1, commit)).toMatchObject({ supports: [2], reason: "Substantive correction of the recorded conclusion." });
  expect(memory.store.getKnowledgeRevision(1, 1)?.supports).toEqual([1]);
  expect(memoryFiles(memory, path).read(`trace://K1@v${memory.store.versionOrdinal(1, commit)}`).content).toContain("F2");
  const runs = memory.store.listRuns(s.id);
  expect(runs.at(-1)).toMatchObject({ kind: "dreaming", branch: "main" });
  expect(runs.at(-1)!.id).toBe(memory.store.getKnowledgeRevision(1, commit)!.runId);
});

// 144 supersedes 86's 1,000-token cap on N and D writes and 135's unlimited manual writes.
test("2026-10-21, 144: '更新旧条目仍然受限，手写也一样，不要维护两套标准' — one title and body limit for the manual tools and the Dreamer's files, set in configuration, with updates of old items inside it", () => {
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
  // The Dreamer's curate file is checked by the same limits.
  const refused = checkWorkspace(memory.store, { kind: "curate", sessionId: path.sessionId, path: { sessionId: path.sessionId, branch: path.branch, headTurnId: path.headTurnId },
    file: { name: "curate.md", text: workspaceBlock(`update ${history(created.knowledgeId, commitOf(created))}`, { reason: "Touch an old item" }, long) } });
  expect(refused.problems.join("\n")).toContain("over the 200-token limit");
  // The limits are configuration, not constants.
  memory.config.writing.bodyTokens = 1_000;
  expect(write([{ ...create, text: long }]).results[0]).toBe("ok");
});

// A merge that omits its title inherits it from the primary it names, whichever of the two is older; an untitled
// legacy primary requires one (2026-10-22: the named primary keeps its identity, no older-survivor rule, no swap).
test("144/2026-10-22: a merge without a title takes the named primary's title, the newer item included; an untitled legacy primary is refused", () => {
  const { create, write, path } = memoryWriter();
  const committed = (title: string, text: string) => write([{ ...create, title, text }]).committed[0] as { knowledgeId: number; version: string };
  const older = committed("Older rule", "Use pnpm"), newer = committed("Newer rule", "Avoid npm");
  const survivor = committed("Survivor rule", "Pin the Node version");
  const legacy = legacyKnowledge(memory.store, path, { text: "Legacy rule body", category: "constraint", scope: "project", supports: [1] });
  const merge = (primary: string, absorb: string) => ({ kind: "curate" as const, sessionId: path.sessionId, path: { sessionId: path.sessionId, branch: path.branch, headTurnId: path.headTurnId },
    file: { name: "curate.md", text: workspaceBlock(`merge ${primary}`, { absorb, reason: "Merged duplicate knowledge." }, "Merged body.") } });
  // Names the newer one: it keeps its identity and its title.
  const merged = applyWorkspace(memory.store, merge(history(newer.knowledgeId, commitOf(newer)), history(older.knowledgeId, commitOf(older))));
  expect(merged.ok, JSON.stringify(merged)).toBe(true);
  // Names an untitled legacy primary: a title is required.
  const refused = applyWorkspace(memory.store, merge(history(legacy.knowledgeId, legacy.commit), history(survivor.knowledgeId, commitOf(survivor))));
  expect(refused.ok).toBe(false);
  expect(refused.ok ? "" : refused.problems.join("\n")).toContain("no title");
  const titleOf = (item: { knowledgeId: number }) => memory.store.currentCommit(item.knowledgeId).map(revision => revision.title);
  expect(titleOf(newer)).toEqual(["Newer rule"]);
  expect(titleOf(older)).toEqual([]);
});

// 2026-10-22 (supersedes tickets 44 and 135): the primary a merge names keeps its identity, newer or not.
test("2026-10-22: a merge keeps the identity of the primary it names even when that is the newer item", () => {
  const { create, write, path } = memoryWriter();
  const created = (write([create, { ...create, text: "Avoid npm", supports: ["F2"] }]).committed as Array<{ knowledgeId: number; version: string }>)
    .map(item => ({ ...item, commit: commitOf(item) }));
  const first = created[0], second = created[1];
  if (!first || !second) throw new Error(`merge fixture needs two identities: ${JSON.stringify(created)}`);
  const merged = curateWrite(path, [{ ...create, op: "merge", reason: "Merged duplicate knowledge into the primary.",
    id: tagged(second.knowledgeId, second.commit), absorb: [tagged(first.knowledgeId, first.commit)], supports: ["F1", "F2"] }]);
  expect(merged.results).toEqual(["ok"]);
  const primary = merged.committed[0];
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
test("2026-10-22: a split keeps the original identity as the primary part, creates the children and does not archive the original", () => {
  const { create, write, path } = memoryWriter();
  const original = (write([{ ...create, text: "Use pnpm and keep the lockfile" }]).committed as Array<{ knowledgeId: number; version: string }>)
    .map(item => ({ ...item, commit: commitOf(item) }))[0]!;
  const child = (title: string, category: string, text: string) => `\n### child\ntitle: ${title}\ncategory: ${category}\nscope: project\ntopics:\nsupports: F1\nreason: split out\n\n${text}\n`;
  const result = applyWorkspace(memory.store, { kind: "curate", sessionId: path.sessionId, path: { sessionId: path.sessionId, branch: path.branch, headTurnId: path.headTurnId },
    file: { name: "curate.md", text: workspaceBlock(`split ${history(original.knowledgeId, original.commit)}`, { reason: "Two independent rules." }, "Use pnpm")
      + child("Lockfile", "reference", "Keep the lockfile") + child("Registry", "goal", "Use the mirror") } });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  const [primary, ...children] = result.blocks[0]!.versions.map(version => Number(/^K(\d+)/.exec(version)![1]));
  expect(primary).toBe(original.knowledgeId);
  expect(children).not.toContain(original.knowledgeId);
  expect(children).toHaveLength(2);
  // The original is not archived: it continues with the primary part's text, and only the children are new.
  expect(memory.store.currentCommit(original.knowledgeId).map(revision => [revision.op, revision.text])).toEqual([["split", "Use pnpm"]]);
  expect(children.map(id => memory.store.currentCommit(id)[0]!.category)).toEqual(["reference", "goal"]);
  expect(memory.store.listKnowledgeLinks(original.knowledgeId).map(link => [link.kind, link.fromCommit, link.toKnowledge]))
    .toEqual(children.map(id => ["split_from", original.commit, id]));
  expect(memory.store.listKnowledgeRevisions(original.knowledgeId).some(revision => revision.op === "archive")).toBe(false);
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
  const edit = async (who: typeof root, text: string, fact = who.fact) => {
    publish(who);
    const current = memory.store.currentCommit(1, who).at(-1)!;
    return curateWrite(who, [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
      id: tagged(1, current.id), ...content(fact, text) }]);
  };
  const tips = (path: { sessionId: number; headTurnId: number }) => memory.store.currentCommit(1, path).map(r => r.id);
  const peer = (projectId = s.projectId) => {
    const other = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId, startedAt: time, firstReplyAt: time });
    return node(other.id, null, "main");
  };
  return { root, c, d, node, peer, content, edit, tips, publish };
}

/** A Dreamer maintenance write as the Dreamer now makes it: one curate file for the path, checked and applied by core. The operations are
 * written in the memory tool's shape (`id` a tag, `supports` F ids); an archive takes no evidence of its own and states Retired plus its reason. */
function curateWrite(path: { sessionId: number; headTurnId: number; branch: string }, operations: any[]) {
  const store = memory.store;
  const address = (tag: string) => {
    const [, id, version] = /^K(\d+)#([a-z]+)$/.exec(tag)!;
    return `K${id}@v${store.versionOrdinal(Number(id), store.resolveVersionTag(Number(id), version!))}`;
  };
  const blocks = operations.map(op => {
    if (op.op === "archive") return workspaceBlock(`archive ${address(op.id)}`, { kind: "inadmissible", reason: op.reason }, op.text ?? `Retired: ${op.reason}`);
    const fields: Record<string, string> = { reason: op.reason };
    for (const key of ["title", "category", "scope"]) if (op[key] !== undefined) fields[key] = op[key];
    if (op.topics) fields.topics = op.topics.join(", ");
    if (op.supports?.length) fields.supports = op.supports.join(", ");
    if (op.op === "merge") fields.absorb = op.absorb.map(address).join(", ");
    return workspaceBlock(`${op.op} ${address(op.id)}`, fields, op.text);
  });
  const result = applyWorkspace(store, { kind: "curate", sessionId: path.sessionId, path: { sessionId: path.sessionId, branch: path.branch, headTurnId: path.headTurnId },
    file: { name: "curate.md", text: blocks.join("\n") } });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  const refused = result.blocks.filter(entry => entry.status !== "applied");
  if (refused.length) throw new Error(refused.map(entry => entry.reason).join("\n"));
  const committed = result.blocks.flatMap(entry => entry.versions).map(version => {
    const [, id, ordinal] = /^K(\d+)@v(\d+)$/.exec(version)!;
    return { knowledgeId: Number(id), version, commit: store.resolveVersionOrdinal(Number(id), Number(ordinal)) };
  });
  return { results: result.blocks.map(() => "ok"), committed: committed as [typeof committed[number], ...typeof committed] };
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
  await edit(c, "C version");
  await edit(d, "D version");
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
  const { root, edit } = commitPaths();
  const updated = await edit(root, "Use blue tiles");
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
  expect(memory.store.getKnowledge(2)).toBeNull();
  expect(memory.store.listKnowledgeRevisions(1)).toHaveLength(2);
});

test("92/118: search previews are tagless, and a stale base is refused naming the current version", () => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  readHandle(file => memoryFiles(memory, other).read(file).content, "K1@v1");
  const successor = other.writeCommitted([{ op: "update", id: tagged(1, 1), topics: [], reason: "A substantive correction.",
    ...content(root.fact, `Unread successor ${"中文😀".repeat(350)}`) }])[0]!;
  const preview = other.tools.find(tool => tool.name === "search")!.execute({ query: "Unread successor", layer: "knowledge" });
  expect(preview).not.toContain("rejected:"); expect(preview).not.toMatch(/K\d+#[a-z]+/);
  const edit = (id: string) => other.write([{ op: "update", topics: [], reason: "A substantive correction.", id, ...content(other.fact) }]);
  expect(edit(tagged(1, 1)).results[0]).toContain(`current: ${history(1, successor.commit)}`);
  const successorTag = tagged(1, successor.commit);
  expect(readHandle(file => memoryFiles(memory, other).read(file).content, successor.version)).toContain(successorTag);
  expect(edit(successorTag).committed![0]!.knowledgeId).toBe(1);
});

test("41a/118: search lists the versions applicable on the reader's path, and exact trace:// versions preserve read scope", async () => {
  const { c, d, edit, publish } = commitPaths();
  const cCommit = (await edit(c, "FILTER-C")).committed[0].commit as number;
  const dCommit = (await edit(d, "FILTER-D")).committed[0].commit as number;
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

test("41b/92/118: search previews omit tags, while an exact tag read from the version's address is a valid base", () => {
  const { peer, content } = commitPaths(); const other = peer();
  const update = (id: string, text: string) => other.writeCommitted([{ op: "update", id, ...content(other.fact, text), topics: [], reason: "41b update" }])[0]!;
  const successor = update(tagged(1, 1), "BASE-SUCCESSOR");
  const preview = other.tools.find(tool => tool.name === "search")!.execute({ query: "BASE-SUCCESSOR", layer: "knowledge" });
  expect(preview).toContain("BASE-SUCCESSOR"); expect(preview).not.toMatch(/K\d+#[a-z]+/);
  // The search preview is tagless; the exact base, not read history, authorizes this write.
  const finite = update(tagged(1, successor.commit), "FINITE-COMPLETE");
  const finiteTag = tagged(1, finite.commit);
  expect(readHandle(file => memoryFiles(memory, other).read(file).content, finite.version)).toContain(finiteTag);
  expect(update(finiteTag, "FULL-COMPLETE").knowledgeId).toBe(1);
});

test("64b/34a: global current scope hides the identity without visible fallback", () => {
  const { root, peer, content, publish } = commitPaths();
  publish(root);
  const maintain = (text: string, scope: "global" | "project" | "session") => {
    const current = memory.store.currentCommit(1, root)[0]!;
    const receipt = curateWrite(root, [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
      id: tagged(1, current.id), ...content(root.fact, text), scope }]);
    return receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1)!.commit as number;
  };
  maintain("Shared globally", "global");
  const outsideProject = memory.store.createProject({ name: "outside", declaredBy: "mark" });
  const outside = peer(outsideProject.id);
  const projectCommit = maintain("Project only", "project");
  expect(memory.inject({ projectId: outsideProject.id })).not.toMatch(/K1[#@]/);
  expect(memoryFiles(memory, outside).read("trace://K1").content.split("\n")[0]).toBe("K1 path current: none");
  const sessionCommit = maintain("Session only", "session");
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

test("64b: stale absorbed bases name the surviving current commit across merge links", () => {
  const { root, peer, content, publish } = commitPaths();
  const second = root.writeCommitted([{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact) }])[0]!;
  const other = peer(); other.read(second.version);
  publish(root);
  const mergedReceipt = curateWrite(root, [{ op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.",
    id: tagged(1, 1), absorb: [tagged(second.knowledgeId, second.commit)], ...content(root.fact) }]);
  const merged = mergedReceipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1)!;
  const updatedReceipt = curateWrite(root, [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
    id: tagged(1, merged.commit), ...content(root.fact, "Surviving current conclusion") }]);
  const survivor = updatedReceipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1)!;
  publish(other);
  const stale = applyWorkspace(memory.store, { kind: "curate", sessionId: other.sessionId, path: { sessionId: other.sessionId, branch: other.branch, headTurnId: other.headTurnId },
    file: { name: "curate.md", text: workspaceBlock(`update ${history(second.knowledgeId, second.commit)}`, { reason: "Substantive correction of the recorded conclusion.", supports: other.fact }, "Invalid absorbed edit") } });
  const rejected = stale.ok ? stale.blocks.map(entry => entry.reason ?? "").join("\n") : stale.problems.join("\n");
  expect(rejected).toContain(`current: ${history(survivor.knowledgeId, survivor.commit)}`);
  expect(memory.store.getKnowledge(second.knowledgeId)).not.toBeNull();
  expect(memory.store.currentCommit(second.knowledgeId, other)).toEqual([]);
});

test("16b: path trace separates applicable history, parents, children and sibling tips", async () => {
  const { root, c, d, edit, publish } = commitPaths();
  const cCommit = (await edit(c, "C version")).committed[0].commit as number;
  const dCommit = (await edit(d, "D version")).committed[0].commit as number;
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
  const cCommit = (await edit(c, "C version")).committed[0].commit as number;
  const dCommit = (await edit(d, "D version")).committed[0].commit as number;
  publish(c);
  const line = (result: unknown, label: string) => (result as string).split("\n").find(l => l.startsWith(`[${label}]`));
  expect(line(memory.search("Use blue tiles", "knowledge", c), history(1, 1))).toContain("(superseded)");
  expect(line(memory.search("C version", "knowledge", c), history(1, cCommit))).not.toContain("(");
  expect(memory.search("D version", "knowledge", c)).not.toContain("D version"); // another branch's version is not applicable here
  expect(line(memory.search("C version", "knowledge", root), history(1, cCommit))).toBeDefined();
  expect(c.read("K1")).toContain("C version");
  const archived = curateWrite(c, [{ op: "archive", kind: "budget", reason: "Retired: the cited evidence withdraws this conclusion.",
    id: tagged(1, cCommit), text: "C version is withdrawn: the cited evidence no longer supports this conclusion." }]);
  expect(archived.committed[0].knowledgeId).toBe(1);
  expect(memory.search("C version", "knowledge", c)).toContain("(archived)");
  expect(memory.search("D version", "knowledge", d)).not.toContain("[K1@v1]");
  publish(d);
  expect(line(memory.search("D version", "knowledge", c), history(1, dCommit))).toBeDefined();
});

test("64b: compaction follows the owner's published foreground across a branch switch", async () => {
  const { c, d, edit, publish } = commitPaths();
  const cCommit = (await edit(c, "C version")).committed[0].commit as number;
  const dCommit = (await edit(d, "D version")).committed[0].commit as number;
  publish(c);
  const onC = compacted(memory.compact(c.sessionId, c.branch, c.headTurnId));
  expect(onC).toContain(`[${tagged(1, cCommit)}]`); expect(onC).not.toContain(`[${tagged(1, dCommit)}]`);
  publish(d);
  const afterSwitch = compacted(memory.compact(c.sessionId, c.branch, c.headTurnId));
  expect(afterSwitch).toContain(`[${tagged(1, dCommit)}]`); expect(afterSwitch).not.toContain(`[${tagged(1, cCommit)}]`);
});

test("16b: branch carry fixture uses evidence ancestry, includes commits and raw; tags delimit and lines stay byte for byte", async () => {
  const { c, d, node, edit, publish } = commitPaths();
  const cCommit = (await edit(c, "C version")).committed[0].commit as number;
  const dCommit = (await edit(d, "D version")).committed[0].commit as number;
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
  const updated = curateWrite(c, [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
    id: tagged(1, 1), ...content(`F${fact}`, "Use violet tiles") }]);
  const commit = updated.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1)!.commit;
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
  // The budgets compact still answers to are its three windows and the one temporary allowance (73, 144): below
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
  expect(windows.envelope).toBe(50_000); // three bases and the one temporary allowance (144)
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
test("45/92: the per-consolidation knowledge-token settings are removed", () => {
  for (const override of [{ render: { knowledgeBlockTokens: 10_000 } }, { consolidation: { knowledgeTokens: 10_000 } }])
    expect(() => api.validateConfig(override as never)).toThrow(/Removed setting .*knowledge.*Tokens/);
  expect(Object.hasOwn(memory.config, "consolidation")).toBe(false);
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
  expect(calls).toHaveLength(1); // one batch: its write task
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
  scoreAll(memory.store); // the Knowledge base carries scored items
  memory.config.compaction.temporaryTokens = 0; // the base cap is hard; with a temporary allowance a misfit would show as a title
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
  expect(runs).toHaveLength(4); // two batches, a write run and a verify run each
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
    submitEmpty(input); return ok([]); });
  try {
    expect(after.store.getRun(legacy)!.mode).toBe("branch");   // reopening the database migrates nothing
    expect(after.trace(`R${legacy}`)).toContain("mode legacy request-copy execution (branch)");
    expect(after.trace(`R${legacy}`)).not.toContain("mode fork"); // an old run is never described as a native fork
    expect(runMode("fork")).toBe("fork"); expect(runMode("subagent")).toBe("subagent"); // new modes read as themselves
    // Reading it, and running new work in the same database afterwards, leave the stored value alone.
    expect((await after.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
    expect(after.trace(`R${legacy}`)).toContain("legacy request-copy execution");
    expect(after.store.getRun(legacy)!.mode).toBe("branch");
    expect(after.store.listRuns(s.id).map(r => r.mode)).toEqual(["branch", "subagent", "subagent"]); // the new run is a batch's two tasks
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
test("21a/116: single-item write keeps supports and reason; an archive in a curate file inherits its parent's evidence", () => {
  const { create, write, path } = memoryWriter();
  const operation = toolDefinitions.find(t => t.name === "memory")!.parameters.properties as Record<string, any>;
  expect(operation.op.enum).toEqual(["create", "update", "archive"]);
  expect(operation).not.toHaveProperty("because");
  expect(operation.reason).toEqual({ type: "string", minLength: 1 });
  expect(operation).not.toHaveProperty("skipped");
  const factSchema = toolDefinitions.find(t => t.name === "note")!.parameters.properties as Record<string, any>;
  expect(factSchema).not.toHaveProperty("reason"); // facts gain no commit metadata and the surface stays four tools
  expect(write([create]).committed).toHaveLength(1);
  const archived = curateWrite(path, [{ op: "archive", kind: "budget", id: tagged(1, 1), reason: "Withdrawn by the user." }]);
  const archiveCommit = archived.committed[0].commit as number;
  expect(memory.store.getKnowledgeRevision(1, archiveCommit)?.supports).toEqual([1]); // no longer cleared
});

// Ticket 21 "Applicability" and "Branch scenario", scenario 5: one citation rule for every commit. An archive block takes no evidence of
// its own (it keeps its parent's), so the Dreamer's citing commits are its update, merge, split and create blocks.
test("64b/21a: a curate update's supports face the same session/project/global table as any other commit", () => {
  const { c, peer, content, publish } = commitPaths();
  const same = peer(), outside = peer(memory.store.createProject({ name: "outside 21a", declaredBy: "mark" }).id);
  for (const scope of ["session", "project", "global"] as const) for (const origin of [c, same, outside]) {
    publish(c);
    const created = c.writeCommitted([{ op: "create", title: "Fixture title", topics: [], ...content(c.fact), scope, reason: "Admitted for the scope check." }])[0]!;
    const allowed = origin === c || scope === "global" || (scope === "project" && origin === same);
    const checked = checkWorkspace(memory.store, { kind: "curate", sessionId: c.sessionId, path: { sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId },
      file: { name: "curate.md", text: workspaceBlock(`update ${history(created.knowledgeId, created.commit)}`, { reason: `Retired on ${origin.branch} evidence.`, supports: origin.fact }, "Changed body.") } });
    expect(checked.problems.length === 0, `${scope} from ${origin.branch}: ${checked.problems.join("; ")}`).toBe(allowed);
  }
  // Reason prose cannot adopt a foreign fact.
  const created = c.writeCommitted([{ op: "create", title: "Fixture title", topics: [], ...content(c.fact), scope: "session", reason: "Admitted for the reason-bypass check." }])[0]!;
  const prose = checkWorkspace(memory.store, { kind: "curate", sessionId: c.sessionId, path: { sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId },
    file: { name: "curate.md", text: workspaceBlock(`update ${history(created.knowledgeId, created.commit)}`, { reason: `The user adopted ${outside.fact} on this path.` }, "Changed body.") } });
  expect(prose.problems).toEqual([]); // it inherits the parent's evidence; the fact named in the reason is not a citation
  const applied = applyWorkspace(memory.store, { kind: "curate", sessionId: c.sessionId, path: { sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId },
    file: { name: "curate.md", text: workspaceBlock(`update ${history(created.knowledgeId, created.commit)}`, { reason: `The user adopted ${outside.fact} on this path.` }, "Changed body.") } });
  if (!applied.ok) throw new Error(applied.problems.join("\n"));
  expect(memory.store.currentCommit(created.knowledgeId, c)[0]!.supports).toEqual([Number(c.fact.slice(1))]);
});

// ---- 21b 2026-09-08: topics classify revisions and change nothing else ----

// Ticket 21 "History and scope", scenario 14: a shared label is not a shared status.
test("64b/21b: a shared label changes no applicability and follows the owner's published foreground", async () => {
  const { c, d, peer, content, tips, publish } = commitPaths();
  const third = peer();
  const label = (who: typeof c, text: string) => {
    publish(who);
    return curateWrite(who, [{ op: "update", id: tagged(1, 1), topics: ["tiling"], reason: "Substantive correction, filed under its subject.", ...content(who.fact, text) }]);
  };
  const cCommit = label(c, "C version").committed[0].commit as number;
  const dCommit = label(d, "D version").committed[0].commit as number;
  expect(tips(third)).toEqual([dCommit]);
  const groups = (who: { sessionId: number; headTurnId: number; branch: string }) => memory.topicGroups(who.sessionId, who.headTurnId, who.branch);
  expect(groups(third).topics).toEqual([{ topic: "tiling", commits: [{ knowledgeId: 1, commit: dCommit }] }]);
  expect(groups(c).topics).toEqual(groups(third).topics);
  publish(c);
  expect(groups(third).topics).toEqual([{ topic: "tiling", commits: [{ knowledgeId: 1, commit: cCommit }] }]);
  // An archive inherits the label (and the evidence of its parent, so it applies where the parent did); explicit search keeps its
  // history labels, automatic material drops it.
  const archiveCommit = curateWrite(c, [{ op: "archive", kind: "budget", id: tagged(1, cCommit), reason: "Retired on this path." }]).committed[0].commit as number;
  const archiveRevision = memory.store.getKnowledgeRevision(1, archiveCommit)!;
  expect(archiveRevision.op).toBe("archive");
  expect(archiveRevision.topics).toEqual(["tiling"]);
  const hits = (memory.search("tiling", "knowledge", { topk: 100 }) as string).split("\n").filter(l => l.startsWith("[K"));
  // The archive inherits the label, so it is found by it, and every version is marked against the latest one.
  expect(hits.find(l => l.startsWith(`[${history(1, archiveCommit)}]`))).toContain("(archived)");
  expect(memory.search("C version", "knowledge")).toContain("(superseded)");
  expect(tips(c)).toEqual([archiveCommit]);
  expect(groups(c).topics).toEqual([]);
  expect(memory.inject(c)).not.toContain(`[${tagged(1, archiveCommit)}]`);
  // Sharing a topic neither revives D nor lets the archive reach D's path.
  publish(d);
  expect(tips(d)).toEqual([dCommit]);
  expect(groups(d).topics).toEqual([{ topic: "tiling", commits: [{ knowledgeId: 1, commit: dCommit }] }]);
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
  expect(schema.reason).toEqual({ type: "string", minLength: 1 });
  // A label is written by the ordinary manual call, with no model call and no independent catalog block.
  expect(write([{ ...create, topics: ["packaging"] }]).committed).toHaveLength(1);
  // Topics stay inherited on archives; the archive block requires an explicit kind and takes no topics.
  const archiveFile = (fields: Record<string, string>) => checkWorkspace(memory.store, { kind: "curate", sessionId: s.id,
    path: { sessionId: s.id, branch: "main", headTurnId: 1 }, file: { name: "curate.md", text: workspaceBlock("archive K1@v1", fields, "No longer holds.") } }).problems.join("\n");
  expect(archiveFile({ reason: "r" })).toContain("missing required field `kind`");
  expect(archiveFile({ kind: "invalid", reason: "r", topics: "packaging" })).toContain("field `topics` is not allowed here");
  const injected = memory.inject(s.id);
  expect(injected).toContain('· topics: ["packaging"]');
  expect(injected.match(/topics:/g)).toHaveLength(1); // the label rides its own knowledge line, nothing more
  expect(injected).not.toContain("<topics>");
  expect(calls).toEqual([]); // storing a label calls no model
});

// 26a's “both tools must be called” signal is superseded on 2026-10-22 (proposal noting-in-two-tasks): an explicit `## none` in
// each file says that there is nothing to write. A missing or empty file is the silence it used to be.
test("2026-10-22: `## none` replaces calling both tools; silence and one file alone are not zero-fact success", async () => {
  const { s, t } = session(); memory.close();
  const script = [{ files: { facts: "", knowledge: "" } }, { files: { facts: "## none\n", knowledge: "" } }, {}];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), scriptedNoter(() => memory, script).agent);
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  // R20's failure mode: a run that submits nothing must not advance its selected entries.
  const silent = await memory.noting(target);
  expect(silent).toMatchObject({ outcome: "failure" });
  expect(silent.outcome === "failure" && silent.problems.join("\n")).toContain("empty file: write `## none`");
  expect(memory.store.getRun(1)!.outcome).toBe("failure"); // the existing outcome value; no new one, no schema change
  expect(hydrate(memory.store.listSourceEntries(s.id), memory.store).some(e => memory.store.entryNoted(e.id))).toBe(false);
  // The prompt says what the runner enforces.
  const prompt = loadPrompt("noting.md");
  expect(prompt).toContain("`## none`");
  expect(prompt).not.toContain("note({})");
  // One file is insufficient; both explicit `## none` complete the batch.
  const one = await memory.noting(target);
  expect(one).toMatchObject({ outcome: "failure" });
  expect(hydrate(memory.store.listSourceEntries(s.id), memory.store).some(e => memory.store.entryNoted(e.id))).toBe(false);
  expect(await memory.noting(target)).toMatchObject({ outcome: "success", facts: [] });
  expect(hydrate(memory.store.sourcePath(s.id, "main", t.id), memory.store).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending_deliveries'").all()).toEqual([]);
});

// Maintainer, 2026-10-22: 「算，每次N未正常结束，无论中断在什么任务，都记为一次N失败」. One Noter run is one failure toward the
// three-failure switch-off, whichever task it stopped in; cancellation still counts nothing.
test("2026-10-22: a Noter run that does not finish normally is one failure, whichever task", async () => {
  const { s, t } = session(); memory.close();
  const script = [
    { outcome: "failure" as const, output: "task 1 stopped", noteInput: [] },                                   // run 1: task 1 fails
    { noteInput: [], verifyResult: { outcome: "failure" as const, output: "task 2 stopped" } },                  // run 2: task 1 passes, task 2 fails
    { verifyResult: { outcome: "failure" as const, output: "resumed task 2 stopped" } },                         // run 3: the resumed task 2 fails
  ];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), scriptedNoter(() => memory, script).agent);
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const count = () => memory.store.taskFailures(s.id).find(row => row.phase === "noting")?.count ?? 0;
  expect((await memory.noting(target)).outcome).toBe("failure");
  expect(count()).toBe(1);
  expect(memory.store.handoff(s.id, "noting")).toBeNull();
  expect((await memory.noting(target)).outcome).toBe("failure");
  expect(count()).toBe(2); // task 1 passed and task 2 failed: one failure, not two
  expect(memory.store.handoff(s.id, "noting")).not.toBeNull();
  const resumed = await memory.noting(target);
  expect(resumed.outcome).toBe("failure");
  expect(memory.store.listRuns(s.id).filter(run => run.kind === "noting" && JSON.parse(run.response!).task === "write")).toHaveLength(2); // the resume ran no task 1
  expect(count()).toBe(3);
  expect(memory.store.enabled(s.id)).toBe(false);
  expect("automaticOff" in resumed && resumed.automaticOff).toBeTruthy();
});

// Maintainer, 2026-10-21/22, proposal "noting in two tasks" (ticket 144): the Noter writes, then an independent request verifies.
const noterFact = (turnId: number, text = "用 pnpm，不要 npm") => ({ title: "Package manager", sources: `[T${turnId}#E1] ${text}` });
const noterOnFile = (script: Parameters<typeof scriptedNoter>[1]) => {
  const file = join(directory, "test.sqlite"); memory.close();
  const noter = scriptedNoter(() => memory, script);
  memory = sourceSeededMemory(file, noter.agent);
  return { file, noter };
};

test("2026-10-22: the Noter writes, then an independent verify runs, and nothing is published before verify passes", async () => {
  const { s, t } = session(); memory.close();
  const file = join(directory, "test.sqlite");
  const during: unknown[] = [];
  const noter = scriptedNoter(() => memory, [{ noteInput: [noterFact(t.id)], verify: () => {
    const other = new Store(file);
    try { during.push(other.listSessionFacts(s.id).length, other.pendingEntries(s.id, "main", t.id).length); } finally { other.close(); }
  } }]);
  memory = sourceSeededMemory(file, noter.agent);
  const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  expect(result.outcome).toBe("success");
  expect(noter.inputs.map(input => input.task)).toEqual(["write", "verify"]); // two requests, in this order
  expect(during[0]).toBe(0);                       // nothing published while task 2 ran
  expect(during[1]).toBeGreaterThan(0);            // and the batch was still pending
  expect(memory.store.listSessionFacts(s.id)).toHaveLength(1);
  expect(memory.pendingEntries(s.id, "main", t.id)).toEqual([]);
});

test("2026-10-22: a malformed file is prompted once, and a second failure keeps nothing", async () => {
  const { s, t } = session();
  const { noter } = noterOnFile([{ noteInput: [noterFact(t.id)], files: { knowledge: "not a block\n" } }]);
  const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  expect(result.outcome).toBe("failure");
  expect(noter.stopMessages).toHaveLength(1);                       // one prompt, not a loop
  expect(noter.inputs).toHaveLength(1);                             // task 2 never started
  expect(memory.store.handoff(s.id, "noting")).toBeNull();          // task 1's files are not kept
  expect(memory.store.listSessionFacts(s.id)).toEqual([]);
  expect(memory.pendingEntries(s.id, "main", t.id).length).toBeGreaterThan(0);
});

test("2026-10-22: a verify failure keeps task 1's files and the next trigger resumes with verify on the same batch", async () => {
  const { s, t } = session();
  const { noter } = noterOnFile([{ noteInput: [noterFact(t.id)], verifyResult: { outcome: "failure", output: "verify stopped" } }, {}]);
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  expect((await memory.noting(target)).outcome).toBe("failure");
  expect(memory.store.listSessionFacts(s.id)).toEqual([]);
  expect(memory.store.handoff(s.id, "noting")).not.toBeNull();
  expect((await memory.noting(target)).outcome).toBe("success");
  expect(noter.inputs.map(input => input.task)).toEqual(["write", "verify", "verify"]); // the retry ran no second write
  expect(memory.store.listSessionFacts(s.id).map(f => f.text)).toEqual(["用 pnpm，不要 npm"]);
  expect(memory.store.handoff(s.id, "noting")).toBeNull();
});

test("2026-10-22: a file holds one record per item, and an update whose base moved is published as a create", async () => {
  const { s, t } = session();
  const path = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const seeded = seedKnowledge(memory.store, path, "session", "constraint", [seedFact(memory, path, "Seed", [{ entry: memory.store.sourcePath(s.id, "main", t.id)[0] as never, text: "seed" }]).id], "Old rule");
  const tag = `K${seeded.knowledgeId}#${memory.store.versionTag(seeded.knowledgeId, seeded.commit)}`;
  const update = (text: string) => ({ op: "update", id: tag, text, supports: ["$1"], reason: "r" });
  const doubled = noterOnFile([{ noteInput: [noterFact(t.id)], memoryInput: [update("one"), update("two")] }]);
  const refused = await memory.noting(path);
  expect(refused.outcome).toBe("failure");
  expect(refused.outcome === "failure" && refused.problems.join("\n")).toContain("already has a record");
  expect(memory.store.currentKnowledge(path)[0]!.revision.text).toBe("Old rule");
  doubled.noter.script.push({ noteInput: [noterFact(t.id)], memoryInput: update("Requested"), verify: () => {
    const other = new Store(doubled.file);
    try {
      const base = other.currentKnowledge(path)[0]!;
      other.commitConsolidationRun({ path, run: { kind: "manual", sessionId: s.id, branch: "main", createdAt: time }, operations: [{ op: "update", knowledgeId: base.knowledge.id,
        baseCommit: base.revision.id, title: "Seed", text: "Concurrent", category: "constraint", scope: "session", topics: [], supports: base.revision.supports, reason: "other", createdAt: time }] });
    } finally { other.close(); }
  } });
  const converted = await memory.noting(path);
  expect(converted.outcome).toBe("success");
  const texts = memory.store.currentKnowledge(path).map(item => item.revision.text);
  expect(texts).toContain("Concurrent");
  expect(texts.some(text => text.includes("Requested") && text.includes(tag))).toBe(true); // a create that names its intended target
});

test("2026-10-22: `check` is callable at any time and returns the task, the problems and every length", async () => {
  const { s, t } = session();
  const reports: string[] = [];
  noterOnFile([{ noteInput: [noterFact(t.id)], verify: (_files, input) => { reports.push(String(input.tools.find(tool => tool.name === "check")!.execute({}))); } }]);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  expect(reports[0]).toContain("Task: verify");
  expect(reports[0]).toContain("Problems: none");
  expect(reports[0]).toMatch(/facts\.md block 1 `## fact f1`: title \d+\/20, body \d+\/200/);
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
    return tokens(instructions) + tokens(JSON.stringify(pricedToolDefinitions(notingToolDefinitions, canonicalToolNames))) + tokens(frozen.prepared!.text);
  };
  const capacity = { inputTokens: priced([e1.id]) };
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
  const dreamer = scriptedDreamer({ instead: { curate: async input => {
    input.acknowledgeRequest();
    enteredDreaming();
    await heldDreaming;
    await writeCurateBatch(input, "## none\n");
    return ok([]);
  } } });
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    if ((raw as { kind: string }).kind === "dreaming") return dreamer.agent(raw);
    const input = raw as NotingAgentInput;
    await heldNoting; // still in flight when the signal fires
    submissions.push(input.tools.find(tool => tool.name === "check")!.execute({}));
    return ok([]);
  });
  memory.config.dreaming.triggerTokens = 1;
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const fact = JSON.parse(memory.tools({ kind: "manual", ...target, currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ title: "Independent evidence", sources: `[T${t.id}#E1] D's independent evidence` })).factIds[0] as number;
  const trigger = seedKnowledge(memory.store, target, "project", "constraint", [fact], "Independent rule");
  const controller = new AbortController();
  const cancelled = memory.noting({ ...target, signal: controller.signal });
  const untouched = memory.dream(target);
  await dreamingStarted;
  expect(memory.store.getClaim(s.id, "noting")).not.toBeNull();
  const dreamClaim = memory.store.getClaim(s.id, "dreaming");
  expect(dreamClaim).not.toBeNull();

  controller.abort();
  releaseNoting();
  const result = await cancelled;
  // N's late write is rejected while the independent D run keeps its claim.
  expect(String(submissions[0])).toContain("rejected: run has finished");
  expect(memory.store.listSessionFacts(s.id).map(f => f.text)).toEqual(["D's independent evidence"]);
  expect(result.outcome).not.toBe("success");
  expect(memory.store.getClaim(s.id, "noting")).toBeNull();
  expect(memory.store.getClaim(s.id, "dreaming")).toEqual(dreamClaim);
  releaseDreaming();
  expect((await untouched).outcome).toBe("success");
  expect(memory.store.getClaim(s.id, "dreaming")).toBeNull();
  expect(memory.store.db.prepare("SELECT revision_id FROM knowledge_processed").all().map(row => Number(row.revision_id))).toContain(trigger.commit);
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
  const cCommit = (await edit(c, "C version")).committed[0].commit as number;
  const dCommit = (await edit(d, "D version")).committed[0].commit as number;
  publish(c);
  const archived = curateWrite(c, [{ op: "archive", kind: "budget", id: tagged(1, cCommit), reason: "Withdraw C only." }]);
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
  // 2026-10-22 files: a merge block carries the complete merged body, so the tool protocol's "a merge may omit text" no longer exists.
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
  for (const file of [...STAGE_PROMPTS, "classifying.md"] as const) {
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
      if (["note", "memory", "check", "create", "update", "merge", "split", "archive", "op", "id", "skip", "skipped", "operations", "layer", "code", "full", "ok", "absorb", "edits", "source", "slot", "drop", "budget", "fact", "none"].includes(word)) continue; // stage tools, operation fields and the workspace file blocks, defined in the stage's own sections
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

// 133 supersedes 73's single shared allowance for episodic borrowing; 144 makes the temporary allowance the only one.
test("133: pending Raw uses only the temporary allowance; unused Knowledge allowance cannot hold it", () => {
  const project = memory.store.createProject({ name: "temporary", declaredBy: "marker" });
  const s = memory.store.createSession({ host: "fake", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
  const turn = memory.store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: time, userPrompt: "pending ".repeat(100) });
  Object.assign(memory.config.compaction, { rawTokens: 30, temporaryTokens: 1 });
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

// The rule is enforced where every merge passes: a workspace file reaches it (the memory tool refuses merges outright).
test("2026-10-21: merged items share one category and scope, through a workspace file", () => {
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

// ---- Ticket 144, stage 4: the Dreamer's superseding rulings (spec 10.4). Each test names its ruling, with the maintainer's words
// where the proposal records them, and calls the scenario through the Dreamer fixture the behaviour tests use. ----------------------

const dreamers: api.TraceMemory[] = [];
afterEach(() => { for (const memory of dreamers.splice(0)) memory.close(); });
const dreamerFixture = (script: DreamerScript = {}) => makeDreamerFixture(dreamers, script);
const taskNames = (f: ReturnType<typeof dreamerFixture>) => f.dreamer.inputs.map(input => input.task);
const executionReasons = (f: ReturnType<typeof dreamerFixture>) => (f.store.db.prepare("SELECT reason FROM task_executions ORDER BY rowid").all() as { reason: string }[]).map(row => row.reason);

test("2026-10-22, 144: 'D的触发阈值可以看N变更过的知识 的token总数（不是diff）' — the Dreamer is due when the knowledge the Noter changed since its last pass weighs 10,000, each item once at its current title and body; a manual write does not count", () => {
  expect(DEFAULT_CONFIG.dreaming.triggerTokens).toBe(10_000);
  const f = dreamerFixture();
  const manual = knowledgeBatch(f.store, f.path, [{ scope: "project", category: "constraint", supports: [f.existingFact("Manual support").id], title: "Manual rule", text: "A hand-written rule" }],
    { kind: "manual", createdAt: "now" });
  expect(manual.committed).toHaveLength(1);
  const rule = f.item("A Noter rule");
  const weight = f.store.noterChangedTokens(f.path);
  expect(weight).toBeGreaterThan(0);
  expect(f.store.noterChangedItems(f.path)).toBe(1); // only the Noter's item counts
  f.memory.config.dreaming.triggerTokens = weight + 1;
  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: false });
  f.memory.config.dreaming.triggerTokens = weight;
  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: true });
  // A later edit of the same item changes its weight to the new body; it is not counted twice and not as a diff.
  updateKnowledge(f.store, f.path, rule.knowledgeId, rule.commit, "A Noter rule, rewritten to be somewhat longer than before", rule.supports);
  expect(f.store.noterChangedItems(f.path)).toBe(1);
});

test("2026-10-21, 144: '整理 → 核查 → 评级；先不轮换' — one run does curate, then verify, then classify, each category in turn within that one run", async () => {
  const f = dreamerFixture();
  const rule = f.item("Use pnpm everywhere", { category: "constraint" });
  f.item("The lockfile is committed", { category: "reference" });
  f.dreamer.script.curate!.constraint = workspaceBlock(`update ${rule.ref}`, { reason: "tidy" }, "Use pnpm everywhere, tidied");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(taskNames(f)).toEqual(["curate", "verify", "classify"]); // one curate conversation visited both categories; classify came last
  expect(f.dreamer.reports[0]).toContain("batch 1 of 2");
  const covered = f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_processed").get()!.n;
  expect(Number(covered)).toBeGreaterThanOrEqual(2); // no rotation: both categories were covered by this run
});

test("2026-10-22, 144: '如果下一个任务失败，上一个任务的输出仍然保留，等待下次触发接续失败的任务' and 「重试沿用MC」 — curate's output stays, a transient failure retries three more times, then the task waits for the next 10k of Noter changes and resumes there", async () => {
  const f = dreamerFixture();
  const rule = f.item("Use pnpm everywhere", { category: "constraint" });
  f.dreamer.script.curate!.constraint = workspaceBlock(`update ${rule.ref}`, { reason: "tidy" }, "Use pnpm everywhere, tidied");
  f.dreamer.script.instead = { verify: () => ({ outcome: "failure", output: "429 rate limit" }) as never };
  for (let attempt = 1; attempt <= 4; attempt++) expect(await f.dream(), `attempt ${attempt}`).toMatchObject({ outcome: "failure", failure: { task: "verify", transient: true } });
  expect(executionReasons(f)).toEqual(["verify: provider error, retry 1/3", "verify: provider error, retry 2/3", "verify: provider error, retry 3/3", "verify: provider error, waits for threshold"]);
  expect(f.store.currentCommit(rule.knowledgeId, f.path)[0]!.text).toBe("Use pnpm everywhere, tidied"); // curate's output is kept
  expect(await f.dream()).toMatchObject({ outcome: "empty" }); // waiting: nothing newer
  f.item("A later Noter item", { category: "reference" });
  delete f.dreamer.script.instead;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(taskNames(f).filter(task => task === "curate")).toHaveLength(1); // the resume continued at verify; curate did not run again
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
});

test("2026-10-21, 144: 「就参考MC的做法」 (failure handling) replaces 2026-10-05 「仍然遵守失败三次关掉，不需要例外」 for the Dreamer — a Dreamer failure never switches memory off", async () => {
  const f = dreamerFixture();
  for (let cycle = 1; cycle <= 4; cycle++) {
    f.item(`Rule ${cycle}`, { category: "constraint" });
    f.next(async () => ({ outcome: "failure", output: "bad request" })); // a permanent failure: one attempt, then it waits
    expect(await f.dream(), `failure ${cycle}`).toMatchObject({ outcome: "failure", failure: { transient: false } });
    expect(f.store.enabled(f.session.id)).toBe(true);
  }
  expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM task_executions WHERE outcome = 'failure'").get()!.n).toBe(4); // more than the old three
});

test("2026-10-21, 144: '超过 100 条后按 MC 的方法做，只评变更过的部分、按每批 100 条分批，并附加 30 条已评过的作为参照' — up to 100 items, one pass; beyond, passes of 100, and a later run scores only what changed beside 30 scored anchors", async () => {
  const f = dreamerFixture();
  const items = Array.from({ length: 105 }, (_, i) => f.item(`Rule number ${i}`, { category: "reference", title: `Rule ${i}` }));
  const classify = () => f.dreamer.inputs.filter(input => input.task === "classify");
  const shown = (text: string) => (text.match(/^K\d+ \[/gm) ?? []).length;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(classify().map(input => shown(input.text))).toEqual([100, 5]);
  updateKnowledge(f.store, f.path, items[0]!.knowledgeId, items[0]!.commit, "Rule number 0, changed", items[0]!.supports, "reference");
  f.item("A new rule", { category: "reference", title: "New rule" });
  f.dreamer.inputs.length = 0;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const text = classify()[0]!.text, cut = text.indexOf("Items to score");
  expect(classify()).toHaveLength(1);
  expect([shown(text.slice(0, cut)), shown(text.slice(cut))]).toEqual([30, 2]); // 30 scored anchors, then the changed and the new item only
});

test("2026-10-22, 144: '所有交付都是文件，包括评级任务，这样方便agent自己check自查' — curate, verify and classify each deliver one file the model checks with `check`; no task is given a memory-writing tool", async () => {
  const f = dreamerFixture({ classify: (_pass, ids) => ids.map(id => `K${id} 77`).join("\n") + "\n" });
  const rule = f.item("Use pnpm everywhere", { category: "constraint" });
  f.dreamer.script.curate!.constraint = workspaceBlock(`update ${rule.ref}`, { reason: "tidy" }, "Use pnpm everywhere, tidied");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(taskNames(f)).toEqual(["curate", "verify", "classify"]);
  for (const input of f.dreamer.inputs) {
    expect(input.tools.map(tool => tool.name), input.task).toContain("check");
    expect(input.tools.map(tool => tool.name), input.task).not.toContain("memory");
    expect(input.workspace.write, input.task).toHaveLength(1); // the one file the task may write
  }
  const score = f.store.db.prepare("SELECT score FROM knowledge WHERE id = ?").get(rule.knowledgeId)!.score;
  expect(score).toBe(77); // classify's scores came from its file
});
