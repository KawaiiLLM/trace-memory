import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { curatePrefix } from "../../../src/core/dreaming/curate.ts";
import { TraceMemory, type DreamingAgentInput } from "../../../src/core/api/index.ts";
import { applyWorkspace } from "../../../src/core/workspace/index.ts";
import { coverKnowledge, curateNow, curateWrite, scriptedDreamer } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { Store, type KnowledgePath } from "../../../src/core/store/index.ts";
import { declarationContext } from "../project-declaration-context.ts";
import { archive, clearSupports, entry, knowledge, knowledgeBatch, legacyFacts, updateKnowledge } from "../../support/seed.ts";
import { operationOfText } from "../../support/dreamer.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

type Fixture = ReturnType<typeof setup>;

function setup(store = new Store(":memory:"), projectName = "A", projectId?: number, host = `${projectName}-${Math.random()}`) {
  if (!stores.includes(store)) stores.push(store);
  const project = projectId === undefined
    ? store.findProjectByName(projectName) ?? store.createProject({ name: projectName, declaredBy: "mark" })
    : store.getProject(projectId)!;
  const session = store.createSession({ host, enrollmentChoice: true, projectId: project.id,
    projectDeclaration: "mark", startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture",
    nativeId: `evidence-${turn.id}`, role: "user", text: "evidence", raw: "evidence", calls: [] });
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#user`],
    entryIds: [entry.id], createdAt: "now",
  }] });
  if (noted.ok) expect(store.factEntries(noted.facts[0]!.id)).toEqual([entry.id]);
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const create = (scope: "global" | "project" | "session", text = `${scope} body`) => {
    const result = store.commitConsolidationRun({ path: target,
      run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" }, operations: [{
        op: "create", title: "Fixture title", handle: "$1", author: "test", text, category: "constraint", scope,
        supports: [noted.facts[0]!.id], topics: [], reason: "test", createdAt: "now",
      }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  return { store, project, session, turn, fact: noted.facts[0]!, target, create };
}

/** A passed curate over the session's pools (stage 4 §2.1): every live item of those pools becomes covered. */
function processPool(f: Fixture) {
  coverKnowledge(f.store, f.target, f.store.curateItems(f.target).map(item => item.value.revision.id));
}
/** The live versions of one of the session's pools that no curate has covered; `all` ignores coverage. */
const inPool = (store: Store, path: KnowledgePath, pool: string, all = false) =>
  store.curateItems(path).filter(item => item.pool === pool && (all || !item.covered)).map(item => item.value.revision.id);
/** An archive statement a manual writer may give (kind `budget` is refused for new writes since stage 4). */
const WITHDRAWN = "The user withdrew this rule and nothing replaces it; the grounds are in the cited evidence.";
const archiveOp = (f: Fixture, base: { knowledgeId: number; commit: number }) => ({ op: "archive" as const, kind: "invalid" as const,
  knowledgeId: base.knowledgeId, baseCommit: base.commit, supports: [f.fact.id], reason: "done", text: WITHDRAWN, createdAt: "now" });

function update(f: Fixture, base: { knowledgeId: number; commit: number }, text: string,
  scope: "global" | "project" | "session" = "global") {
  const result = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" }, path: f.target, operations: [{ op: "update",
    knowledgeId: base.knowledgeId, baseCommit: base.commit, text, category: "constraint", scope,
    supports: [f.fact.id], topics: [], reason: "maintenance", createdAt: "now" }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!;
}

test("64c current versions: global is shared, project is shared only within its project, and session stays local", () => {
  const a = setup(), same = setup(a.store, "A", a.project.id), other = setup(a.store, "B");
  const global = a.create("global"), project = a.create("project"), session = a.create("session");
  expect(inPool(a.store, a.target, "global")).toEqual([global.commit]);
  expect(inPool(a.store, other.target, "global")).toEqual([global.commit]);
  expect(inPool(a.store, same.target, `project:${a.project.id}`)).toEqual([project.commit]);
  expect(inPool(a.store, other.target, `project:${other.project.id}`)).toEqual([]);
  expect(inPool(a.store, a.target, `session:${a.session.id}`)).toEqual([session.commit]);
  expect(inPool(a.store, same.target, `session:${a.session.id}`)).toEqual([]);
  processPool(a);
  expect(inPool(a.store, other.target, "global")).toEqual([]);
  expect(inPool(a.store, same.target, `project:${a.project.id}`)).toEqual([]);
});

test("64c current versions: repeated updates count once at the latest revision and archives count zero", () => {
  const f = setup(), item = f.create("global", "v1");
  const v2 = update(f, item, "v2 with more body");
  const v3 = update(f, v2, "v3 is the only current body");
  const live = f.store.curateItems(f.target);
  expect(live).toHaveLength(1);
  expect(live[0]!.value.revision).toMatchObject({ knowledgeId: item.knowledgeId, id: v3.commit, text: "v3 is the only current body" });

  const archived = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" }, path: f.target,
    operations: [archiveOp(f, v3)] });
  expect(archived.ok).toBe(true);
  expect(f.store.curateItems(f.target)).toEqual([]);
});

test("64c current versions: session visibility follows the selected branch and rewind to no current does not throw", () => {
  const store = new Store(":memory:"); stores.push(store);
  const project = store.createProject({ name: "branches", declaredBy: "mark" });
  const session = store.createSession({ host: "branches", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const root = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: "now" });
  const left = store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "left", startedAt: "now" });
  const right = store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "right", startedAt: "now" });
  const entry = (turnId: number, id: string) => store.appendSourceEntry({ sessionId: session.id, turnId, nativeLineage: "native", nativeId: id,
    role: "user", text: id, raw: id, calls: [] });
  const er = entry(root.id, "root"), el = entry(left.id, "left"), eg = entry(right.id, "right");
  store.selectSourcePath(session.id, "left", [er.id, el.id]);
  store.selectSourcePath(session.id, "right", [er.id, eg.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "left", createdAt: "now" }, facts: [{
    turnId: left.id, category: "decision", actor: "user", text: "left evidence", source: [`T${left.id}#user`], entryIds: [el.id], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const made = store.commitConsolidationRun({ path: { sessionId: session.id, branch: "left", headTurnId: left.id },
    run: { kind: "manual", sessionId: session.id, branch: "left", createdAt: "now" }, operations: [{ op: "create", title: "Fixture title", handle: "$1",
      author: "test", text: "left only", category: "constraint", scope: "session", supports: [noted.facts[0]!.id], topics: [], reason: "test", createdAt: "now" }] });
  if (!made.ok) throw new Error(made.problems.join("; "));
  store.setCurrentPath(session.id, "left", left.id, "lineage");
  expect(inPool(store, { sessionId: session.id, branch: "left", headTurnId: left.id }, `session:${session.id}`)).toHaveLength(1);
  store.setCurrentPath(session.id, "right", right.id, "lineage");
  expect(inPool(store, { sessionId: session.id, branch: "right", headTurnId: right.id }, `session:${session.id}`)).toEqual([]);
});

test("64c current versions: merge absorption yields one current identity and split yields the item and its children", () => {
  const merged = setup(), first = merged.create("global", "first"), second = merged.create("global", "second");
  const [merge] = curateWrite(merged, merged.target, [{ op: "merge",
    intoKnowledgeId: first.knowledgeId, intoBaseCommit: first.commit, absorb: [{ knowledgeId: second.knowledgeId, baseCommit: second.commit }],
    text: "merged", category: "constraint", scope: "global", supports: [], topics: [], reason: "deduplicate", createdAt: "now" }]);
  expect(inPool(merged.store, merged.target, "global", true)).toEqual([merge!.commit]);

  const split = setup(), parent = split.create("global", "mixed");
  const result = curateWrite(split, split.target, [{ op: "split",
    knowledgeId: parent.knowledgeId, baseCommit: parent.commit, text: "mixed, primary part", category: "constraint", scope: "global", topics: [], supports: [], reason: "separate", createdAt: "now",
    children: [{ title: "Fixture child", text: "one", category: "constraint", topics: [] }, { title: "Fixture child", text: "two", category: "constraint", topics: [] }] }]);
  // The split item continues as its primary part beside its two children: three current versions.
  expect(result).toHaveLength(3);
  expect(result[0]!.knowledgeId).toBe(parent.knowledgeId);
  expect(inPool(split.store, split.target, "global", true)).toEqual(result.map(v => v.commit).sort((x, y) => x - y));
});

test("64c current versions: legal P to Q to P declarations preserve pair semantics and an acyclic project graph", () => {
  const f = setup(), projectItem = f.create("project");
  processPool(f);
  const globalItem = f.create("global"), sessionItem = f.create("session");
  const beforeGlobal = inPool(f.store, f.target, "global");
  const beforeSession = inPool(f.store, f.target, `session:${f.session.id}`);
  const q = f.store.createProject({ name: "Q", declaredBy: "mark" });
  f.store.declareProject(f.session.id, q.name, "mark", declarationContext(f.store, f.target));
  expect(inPool(f.store, f.target, `project:${q.id}`)).toEqual([projectItem.commit]);
  expect(inPool(f.store, f.target, "global")).toEqual(beforeGlobal);
  expect(inPool(f.store, f.target, `session:${f.session.id}`)).toEqual(beforeSession);
  f.store.declareProject(f.session.id, f.project.name, "mark", declarationContext(f.store, f.target));
  expect(inPool(f.store, f.target, `project:${f.project.id}`)).toEqual([projectItem.commit]);
  expect([globalItem.commit, sessionItem.commit]).toEqual([beforeGlobal[0], beforeSession[0]]);
  expect(f.store.getProject(f.project.id)!.mergedInto).toBeNull();
  expect(f.store.getProject(q.id)!.mergedInto).toBeNull();
  expect(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_event%'").all()).toEqual([]);
});

// 126 writable set: a curate batch may update, archive or split an item in each of the session's pools.
test.each(["update", "archive", "split"] as const)("126 writable set: one curate file may %s knowledge in each of the session's pools", op => {
  const f = setup(), items = (["global", "project", "session"] as const).map(scope => f.create(scope, `${scope} item`));
  const operation = (base: { knowledgeId: number; commit: number }, scope: "global" | "project" | "session") => op === "update"
    ? { op, knowledgeId: base.knowledgeId, baseCommit: base.commit, text: `${scope} rewritten`, category: "constraint" as const, scope,
      supports: [], topics: [], reason: "maintenance", createdAt: "now" }
    : op === "archive" ? { ...archiveOp(f, base), supports: [] }
    : { op, knowledgeId: base.knowledgeId, baseCommit: base.commit, text: `${scope} primary`, category: "constraint" as const, scope, topics: [], supports: [], reason: "separate", createdAt: "now",
      children: [{ title: "Fixture child", text: "one", category: "constraint" as const, topics: [] }, { title: "Fixture child", text: "two", category: "constraint" as const, topics: [] }] };
  curateWrite(f, f.target, items.map((item, index) => operation(item, (["global", "project", "session"] as const)[index]!)));
  expect(items.map(item => f.store.currentCommit(item.knowledgeId, f.target)[0]?.id ?? null).every(id => !items.some(item => item.commit === id))).toBe(true);
});

/** Another project's item: never in this session's pools. */
function foreignItem(f: Fixture) {
  const other = setup(f.store, "elsewhere");
  return other.create("project", "another project's item");
}

test.each(["update", "archive", "split"] as const)("126 writable set: a %s base outside the session's pools is refused without side effects", op => {
  const f = setup(), own = f.create("global"), foreign = foreignItem(f);
  const ref = `K${foreign.knowledgeId}@v1`, supports = f.store.knowledgeRevision(foreign.commit)!.supports.map(id => `F${id}`).join(", ");
  const text = op === "update" ? block(`update ${ref}`, { reason: "cross pool" }, "forbidden")
    : op === "archive" ? block(`archive ${ref}`, { kind: "invalid", reason: "cross pool" }, WITHDRAWN)
    : block(`split ${ref}`, { reason: "cross pool" }, "forbidden") + `\n### child\ntitle: Fixture child\ncategory: constraint\nscope: project\ntopics:\nsupports: ${supports}\nreason: cross pool\n\none\n`;
  const before = { revisions: f.store.listKnowledgeRevisions(), links: f.store.listKnowledgeLinks(foreign.knowledgeId) };
  const result = applyWorkspace(f.store, { kind: "curate", operation: operationOfText(text), sessionId: f.session.id, path: f.target, file: { name: "curate.md", text } });
  // Either the file fails its check or the block is refused; in both nothing is written and the reason names the foreign version.
  const reasons = result.ok ? result.blocks.flatMap(entry => entry.status === "refused" ? [entry.reason ?? ""] : []) : result.problems;
  expect(reasons.length).toBeGreaterThan(0);
  expect(reasons.join(" ")).toContain(ref);
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  expect(f.store.listKnowledgeLinks(foreign.knowledgeId)).toEqual(before.links);
  expect(inPool(f.store, f.target, "global")).toContain(own.commit);
});

test("64c merge scope: merge parents from two of the session's pools are refused without side effects", () => {
  const f = setup(), global = f.create("global"), project = f.create("project");
  const before = { revisions: f.store.listKnowledgeRevisions(), links: f.store.listKnowledgeLinks(project.knowledgeId) };
  const result = applyWorkspace(f.store, { kind: "curate", operation: "merge", sessionId: f.session.id, path: f.target, file: { name: "curate.md", text:
    block(`merge K${global.knowledgeId}@v1`, { absorb: `K${project.knowledgeId}@v1`, category: "constraint", scope: "global", reason: "cross pool" }, "forbidden merge") } });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problems.join(" ")).toContain("merged items share one scope");
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  expect(f.store.listKnowledgeLinks(project.knowledgeId)).toEqual(before.links);
});

test("67: create batches skip writer graphs while consuming operations recheck after prior mutations", () => {
  const f = setup(), graph = vi.spyOn(f.store, "commitGraphInput");
  try {
    const operations = Array.from({ length: 30 }, (_, i) => ({ op: "create" as const, title: "Fixture title", handle: `$${i}`, author: "test",
      text: `body ${i}`, category: "constraint" as const, scope: "global" as const, supports: [f.fact.id], topics: [], reason: "test", createdAt: "now" }));
    const created = f.store.commitConsolidationRun({ path: f.target,
      run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" }, operations });
    expect(created.ok).toBe(true);
    expect(graph).not.toHaveBeenCalled();
    const before = f.store.listKnowledgeRevisions();
    const bad = f.store.commitConsolidationRun({ path: f.target,
      run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" },
      operations: [operations[0]!, { ...operations[1]!, supports: [999_999] }] });
    expect(bad.ok).toBe(false);
    expect(f.store.listKnowledgeRevisions()).toEqual(before);
    const base = before[0]!;
    const archived = archiveOp(f, { knowledgeId: base.knowledgeId, commit: base.id });
    graph.mockClear();
    const consumed = f.store.commitConsolidationRun({ path: f.target,
      run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" }, operations: [archived, archived] });
    expect(consumed.ok).toBe(false);
    expect(graph).toHaveBeenCalledTimes(2);
    expect(f.store.listKnowledgeRevisions()).toEqual(before);
  } finally { graph.mockRestore(); }
});

test("67: the Dreamer's due read batches graph and processing history independently of identity count", () => {
  const f = setup();
  const graphInput = vi.spyOn(f.store, "commitGraphInput"), graph = vi.spyOn(f.store, "commitGraph");
  const prepare = vi.spyOn(f.store.db, "prepare");
  const prepares: number[] = [];
  try {
    for (const count of [3, 60]) {
      for (let i = count === 3 ? 0 : 3; i < count; i++)
        knowledge(f.store, f.target, (["global", "project", "session"] as const)[i % 3]!, "constraint", [f.fact.id], `rule ${i}`); // Noter versions: they count
      graphInput.mockClear(); graph.mockClear(); prepare.mockClear();
      const start = performance.now();
      const changed = f.store.noterOperations(f.target);
      const elapsedMs = performance.now() - start;
      expect(changed).toBe(count);
      expect(f.store.noterOperations(f.target)).toBe(count);
      expect(graphInput).toHaveBeenCalledTimes(2); // one per read, never one per identity
      expect(graph).toHaveBeenCalledTimes(1); // the second read takes the live-set memo of the first
      prepares.push(prepare.mock.calls.length);
      expect(prepare.mock.calls.length).toBeLessThanOrEqual(25);
      console.info(JSON.stringify({ fixture: "67 pool projection", count, elapsedMs, prepares: prepare.mock.calls.length }));
    }
    expect(prepares[1]).toBeLessThanOrEqual(prepares[0]!); // twenty times the identities, no more statements
    graphInput.mockClear();
    f.store.dreamingDue(f.target);
    expect(graphInput).toHaveBeenCalledTimes(1);
  } finally { graphInput.mockRestore(); graph.mockRestore(); prepare.mockRestore(); }
});

test("92: the pool read rejects a live version whose tag is missing", () => {
  const f = setup(), item = f.create("global");
  expect(f.store.curateItems(f.target)).toHaveLength(1);
  f.store.db.prepare("DELETE FROM knowledge_version_tags WHERE commit_id = ?").run(item.commit);
  expect(() => f.store.curateItems(f.target)).toThrow();
});

test("67: atomic admission preserves competing seats, reserved takeover and expired-claim fences", () => {
  const f = setup(), other = setup(f.store, "B");
  for (const value of [f, other]) knowledge(f.store, value.target, "global", "constraint", [value.fact.id], "evidence ".repeat(25)); // Noter versions make a Dreamer due
  const admit = (value: Fixture, executor: string) => f.store.acquireClaim(value.target, "dreaming", executor, false, () => true, 1);
  const commit = (value: Fixture, claim: NonNullable<ReturnType<typeof admit>>) => f.store.commitTaskPass({
    run: { kind: "dreaming", sessionId: value.session.id, branch: "main", createdAt: "now", claim }, path: value.target, handoff: () => null });
  const first = admit(f, "first")!;
  expect(first).not.toBeNull();
  expect(admit(other, "competitor")).toBeNull(); // one database-wide Dreamer seat
  expect(admit(f, "first")).toBeNull();
  expect(f.store.getClaim(f.session.id, "dreaming")!.token).toBe(first.token);

  f.store.reopenSession(f.session.id, "replacement");
  const reserved = f.store.getClaim(f.session.id, "dreaming")!;
  expect(reserved.reserved).toBe(true);
  const replacement = admit(f, "replacement")!;
  expect(replacement).not.toBeNull();
  expect(replacement.token).toBe(reserved.token);
  expect(replacement.reserved).toBe(false);
  expect(() => commit(f, first)).toThrow(/claim/);

  f.store.db.prepare("UPDATE task_claims SET expires_at = ? WHERE token = ?").run(Date.now() - 1, replacement.token);
  expect(admit(other, "competitor")).not.toBeNull();
  expect(() => commit(f, replacement)).toThrow(/claim/);
});

test("67: admission observes intervening knowledge mutation and preserves enrollment/borrowed guards", () => {
  const f = setup();
  const item = knowledge(f.store, f.target, "global", "constraint", [f.fact.id], "evidence ".repeat(25));
  expect(f.store.dreamingDue(f.target, 1)).toBe(true);
  const admit = (borrowed = false) => f.store.acquireClaim(f.target, "dreaming", "executor", borrowed, () => true, 1);
  expect(admit(true)).toBeNull(); // borrowing needs a closed session
  f.store.setEnrollment(f.session.id, false);
  expect(admit()).toBeNull();
  f.store.setEnrollment(f.session.id, true);
  const archived = f.store.commitConsolidationRun({ path: f.target,
    run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" },
    operations: [archiveOp(f, item)] });
  expect(archived.ok).toBe(true);
  expect(admit()).toBeNull();
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
});

test("67: facade Dreamer eligibility and explicit pending status each share their pool work", () => {
  const memory = TraceMemory(":memory:", async () => { throw new Error("no model expected"); });
  const f = setup(memory.store), graph = vi.spyOn(memory.store, "commitGraphInput");
  try {
    f.create("global"); f.create("project"); f.create("session");
    graph.mockClear();
    expect(memory.taskEligibility("dreaming", f.target).due).toBe(false);
    expect(graph).toHaveBeenCalledTimes(1);
    graph.mockClear();
    expect(memory.dreamingPending(f.target).state).toBe("known");
    expect(graph).toHaveBeenCalledTimes(1);
  } finally { graph.mockRestore(); memory.close(); stores.splice(stores.indexOf(memory.store), 1); }
});

test("64c current versions: same-project relabel is a processing no-op", () => {
  const f = setup(), item = f.create("project");
  processPool(f);
  const before = f.store.db.prepare("SELECT * FROM knowledge_processed").all();
  f.store.mergeProject(f.project.id, f.project.id);
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual(before);
  expect(inPool(f.store, f.target, `project:${f.project.id}`)).not.toContain(item.commit);
});

test("104: two sessions sharing a pool start one Dreamer run", async () => {
  let release!: () => void, started = 0;
  const memory = TraceMemory(":memory:", async () => {
    started++;
    await new Promise<void>(resolve => { release = resolve; });
    return { outcome: "cancelled", output: "fixture", request: {} };
  }, { dreaming: { triggerOperations: 1 } });
  const a = setup(memory.store, "shared"), b = setup(memory.store, "shared");
  knowledge(memory.store, a.target, "project", "constraint", [a.fact.id], "shared rule ".repeat(30)); // a Noter version: only those make the Dreamer due
  expect([a, b].map(value => memory.taskEligibility("dreaming", value.target).due)).toEqual([true, true]);
  const first = memory.dream(a.target);
  await vi.waitFor(() => expect(started).toBe(1));
  expect(await memory.dream(b.target)).toEqual({ outcome: "dropped" });
  release();
  expect((await first).outcome).not.toBe("dropped");
  expect(started).toBe(1);
});

test.each(["A", "B"] as const)("126: two sessions due at once on the shared global pool run one at a time; %s first, then the other", async opener => {
  let hold = true, release = () => {};
  const dreamer = scriptedDreamer();
  const runs: number[] = [];
  const memory = TraceMemory(":memory:", async raw => {
    runs.push((raw as DreamingAgentInput).sessionId);
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    return dreamer.agent(raw);
  }, { dreaming: { triggerOperations: 1 } });
  const a = setup(memory.store, "A"), b = setup(memory.store, "B");
  const noted = (f: Fixture, scope: "global" | "project", text: string) => knowledge(memory.store, f.target, scope, "constraint", [f.fact.id], text);
  noted(a, "global", "shared rule ".repeat(30));
  noted(a, "project", "A's project rule"); noted(b, "project", "B's project rule");
  const [first, second] = opener === "A" ? [a, b] : [b, a];
  expect([a, b].map(value => memory.taskEligibility("dreaming", value.target).due)).toEqual([true, true]);
  const running = memory.dream(first.target);
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  expect(await memory.dream(second.target)).toEqual({ outcome: "dropped" }); // one database-wide Dreamer seat
  noted(second, "global", "late shared rule"); // written while the first run holds the seat
  hold = false; release();
  expect((await running).outcome).toBe("success");
  expect([...new Set(runs)]).toEqual([first.session.id]); // one conversation per task: the session's run, not the other's
  // The other session still has its own uncovered project rule and the late one: it runs next, then nothing is due.
  expect(memory.taskEligibility("dreaming", second.target).due).toBe(true);
  expect((await memory.dream(second.target)).outcome).toBe("success");
  expect([...new Set(runs)]).toEqual([first.session.id, second.session.id]);
  for (const f of [a, b]) expect(memory.taskEligibility("dreaming", f.target).due).toBe(false);
});

// 139: a story with a covered reference, an updated item, an archived item, a new and a supportless item, whose
// facts are dated `times` (a time that cannot be parsed yields no date). The ids and texts do not depend on `times`.
function datedStory(times: readonly [string, string, string]) {
  const f = setup();
  const source = entry(f.store, f.session.id, f.turn.id, "dated-evidence", "user");
  const [a, b, c] = legacyFacts(f.store, { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" }, times.map((createdAt, i) => ({
    sources: [{ entry: source, address: `T${f.turn.id}#E${source.entryOrdinal}` }], text: `fact ${i}`, category: "decision" as const, actor: "user" as const, createdAt,
  }))).facts.map(fact => fact.id) as [number, number, number];
  const make = (text: string, supports: number[]) => knowledgeBatch(f.store, f.target,
    [{ text, supports, scope: "project", category: "constraint" }], { kind: "manual", createdAt: "now" }).committed[0]!;
  const reference = make("reference rule", [a, b]), changed = make("changed rule", [a]), retired = make("retired rule", [a, b]);
  processPool(f);
  const updated = updateKnowledge(f.store, f.target, changed.knowledgeId, changed.commit, "changed rule, newer", [c]);
  const archived = archive(f.store, f.target, retired.knowledgeId, retired.commit, [c], "invalid", WITHDRAWN);
  const fresh = make("new rule", [c]), bare = make("supportless rule", [c]);
  clearSupports(f.store, bare.commit);
  const read = () => f.store.curateItems(f.target);
  const datesOf = (commit: number) => read().find(item => item.value.revision.id === commit)?.dates;
  return { read, datesOf, ids: { reference, updated, archive: { commit: archived }, fresh, bare }, facts: { a, b, c }, spy: () => vi.spyOn(f.store.db, "prepare"), f };
}

test("139: the curate material shows the UTC date range of the supports of the version shown, for every live item", () => {
  const story = datedStory(["2026-10-01T22:00:00-05:00", "2026-10-05T01:00:00.000Z", "2026-10-03T23:30:00.000Z"]);
  expect(story.datesOf(story.ids.reference.commit)).toBe("2026-10-02..2026-10-05");
  expect(story.datesOf(story.ids.fresh.commit)).toBe("2026-10-03");
  expect(story.datesOf(story.ids.updated.commit)).toBe("2026-10-03"); // its own support, not merged with the earlier version's
  expect(story.datesOf(story.ids.archive.commit)).toBeUndefined(); // an archived item is not live: the curate view does not list it
  expect(story.datesOf(story.ids.bare.commit)).toBeUndefined();
  const prefix = curatePrefix(story.f.store, story.f.target).text;
  expect(prefix).toMatch(/\(\d+ tokens; facts 2026-10-02\.\.2026-10-05\)/);
  expect(prefix).toMatch(/\(\d+ tokens; facts 2026-10-03\)/);
});

test("139: the dates never count toward item tokens", () => {
  const dated = datedStory(["2026-10-01T22:00:00-05:00", "2026-10-05T01:00:00.000Z", "2026-10-03T23:30:00.000Z"]);
  const plain = datedStory(["now", "now", "now"]);
  const withDates = curatePrefix(dated.f.store, dated.f.target).text, without = curatePrefix(plain.f.store, plain.f.target).text;
  expect(without).not.toContain("facts 20");
  expect(withDates).toContain("facts 20");
  // The label on every item states the same cost, with or without dates.
  const cost = (text: string) => [...text.matchAll(/\((\d+) tokens[;)]/g)].map(match => match[1]);
  expect(cost(withDates)).toEqual(cost(without));
});

test("139: the fact dates of the whole material cost no per-item or per-fact query", () => {
  const story = datedStory(["2026-10-01T22:00:00-05:00", "2026-10-05T01:00:00.000Z", "2026-10-03T23:30:00.000Z"]);
  const prepare = story.spy();
  try {
    story.read();
    const reads = prepare.mock.calls.map(([sql]) => sql).filter(sql => /\bFROM facts\b/.test(sql));
    expect(reads.length).toBeLessThanOrEqual(1); // the single batched read of the graph input, shared with the citation checks
    for (const sql of reads) expect(sql).toContain("json_each");
  } finally { prepare.mockRestore(); }
});
