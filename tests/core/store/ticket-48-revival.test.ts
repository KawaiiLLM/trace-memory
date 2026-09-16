import { afterEach, expect, test } from "vitest";
import { Store, type KnowledgeOperationInput, type KnowledgePath, type RunInput, type TaskTarget } from "../../../src/core/store/index.ts";
import { tokens } from "../../../src/core/render/index.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const project = store.createProject({ name: "revival", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const root = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: "now" });
  const path: TaskTarget = { sessionId: session.id, branch: "main", headTurnId: root.id };
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
    { turnId: root.id, category: "decision", actor: "user", text: "The object exists", source: [`T${root.id}#user`], createdAt: "now" },
  ] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const fact = noted.facts[0]!.id;
  const content = (text: string) => ({ text, category: "constraint" as const, scope: "project" as const,
    supports: [fact], reason: "test", topics: ["object"], createdAt: "now" });
  const write = (operations: KnowledgeOperationInput[], run: RunInput = { kind: "manual", sessionId: session.id, createdAt: "now" }, target = path) =>
    store.commitConsolidationRun({ path: target, run, operations });
  const create = (text: string) => {
    const result = write([{ op: "create", handle: `$${text}`, author: "test", ...content(text) }]);
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  const trusted = (target: TaskTarget, eventIds: number[], supplied: number[] = []) => {
    const range = store.retainDreamingRange(target, eventIds, supplied);
    const claim = store.acquireClaim(target, "dreaming", `ticket-48-${range.id}`)!;
    const executionId = store.beginExecution({ sessionId: session.id, phase: "dreaming", head: range.anchor, origin: range.origin });
    const run = store.bindDreamingRun(store.bindRunOrigin({ kind: "dreaming", sessionId: session.id, branch: target.branch,
      dreamingRangeId: range.id, claim, executionId, createdAt: "now" }, range.origin));
    return { range, run };
  };
  return { store, session, root, path, fact, content, write, create, trusted };
}

function archiveAndClose(f: ReturnType<typeof fixture>, item: { knowledgeId: number; commit: number }) {
  const first = f.trusted(f.path, [item.commit]);
  const archived = f.write([{ op: "archive", knowledgeId: item.knowledgeId, baseCommit: item.commit,
    supports: [], reason: "Object ended", createdAt: "now" }], first.run);
  if (!archived.ok) throw new Error(archived.problems.join("; "));
  const archive = archived.committed[0]!;
  const runId = f.store.dreamingRunId(first.run)!;
  f.store.updateRun(runId, { ...first.run, outcome: "success" });
  f.store.completeDreaming(runId, [item.commit], [archive.commit]);
  f.store.releaseClaim(first.run.claim!);
  return archive;
}

test("48: a trusted Dreamer revives an archived older identity through merge only", () => {
  const f = fixture();
  const old = f.create("Object state before retirement");
  const archive = archiveAndClose(f, old);
  const returned = f.create("Object state after return");
  const dream = f.trusted(f.path, [returned.commit]);
  const merged = f.write([{ op: "merge", intoKnowledgeId: old.knowledgeId, intoBaseCommit: archive.commit,
    absorb: [{ knowledgeId: returned.knowledgeId, baseCommit: returned.commit }], ...f.content("Object state after return") }], dream.run);
  expect(merged.ok).toBe(true);
  if (!merged.ok) return;
  const revived = merged.committed[0]!;
  expect(revived.knowledgeId).toBe(old.knowledgeId);
  expect(f.store.knowledgeRevision(revived.commit)?.parentId).toBe(archive.commit);
  expect(f.store.listKnowledgeLinks(returned.knowledgeId)).toContainEqual(expect.objectContaining({
    fromKnowledge: returned.knowledgeId, fromCommit: returned.commit, kind: "merged_into",
    toKnowledge: old.knowledgeId, toCommit: revived.commit,
  }));
  expect(f.store.dreamingRange(dream.range.id)?.knowledgeIds).toEqual([old.knowledgeId, returned.knowledgeId]);
  expect(f.store.listCurrentKnowledge(f.path).map(item => [item.knowledge.id, item.revision.id])).toEqual([[old.knowledgeId, revived.commit]]);
  const stale = f.write([{ op: "merge", intoKnowledgeId: old.knowledgeId, intoBaseCommit: archive.commit,
    absorb: [{ knowledgeId: returned.knowledgeId, baseCommit: returned.commit }], ...f.content("Stale revival retry") }], dream.run);
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.problems.join(" ")).toMatch(/target moved on|trigger ancestry is unknown/);
});

test("48: archive bases remain forbidden outside the one trusted revival shape", () => {
  const f = fixture();
  const old = f.create("Old identity");
  const archive = archiveAndClose(f, old);
  const active = f.create("Returned identity");
  const retiredMember = f.create("Family member to retire");
  const dream = f.trusted(f.path, [active.commit, retiredMember.commit]);
  const retired = f.write([{ op: "archive", knowledgeId: retiredMember.knowledgeId, baseCommit: retiredMember.commit,
    supports: [], reason: "Retire family member", createdAt: "now" }], dream.run);
  if (!retired.ok) throw new Error(retired.problems.join("; "));
  const outside = f.create("Unrelated outside identity");
  const update = { op: "update" as const, knowledgeId: old.knowledgeId, baseCommit: archive.commit, ...f.content("Updated archive") };
  expect(f.write([update]).ok).toBe(false);
  expect(f.write([update], dream.run).ok).toBe(false);
  expect(f.write([{ op: "merge", intoKnowledgeId: old.knowledgeId, intoBaseCommit: archive.commit,
    absorb: [{ knowledgeId: outside.knowledgeId, baseCommit: outside.commit }], ...f.content("Two outsiders") }], dream.run).ok).toBe(false);
  expect(f.write([{ op: "merge", intoKnowledgeId: outside.knowledgeId, intoBaseCommit: outside.commit,
    absorb: [{ knowledgeId: active.knowledgeId, baseCommit: active.commit }], ...f.content("Outside active survivor") }], dream.run).ok).toBe(false);
  expect(f.write([{ op: "merge", intoKnowledgeId: active.knowledgeId, intoBaseCommit: active.commit,
    absorb: [{ knowledgeId: retiredMember.knowledgeId, baseCommit: retired.committed[0]!.commit }], ...f.content("Archived absorbed parent") }], dream.run).ok).toBe(false);
});

test("48: a later invalid operation rolls revival, link, revision and family admission back together", () => {
  const f = fixture();
  const old = f.create("Old identity");
  const archive = archiveAndClose(f, old);
  const active = f.create("Returned identity");
  const dream = f.trusted(f.path, [active.commit]);
  const before = { revisions: f.store.listKnowledgeRevisions(), links: f.store.listKnowledgeLinks(active.knowledgeId), family: f.store.dreamingRange(dream.range.id) };
  const result = f.write([
    { op: "merge", intoKnowledgeId: old.knowledgeId, intoBaseCommit: archive.commit,
      absorb: [{ knowledgeId: active.knowledgeId, baseCommit: active.commit }], ...f.content("Revived identity") },
    { op: "update", knowledgeId: active.knowledgeId, baseCommit: active.commit, ...f.content("Consumed base reused") },
  ], dream.run);
  expect(result.ok).toBe(false);
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  expect(f.store.listKnowledgeLinks(active.knowledgeId)).toEqual(before.links);
  expect(f.store.dreamingRange(dream.range.id)).toEqual(before.family);
});

test("48: changed material is grouped New, Changed, Archived from applicable certificates", () => {
  const f = fixture();
  const fresh = f.create("Fresh v1");
  const fresh2 = f.write([{ op: "update", knowledgeId: fresh.knowledgeId, baseCommit: fresh.commit, ...f.content("Fresh v2") }]);
  if (!fresh2.ok) throw new Error(fresh2.problems.join("; "));
  const fresh3 = f.write([{ op: "update", knowledgeId: fresh.knowledgeId, baseCommit: fresh2.committed[0]!.commit, ...f.content("Fresh v3") }]);
  if (!fresh3.ok) throw new Error(fresh3.problems.join("; "));

  const changed = f.create("Changed v1");
  const cert = f.trusted(f.path, [changed.commit]);
  const certRun = f.store.dreamingRunId(cert.run)!;
  f.store.updateRun(certRun, { ...cert.run, outcome: "success" });
  f.store.completeDreaming(certRun, [changed.commit], [changed.commit]);
  f.store.releaseClaim(cert.run.claim!);
  const changed2 = f.write([{ op: "update", knowledgeId: changed.knowledgeId, baseCommit: changed.commit, ...f.content("Changed v2") }]);
  if (!changed2.ok) throw new Error(changed2.problems.join("; "));

  const archivedBase = f.create("Archived predecessor body");
  const archived = archiveAndClose(f, archivedBase);
  const input = f.store.dreamingInput(f.path, [fresh.commit, fresh2.committed[0]!.commit, fresh3.committed[0]!.commit, changed2.committed[0]!.commit, archived.commit]);
  expect(input.text.indexOf("New:")).toBeLessThan(input.text.indexOf("Changed:"));
  expect(input.text.indexOf("Changed:")).toBeLessThan(input.text.indexOf("Archived:"));
  expect(input.text.slice(input.text.indexOf("New:"), input.text.indexOf("Changed:"))).toContain("Fresh v3");
  expect(input.text.slice(input.text.indexOf("Changed:"), input.text.indexOf("Archived:"))).toContain("Changed v2");
  expect(input.text.slice(input.text.indexOf("Archived:"))).toContain("Archived predecessor body");
  expect(input.text.match(/Fresh v3/g)).toHaveLength(1);
  expect(input.text.match(/Changed v2/g)).toHaveLength(1);
  expect(input.text.match(/Archived predecessor body/g)).toHaveLength(1);
});

test("48: group headings and framing participate in exact changed-material admission", () => {
  const f = fixture();
  const item = f.create("Budgeted new item");
  const snapshot = f.store.dreamingInputSnapshot(f.path);
  const complete = snapshot.input([item.commit], []);
  const exact = tokens(complete.text);
  const fits = snapshot.select(undefined, candidate => tokens(candidate.text) <= exact);
  const exceeds = snapshot.select(undefined, candidate => tokens(candidate.text) <= exact - 1);
  expect(fits.eventIds).toEqual([item.commit]);
  expect(fits.input.text).toContain("New:\n");
  expect(exceeds.eventIds).toEqual([]);
});

test("48: a certificate on an inapplicable sibling version does not make the head identity Changed", () => {
  const f = fixture();
  const base = f.create("Head version");
  const siblingTurn = f.store.appendTurn({ sessionId: f.session.id, parentTurnId: f.root.id, kind: "turn", userPrompt: "sibling", startedAt: "later" });
  const siblingPath = { sessionId: f.session.id, branch: "sibling", headTurnId: siblingTurn.id };
  const siblingFact = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "later" }, facts: [
    { turnId: siblingTurn.id, category: "decision", actor: "user", text: "Sibling change", source: [`T${siblingTurn.id}#user`], createdAt: "later" },
  ] });
  if (!siblingFact.ok) throw new Error(siblingFact.problems.join("; "));
  const sibling = f.write([{ op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit,
    ...f.content("Sibling version"), supports: [siblingFact.facts[0]!.id] }], undefined, siblingPath);
  if (!sibling.ok) throw new Error(sibling.problems.join("; "));
  const certified = f.trusted(siblingPath, [sibling.committed[0]!.commit]);
  const certifiedRun = f.store.dreamingRunId(certified.run)!;
  f.store.updateRun(certifiedRun, { ...certified.run, outcome: "success" });
  f.store.completeDreaming(certifiedRun, [sibling.committed[0]!.commit], [sibling.committed[0]!.commit]);
  f.store.releaseClaim(certified.run.claim!);
  const input = f.store.dreamingInput(f.path, [base.commit]);
  expect(input.text).toContain("New:");
  expect(input.text).not.toContain("Changed:");
  expect(input.text).toContain("Head version");
});
