import { afterEach, expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import type { RunInput } from "../../../src/core/store/index.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";

const at = "2026-09-20T13:00:00Z";
let open: ReturnType<typeof sourceSeededMemory> | undefined;
afterEach(() => open?.close());

function pathFixture() {
  const memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model expected"); });
  open = memory;
  const project = memory.store.createProject({ name: "64b-path-policy", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "policy", projectId: project.id, enrollmentChoice: true,
    startedAt: at, firstReplyAt: at });
  const root = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: at });
  const left = memory.store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "left", startedAt: at });
  const right = memory.store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "right", startedAt: at });
  const compact = memory.store.appendTurn({ sessionId: session.id, parentTurnId: left.id, kind: "compaction", startedAt: at });
  const entries = memory.store.listSourceEntries(session.id);
  const ids = (turns: number[]) => entries.filter(entry => turns.includes(entry.turnId)).map(entry => entry.id);
  memory.selectEntries(session.id, "left", ids([root.id, left.id]));
  memory.selectEntries(session.id, "right", ids([root.id, right.id]));
  memory.selectEntries(session.id, "headless", []);
  return { memory, session, root, left, right, compact };
}

test("64b: a persisted foreground requires a coherent branch/head pair without rejecting valid host prefixes", () => {
  const f = pathFixture();
  expect(f.memory.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dreaming_family'").get()).toBeUndefined();

  expect(() => f.memory.store.setCurrentPath(f.session.id, "left", f.root.id, "test-lineage")).not.toThrow();
  expect(() => f.memory.store.setCurrentPath(f.session.id, "left", f.compact.id, "test-lineage")).not.toThrow();
  expect(() => f.memory.store.setCurrentPath(f.session.id, "headless", f.compact.id, "test-lineage")).not.toThrow();

  expect(() => f.memory.store.setCurrentPath(f.session.id, "left", f.right.id, "test-lineage"))
    .toThrow("is not coherent with branch left");
});

function retainedFixture() {
  const f = pathFixture(), store = f.memory.store;
  const entries = store.listSourceEntries(f.session.id);
  const rootEntry = entries.find(entry => entry.turnId === f.root.id)!;
  const leftEntry = entries.find(entry => entry.turnId === f.left.id)!;
  const noted = store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, branch: "left", createdAt: at },
    entryIds: [rootEntry.id, leftEntry.id], facts: [
      { turnId: f.root.id, category: "decision", actor: "user", text: "stable root", source: [`T${f.root.id}#E${rootEntry.entryOrdinal}`], entryIds: [rootEntry.id], createdAt: at },
      { turnId: f.left.id, category: "decision", actor: "user", text: "left-only obligation", source: [`T${f.left.id}#E${leftEntry.entryOrdinal}`], entryIds: [leftEntry.id], createdAt: at },
    ] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  // Noter-written: only the Noter's changes make a Dreamer due (2026-10-22 trigger).
  const create = (text: string, support: number) => commitNoterKnowledge(store, {
    path: { sessionId: f.session.id, branch: "left", headTurnId: f.left.id },
    run: { sessionId: f.session.id, branch: "left", createdAt: at }, operations: [{ files: null, op: "create", title: "Fixture title", handle: `$${text}`,
      author: "test", text, category: "constraint", scope: "project", supports: [support], topics: [], reason: "fixture", createdAt: at }],
  });
  const stable = create("stable", noted.facts[0]!.id);
  if (!stable.ok) throw new Error("could not create retained fixture");
  const foreign = store.createSession({ host: "foreign", projectId: f.session.projectId, enrollmentChoice: true,
    startedAt: at, firstReplyAt: at });
  const foreignRoot = store.appendTurn({ sessionId: foreign.id, kind: "turn", userPrompt: "foreign root", startedAt: at });
  const foreignChild = store.appendTurn({ sessionId: foreign.id, parentTurnId: foreignRoot.id, kind: "turn", userPrompt: "foreign child", startedAt: at });
  const foreignEntries = store.listSourceEntries(foreign.id);
  store.selectSourcePath(foreign.id, "root", [foreignEntries.find(entry => entry.turnId === foreignRoot.id)!.id]);
  store.selectSourcePath(foreign.id, "child", foreignEntries.map(entry => entry.id));
  const foreignEntry = foreignEntries.find(entry => entry.turnId === foreignChild.id)!;
  const foreignNoted = store.commitNotingRun({ run: { kind: "noting", sessionId: foreign.id, branch: "child", createdAt: at },
    entryIds: [foreignEntry.id], facts: [{ turnId: foreignChild.id, category: "decision", actor: "user", text: "foreign-only obligation",
      source: [`T${foreignChild.id}#E${foreignEntry.entryOrdinal}`], entryIds: [foreignEntry.id], createdAt: at }] });
  if (!foreignNoted.ok) throw new Error(foreignNoted.problems.join("; "));
  const unrelated = store.commitConsolidationRun({ path: { sessionId: foreign.id, branch: "child", headTurnId: foreignChild.id },
    run: { kind: "manual", sessionId: foreign.id, branch: "child", createdAt: at }, operations: [{ files: null, op: "create", title: "Fixture title", handle: "$foreign",
      author: "test", text: "foreign obligation", category: "constraint", scope: "project", supports: [foreignNoted.facts[0]!.id],
      topics: [], reason: "fixture", createdAt: at }] });
  if (!unrelated.ok) throw new Error(unrelated.problems.join("; "));
  const target = { sessionId: f.session.id, branch: "left", headTurnId: f.left.id, triggerEntryId: rootEntry.id };
  store.setCurrentPath(f.session.id, "left", f.left.id, "test-lineage");
  store.setCurrentPath(foreign.id, "child", foreignChild.id, "test-lineage");
  const claim = store.acquireClaim(target, "dreaming", "64b-policy", false, () => true, 1)!;
  const run: RunInput = { kind: "dreaming", sessionId: f.session.id, branch: "left", claim,
    executionId: store.beginExecution({ sessionId: f.session.id, phase: "dreaming", origin: store.triggerOrigin(target) }), createdAt: at };
  return { ...f, store, target, claim, run, stable: stable.committed[0]!, unrelated: unrelated.committed[0]!,
    foreign, foreignRoot };
}

test("64b: stale guidance follows split descendants instead of reporting the old identity has no tip", () => {
  const f = retainedFixture();
  const split = f.store.commitWorkspaceRun({ run: f.run, path: f.target, operations: [{ files: null, op: "split",
    knowledgeId: f.stable.knowledgeId, baseCommit: f.stable.commit, text: "stable, primary part", category: "constraint", scope: "project", topics: [],
    supports: [], reason: "split", createdAt: at,
    children: [
      { files: null, title: "Fixture child", text: "stable A", category: "constraint", topics: [] },
      { files: null, title: "Fixture child", text: "stable B", category: "constraint", topics: [] },
    ] }] });
  const applied = split.results[0]!;
  expect(applied.ok).toBe(true);
  if (!applied.ok) return;
  const before = f.store.listKnowledgeRevisions().length;
  const stale = f.store.commitWorkspaceRun({ run: f.run, path: f.target, operations: [{ files: null, op: "archive", kind: "invalid", text: "Stale archive, with its grounds in the cited evidence.",
    knowledgeId: f.stable.knowledgeId, baseCommit: f.stable.commit, supports: [], reason: "stale", createdAt: at }] }).results[0]!;
  expect(stale.ok).toBe(false);
  const problem = stale.ok ? "" : stale.reason;
  // A workspace refusal names versions by their ordinal (K<id>@v<n>).
  for (const child of applied.committed) expect(problem).toContain(`K${child.knowledgeId}@v${f.store.versionOrdinal(child.knowledgeId, child.commit)}`);
  expect(f.store.listKnowledgeRevisions()).toHaveLength(before);
});

test("64b: write legality ignores an unrelated rewound retained obligation but keeps current-base and seat fences", () => {
  const f = retainedFixture();
  f.store.setCurrentPath(f.foreign.id, "root", f.foreignRoot.id, "test-lineage");
  const update = (baseCommit: number, text: string) => ({ files: null, op: "update" as const, knowledgeId: f.stable.knowledgeId, baseCommit,
    text, category: "constraint" as const, scope: "project" as const, supports: [] as number[], topics: [], reason: text, createdAt: at });

  const accepted = f.store.commitWorkspaceRun({ run: f.run, path: f.target, operations: [update(f.stable.commit, "maintained")] }).results[0]!;
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;

  const beforeStale = f.store.listKnowledgeRevisions().length;
  const stale = f.store.commitWorkspaceRun({ run: f.run, path: f.target, operations: [update(f.stable.commit, "stale")] }).results[0]!;
  expect(stale.ok).toBe(false);
  expect(stale.ok ? "" : stale.reason).toContain(`base is not the latest effective applicable revision; current: K${f.stable.knowledgeId}@v${f.store.versionOrdinal(f.stable.knowledgeId, accepted.committed[0]!.commit)}`);
  expect(f.store.listKnowledgeRevisions()).toHaveLength(beforeStale);

  f.store.releaseClaim(f.claim);
  const beforeExpired = f.store.listKnowledgeRevisions().length;
  expect(() => f.store.commitWorkspaceRun({ run: f.run, path: f.target, operations: [update(accepted.committed[0]!.commit, "expired")] }))
    .toThrow("claim is no longer current and unexpired");
  expect(f.store.listKnowledgeRevisions()).toHaveLength(beforeExpired);
});
