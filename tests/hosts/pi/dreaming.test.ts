import { expect, test, vi } from "vitest";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { host, reply, type Reply } from "./test-host.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";

const workflowHeadings = (JSON.parse(readFileSync(new URL("../../fixtures/dreaming-workflow.json", import.meta.url), "utf8")) as { promptOrder: string[] }).promptOrder;
const call = (id: string, name: string, args: unknown): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args as Record<string, unknown> }] });
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
  return { h, store, item: c.committed[0]!, content };
}
const terminal = async (h: ReturnType<typeof host>) => vi.waitFor(() => {
  const run = h.memory.store.listRuns(1).find(r => r.kind === "dreaming" && JSON.parse(r.response ?? "{}").check);
  expect(run).toBeTruthy(); return run!;
}, { timeout: 5000 });

test("Dreamer pre-request capacity failure names its own phase and retains its work", async () => {
  const { h, store, item } = await seeded();
  const measure = vi.spyOn(AgentSession.prototype, "getContextUsage").mockReturnValue({ tokens: 200_000, contextWindow: 200_000, percent: 100 });
  try {
    await h.turn(); await h.drain();
    const runs = store.listRuns(1).filter(r => r.kind === "dreaming");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("failure");
    expect(runs[0]!.response).toContain("Dreamer capacity: the child's context");
    expect(runs[0]!.response).not.toContain("Consolidation capacity");
    expect(h.requests).toEqual([]);
    expect(store.isKnowledgeProcessed(item.commit)).toBe(false);
    expect(store.getClaim(1, "dreaming")).toBeNull();
    expect(store.taskFailures(1)).toMatchObject([{ phase: "dreaming", count: 1 }]);
  } finally { measure.mockRestore(); await h.dispose(); }
});

test("32d native host: entry completion starts fresh Dreamer; no tool check still certifies", async () => {
  const { h, store, item } = await seeded({ "dreaming.model": "fake/test-thinking", "dreaming.thinking": "high", compaction: { enabled: true } });
  try {
    let requests = 0;
    h.provider(async c => { expect(c.systemPrompt).toContain("# Dreamer"); expect(c.tools?.map(t => t.name)).toEqual(["trace", "search", "check", "memory"]);
      return ++requests === 1 ? skip(`K${item.knowledgeId}@${item.commit}`) : reply("Reviewed without changes"); }, { autoStop: false });
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
    const range = store.dreamingRange(1, true)!;
    expect(range.origin).toEqual(run.origin);
    const execution = store.db.prepare("SELECT e.origin_session_id, e.origin_entry_ids FROM task_executions e JOIN execution_runs x ON x.execution_id = e.id WHERE x.run_id = ?").get(run.id)!;
    expect({ sessionId: execution.origin_session_id, entryIds: JSON.parse(String(execution.origin_entry_ids)) }).toEqual(run.origin);
    expect(store.isKnowledgeProcessed(item.commit)).toBe(true);
    expect(JSON.parse(readFileSync(join(h.dir, "agent", "settings.json"), "utf8")).compaction.enabled).toBe(true);
    expect(h.requests).toHaveLength(2);
  } finally { await h.dispose(); }
});

test("32d native host: pass ends after all intermediate tool turns; first memory commits live", async () => {
  const { h, store, item } = await seeded();
  try {
    let requests = 0;
    h.provider(async () => {
      requests++;
      if (requests === 1) return call("archive", "memory", { operations: [{ op: "archive", id: `K${item.knowledgeId}@${item.commit}`, supports: [], reason: "Retire redundant active rule; history preserved" }], skipped: [] });
      expect(store.listCurrentKnowledge(store.knowledgePath(1))).toEqual([]);
      expect(store.isKnowledgeProcessed(store.listKnowledgeRevisions().at(-1)!.id)).toBe(false);
      if (requests === 2) return call("read", "trace", { address: `K${item.knowledgeId}` });
      return reply("Done");
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h);
    expect(run.outcome).toBe("success"); expect(requests).toBe(3);
    expect(JSON.parse(run.response!).rounds).toBe(2);
    expect(store.isKnowledgeProcessed(store.listKnowledgeRevisions().at(-1)!.id)).toBe(true);
  } finally { await h.dispose(); }
});

test("32d native host: one system repair shares 50 rounds and provider retry cannot reset them", async () => {
  const { h, store, item } = await seeded({}, "budget ".repeat(6000));
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
      if (requests === 1) {
        const outside = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, operations: [{ op: "create", handle: "$2", author: "test", text: "outside ".repeat(4500), category: "constraint", scope: "project", supports: [1], topics: [], reason: "outside frozen family", createdAt: "now" }] });
        if (!outside.ok) throw Error(outside.problems.join());
        const range = store.openDreamingRange(1, "main")!;
        const id = store.recordRun({ kind: "dreaming", sessionId: 1, branch: "main", dreamingRangeId: range.id,
          outcome: "success", createdAt: "now" }).id;
        store.completeDreaming(id, [outside.committed[0]!.commit], [outside.committed[0]!.commit]);
      }
      if (tools === 24 && !conversation.messages.some(m => JSON.stringify(m).includes("One repair,"))) return reply("Done first pass");
      if (tools === 26 && !transient) { transient = true; return { ...reply(""), stopReason: "error", errorMessage: "rate limit exceeded" }; }
      tools++;
      return call(`read-${tools}`, "trace", { address: `K${item.knowledgeId}` });
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h), audit = JSON.parse(run.response!);
    expect(run.outcome).toBe("failure"); expect(tools).toBe(50); expect(audit.rounds).toBe(50);
    expect(audit.repaired).toBe(true); expect(audit.retries).toHaveLength(1);
    expect(audit.problems.join()).toContain("exceeds 10000");
    expect(store.isKnowledgeProcessed(item.commit)).toBe(false);
    const log = readFileSync(audit.nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const repairMessages = log.filter(e => JSON.stringify(e).includes("System-generated Dreamer completion check"));
    expect(repairMessages).toHaveLength(1);
    expect(initialSystem).toContain("# Dreamer — bounded knowledge maintenance");
    expect(initialSystem).toContain("Your tools are `trace`, `search`, `memory` and `check`.");
    let priorStage = -1;
    for (const heading of workflowHeadings) {
      const position = initialSystem!.indexOf(heading);
      expect(position, `effective prompt missing ordered stage: ${heading}`).toBeGreaterThan(priorStage);
      priorStage = position;
    }
    expect(initialSystem).toContain("Protect first: user constraints and corrections, milestone results, errors and lessons, designs and their reasons, important deadlines, open matters.");
    expect(initialSystem).toContain("An archive states who fully carries the information, what evidence proves it expired, or what the budget trade actually lost.");
    expect(initialSystem).toContain("Old, short, rarely used or finished is by itself no proof of no value.");
    expect(initialSystem).not.toMatch(/global 4,000|project 10,000|session 1,000|applicable block within 15,000/);
    expect(repairSystems.length).toBeGreaterThan(1);
    expect(repairSystems.every(system => system === initialSystem),
      JSON.stringify(repairSystems.map(system => ({ bytes: system === undefined ? undefined : Buffer.byteLength(system), dreamer: system?.startsWith("# Dreamer") })))).toBe(true);
    expect(repairSystems.every(system => system?.includes("`supports: []` is allowed here for update, merge, split and archive"))).toBe(true);
    expect(initialTools).toEqual(["trace", "search", "check", "memory"]);
    expect(repairToolSets.every(tools => JSON.stringify(tools) === JSON.stringify(initialTools))).toBe(true);
    expect(repairHistory?.filter(m => m.role === "toolResult")).toHaveLength(24);
    expect(String(repairHistory?.find(m => m.role === "user")?.content)).toContain("Changed knowledge (unsettled events):");
    expect(repairMessages[0]).toMatchObject({ type: "message", message: { role: "user" } });
    expect(requests).toBe(52); // 50 tool rounds, one pass-ending text, one provider retry
  } finally { await h.dispose(); }
});

test("34b native host: unchanged indivisible retained work stops relaunching until its graph changes", async () => {
  const { h, store, item, content } = await seeded();
  let other: Store | undefined;
  try {
    let requests = 0;
    h.provider(async () => ++requests === 1
      ? call("oversize", "memory", { operations: [{ op: "update", id: `K${item.knowledgeId}@${item.commit}`,
        text: "oversized ".repeat(11000), category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "indivisible retained output" }], skipped: [] })
      : reply("Done"), { autoStop: false });
    await h.turn(); await h.drain();
    expect((await terminal(h)).outcome).toBe("failure");
    const target = { sessionId: 1, branch: "main", headTurnId: store.knowledgePath(1).headTurnId! };
    const oversized = store.currentCommit(item.knowledgeId, target)[0]!;

    // The first pre-request refusal records the disposition on the existing logical task.
    await h.turn(); await h.drain();
    expect(h.memory.taskEligibility("dreaming", target)).toEqual({ due: false });
    expect(store.getClaim(1, "dreaming")).toBeNull();
    expect(store.taskFailures(1)).toMatchObject([{ phase: "dreaming", count: 1 }]);
    const blockedAt = requests, runCount = store.listRuns(1).length;
    await h.turn(); await h.turn(); await h.drain();
    expect(requests).toBe(blockedAt);
    expect(store.listRuns(1)).toHaveLength(runCount);
    expect(store.taskFailures(1)).toMatchObject([{ phase: "dreaming", count: 1 }]);

    // A successor changes the retained obligation graph and restores normal automatic eligibility.
    other = new Store(h.dbPath);
    const peer = other.createSession({ host: "peer", projectId: store.getSession(1)!.projectId, enrollmentChoice: true,
      startedAt: "now", firstReplyAt: "now" });
    const turn = other.appendTurn({ sessionId: peer.id, kind: "turn", userPrompt: "repair", startedAt: "now" });
    const repaired = other.commitConsolidationRun({ path: { sessionId: peer.id, branch: "main", headTurnId: turn.id },
      run: { kind: "manual", sessionId: peer.id, branch: "main", createdAt: "now" }, operations: [{ op: "update",
        knowledgeId: oversized.knowledgeId, baseCommit: oversized.id, ...content, text: "fitting successor" }] });
    if (!repaired.ok) throw new Error(repaired.problems.join("; "));
    expect(h.memory.taskEligibility("dreaming", target)).toEqual({ due: true });
    h.provider(async () => ++requests === blockedAt + 1 ? skip(`K${repaired.committed[0]!.knowledgeId}@${repaired.committed[0]!.commit}`) : reply("Reviewed fitting successor"), { autoStop: false });
    await h.turn(); await h.drain();
    expect(store.isKnowledgeProcessed(repaired.committed[0]!.commit)).toBe(true);
    expect(requests).toBe(blockedAt + 2);
  } finally { other?.close(); await h.dispose(); }
});

test("32d native host: Consolidator and Dreamer occupy independent seats", async () => {
  const { h, store, item } = await seeded({ "consolidation.triggerTokens": 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const phases = new Set<string>();
    let dreamerRequests = 0;
    h.provider(async c => { const dreamer = c.systemPrompt!.startsWith("# Dreamer"); phases.add(dreamer ? "D" : "C"); await held;
      return dreamer && ++dreamerRequests === 1 ? skip(`K${item.knowledgeId}@${item.commit}`) : reply("Done"); }, { autoStop: false });
    await h.turn();
    await vi.waitFor(() => expect([...phases].sort()).toEqual(["C", "D"]));
    expect(store.getClaim(1, "dreaming")).not.toBeNull(); expect(store.getClaim(1, "consolidation")).not.toBeNull();
    release(); await h.drain();
    expect((await terminal(h)).outcome).toBe("success");
  } finally { release(); await h.dispose(); }
});

test("32d native host: stop preserves partial commits, cancels the claim and retries the original range", async () => {
  const { h, store, item } = await seeded();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    let requests = 0;
    h.provider(async () => {
      if (++requests === 1) return call("update", "memory", { operations: [{ op: "update", id: `K${item.knowledgeId}@${item.commit}`, text: "Keep the user's exact constraint", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "clarify without new facts" }], skipped: [] });
      await held; return reply("late reply");
    }, { autoStop: false });
    await h.turn();
    await vi.waitFor(() => expect(requests).toBe(2));
    await h.commands.get("trace").handler("stop", h.ctx);
    const cancelled = await terminal(h);
    expect(cancelled.outcome).toBe("cancelled");
    expect(store.getClaim(1, "dreaming")).toBeNull();
    const changed = store.listCommitsByRun(cancelled.id)[0]!;
    expect(changed.parentId).toBe(item.commit);
    expect(store.isKnowledgeProcessed(changed.id)).toBe(false);
    expect(store.retryDreamingRange({ sessionId: 1, branch: "main", headTurnId: null })?.anchor).toBe(item.commit);
    expect(store.taskFailures(1).every(f => f.count === 0)).toBe(true);
    release();
    let retry = 0;
    h.provider(async () => ++retry === 1 ? skip(`K${changed.knowledgeId}@${changed.id}`) : reply("Reviewed retry without further changes"), { autoStop: false });
    await h.turn(); await h.drain();
    expect(store.listRuns(1).filter(r => r.kind === "dreaming")).toHaveLength(2);
    expect(store.isKnowledgeProcessed(changed.id)).toBe(true);
    expect(store.isKnowledgeProcessed(item.commit)).toBe(false);
  } finally { release(); await h.dispose(); }
});

test("32d native host: provider overflow does not compact a Dreamer or roll back its archive", async () => {
  const { h, store, item } = await seeded({ compaction: { enabled: true }, retry: { enabled: false } });
  try {
    let requests = 0;
    h.provider(async () => ++requests === 1
      ? call("archive", "memory", { operations: [{ op: "archive", id: `K${item.knowledgeId}@${item.commit}`, supports: [], reason: "Deliberate budget retirement" }], skipped: [] })
      : { ...reply(""), stopReason: "error", errorMessage: "maximum context length exceeded" }, { autoStop: false });
    await h.turn(); const run = await terminal(h);
    expect(run.outcome).toBe("failure"); expect(requests).toBe(2);
    const archive = store.listCommitsByRun(run.id)[0]!;
    expect(archive.op).toBe("archive"); expect(store.isKnowledgeProcessed(archive.id)).toBe(false);
    expect(store.retryDreamingRange({ sessionId: 1, branch: "main", headTurnId: null })?.anchor).toBe(item.commit);
    const entries = readFileSync(JSON.parse(run.response!).nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries.some(e => e.type === "compaction")).toBe(false);
  } finally { await h.dispose(); }
});

test.each([false, true])("external merge=%s consumes the exact input without completion chaining; next entry processes the outside event", async merge => {
  const { h, store, item, content } = await seeded();
  const other = new Store(h.dbPath);
  let entered!: () => void, release!: () => void;
  const frozen = new Promise<void>(resolve => { entered = resolve; });
  const changed = new Promise<void>(resolve => { release = resolve; });
  try {
    const session = other.createSession({ host: "external", projectId: store.getSession(1)!.projectId, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = other.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "external writer", startedAt: "now" });
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    let requests = 0;
    h.provider(async () => { requests++; entered(); await changed; return reply("Reviewed; external change remains"); }, { autoStop: false });
    const first = h.turn();
    await frozen;
    const run = { kind: "manual" as const, sessionId: session.id, createdAt: "now" };
    let operations: Parameters<Store["commitConsolidationRun"]>[0]["operations"];
    if (merge) {
      const created = other.commitConsolidationRun({ run, operations: [{ op: "create", handle: "$outside", author: "external", ...content }] });
      if (!created.ok) throw Error(created.problems.join());
      const outside = created.committed[0]!;
      // Ticket 44: this unrelated consumption fixture keeps the older input identity as survivor.
      operations = [{ op: "merge", intoKnowledgeId: item.knowledgeId, intoBaseCommit: item.commit,
        absorb: [{ knowledgeId: outside.knowledgeId, baseCommit: outside.commit }], ...content, text: "Merged external rule" }];
    } else operations = [{ op: "update", knowledgeId: item.knowledgeId, baseCommit: item.commit, ...content, text: "External updated rule" }];
    const written = other.commitConsolidationRun({ run, path, operations });
    if (!written.ok) throw Error(written.problems.join());
    const external = written.committed[0]!;
    release(); await first;
    expect((await terminal(h)).outcome).toBe("success");
    expect(requests).toBe(1);
    expect(store.listRuns(1).filter(r => r.kind === "dreaming")).toHaveLength(1);
    expect(store.db.prepare("SELECT event_id FROM settled_knowledge_events").all().map(row => Number(row.event_id))).toEqual([item.commit]);
    expect(store.db.prepare("SELECT commit_id FROM processed_knowledge_versions").all()).toEqual([]);
    expect(store.isKnowledgeProcessed(external.commit)).toBe(false);
    expect(store.taskFailures(1).every(row => row.count === 0)).toBe(true);
    await h.drain();
    expect(requests).toBe(1);
    expect(store.retryDreamingRange(store.knowledgePath(1, "main"))).toBeNull();
    let second = 0;
    h.provider(async conversation => {
      expect(JSON.stringify(conversation.messages)).toContain(`K${external.knowledgeId}@${external.commit}`);
      return ++second === 1 ? skip(`K${external.knowledgeId}@${external.commit}`) : reply("Maintained the freshly frozen external version");
    }, { autoStop: false });
    await h.turn(); await h.drain();
    const runs = store.listRuns(1).filter(r => r.kind === "dreaming");
    expect(runs.map(r => r.outcome)).toEqual(["success", "success"]);
    expect(store.isKnowledgeProcessed(external.commit)).toBe(true);
    expect(store.isKnowledgeProcessed(item.commit)).toBe(false);
    expect(store.pendingKnowledgeEvents(store.knowledgePath(1, "main"))).toEqual([]);
    expect(store.retryDreamingRange(store.knowledgePath(1, "main"))).toBeNull();
  } finally { release(); other.close(); await h.dispose(); }
});
