import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, type DreamingAgentInput } from "../../../src/core/api/index.ts";
import { skipRest } from "../../dreaming-skips.ts";

const memories: ReturnType<typeof TraceMemory>[] = [], dirs: string[] = [];
afterEach(() => {
  for (const memory of memories.splice(0)) if (!memory.store.closed) memory.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const at = "2026-09-12T00:00:00.000Z";
const success = { outcome: "success", output: "reviewed", request: { exact: "offline" } } as const;

function pathFixture(agent: (task: DreamingAgentInput) => Promise<typeof success> = async () => success, seedOlderSurvivor = false) {
  const dir = mkdtempSync(join(tmpdir(), "tm-34b-path-")); dirs.push(dir);
  const db = join(dir, "memory.sqlite");
  let runAgent = agent;
  const memory = TraceMemory(db, task => runAgent(task as DreamingAgentInput), { dreaming: { triggerTokens: 1 } }); memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "shared", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: at });
  const append = (nativeId: string, text = nativeId) => memory.appendEntry({ sessionId: session.id, turnId: turn.id,
    nativeLineage: "native", nativeId, role: "user", text, raw: JSON.stringify({ role: "user", content: text }), calls: [] });
  const root = append("root"), left = append("left"), right = append("right");
  memory.selectEntries(session.id, "root", [root.id]);
  memory.selectEntries(session.id, "left", [root.id, left.id]);
  memory.selectEntries(session.id, "right", [root.id, right.id]);
  const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "root", createdAt: at }, facts: [{
    turnId: turn.id, entryIds: [root.id], category: "decision", actor: "user", text: "shared evidence", source: [`T${turn.id}#E1`], createdAt: at,
  }] });
  if (!facts.ok) throw new Error(facts.problems.join("; "));
  const fact = facts.facts[0]!.id;
  const path = (branch: "root" | "left" | "right", triggerEntryId: number) => ({ kind: "manual" as const,
    sessionId: session.id, branch, currentTurnId: turn.id, triggerEntryId });
  const write = (branch: "root" | "left" | "right", triggerEntryId: number, input: unknown) => {
    const tools = memory.tools(path(branch, triggerEntryId));
    return { trace: tools.find(tool => tool.name === "trace")!, memory: tools.find(tool => tool.name === "memory")!, input };
  };
  const writer = write("root", root.id, {}).memory;
  const older = seedOlderSurvivor ? JSON.parse(writer.execute({ operations: [{ op: "create", text: "older survivor", category: "constraint", scope: "project",
    supports: [`F${fact}`], topics: [], reason: "older identity" }], skipped: [] })).committed[0] as { knowledgeId: number; commit: number } : undefined;
  const initial = writer.execute({ operations: [{ op: "create", text: "base", category: "constraint", scope: "project",
    supports: [`F${fact}`], topics: [], reason: "initial" }], skipped: [] });
  const base = JSON.parse(initial).committed[0] as { knowledgeId: number; commit: number };
  return { memory, store, db, project, session, turn, root, left, right, fact, older, base, path, write,
    setAgent: (next: typeof agent) => { runAgent = next; } };
}

function update(f: ReturnType<typeof pathFixture>, branch: "root" | "left" | "right", trigger: number, text: string) {
  const bound = f.write(branch, trigger, {});
  bound.trace.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
  return bound.memory.execute({ operations: [{ op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`, text,
    category: "constraint", scope: "project", supports: [`F${f.fact}`], topics: [], reason: text }], skipped: [] });
}

test("34b: shared-evidence sibling origins may consume one base, while equal and ancestor origins cannot", () => {
  const f = pathFixture();
  const left = update(f, "left", f.left.id, "left result");
  expect(left).not.toContain("rejected:");
  const right = update(f, "right", f.right.id, "right result");
  expect(right).not.toContain("rejected:");
  expect(f.store.currentCommit(f.base.knowledgeId, { sessionId: f.session.id, branch: "right", headTurnId: f.turn.id })).toHaveLength(2);

  expect(update(f, "right", f.right.id, "equal-origin competitor")).toContain("competing consuming successor");
  expect(update(f, "root", f.root.id, "ancestor-origin competitor")).toContain("competing consuming successor");
  expect(f.store.listKnowledgeRevisions(f.base.knowledgeId).map(revision => revision.text)).toEqual(["base", "left result", "right result"]);
});

test.each(["update", "archive", "split", "merge-into", "merge-absorb"] as const)(
  "34b: %s consumption blocks a comparable base but permits a divergent sibling", async operation => {
    const f = pathFixture(undefined, operation === "merge-absorb");
    const origin = f.store.triggerOrigin({ sessionId: f.session.id, branch: "left", headTurnId: f.turn.id }, f.left.id);
    const run = () => f.store.bindRunOrigin({ kind: "manual" as const, sessionId: f.session.id, branch: "left", createdAt: at }, origin);
    const content = { text: `${operation} result`, category: "constraint" as const, scope: "project" as const,
      supports: [f.fact], topics: [], reason: operation, createdAt: at };
    let result;
    if (operation === "update") result = f.store.commitConsolidationRun({ path: { sessionId: f.session.id, branch: "left", headTurnId: f.turn.id },
      run: run(), operations: [{ op: "update", knowledgeId: f.base.knowledgeId, baseCommit: f.base.commit, ...content }] });
    else if (operation === "archive") result = f.store.commitConsolidationRun({ path: { sessionId: f.session.id, branch: "left", headTurnId: f.turn.id },
      run: run(), operations: [{ op: "archive", knowledgeId: f.base.knowledgeId, baseCommit: f.base.commit,
        supports: [f.fact], reason: operation, createdAt: at }] });
    else if (operation === "split") {
      f.setAgent(async task => {
        const receipt = JSON.parse(task.tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "split",
          id: `K${f.base.knowledgeId}@${f.base.commit}`, children: [{ text: "split one", category: "constraint", topics: [] },
            { text: "split two", category: "constraint", topics: [] }], supports: [`F${f.fact}`], reason: operation }], skipped: [] }));
        expect(receipt.committed).toHaveLength(2);
        return success;
      });
      expect((await f.memory.dream({ sessionId: f.session.id, branch: "left", headTurnId: f.turn.id, triggerEntryId: f.left.id })).outcome).toBe("success");
      result = { ok: true, problems: [] };
    }
    else {
      const created = operation === "merge-into" ? f.store.commitConsolidationRun({ run: run(), operations: [{ op: "create", handle: "$absorbed", author: "test", ...content }] }) : undefined;
      if (created && !created.ok) throw new Error(created.problems.join("; "));
      const other = operation === "merge-into" ? created!.committed[0]! : f.older!;
      // Ticket 44: merge-absorb seeds an older survivor before the target base; no reverse merge fixture bypasses the store rule.
      result = f.store.commitConsolidationRun({ path: { sessionId: f.session.id, branch: "left", headTurnId: f.turn.id }, run: run(), operations: [{ op: "merge",
        intoKnowledgeId: operation === "merge-into" ? f.base.knowledgeId : other.knowledgeId,
        intoBaseCommit: operation === "merge-into" ? f.base.commit : other.commit,
        absorb: [{ knowledgeId: operation === "merge-into" ? other.knowledgeId : f.base.knowledgeId,
          baseCommit: operation === "merge-into" ? other.commit : f.base.commit }], ...content }] });
    }
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(update(f, "left", f.left.id, "comparable competitor")).toContain("competing consuming successor");
    expect(update(f, "right", f.right.id, "divergent result")).not.toContain("rejected:");
  },
);

test("34b: comparable origin rejects a successor whose later evidence is inapplicable at the losing origin", () => {
  const f = pathFixture();
  const noted = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, branch: "left", createdAt: at }, facts: [{
    turnId: f.turn.id, entryIds: [f.left.id], category: "decision", actor: "user", text: "left-only", source: [`T${f.turn.id}#E2`], createdAt: at,
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const left = f.memory.tools(f.path("left", f.left.id));
  left.find(tool => tool.name === "trace")!.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
  const committed = left.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`,
    text: "left only", category: "constraint", scope: "project", supports: [`F${noted.facts[0]!.id}`], topics: [], reason: "left" }], skipped: [] });
  expect(committed).not.toContain("rejected:");
  const leftCommit = JSON.parse(committed).committed[0].commit as number;
  expect(f.store.currentCommit(f.base.knowledgeId, { sessionId: f.session.id, branch: "root", headTurnId: f.turn.id }).map(revision => revision.id))
    .toEqual([f.base.commit]);
  const refused = update(f, "root", f.root.id, "ancestor competitor");
  expect(refused).toContain("competing consuming successor");
  expect(refused).toContain(`K${f.base.knowledgeId}@${leftCommit}`);
  expect(refused).toContain("no applicable successor exists at the frozen writer path");
  expect(refused).not.toContain("re-read");
});

test.each(["missing run", "missing session"] as const)("34b: %s provenance rejects the affected stale write atomically, regardless of successor applicability", missing => {
  for (const applicable of [false, true]) {
    const f = pathFixture();
    const support = applicable ? f.fact : (() => {
      const noted = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, branch: "left", createdAt: at }, facts: [{
        turnId: f.turn.id, entryIds: [f.left.id], category: "decision", actor: "user", text: "left-only provenance case",
        source: [`T${f.turn.id}#E2`], createdAt: at,
      }] });
      if (!noted.ok) throw new Error(noted.problems.join("; "));
      return noted.facts[0]!.id;
    })();
    const left = f.memory.tools(f.path("left", f.left.id));
    left.find(tool => tool.name === "trace")!.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
    const written = left.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`,
      text: applicable ? "shared successor" : "left-only successor", category: "constraint", scope: "project",
      supports: [`F${support}`], topics: [], reason: "first consumer" }], skipped: [] });
    const successor = JSON.parse(written).committed[0].commit as number;
    const revision = f.store.knowledgeRevision(successor)!;
    if (missing === "missing run") f.store.db.prepare("UPDATE knowledge_revisions SET run_id = NULL WHERE id = ?").run(successor);
    else f.store.db.prepare("UPDATE runs SET session_id = NULL WHERE id = ?").run(revision.runId!);

    const root = f.write("root", f.root.id, {});
    root.trace.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
    const beforeKnowledge = f.store.db.prepare("SELECT count(*) count FROM knowledge").get()!.count;
    const beforeRevisions = f.store.listKnowledgeRevisions().length;
    const rejected = root.memory.execute({ operations: [
      { op: "create", text: "must roll back", category: "constraint", scope: "project", supports: [`F${f.fact}`], topics: [], reason: "rollback probe" },
      { op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`, text: "must reject", category: "constraint", scope: "project",
        supports: [`F${f.fact}`], topics: [], reason: "stale write" },
    ], skipped: [] });
    expect(rejected).toContain("cannot determine target-session provenance");
    expect(rejected).toContain(`K${f.base.knowledgeId}@${f.base.commit}`);
    expect(f.store.db.prepare("SELECT count(*) count FROM knowledge").get()!.count).toBe(beforeKnowledge);
    expect(f.store.listKnowledgeRevisions()).toHaveLength(beforeRevisions);
    expect(f.store.knowledgeRevision(successor)?.text).toBe(applicable ? "shared successor" : "left-only successor");
  }
});

test("34b: proven independent sessions keep the applicability guard even when the prior origin is unknown", () => {
  const f = pathFixture();
  const other = TraceMemory(f.db, async () => success); memories.push(other);
  const session = other.store.createSession({ host: "other", projectId: f.project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  const turn = other.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "other", startedAt: at });
  const entry = other.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "other", nativeId: "other-root", role: "user", text: "other", raw: "{}", calls: [] });
  other.selectEntries(session.id, "main", [entry.id]);
  const origin = other.store.triggerOrigin({ sessionId: session.id, branch: "main", headTurnId: turn.id }, entry.id);
  const run = other.store.bindRunOrigin({ kind: "manual" as const, sessionId: session.id, branch: "main", createdAt: at }, origin);
  const successor = other.store.commitConsolidationRun({ path: { sessionId: session.id, branch: "main", headTurnId: turn.id }, run,
    operations: [{ op: "update", knowledgeId: f.base.knowledgeId, baseCommit: f.base.commit, text: "independent applicable successor",
      category: "constraint", scope: "project", supports: [f.fact], topics: [], reason: "independent", createdAt: at }] });
  if (!successor.ok) throw new Error(successor.problems.join("; "));
  const runId = other.store.knowledgeRevision(successor.committed[0]!.commit)!.runId!;
  other.store.db.prepare("UPDATE runs SET origin_session_id = NULL, origin_entry_ids = NULL WHERE id = ?").run(runId);

  const root = f.write("root", f.root.id, {});
  root.trace.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
  const rejected = root.memory.execute({ operations: [{ op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`,
    text: "cross-session stale", category: "constraint", scope: "project", supports: [`F${f.fact}`], topics: [], reason: "stale" }], skipped: [] });
  expect(rejected).toContain("applicable consuming successor from independent target session");
  expect(rejected).not.toContain("cannot determine target-session provenance");
});

test("34b: an applicable independent-session successor retains the stale-base refusal", () => {
  const f = pathFixture();
  const committed = update(f, "left", f.left.id, "left result");
  expect(committed).not.toContain("rejected:");
  const successor = JSON.parse(committed).committed[0].commit as number;
  const other = TraceMemory(f.db, async () => success); memories.push(other);
  const session = other.store.createSession({ host: "other", projectId: f.project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  const turn = other.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "other", startedAt: at });
  const entry = other.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "other", nativeId: "root", role: "user", text: "other", raw: "{}", calls: [] });
  other.selectEntries(session.id, "main", [entry.id]);
  const tools = other.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id, triggerEntryId: entry.id });
  tools.find(tool => tool.name === "trace")!.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
  const result = tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`,
    text: "independent competitor", category: "constraint", scope: "project", supports: [`F${f.fact}`], topics: [], reason: "compete" }], skipped: [] });
  expect(result).toContain("applicable consuming successor from independent target session");
  expect(result).toContain(`current: K${f.base.knowledgeId}@${successor}`);
  expect(result).toContain("re-read the exact current K@commit and resubmit");
});

test("34b: a consumed supplied event succeeds with exact settlement and no adopted certificate", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = pathFixture(async () => { entered(); await held; return success; });
  const pending = f.memory.dream({ sessionId: f.session.id, branch: "left", headTurnId: f.turn.id, triggerEntryId: f.left.id });
  await started;
  const rival = update(f, "left", f.left.id, "rival result");
  expect(rival).not.toContain("rejected:");
  const rivalCommit = JSON.parse(rival).committed[0].commit as number;
  release();
  const result = await pending;
  expect(result.outcome).toBe("success");
  if (!("runId" in result)) throw new Error("missing run id");
  const response = JSON.parse(f.store.getRun(result.runId)!.response!);
  expect(response.check.resultIds).toEqual([]);
  expect(response.check.eventIds).toEqual([f.base.commit]);
  expect(response.check.totals).toHaveLength(4);
  expect(response.check.totals.map((total: { scope: string }) => total.scope)).toEqual([
    "global", `project:${f.project.id}`, `session:${f.session.id}`, `applicable:S${f.session.id}/left/T${f.turn.id}`,
  ]);
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events ORDER BY event_id").all().map(row => Number(row.event_id))).toEqual([f.base.commit]);
  expect(f.store.db.prepare("SELECT commit_id FROM processed_knowledge_versions ORDER BY commit_id").all()).toEqual([]);
  expect(f.store.isKnowledgeProcessed(rivalCommit)).toBe(false);
  expect(f.store.pendingKnowledgeEvents({ sessionId: f.session.id, branch: "left", headTurnId: f.turn.id }).map(event => event.id)).toEqual([rivalCommit]);
});

test("34b: a core-verified stale Dreamer operation is skipped, but an arbitrary stale base is not", async () => {
  let f!: ReturnType<typeof pathFixture>;
  f = pathFixture(async task => {
    const rival = update(f, "left", f.left.id, "rival before stale submission");
    expect(rival).not.toContain("rejected:");
    const memory = task.tools.find(tool => tool.name === "memory")!;
    expect(memory.execute({ operations: [{ op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`, text: "losing result",
      category: "constraint", scope: "project", supports: [`F${f.fact}`], topics: [], reason: "losing write" }], skipped: [] }))
      .toContain("competing consuming successor");
    return success;
  });
  const result = await f.memory.dream({ sessionId: f.session.id, branch: "left", headTurnId: f.turn.id, triggerEntryId: f.left.id });
  expect(result.outcome).toBe("success");
  expect(f.store.taskFailures(f.session.id)).toMatchObject([{ phase: "dreaming", count: 0 }]);
  expect(f.store.listKnowledgeRevisions(f.base.knowledgeId).map(revision => revision.text)).toEqual(["base", "rival before stale submission"]);

  const other = JSON.parse(update(f, "right", f.right.id, "independent pending result")).committed[0].commit as number;
  const failed = await f.memory.dream({ sessionId: f.session.id, branch: "right", headTurnId: f.turn.id, triggerEntryId: f.right.id });
  expect(failed.outcome).toBe("failure");
  expect(f.store.isKnowledgeProcessed(other)).toBe(false);
  expect(f.store.taskFailures(f.session.id)).toContainEqual(expect.objectContaining({ phase: "dreaming", count: 1 }));
});

test("34b: a later invalid batch cannot reuse a prior verified competitive skip", async () => {
  let f!: ReturnType<typeof pathFixture>;
  f = pathFixture(async task => {
    expect(update(f, "left", f.left.id, "rival")).not.toContain("rejected:");
    const memory = task.tools.find(tool => tool.name === "memory")!;
    expect(memory.execute({ operations: [{ op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`,
      text: "stale", category: "constraint", scope: "project", supports: [`F${f.fact}`], topics: [], reason: "stale" }], skipped: [] }))
      .toContain("competing consuming successor");
    expect(memory.execute({ operations: [{ op: "create", text: "not allowed", category: "constraint", scope: "project",
      supports: [], topics: [], reason: "invalid" }], skipped: [] })).toContain("rejected:");
    return success;
  });
  const result = await f.memory.dream({ sessionId: f.session.id, branch: "left", headTurnId: f.turn.id, triggerEntryId: f.left.id });
  expect(result.outcome).toBe("failure");
  expect(f.store.db.prepare("SELECT * FROM settled_knowledge_events").all()).toEqual([]);
  expect(f.store.db.prepare("SELECT * FROM processed_knowledge_versions").all()).toEqual([]);
  expect(f.store.taskFailures(f.session.id)).toContainEqual(expect.objectContaining({ phase: "dreaming", count: 1 }));
});

test("34b: shared-result peer propagation blocks the whole oversized group while an independent event completes", async () => {
  const f = pathFixture();
  const left = f.memory.tools(f.path("left", f.left.id));
  const created = JSON.parse(left.find(tool => tool.name === "memory")!.execute({ operations: [
    { op: "create", text: "second", category: "constraint", scope: "project", supports: [`F${f.fact}`], topics: [], reason: "second" },
    { op: "create", text: "independent ".repeat(1000), category: "constraint", scope: "project", supports: [`F${f.fact}`], topics: [], reason: "independent" },
  ], skipped: [] }));
  const second = created.committed[0] as { knowledgeId: number; commit: number };
  const independent = created.committed[1] as { knowledgeId: number; commit: number };
  const target = { sessionId: f.session.id, branch: "right", headTurnId: f.turn.id, triggerEntryId: f.right.id };
  f.store.retainDreamingRange(target, [f.base.commit, second.commit, independent.commit],
    [f.base.knowledgeId, second.knowledgeId, independent.knowledgeId]);

  left.find(tool => tool.name === "trace")!.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
  left.find(tool => tool.name === "trace")!.execute({ address: `K${second.knowledgeId}@${second.commit}`, itemBudget: null });
  const merged = JSON.parse(left.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "merge",
    id: `K${f.base.knowledgeId}@${f.base.commit}`, absorb: [`K${second.knowledgeId}@${second.commit}`],
    text: "shared ".repeat(6000), category: "constraint", scope: "project", supports: [`F${f.fact}`], topics: [], reason: "shared merge" }], skipped: [] })).committed[0] as { knowledgeId: number; commit: number };
  const right = f.memory.tools(f.path("right", f.right.id));
  right.find(tool => tool.name === "trace")!.execute({ address: `K${second.knowledgeId}@${second.commit}`, itemBudget: null });
  const peer = JSON.parse(right.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "update",
    id: `K${second.knowledgeId}@${second.commit}`, text: "peer ".repeat(6000), category: "constraint", scope: "project",
    supports: [`F${f.fact}`], topics: [], reason: "divergent peer" }], skipped: [] })).committed[0] as { knowledgeId: number; commit: number };

  f.setAgent(async task => {
    expect(task.material.changed).toContain(`K${independent.knowledgeId}@${independent.commit}`);
    expect(task.material.changed).not.toContain(`K${merged.knowledgeId}@${merged.commit}`);
    expect(task.material.changed).not.toContain(`K${peer.knowledgeId}@${peer.commit}`);
    skipRest(task);
    const receipt = task.tools.find(tool => tool.name === "check")!.execute({});
    expect(receipt).toContain("- supplied formal events: 1");
    expect(receipt).toContain("Blockers: none");
    expect(receipt).not.toContain(`K@${independent.commit}`);
    return success;
  });
  const result = await f.memory.dream(target);
  expect(result.outcome).toBe("success");
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events").all().map(row => Number(row.event_id))).toEqual([independent.commit]);
  expect(f.store.db.prepare("SELECT commit_id FROM processed_knowledge_versions").all().map(row => Number(row.commit_id))).toEqual([independent.commit]);
  const remaining = f.store.pendingKnowledgeEvents(target).map(event => event.id);
  expect(remaining).toEqual(expect.arrayContaining([f.base.commit, second.commit, merged.commit, peer.commit]));
  expect(remaining).not.toContain(independent.commit);
});

test("34b/35b: a restored exact version is reported honestly as pending work by the bound check", async () => {
  const f = pathFixture();
  const noted = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, branch: "left", createdAt: at }, facts: [{
    turnId: f.turn.id, entryIds: [f.left.id], category: "decision", actor: "user", text: "left-only evidence", source: [`T${f.turn.id}#E2`], createdAt: at,
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const tools = f.memory.tools(f.path("left", f.left.id));
  tools.find(tool => tool.name === "trace")!.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
  const written = tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "update", id: `K${f.base.knowledgeId}@${f.base.commit}`,
    text: "left result", category: "constraint", scope: "project", supports: [`F${noted.facts[0]!.id}`], topics: [], reason: "left-only update" }], skipped: [] });
  const successor = JSON.parse(written).committed[0].commit as number;
  const leftPath = { sessionId: f.session.id, branch: "left", headTurnId: f.turn.id };
  const range = f.store.retainDreamingRange(leftPath, [f.base.commit]);
  const run = f.store.recordRun({ kind: "dreaming", sessionId: f.session.id, branch: leftPath.branch,
    dreamingRangeId: range.id, createdAt: at, outcome: "success" });
  f.store.completeDreaming(run.id, [f.base.commit], [successor]);
  const rootPath = { sessionId: f.session.id, branch: "root", headTurnId: f.turn.id };
  expect(f.store.currentCommit(f.base.knowledgeId, rootPath).map(revision => revision.id)).toEqual([f.base.commit]);
  expect(f.store.pendingKnowledgeEvents(rootPath).map(event => event.id)).toEqual([f.base.commit]);
  expect(f.memory.taskEligibility("dreaming", rootPath)).toEqual({ due: true });
  f.setAgent(async task => {
    const receipt = task.tools.find(tool => tool.name === "check")!.execute({});
    expect(receipt).toContain("- pending obligations: 1 (change events 0; exact versions 1)");
    return success;
  });
  expect((await f.memory.dream(rootPath)).outcome).toBe("success");
});

test.each([
  { name: "divergent inapplicable", support: "right" as const, target: "left" as const, certified: true },
  { name: "divergent applicable", support: "shared" as const, target: "left" as const, certified: false },
  { name: "descendant inapplicable", support: "right" as const, target: "root" as const, certified: false },
])("47 certification: $name successor follows lineage-or-applicable", async ({ support, target, certified }) => {
  let f!: ReturnType<typeof pathFixture>, successorCommit = 0;
  f = pathFixture(async task => {
    skipRest(task);
    let fact = f.fact;
    if (support === "right") {
      const noted = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, branch: "right", createdAt: at }, facts: [{
        turnId: f.turn.id, entryIds: [f.right.id], category: "decision", actor: "user", text: "right-only certification evidence",
        source: [`T${f.turn.id}#E3`], createdAt: at,
      }] });
      if (!noted.ok) throw new Error(noted.problems.join("; "));
      fact = noted.facts[0]!.id;
    }
    const right = f.memory.tools(f.path("right", f.right.id));
    right.find(tool => tool.name === "trace")!.execute({ address: `K${f.base.knowledgeId}@${f.base.commit}`, itemBudget: null });
    const successor = right.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "update",
      id: `K${f.base.knowledgeId}@${f.base.commit}`, text: `${support} successor`, category: "constraint", scope: "project",
      supports: [`F${fact}`], topics: [], reason: "certification successor" }], skipped: [] });
    expect(successor).not.toContain("rejected:");
    successorCommit = JSON.parse(successor).committed[0].commit as number;
    return success;
  });
  const selected = target === "root"
    ? { sessionId: f.session.id, branch: "root", headTurnId: f.turn.id, triggerEntryId: f.root.id }
    : { sessionId: f.session.id, branch: "left", headTurnId: f.turn.id, triggerEntryId: f.left.id };
  const result = await f.memory.dream(selected);
  expect(result.outcome).toBe("success");
  expect(f.store.isKnowledgeProcessed(f.base.commit)).toBe(certified);
  const runId = (result as { runId: number }).runId;
  const completion = f.store.db.prepare("SELECT result_ids FROM dreaming_completions WHERE run_id = ?").get(runId)!;
  expect(JSON.parse(String(completion.result_ids))).toEqual(certified ? [f.base.commit] : []);
  if (support === "shared") {
    expect(f.store.isKnowledgeProcessed(successorCommit)).toBe(false);
    expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events WHERE event_id = ?").get(successorCommit)).toBeUndefined();
    expect(f.store.pendingKnowledgeEvents(selected).map(event => event.id)).toContain(successorCommit);
    const rangeId = Number(f.store.db.prepare("SELECT range_id FROM dreaming_run_ranges WHERE run_id = ?").get(runId)!.range_id);
    const retained = f.store.dreamingRange(rangeId, true)!;
    expect([...retained.eventIds, ...retained.versionIds, ...f.store.dreamingOwnCommits(rangeId)]).not.toContain(successorCommit);
  }
});

test("47 certification: unknown required same-session successor provenance fails explicitly", async () => {
  const f = pathFixture();
  const noted = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, branch: "right", createdAt: at }, facts: [{
    turnId: f.turn.id, entryIds: [f.right.id], category: "decision", actor: "user", text: "unknown-origin right evidence",
    source: [`T${f.turn.id}#E3`], createdAt: at,
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const successor = f.store.commitConsolidationRun({ path: { sessionId: f.session.id, branch: "right", headTurnId: f.turn.id },
    run: { kind: "manual", sessionId: f.session.id, branch: "right", createdAt: at }, operations: [{ op: "update",
      knowledgeId: f.base.knowledgeId, baseCommit: f.base.commit, text: "unknown-origin successor", category: "constraint", scope: "project",
      supports: [noted.facts[0]!.id], topics: [], reason: "unknown", createdAt: at }] });
  if (!successor.ok) throw new Error(successor.problems.join("; "));
  const result = await f.memory.dream({ sessionId: f.session.id, branch: "left", headTurnId: f.turn.id, triggerEntryId: f.left.id });
  expect(result.outcome).toBe("failure");
  expect("problems" in result ? result.problems.join(" ") : "").toContain("trigger ancestry is unknown");
  expect(f.store.isKnowledgeProcessed(f.base.commit)).toBe(false);
});
