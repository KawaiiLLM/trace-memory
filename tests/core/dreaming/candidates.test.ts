import { afterEach, expect, test } from "vitest";
import { workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";
import { facts, knowledge, scoreAll, updateKnowledge, session as peerSession } from "../../support/seed.ts";
import { boundaryOf, incrementalCandidates, projectItems } from "../../../src/core/dreaming/candidates.ts";

const opened: WorkspaceBatch[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.memory.close(); });
const fixture = () => { const f = workspaceBatch(); opened.push(f); return f; };

test("new facts are background only; changed and flagged project/global items are candidates", () => {
  const f = fixture();
  const support = facts(f.memory, f.path, [{ title: "Store ground", objects: ["Store"], sources: [{ entry: f.store.getSourceEntry(f.entries[0]!.id)!, text: "Store records" }] }])[0]!;
  const global = knowledge(f.store, f.path, "global", "constraint", [support.id], "Store global", { operation: { title: "Global" } });
  const project = knowledge(f.store, f.path, "project", "constraint", [support.id], "Store distinctive", { operation: { title: "Distinctive" } });
  const session = knowledge(f.store, f.path, "session", "constraint", [support.id], "Store distinctive session", { operation: { title: "Distinctive session" } });
  const flagged = Array.from({ length: 8 }, (_, i) => f.item(`Unrelated rule ${i}`, { title: `Unrelated ${i}` }));
  scoreAll(f.store, 60); // scored by an earlier run: only change and flags select (181)
  const since = boundaryOf(f.store, projectItems(f.store, f.path));
  for (const item of [...flagged, session]) f.store.setKnowledgeStale(item.commit, { reason: "unresolved_check", detail: "Needs a ruling" });
  updateKnowledge(f.store, f.path, global.knowledgeId, global.commit, "Store global changed", [support.id]);
  const source = f.entries[0]!;
  const result = f.store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, branch: "main", createdAt: "now" }, facts: [{ title: "Distinctive", objects: ["Store"], text: "Store changed", segments: ["Store changed"], source: [f.address(0)], entryIds: [source.id], turnId: source.turnId, createdAt: "now" }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  const selected = incrementalCandidates(f.store, f.path, since);
  expect(selected.background).toContain(`F${result.facts[0]!.id} Distinctive — Store`);
  expect(selected.candidates.map(item => item.value.knowledge.id).sort((a, b) => a - b)).toEqual([global.knowledgeId, ...flagged.map(item => item.knowledgeId)]);
});

test("Noter negation flags current direct support immediately, with the source reason", () => {
  const f = fixture(), affected = f.item("Use pnpm"), unrelated = f.item("Keep the lockfile");
  const result = f.store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, branch: "main", createdAt: "now" }, facts: [{ title: "pnpm withdrawn", text: "Do not use pnpm", segments: ["Do not use pnpm"], source: [f.address(0)], entryIds: [f.entries[0]!.id], turnId: f.entries[0]!.turnId, createdAt: "now", negate: [{ target: `F${affected.supports[0]}`, strength: "strong" }] }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  expect(f.store.knowledgeStaleReasons(affected.commit)).toEqual([expect.objectContaining({ reason: "negated_fact", detail: expect.stringContaining(`F${affected.supports[0]}`) })]);
  expect(f.store.knowledgeStaleReasons(unrelated.commit)).toEqual([]);
});

test("session knowledge neither triggers nor enters a manual routine Dreamer", async () => {
  const f = fixture();
  f.item("A session-only reminder", { scope: "session" });
  expect(f.store.noterChangedItems(f.path)).toBe(0);
  expect(await f.memory.dream({ sessionId: f.session.id, branch: "main", headTurnId: f.path.headTurnId!, model: "test", manual: true })).toEqual({ outcome: "empty" });
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
});


test("project transfer includes newly visible knowledge even when its revision predates the watermark", () => {
  const f = fixture(); f.item("Existing project rule");
  const project = f.store.createProject({ name: "donor", declaredBy: "mark" }), donor = peerSession(f.store, project.id, "pi:donor");
  const turn = f.store.appendTurn({ sessionId: donor.id, kind: "turn", userPrompt: "Imported boundary", startedAt: "now" });
  const path = f.store.knowledgePath(donor.id, "main", turn.id), source = f.store.sourcePath(donor.id, "main", turn.id)[0]!;
  const support = facts(f.memory, path, [{ title: "Imported boundary", sources: [{ entry: f.store.getSourceEntry(source.id)!, text: "Imported boundary" }] }])[0]!;
  const incoming = knowledge(f.store, path, "project", "constraint", [support.id], "Imported boundary", { operation: { title: "Imported boundary" } });
  scoreAll(f.store, 60);
  const since = boundaryOf(f.store, projectItems(f.store, f.path));
  expect(since.revision).toBeGreaterThanOrEqual(incoming.commit);
  f.store.mergeProject(project.id, f.project.id);
  const selected = incrementalCandidates(f.store, f.path, since);
  expect(selected.candidates.map(item => item.value.knowledge.id)).toEqual([incoming.knowledgeId]);
});

test("181: every unscored project or global item is a candidate, covered or not, until a run scores it", () => {
  const f = fixture(), scored = f.item("A scored rule"), unscored = f.item("A covered but unscored rule");
  f.item("A session reminder", { scope: "session" });
  f.store.db.prepare("UPDATE knowledge SET score = 60 WHERE id = ?").run(scored.knowledgeId);
  const since = boundaryOf(f.store, projectItems(f.store, f.path)); // everything is covered: nothing changed since
  const ids = () => incrementalCandidates(f.store, f.path, since).candidates.map(item => item.value.knowledge.id);
  expect(ids()).toEqual([unscored.knowledgeId]); // not the scored item, not session scope
  f.store.db.prepare("UPDATE knowledge SET score = 60 WHERE id = ?").run(unscored.knowledgeId);
  expect(ids()).toEqual([]);
});
