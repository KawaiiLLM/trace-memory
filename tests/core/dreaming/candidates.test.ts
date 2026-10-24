import { afterEach, expect, test } from "vitest";
import { workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";
import { facts, knowledge, updateKnowledge, session as peerSession } from "../../support/seed.ts";
import { boundaryOf, incrementalCandidates, projectItems } from "../../../src/core/dreaming/candidates.ts";

const opened: WorkspaceBatch[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.memory.close(); });
const fixture = () => { const f = workspaceBatch(); opened.push(f); return f; };

test("per-seed object and text caps are independent; flags are uncapped and session items stay out", () => {
  const f = fixture();
  const support = facts(f.memory, f.path, [{ title: "Store ground", objects: ["Store"], sources: [{ entry: f.store.getSourceEntry(f.entries[0]!.id)!, text: "Store records" }] }])[0]!;
  const global = knowledge(f.store, f.path, "global", "constraint", [support.id], "Store global", { operation: { title: "Global" } });
  const project = knowledge(f.store, f.path, "project", "constraint", [support.id], "Store distinctive", { operation: { title: "Distinctive" } });
  const session = knowledge(f.store, f.path, "session", "constraint", [support.id], "Store distinctive session", { operation: { title: "Distinctive session" } });
  const flagged = Array.from({ length: 8 }, (_, i) => f.item(`Unrelated rule ${i}`, { title: `Unrelated ${i}` }));
  const since = boundaryOf(f.store, projectItems(f.store, f.path));
  for (const item of [...flagged, session]) f.store.setKnowledgeStale(item.commit, { reason: "unresolved_check", detail: "Needs a ruling" });
  const source = f.entries[0]!;
  const result = f.store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, branch: "main", createdAt: "now" }, facts: [{ title: "Distinctive", objects: ["Store"], text: "Store changed", segments: ["Store changed"], source: [f.address(0)], entryIds: [source.id], turnId: source.turnId, createdAt: "now" }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  const selected = incrementalCandidates(f.store, f.path, 1, since);
  expect(selected.seeds.map(seed => seed.kind)).toEqual(["fact"]);
  expect(selected.candidates.map(item => item.value.knowledge.id)).toEqual([global.knowledgeId, project.knowledgeId, ...flagged.map(item => item.knowledgeId)]);
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
  expect(f.store.noterOperations(f.path)).toBe(0);
  expect(await f.memory.dream({ sessionId: f.session.id, branch: "main", headTurnId: f.path.headTurnId!, model: "test", manual: true })).toEqual({ outcome: "empty" });
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
});

test("text retrieval cannot spend its per-seed cap on a match in an obsolete version", () => {
  const f = fixture(), old = f.item("Retired subject", { title: "General pointer" });
  updateKnowledge(f.store, f.path, old.knowledgeId, old.commit, "Current subject", old.supports);
  const since = boundaryOf(f.store, projectItems(f.store, f.path)), source = f.entries[0]!;
  const result = f.store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, branch: "main", createdAt: "now" },
    facts: [{ title: "Retired subject", text: "Retired subject discussed", segments: ["Retired subject discussed"],
      source: [f.address(0)], entryIds: [source.id], turnId: source.turnId, createdAt: "now" }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  expect(incrementalCandidates(f.store, f.path, 1, since)).toMatchObject({ seeds: [expect.objectContaining({ kind: "fact" })], candidates: [] });
});

test("project transfer seeds newly visible knowledge even when its revision predates the watermark", () => {
  const f = fixture(); f.item("Existing project rule");
  const project = f.store.createProject({ name: "donor", declaredBy: "mark" }), donor = peerSession(f.store, project.id, "pi:donor");
  const turn = f.store.appendTurn({ sessionId: donor.id, kind: "turn", userPrompt: "Imported boundary", startedAt: "now" });
  const path = f.store.knowledgePath(donor.id, "main", turn.id), source = f.store.sourcePath(donor.id, "main", turn.id)[0]!;
  const support = facts(f.memory, path, [{ title: "Imported boundary", sources: [{ entry: f.store.getSourceEntry(source.id)!, text: "Imported boundary" }] }])[0]!;
  const incoming = knowledge(f.store, path, "project", "constraint", [support.id], "Imported boundary", { operation: { title: "Imported boundary" } });
  const since = boundaryOf(f.store, projectItems(f.store, f.path));
  expect(since.revision).toBeGreaterThanOrEqual(incoming.commit);
  f.store.mergeProject(project.id, f.project.id);
  const selected = incrementalCandidates(f.store, f.path, 10, since);
  expect(selected.seeds).toEqual([expect.objectContaining({ kind: "knowledge", knowledgeId: incoming.knowledgeId })]);
  expect(selected.candidates.map(item => item.value.knowledge.id)).toEqual([incoming.knowledgeId]);
});
