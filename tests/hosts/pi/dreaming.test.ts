import { expect, test, vi } from "vitest";
import { roomyPoolBudget } from "../../knowledge-budget-fixture.ts";
import type { JsonObject } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { host, reply, emptyNote, dreamerReply, type Reply } from "./test-host.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { memoryFiles } from "../../../src/core/api/index.ts";
import { readHandle } from "../../read-handle-fixture.ts";
import { knowledge, legacyFacts } from "../../support/seed.ts";

const workflowHeadings = (JSON.parse(readFileSync(new URL("../../fixtures/dreaming-workflow.json", import.meta.url), "utf8")) as { promptOrder: string[] }).promptOrder;
const call = (id: string, name: string, args: unknown): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args as JsonObject }] });
// 59/127: a scripted Dreamer accounts for the supplied handles it leaves untouched, one skip call each, in one response.
const skip = (...handles: string[]): Reply => dreamerReply("skip", { skipped: handles.map(knowledge => ({ knowledge, because: "reviewed; no operation needed" })) });
async function seeded(config: Record<string, unknown> = {}, text = "Keep the user constraint") {
  const h = host({ "noting.triggerTokens": 1000000, "dreaming.triggerTokens": 1, ...config });
  await h.emit("session_start"); await h.turn();
  const store = h.memory.store;
  const user = store.sourcePath(1, "main", 1).find(value => store.getSourceEntry(value.id)?.role === "user")!;
  const evidence = legacyFacts(store, { kind: "manual", sessionId: 1, createdAt: "now" },
    [{ sources: [{ entry: user, address: `T1#E${user.entryOrdinal}` }], text,
      category: "decision", actor: "user", createdAt: "now" }]).facts[0]!;
  const content = { text, category: "constraint" as const, scope: "project" as const, supports: [evidence.id], topics: [], reason: "evidence", createdAt: "now" };
  const c = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, operations: [{ op: "create", title: "Fixture title", handle: "$1", author: "test", ...content }] });
  if (!c.ok) throw Error(c.problems.join());
  const path = store.knowledgePath(1);
  const created = c.committed[0]!;
  const item = { ...created, tagged: readHandle(address => memoryFiles(h.memory, { sessionId: 1, branch: "main", headTurnId: path.headTurnId! }).read(address).content, `K${created.knowledgeId}`) };
  const renderedTokens = store.pendingVersions(`project:${store.getSession(1)!.projectId}`, path)
    .find(value => value.revisionId === item.commit)!.tokens;
  const pool = `project:${store.getSession(1)!.projectId}`;
  h.memory.setKnowledgeBudget("project", roomyPoolBudget(renderedTokens));
  expect(store.dreamingDue(path, 1)).toBe(true);
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
  const range = store.retainKnowledgePoolRange(path, claim);
  const executionId = store.beginExecution({ sessionId: 1, phase: "dreaming", origin: range.origin });
  const run = store.bindDreamingRun({ kind: "dreaming", sessionId: 1, branch: path.branch,
    dreamingRangeId: range.id, executionId, claim, createdAt: "now" });
  store.completeKnowledgePoolRange(run, "success", range.eventIds);
  store.releaseClaim(claim);
  const priorSize = store.poolSizes(path).find(value => value.pool === pool)!.tokens;
  const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, operations: [
    { op: "create", title: "Fixture title", handle: "$later", author: "test", ...content, text: "Small new rule" }] });
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

test("entry ingestion starts a fresh Dreamer and records its frozen pool range", async () => {
  const { h, store, item, pool } = await seeded({ "dreaming.model": "fake/test-thinking", "dreaming.thinking": "high", compaction: { enabled: true } });
  try {
    let requests = 0;
    h.provider(async c => { expect(c.systemPrompt).toContain("# Dreamer"); expect(c.tools?.map(t => t.name).sort()).toEqual(["check", "memory", "read", "search"]);
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
    expect(h.requests).toHaveLength(3); // skip batch, pass-ending reply, and the reply to the end review (125)
  } finally { await h.dispose(); }
});

test("136 review SPEC4: a Pi Dreamer's over-long search output is saved and its path is readable by the worker's Read", async () => {
  const { h, store, item, pool } = await seeded();
  try {
    const toolText = (message: { content?: unknown } | undefined) => ((message?.content as { text?: string }[] | undefined) ?? []).map(part => part.text ?? "").join("");
    let requests = 0, path = "", readBack = "";
    h.provider(async c => {
      requests++;
      const results = c.messages.filter(m => m.role === "toolResult");
      if (requests === 1) return call("s1", "search", { layer: "knowledge", code: "text(Array.from({ length: 40000 }, (_, i) => 'line ' + i + ' word').join('\\n'))" });
      if (requests === 2) {
        path = /\[Full output: (.+)\]/.exec(toolText(results.at(-1)))![1]!;
        return call("r1", "read", { path });
      }
      if (requests === 3) { readBack = toolText(results.at(-1)); return skip(`K${item.knowledgeId}@v1`); }
      return reply("Reviewed without changes");
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h);
    expect(run.outcome).toBe("success");
    expect(path).toMatch(/trace-memory-worker-[^/]+\/output-[^/]+\.txt$/);
    expect(readBack).toContain("line 0 word");
    expect(existsSync(path)).toBe(false); // removed with the run
    expect(processedIn(store, pool, item.commit)).toBe(true);
  } finally { await h.dispose(); }
});

test("32d native host: pass ends after all intermediate tool turns; first memory commits live", async () => {
  const { h, store, item, pool } = await seeded();
  try {
    let requests = 0;
    h.provider(async () => {
      requests++;
      if (requests === 1) return call("archive", "memory", { op: "archive", kind: "budget", id: item.tagged, supports: [], reason: "Retire redundant active rule; history preserved" });
      expect(store.currentKnowledge(store.knowledgePath(1))).toEqual([]);
      expect(processedIn(store, pool, store.listKnowledgeRevisions().at(-1)!.id)).toBe(false);
      if (requests === 2) return call("read", "read", { path: `trace://K${item.knowledgeId}` });
      return reply("Done");
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h);
    expect(run.outcome).toBe("success"); expect(requests).toBe(4); // 125: the fourth request answers the end review
    expect(JSON.parse(run.response!).rounds).toBe(2);
    expect(processedIn(store, pool, store.listKnowledgeRevisions().at(-1)!.id)).toBe(true);
  } finally { await h.dispose(); }
});

test("64c native host: a reads-only first pass ends without a repair round; 104: its undeliberated item fails the run", async () => {
  const { h, store, item, pool } = await seeded({}, "budget ".repeat(6000));
  try {
    // 6k changed body fits admission; 4.5k processed outside the family makes the pool over-cap.
    let requests = 0, tools = 0, transient = false;
    let initialSystem: string | undefined, initialMaterial: string | undefined;
    const repairSystems: (string | undefined)[] = [], repairToolSets: (string[] | undefined)[] = [];
    let initialTools: string[] | undefined, repairHistory: { role: string; content?: unknown }[] | undefined;
    h.provider(async conversation => {
      requests++;
      const isRepair = conversation.messages.some(m => JSON.stringify(m).includes("System-generated Dreamer completion check"));
      if (requests === 1) {
        initialSystem = conversation.systemPrompt;
        initialMaterial = JSON.stringify(conversation.messages);
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
      return call(`read-${tools}`, "read", { path: `trace://K${item.knowledgeId}` });
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h), audit = JSON.parse(run.response!);
    expect(run.outcome).toBe("failure"); expect(tools).toBe(24); expect(audit.rounds).toBe(24);
    expect(audit.repaired).toBeUndefined(); expect(audit.retries).toBeUndefined();
    expect(audit.problems).toEqual([`frozen versions not deliberated: K${item.knowledgeId}@v1`]);
    expect(processedIn(store, pool, item.commit)).toBe(false); // Reads alone do not deliberate or consume the input.
    expect(store.pendingVersions(pool, store.knowledgePath(1)).map(value => value.revisionId)).toContain(item.commit);
    const log = readFileSync(audit.nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const repairMessages = log.filter(e => JSON.stringify(e).includes("System-generated Dreamer completion check"));
    expect(initialSystem).toContain("# Dreamer — knowledge maintenance");
    expect(initialMaterial).toContain("trace://knowledge/S1");
    expect(initialSystem).not.toContain("trace://knowledge/S1");
    let priorStage = -1;
    for (const heading of workflowHeadings.filter(value => !value.includes("Intensity, set by the failed check"))) {
      const position = initialSystem!.indexOf(heading);
      expect(position, `effective prompt missing ordered stage: ${heading}`).toBeGreaterThan(priorStage);
      priorStage = position;
    }
    expect(initialSystem).not.toContain("### Intensity, set by the failed check");
    expect(initialSystem).not.toMatch(/global 4,000|project 10,000|session 1,000|applicable block within 15,000/);
    expect(repairSystems).toEqual([]); expect(repairToolSets).toEqual([]); expect(repairHistory).toBeUndefined();
    expect(repairMessages).toEqual([]);
    expect(initialTools).toEqual(["search", "check", "memory", "read"]);
    expect(transient).toBe(false);
    expect(requests).toBe(26); // 24 tool rounds, one pass-ending text, and the reply to the end review (125)
    expect(log.filter(e => JSON.stringify(e).includes("Before this run ends, review it once."))).not.toEqual([]);
  } finally { await h.dispose(); }
});

test("32d native host: Noter and Dreamer occupy independent seats", async () => {
  const { h, store, item } = await seeded({ "noting.triggerTokens": 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const phases = new Set<string>();
    let dreamerRequests = 0;
    h.provider(async c => { const dreamer = c.systemPrompt!.startsWith("# Dreamer"); phases.add(dreamer ? "D" : "N"); await held;
      if (!dreamer) return emptyNote(c) ?? reply("Done");
      if (++dreamerRequests > 3) throw new Error("Unexpected Dreamer continuation"); // skip batch, closing reply, end review (125)
      return dreamerRequests === 1 ? skip(`K${item.knowledgeId}@v1`) : reply("Done"); }, { autoStop: false });
    await h.turn();
    await vi.waitFor(() => expect([...phases].sort()).toEqual(["D", "N"]));
    expect(store.getClaim(1, "dreaming")).not.toBeNull(); expect(store.getClaim(1, "noting")).not.toBeNull();
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
      if (++requests === 1) return call("update", "memory", { op: "update", id: item.tagged, text: "Keep the user's exact constraint", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "clarify without new facts" });
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
      ? call("archive", "memory", { op: "archive", kind: "budget", id: item.tagged, supports: [], reason: "Deliberate budget retirement" })
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

test("125: native Dreamer gets the end review once after its first pass; a second-pass operation commits and no third pass follows", async () => {
  const { h, store, item } = await seeded();
  try {
    const update = (id: string, text: string, reason: string) => call(reason, "memory", { op: "update", id, text,
      category: "constraint", scope: "project", supports: [], topics: [], reason });
    const reviewed: boolean[] = [];
    h.provider(async conversation => {
      const review = conversation.messages.map(message => JSON.stringify(message.content))
        .find(text => text.includes("Before this run ends, review it once."));
      reviewed.push(review !== undefined);
      switch (reviewed.length) {
        case 1: return update(item.tagged, "Keep the user's constraint", "clarify");
        case 2: return reply("Done first pass");
        case 3: return update(/\[(K\d+#[a-z]+)\]/.exec(review!)![1]!, "Keep the user's constraint, restored", "restore a clause");
        case 4: return reply("Reviewed");
        default: throw new Error("Unexpected third pass");
      }
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h);
    expect(run.outcome, run.response ?? "").toBe("success");
    expect(reviewed).toEqual([false, false, true, true]);
    expect(store.listCommitsByRun(run.id).map(revision => revision.text))
      .toEqual(["Keep the user's constraint", "Keep the user's constraint, restored"]);
  } finally { await h.dispose(); }
});

test("127: one native response's memory calls run in order and commit independently; a refused one blocks until the second pass drops it", async () => {
  const { h, store, item } = await seeded();
  try {
    const results: string[][] = [];
    let review = "";
    h.provider(async conversation => {
      const texts = conversation.messages.map(message => JSON.stringify(message.content));
      review ||= texts.find(text => text.includes("Before this run ends, review it once.")) ?? "";
      results.push(conversation.messages.filter(message => message.role === "toolResult")
        .map(message => (message.content as { type: string; text: string }[]).map(part => part.text).join("")));
      switch (results.length) {
        case 1: return dreamerReply("first", { operations: [{ op: "archive", kind: "budget", id: `K${item.knowledgeId}#zzzz`, supports: [], reason: "bad tag" },
          { op: "update", id: item.tagged, text: "Keep the user's constraint", category: "constraint", scope: "project", supports: [], topics: [], reason: "clarify" }] });
        case 2: return reply("Done first pass");
        case 3: return call("drop", "memory", { drop: "M1" });
        case 4: return reply("Reviewed");
        default: throw new Error("Unexpected third pass");
      }
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h);
    expect(run.outcome, run.response ?? "").toBe("success");
    const [refused, committed] = results[1]!.map(text => JSON.parse(text));
    expect(refused.results).toEqual([expect.stringMatching(/^rejected: M1: /)]);
    expect(committed).toMatchObject({ results: ["ok"], committed: [{ knowledgeId: item.knowledgeId }] });
    expect(committed.rejected).toHaveProperty("M1"); // the later sibling's commit leaves the refusal outstanding
    expect(review).toContain("Blockers:\\nM1: ");
    expect(results[3]!.at(-1)).toContain("dropped: M1");
    expect(store.listCommitsByRun(run.id).map(revision => revision.text)).toEqual(["Keep the user's constraint"]);
  } finally { await h.dispose(); }
});

for (const resolved of [false, true]) test(`127: a Dreamer memory call Pi refuses natively is numbered and blocks the run until dropped (resolved=${resolved})`, async () => {
  const { h, store, item } = await seeded();
  try {
    let review = "", round = 0;
    h.provider(async conversation => {
      review ||= conversation.messages.map(message => JSON.stringify(message.content))
        .find(text => text.includes("Before this run ends, review it once.")) ?? "";
      switch (++round) {
        // `create` is outside the Dreamer's op enum: Pi refuses the call before it reaches core.
        case 1: return dreamerReply("first", { operations: [{ op: "create", title: "Fixture title", text: "A new rule", category: "constraint", scope: "project", supports: [], topics: [], reason: "invalid op" },
          { op: "update", id: item.tagged, text: "Keep the user's constraint", category: "constraint", scope: "project", supports: [], topics: [], reason: "clarify" }] });
        case 2: return reply("Done first pass");
        case 3: return resolved ? call("drop", "memory", { drop: "M1" }) : reply("Reviewed");
        default: return reply("Reviewed");
      }
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h);
    expect(run.outcome, run.response ?? "").toBe(resolved ? "success" : "failure");
    expect(review).toMatch(/Blockers:\\nM1: /);
    const audit = JSON.parse(run.response!);
    const refused = audit.toolCalls.find((call: { input?: { op?: string } }) => call.input?.op === "create");
    expect(refused.problems[0]).toContain('"rejected":{"M1"'); // recorded through the Noter's path, not by core execution
    if (!resolved) expect(audit.problems[0]).toMatch(/^M1: /);
    expect(store.listCommitsByRun(run.id).map(revision => revision.text)).toEqual(["Keep the user's constraint"]);
  } finally { await h.dispose(); }
});

test("126: one native Dreamer run covers the session's pools; the end review is sent once", async () => {
  const { h, store, item, content, pool } = await seeded();
  try {
    const made = (scope: "global" | "session") => knowledge(store, store.knowledgePath(1, "main"), scope, content.category,
      content.supports, `A ${scope} rule`, { run: { kind: "manual", createdAt: "now" } });
    const global = made("global"), local = made("session");
    const history = (value: { knowledgeId: number; commit: number }) => `K${value.knowledgeId}@v${store.versionOrdinal(value.knowledgeId, value.commit)}`;
    const reviews: string[] = [];
    h.provider(async conversation => {
      const review = conversation.messages.map(message => JSON.stringify(message.content))
        .find(text => text.includes("Before this run ends, review it once."));
      if (review) { reviews.push(review); return reply("Reviewed"); }
      if (conversation.messages.some(message => message.role === "toolResult")) return reply("Done first pass");
      return dreamerReply("maintain", { operations: [{ op: "update", id: `K${global.knowledgeId}#${store.versionTag(global.knowledgeId, global.commit)}`,
        text: "A global rule, clarified", category: "constraint", scope: "global", supports: [], topics: [], reason: "clarify" }],
        skipped: [history(item), history(local)].map(knowledge => ({ knowledge, because: "reviewed; no operation needed" })) });
    }, { autoStop: false });
    await h.turn();
    const run = await terminal(h);
    expect(run.outcome, run.response ?? "").toBe("success");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain(`K${global.knowledgeId}#`);
    const own = store.listCommitsByRun(run.id)[0]!;
    expect([processedIn(store, "global", own.id), processedIn(store, pool, item.commit), processedIn(store, "session:1", local.commit)])
      .toEqual([true, true, true]);
  } finally { await h.dispose(); }
});
