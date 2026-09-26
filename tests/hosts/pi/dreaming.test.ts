import { expect, test, vi } from "vitest";
import type { JsonObject } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { host, reply, type Reply } from "./test-host.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { readHandle } from "../../read-handle-fixture.ts";

const workflowHeadings = (JSON.parse(readFileSync(new URL("../../fixtures/dreaming-workflow.json", import.meta.url), "utf8")) as { promptOrder: string[] }).promptOrder;
const call = (id: string, name: string, args: unknown): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args as JsonObject }] });
// 59: a scripted Dreamer accounts for the supplied handles it leaves untouched with one explicit skip batch.
const skip = (...handles: string[]): Reply => call("skip", "memory", { operations: [], skipped: handles.map(knowledge => ({ knowledge, because: "reviewed; no operation needed" })) });
async function seeded(config: Record<string, unknown> = {}, text = "Keep the user constraint") {
  const h = host({ "noting.triggerTokens": 1000000, "consolidation.triggerTokens": 1000000, "dreaming.triggerTokens": 1, ...config });
  await h.emit("session_start"); await h.turn();
  const store = h.memory.store;
  const f = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, facts: [{ turnId: 1, source: ["T1#user"], actor: "user", category: "decision", text, createdAt: "now" }] });
  if (!f.ok) throw Error(f.problems.join());
  const content = { text, category: "constraint" as const, scope: "project" as const, supports: [f.facts[0]!.id], topics: [], reason: "evidence", createdAt: "now" };
  const c = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, operations: [{ op: "create", handle: "$1", author: "test", ...content }] });
  if (!c.ok) throw Error(c.problems.join());
  const path = store.knowledgePath(1);
  const created = c.committed[0]!;
  const item = { ...created, tagged: readHandle(h.memory.tools({ kind: "manual", sessionId: 1,
    branch: "main", currentTurnId: path.headTurnId! }), `K${created.knowledgeId}`) };
  const renderedTokens = store.pendingVersions(`project:${store.getSession(1)!.projectId}`, path)
    .find(value => value.revisionId === item.commit)!.tokens;
  const pool = `project:${store.getSession(1)!.projectId}`;
  h.memory.setKnowledgeBudget("project", renderedTokens * 2);
  expect(store.duePools(path, 1).map(value => value.pool)).toContain(pool);
  return { h, store, item, content, pool };
}
const terminal = async (h: ReturnType<typeof host>) => vi.waitFor(() => {
  const run = h.memory.store.listRuns(1).find(r => r.kind === "dreaming" && JSON.parse(r.response ?? "{}").check);
  expect(run).toBeTruthy(); return run!;
}, { timeout: 5000 });
const processedIn = (store: Store, pool: string, revisionId: number) => !!store.db.prepare(
  "SELECT 1 FROM knowledge_processed WHERE pool = ? AND revision_id = ?").get(pool, revisionId);

test("85: Pi does not launch Dreamer for an over-budget pool below its pending trigger", async () => {
  const { h, store, content, pool } = await seeded({ "dreaming.triggerTokens": 5000 }, "Durable constraint ".repeat(100));
  const path = { sessionId: 1, branch: "main", headTurnId: store.knowledgePath(1, "main").headTurnId! };
  const claim = store.acquireClaim(path, "dreaming", "fixture")!;
  const range = store.retainKnowledgePoolRange(path, pool, claim);
  const executionId = store.beginExecution({ sessionId: 1, phase: "dreaming", head: range.anchor, origin: range.origin });
  const run = store.bindDreamingRun({ kind: "dreaming", sessionId: 1, branch: path.branch,
    dreamingRangeId: range.id, executionId, claim, createdAt: "now" });
  store.completeKnowledgePoolRange(run, "success", range.eventIds);
  store.releaseClaim(claim);
  const priorSize = store.poolSizes(path).find(value => value.pool === pool)!.tokens;
  const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, operations: [
    { op: "create", handle: "$later", author: "test", ...content, text: "Small new rule" }] });
  if (!created.ok) throw Error(created.problems.join());
  h.memory.setKnowledgeBudget("project", priorSize - 1);
  expect(store.pendingPoolWeight(pool, path)).toBeLessThan(priorSize - 1);
  expect(store.poolSizes(path).find(value => value.pool === pool)!.tokens).toBeGreaterThan(priorSize - 1);
  expect(h.memory.taskEligibility("dreaming", path).due).toBe(false);
  const before = store.listRuns(1).filter(value => value.kind === "dreaming").length;
  await h.turn(); await h.drain();
  const after = store.listRuns(1).filter(value => value.kind === "dreaming");
  expect(after.length).toBe(before);
});

test("Dreamer pre-request capacity failure names its own phase and retains its work", async () => {
  const { h, store, item, pool } = await seeded();
  const measure = vi.spyOn(AgentSession.prototype, "getContextUsage").mockReturnValue({ tokens: 200_000, contextWindow: 200_000, percent: 100 });
  try {
    await h.turn(); await h.drain();
    const runs = store.listRuns(1).filter(r => r.kind === "dreaming");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("failure");
    expect(runs[0]!.response).toContain("Dreamer capacity: the child's context");
    expect(runs[0]!.response).not.toContain("Consolidation capacity");
    expect(h.requests).toEqual([]);
    expect(processedIn(store, pool, item.commit)).toBe(false);
    expect(store.pendingVersions(pool, store.knowledgePath(1)).map(value => value.revisionId)).toContain(item.commit);
    expect(store.getClaim(1, "dreaming")).toBeNull();
    expect(store.taskFailures(1)).toMatchObject([{ phase: "dreaming", count: 1 }]);
  } finally { measure.mockRestore(); await h.dispose(); }
});

test("32d native host: entry completion starts a fresh Dreamer and records its frozen pool range", async () => {
  const { h, store, item, pool } = await seeded({ "dreaming.model": "fake/test-thinking", "dreaming.thinking": "high", compaction: { enabled: true } });
  try {
    let requests = 0;
    h.provider(async c => { expect(c.systemPrompt).toContain("# Dreamer"); expect(c.tools?.map(t => t.name)).toEqual(["trace", "search", "check", "memory"]);
      return ++requests === 1 ? skip(`K${item.knowledgeId}@v1`) : reply("Reviewed without changes"); }, { autoStop: false });
    await h.turn();
    const run = await terminal(h);
    expect(run.outcome).toBe("success"); expect(run.mode).toBe("subagent"); expect(run.model).toBe("fake/test-thinking");
    expect(JSON.parse(run.response!).thinking).toEqual({ requested: "high", effective: "high" });
    expect(run.origin).not.toBeNull();
    expect(run.origin!.sessionId).toBe(1);
    const exactTrigger = run.origin!.entryIds.at(-1)!;
    const laterHead = store.sourceHeadEntryId(1, "main", store.knowledgePath(1).headTurnId!)!;
    expect(exactTrigger).toBeLessThan(laterHead);
    expect(store.getSourceEntry(exactTrigger)!.turnId).toBe(store.getSourceEntry(laterHead)!.turnId);
    expect(run.origin!.entryIds).not.toContain(laterHead);
    const execution = store.db.prepare("SELECT e.origin_session_id, e.origin_entry_ids FROM task_executions e JOIN execution_runs x ON x.execution_id = e.id WHERE x.run_id = ?").get(run.id)!;
    expect({ sessionId: execution.origin_session_id, entryIds: JSON.parse(String(execution.origin_entry_ids)) }).toEqual(run.origin);
    expect(processedIn(store, pool, item.commit)).toBe(true);
    expect(JSON.parse(readFileSync(join(h.dir, "agent", "settings.json"), "utf8")).compaction.enabled).toBe(true);
    expect(h.requests).toHaveLength(2);
  } finally { await h.dispose(); }
});

test("32d native host: pass ends after all intermediate tool turns; first memory commits live", async () => {
  const { h, store, item, pool } = await seeded();
  try {
    let requests = 0;
    h.provider(async () => {
      requests++;
      if (requests === 1) return call("archive", "memory", { operations: [{ op: "archive", id: item.tagged, supports: [], reason: "Retire redundant active rule; history preserved" }], skipped: [] });
      expect(store.currentKnowledge(store.knowledgePath(1))).toEqual([]);
      expect(processedIn(store, pool, store.listKnowledgeRevisions().at(-1)!.id)).toBe(false);
      if (requests === 2) return call("read", "trace", { address: `K${item.knowledgeId}` });
      return reply("Done");
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h);
    expect(run.outcome).toBe("success"); expect(requests).toBe(3);
    expect(JSON.parse(run.response!).rounds).toBe(2);
    expect(processedIn(store, pool, store.listKnowledgeRevisions().at(-1)!.id)).toBe(true);
  } finally { await h.dispose(); }
});

test("64c native host: a fitting residual ends successfully without a repair round", async () => {
  const { h, store, item, pool } = await seeded({}, "budget ".repeat(6000));
  try {
    // 6k changed body fits admission; 4.5k processed outside the family makes the pool over-cap.
    let requests = 0, tools = 0, transient = false;
    let initialSystem: string | undefined;
    const repairSystems: (string | undefined)[] = [], repairToolSets: (string[] | undefined)[] = [];
    let initialTools: string[] | undefined, repairHistory: { role: string; content?: unknown }[] | undefined;
    h.provider(async conversation => {
      requests++;
      const isRepair = conversation.messages.some(m => JSON.stringify(m).includes("System-generated Dreamer completion check"));
      if (requests === 1) {
        initialSystem = conversation.systemPrompt;
        initialTools = conversation.tools?.map(tool => tool.name);
      }
      if (isRepair) {
        repairSystems.push(conversation.systemPrompt);
        repairToolSets.push(conversation.tools?.map(tool => tool.name));
        repairHistory ??= conversation.messages;
      }
      if (tools === 24 && !conversation.messages.some(m => JSON.stringify(m).includes("One repair,"))) return reply("Done first pass");
      if (tools === 26 && !transient) { transient = true; return { ...reply(""), stopReason: "error", errorMessage: "rate limit exceeded" }; }
      tools++;
      return call(`read-${tools}`, "trace", { address: `K${item.knowledgeId}` });
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h), audit = JSON.parse(run.response!);
    expect(run.outcome).toBe("success"); expect(tools).toBe(24); expect(audit.rounds).toBe(24);
    expect(audit.repaired).toBeUndefined(); expect(audit.retries).toBeUndefined();
    expect(audit.problems).toEqual([]);
    expect(processedIn(store, pool, item.commit)).toBe(false); // Reads alone do not deliberate or consume the input.
    expect(store.pendingVersions(pool, store.knowledgePath(1)).map(value => value.revisionId)).toContain(item.commit);
    const log = readFileSync(audit.nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const repairMessages = log.filter(e => JSON.stringify(e).includes("System-generated Dreamer completion check"));
    expect(initialSystem).toContain("# Dreamer — bounded knowledge maintenance");
    expect(initialSystem).toContain("Your tools are `trace`, `search`, `memory` and `check`.");
    let priorStage = -1;
    for (const heading of workflowHeadings.filter(value => !value.includes("Intensity, set by the failed check"))) {
      const position = initialSystem!.indexOf(heading);
      expect(position, `effective prompt missing ordered stage: ${heading}`).toBeGreaterThan(priorStage);
      priorStage = position;
    }
    expect(initialSystem).not.toContain("### Intensity, set by the failed check");
    expect(initialSystem).toContain("When over budget, protect first: user constraints and corrections, milestone results, errors and lessons, designs and their reasons, important deadlines, open matters.");
    expect(initialSystem).toContain("An archive states who fully carries the information, what evidence proves it expired, or what the budget trade actually lost.");
    expect(initialSystem).toContain("Old, short, rarely used or finished is by itself no proof of no value.");
    expect(initialSystem).not.toMatch(/global 4,000|project 10,000|session 1,000|applicable block within 15,000/);
    expect(repairSystems).toEqual([]); expect(repairToolSets).toEqual([]); expect(repairHistory).toBeUndefined();
    expect(repairMessages).toEqual([]);
    expect(initialTools).toEqual(["trace", "search", "check", "memory"]);
    expect(transient).toBe(false);
    expect(requests).toBe(25); // 24 tool rounds and one pass-ending text
  } finally { await h.dispose(); }
});

test("32d native host: Consolidator and Dreamer occupy independent seats", async () => {
  const { h, store, item } = await seeded({ "consolidation.triggerTokens": 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const phases = new Set<string>();
    let dreamerRequests = 0;
    h.provider(async c => { const dreamer = c.systemPrompt!.startsWith("# Dreamer"); phases.add(dreamer ? "D" : "C"); await held;
      return dreamer && ++dreamerRequests === 1 ? skip(`K${item.knowledgeId}@v1`) : reply("Done"); }, { autoStop: false });
    await h.turn();
    await vi.waitFor(() => expect([...phases].sort()).toEqual(["C", "D"]));
    expect(store.getClaim(1, "dreaming")).not.toBeNull(); expect(store.getClaim(1, "consolidation")).not.toBeNull();
    release(); await h.drain();
    expect((await terminal(h)).outcome).toBe("success");
  } finally { release(); await h.dispose(); }
});

test("64c native host: stop after a commit records the frozen range and own commit without retry", async () => {
  const { h, store, item, pool } = await seeded();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    let requests = 0;
    h.provider(async () => {
      if (++requests === 1) return call("update", "memory", { operations: [{ op: "update", id: item.tagged, text: "Keep the user's exact constraint", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "clarify without new facts" }], skipped: [] });
      await held; return reply("late reply");
    }, { autoStop: false });
    await h.turn();
    await vi.waitFor(() => expect(requests).toBe(2));
    await h.commands.get("trace").handler("stop", h.ctx);
    const cancelled = await terminal(h);
    expect(cancelled.outcome, cancelled.response ?? "").toBe("cancelled");
    expect(store.getClaim(1, "dreaming")).toBeNull();
    const changed = store.listCommitsByRun(cancelled.id)[0]!;
    expect(changed.parentId).toBe(item.commit);
    expect(processedIn(store, pool, item.commit)).toBe(false); // Superseded input needs no protection row.
    expect(processedIn(store, pool, changed.id)).toBe(true);
    expect(store.taskFailures(1).every(f => f.count === 0)).toBe(true);
    release();
    const requestsAfterStop = requests;
    await h.turn(); await h.drain();
    expect(store.listRuns(1).filter(r => r.kind === "dreaming")).toHaveLength(1);
    expect(requests).toBe(requestsAfterStop);
  } finally { release(); await h.dispose(); }
});

test("64c native host: provider overflow keeps the archive and consumes the failed run range without retry", async () => {
  const { h, store, item, pool } = await seeded({ compaction: { enabled: true }, retry: { enabled: false } });
  try {
    let requests = 0;
    h.provider(async () => ++requests === 1
      ? call("archive", "memory", { operations: [{ op: "archive", id: item.tagged, supports: [], reason: "Deliberate budget retirement" }], skipped: [] })
      : { ...reply(""), stopReason: "error", errorMessage: "maximum context length exceeded" }, { autoStop: false });
    await h.turn(); const run = await terminal(h);
    expect(run.outcome).toBe("failure"); expect(requests).toBe(2);
    const archive = store.listCommitsByRun(run.id)[0]!;
    expect(archive.op).toBe("archive");
    expect(processedIn(store, pool, item.commit)).toBe(false); // Superseded input needs no protection row.
    expect(processedIn(store, pool, archive.id)).toBe(true);
    const entries = readFileSync(JSON.parse(run.response!).nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries.some(e => e.type === "compaction")).toBe(false);
  } finally { await h.dispose(); }
});
