import { afterEach, expect, test, vi } from "vitest";
import { TraceMemory, knowledgeStateKey, noVisibility, type VisibleView } from "../../../src/core/api/index.ts";
import { budgetKnowledge, renderEntry, renderKnowledge, tokens } from "../../../src/core/render/index.ts";
import { injectionText } from "../../../src/core/render/material.ts";

const time = "2026-09-12T00:00:00Z";
const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { while (memories.length) memories.pop()!.close(); });

function fixture(config: Record<string, unknown> = {}) {
  const memory = TraceMemory(":memory:", async () => { throw new Error("offline only"); }, config);
  memories.push(memory);
  const project = memory.store.createProject({ name: "delivery", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: time });
  const entries = ["first", "second"].map((nativeId, index) => memory.appendEntry({ sessionId: session.id, turnId: turn.id,
    nativeLineage: "lineage", nativeId, role: "user", text: `evidence ${index}`, raw: `{\"text\":${index}}`, calls: [] }));
  memory.selectEntries(session.id, "main", entries.map(entry => entry.id));
  const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
    entryIds: entries.map(entry => entry.id), facts: entries.map((entry, index) => ({ turnId: turn.id, entryIds: [entry.id],
      category: "decision" as const, actor: "user" as const, text: `fact ${index}`, source: [`T${turn.id}#E${entry.entryOrdinal}`], createdAt: time })) });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const create = (text: string, supports: number[]) => {
    const result = memory.store.commitConsolidationRun({ path: { sessionId: session.id, branch: "main", headTurnId: turn.id },
      run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: time }, operations: [{ op: "create", handle: `$${text}`,
        author: "fixture", text, category: "constraint", scope: "project", supports, topics: [], reason: "record conclusion", createdAt: time }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  return { memory, session, turn, entries, facts: noted.facts, create, target };
}

const view = (over: Partial<VisibleView> = {}): VisibleView => ({ ...noVisibility(), ...over });

test("34c evidence predicate uses complete Fact or proven complete original/bounded Raw coverage", () => {
  const f = fixture();
  const first = f.create("covered by first fact", [f.facts[0]!.id]);
  const both = f.create("requires both facts", f.facts.map(fact => fact.id));

  expect(f.memory.injection(f.target).knowledgeCommitIds).toEqual([first.commit, both.commit]);
  expect(f.memory.injection(f.target, view({ factIds: new Set([f.facts[0]!.id]) })).knowledgeCommitIds).toEqual([both.commit]);

  const original = view({ raw: new Map([["first", "source"]]) });
  expect(f.memory.injection(f.target, original).knowledgeCommitIds).toEqual([both.commit]);

  const bounded = view({ raw: new Map([["first", "view"]]), rawEntryIds: new Map([[f.entries[0]!.id, "first"]]) });
  expect(f.memory.injection(f.target, bounded).knowledgeCommitIds).toEqual([both.commit]);
  // Identity-level bounded coverage deliberately counts even when its rendered middle omitted the fact.
  expect(f.memory.injection(f.target, bounded).text).not.toContain("covered by first fact");

  const mixedComplete = view({ raw: new Map([["first", "source"]]), factIds: new Set([f.facts[1]!.id]) });
  expect(f.memory.injection(f.target, mixedComplete).knowledgeCommitIds).toEqual([]);
  expect(f.memory.injection(f.target, original).knowledgeCommitIds).toEqual([both.commit]); // partial support coverage

  // Losing one persisted binding makes Raw proof incomplete and restores eligibility.
  f.memory.store.db.prepare("DELETE FROM fact_sources WHERE fact_id = ?").run(f.facts[0]!.id);
  expect(f.memory.injection(f.target, original).knowledgeCommitIds).toEqual([first.commit, both.commit]);
});

test("34c valid database/native pairs from sibling and foreign paths cannot masquerade as selected bounded Raw", () => {
  const f = fixture();
  const sameSessionSibling = f.memory.appendEntry({ sessionId: f.session.id, turnId: f.turn.id, nativeLineage: "lineage",
    nativeId: "same-session-sibling", role: "user", text: "off-path source", raw: "{}", calls: [] });
  f.memory.selectEntries(f.session.id, "sibling", [...f.entries.map(entry => entry.id), sameSessionSibling.id]);
  const selectedSnapshot = f.memory.store.pathSnapshot(f.target);
  expect(f.memory.store.visibleSourceEntryIds(f.target, selectedSnapshot, new Map([[sameSessionSibling.nativeId, "view"]]),
    new Map([[sameSessionSibling.id, sameSessionSibling.nativeId]]))).toEqual(new Set());

  const peer = f.memory.store.createSession({ host: "peer", projectId: f.memory.store.getSession(f.session.id)!.projectId,
    enrollmentChoice: true, startedAt: time, firstReplyAt: time });
  const turn = f.memory.store.appendTurn({ sessionId: peer.id, kind: "turn", userPrompt: "peer evidence", startedAt: time });
  const sibling = f.memory.appendEntry({ sessionId: peer.id, turnId: turn.id, nativeLineage: "peer", nativeId: "peer-sibling",
    role: "user", text: "foreign source", raw: "{}", calls: [] });
  f.memory.selectEntries(peer.id, "sibling", [sibling.id]);
  const noted = f.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: peer.id, branch: "sibling", createdAt: time },
    entryIds: [sibling.id], facts: [{ turnId: turn.id, entryIds: [sibling.id], category: "decision", actor: "user",
      text: "shared-project foreign fact", source: [`T${turn.id}#E${sibling.entryOrdinal}`], createdAt: time }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const knowledge = f.create("foreign-supported current knowledge", [noted.facts[0]!.id]);
  const forged = view({ raw: new Map([[sibling.nativeId, "view"]]), rawEntryIds: new Map([[sibling.id, sibling.nativeId]]) });
  expect(f.memory.injection(f.target, forged).knowledgeCommitIds).toContain(knowledge.commit);
  // The same identified bounded carrier remains valid on its real selected session/path.
  expect(f.memory.store.visibleSourceEntryIds({ sessionId: peer.id, branch: "sibling", headTurnId: turn.id },
    f.memory.store.pathSnapshot({ sessionId: peer.id, branch: "sibling", headTurnId: turn.id }), forged.raw, forged.rawEntryIds!))
    .toEqual(new Set([sibling.id]));
});

test("34c recognized bounded Raw may suppress even when truncation removed the evidentiary text", () => {
  const f = fixture({ render: { entryTokens: 40, toolInputTokens: 20, toolResultTokens: 20 } });
  const text = "head ".repeat(200) + "EVIDENCE-ONLY-IN-OMITTED-MIDDLE" + " tail".repeat(200);
  const entry = f.memory.appendEntry({ sessionId: f.session.id, turnId: f.turn.id, nativeLineage: "lineage", nativeId: "long",
    role: "user", text, raw: JSON.stringify({ text }), calls: [] });
  f.memory.selectEntries(f.session.id, "main", [...f.entries.map(value => value.id), entry.id]);
  const noted = f.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, branch: "main", createdAt: time },
    entryIds: [entry.id], facts: [{ turnId: f.turn.id, entryIds: [entry.id], category: "observation", actor: "user",
      text: "The omitted middle contains the evidence", source: [`T${f.turn.id}#E${entry.entryOrdinal}`], createdAt: time }] });
  if (!noted.ok) throw new Error(noted.problems.join());
  const knowledge = f.create("Conclusion whose source text is not visible", [noted.facts[0]!.id]);
  const boundedText = renderEntry(entry, f.memory.config.render).content;
  expect(boundedText).toContain("characters truncated");
  expect(boundedText).not.toContain("EVIDENCE-ONLY-IN-OMITTED-MIDDLE");
  const bounded = view({ raw: new Map([[entry.nativeId, "view"]]), rawEntryIds: new Map([[entry.id, entry.nativeId]]) });
  expect(f.memory.injection(f.target, bounded).knowledgeCommitIds).not.toContain(knowledge.commit);
});

test("34c empty supports are never evidence-suppressed and only current-change supports are inspected", () => {
  const f = fixture();
  const parent = f.create("parent", [f.facts[0]!.id]);
  const update = f.memory.store.commitConsolidationRun({ path: f.target, run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: time },
    operations: [{ op: "update", knowledgeId: parent.knowledgeId, baseCommit: parent.commit, text: "changed", category: "constraint", scope: "project",
      supports: [f.facts[1]!.id], topics: [], reason: "change", createdAt: time }] });
  if (!update.ok) throw new Error(update.problems.join("; "));
  const coveredParentOnly = view({ factIds: new Set([f.facts[0]!.id]) });
  expect(f.memory.injection(f.target, coveredParentOnly).knowledgeCommitIds).toEqual([update.committed[0]!.commit]);

  // A trusted empty-support maintenance row is represented directly to isolate delivery semantics.
  f.memory.store.db.prepare("UPDATE knowledge_revisions SET supports = '[]' WHERE id = ?").run(update.committed[0]!.commit);
  expect(f.memory.injection(f.target, view({ factIds: new Set(f.facts.map(fact => fact.id)) })).knowledgeCommitIds)
    .toEqual([update.committed[0]!.commit]);
});

test("34c remaining rendered allowance counts retained historical bodies and exact whole-item fit", () => {
  const f = fixture();
  const old = f.create("old body ".repeat(20), [f.facts[0]!.id]);
  const newer = f.create("new body ".repeat(20), [f.facts[1]!.id]);
  const visible = view({ knowledgeCommitIds: new Set([old.commit]) });
  const full = f.memory.injection(f.target, visible);
  expect(full.knowledgeCommitIds).toEqual([newer.commit]);
  const rendered = (commit: number) => {
    const revision = f.memory.store.knowledgeRevision(commit)!;
    const value = { knowledge: f.memory.store.getKnowledge(revision.knowledgeId)!, revision };
    const budgeted = budgetKnowledge([value], Infinity, renderKnowledge);
    return injectionText({ knowledge: budgeted.groups, receipts: [] });
  };
  const oldCost = tokens(rendered(old.commit));
  const exact = oldCost + tokens(full.text);
  f.memory.config.render.knowledgeBlockTokens = exact;
  expect(f.memory.injection(f.target, visible).knowledgeCommitIds).toEqual([newer.commit]);
  f.memory.config.render.knowledgeBlockTokens = exact - 1;
  expect(f.memory.injection(f.target, visible).text).toBe(""); // no omission-only message
  f.memory.config.render.knowledgeBlockTokens = oldCost;
  expect(f.memory.injection(f.target, visible).text).toBe(""); // zero remainder
});

test("34c an unfit first body does not skip ahead or emit an omission receipt", () => {
  const f = fixture();
  f.create("large first ".repeat(500), [f.facts[0]!.id]);
  f.create("small later", [f.facts[1]!.id]);
  f.memory.config.render.knowledgeBlockTokens = 100;
  const result = f.memory.injection(f.target);
  expect(result).toMatchObject({ text: "", knowledgeCommitIds: [] });
});

test("34c a visible applicable Knowledge view at or above the configured 20,000 emits nothing", () => {
  const f = fixture();
  const old = f.create("seed", [f.facts[0]!.id]);
  const revision = f.memory.store.knowledgeRevision(old.commit)!;
  const knowledge = f.memory.store.getKnowledge(old.knowledgeId)!;
  const cost = (text: string) => {
    const line = renderKnowledge({ knowledge, revision: { ...revision, text } });
    return tokens(injectionText({ knowledge: budgetKnowledge([{ knowledge, revision: { ...revision, text } }], Infinity, () => line).groups, receipts: [] }));
  };
  let body = "";
  for (let words = 19_800; words <= 20_100; words++) {
    const candidate = "x ".repeat(words);
    if (cost(candidate) === 20_000) { body = candidate; break; }
  }
  expect(body).not.toBe("");
  f.memory.store.db.prepare("UPDATE knowledge_revisions SET text = ? WHERE id = ?").run(body, old.commit);
  f.create("pending body", [f.facts[1]!.id]);
  f.memory.config.render.knowledgeBlockTokens = 20_000;
  expect(f.memory.injection(f.target, view({ knowledgeCommitIds: new Set([old.commit]) })).text).toBe("");
  f.memory.store.db.prepare("UPDATE knowledge_revisions SET text = ? WHERE id = ?").run(body + " x", old.commit);
  expect(f.memory.injection(f.target, view({ knowledgeCommitIds: new Set([old.commit]) })).text).toBe("");
});

test("34c processing status is independent of delivery eligibility", () => {
  const f = fixture();
  const unprocessed = f.create("unprocessed", [f.facts[0]!.id]);
  const processed = f.create("processed", [f.facts[1]!.id]);
  const run = f.memory.store.recordRun({ kind: "dreaming", sessionId: f.session.id, outcome: "success", createdAt: time });
  f.memory.store.db.prepare("INSERT INTO dreaming_completions VALUES (?, ?, ?)").run(run.id, "[]", JSON.stringify([processed.commit]));
  f.memory.store.db.prepare("INSERT INTO processed_knowledge_versions VALUES (?, ?)").run(processed.commit, run.id);
  expect(f.memory.injection(f.target).knowledgeCommitIds).toEqual([unprocessed.commit, processed.commit]);
});

test("34c archive evidence suppression requires all nonempty current-change supports", () => {
  const f = fixture();
  const parent = f.create("retire me", [f.facts[0]!.id]);
  const archive = f.memory.store.commitConsolidationRun({ path: f.target, run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: time },
    operations: [{ op: "archive", knowledgeId: parent.knowledgeId, baseCommit: parent.commit, supports: f.facts.map(fact => fact.id),
      reason: "withdraw", createdAt: time }] });
  if (!archive.ok) throw new Error(archive.problems.join());
  const visibleParent = { knowledgeCommitIds: new Set([parent.commit]) };
  const missing = f.memory.injection(f.target, view(visibleParent));
  expect(missing.text).toContain("is archived");
  expect(missing.knowledgeCommitIds).toEqual([]);
  expect(missing.knowledgeStates).toEqual([{ fromCommit: parent.commit, toCommits: [archive.committed[0]!.commit] }]);
  expect(f.memory.injection(f.target, view({ ...visibleParent, factIds: new Set([f.facts[0]!.id]) })).text).toContain("is archived");
  expect(f.memory.injection(f.target, view({ ...visibleParent, factIds: new Set(f.facts.map(fact => fact.id)) })).text).toBe("");
});

test("34c a retained state-only receipt consumes allowance without granting body visibility", () => {
  const f = fixture();
  const parent = f.create("retired", [f.facts[0]!.id]);
  const archive = f.memory.store.commitConsolidationRun({ path: f.target, run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: time },
    operations: [{ op: "archive", knowledgeId: parent.knowledgeId, baseCommit: parent.commit,
      supports: [f.facts[0]!.id], reason: "retire", createdAt: time }] });
  if (!archive.ok) throw new Error(archive.problems.join());
  f.create("remaining candidate", [f.facts[1]!.id]);
  const candidate = f.memory.injection(f.target);
  f.memory.config.render.knowledgeBlockTokens = tokens(candidate.text);
  const state = { fromCommit: parent.commit, toCommits: [archive.committed[0]!.commit] };
  expect(f.memory.injection(f.target, view({ knowledgeStates: new Set([knowledgeStateKey(state)]) })).text).toBe("");
});

test("34c state transitions are whole deterministic prefix items and only selected receipts persist", () => {
  const f = fixture();
  const parents = [f.create("retire first", [f.facts[0]!.id]), f.create("retire second", [f.facts[1]!.id]), f.create("retire third", [f.facts[0]!.id])];
  const archives = parents.map((parent, index) => {
    const result = f.memory.store.commitConsolidationRun({ path: f.target,
      run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: time }, operations: [{ op: "archive",
        knowledgeId: parent.knowledgeId, baseCommit: parent.commit, supports: [f.facts[index % 2]!.id], reason: `retire ${index}`, createdAt: time }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  });
  const visibleParents = new Set(parents.map(parent => parent.commit));
  const firstOnly = f.memory.injection(f.target, view({ knowledgeCommitIds: new Set([parents[0]!.commit]) }));
  expect(firstOnly.knowledgeStates).toEqual([{ fromCommit: parents[0]!.commit, toCommits: [archives[0]!.commit] }]);
  const visibleValues = parents.map(parent => {
    const revision = f.memory.store.knowledgeRevision(parent.commit)!;
    return { knowledge: f.memory.store.getKnowledge(parent.knowledgeId)!, revision };
  });
  const visibleCost = tokens(injectionText({ knowledge: budgetKnowledge(visibleValues, Infinity, renderKnowledge).groups, receipts: [] }));
  f.memory.config.render.knowledgeBlockTokens = visibleCost + tokens(firstOnly.text);

  const first = f.memory.injection(f.target, view({ knowledgeCommitIds: visibleParents }));
  expect(first.knowledgeCommitIds).toEqual([]);
  expect(first.knowledgeStates).toEqual([{ fromCommit: parents[0]!.commit, toCommits: [archives[0]!.commit] }]);
  expect(first.text).toContain(`K${parents[0]!.knowledgeId}@${parents[0]!.commit} is archived`);
  expect(first.text).not.toContain(`K${parents[1]!.knowledgeId}@${parents[1]!.commit} is archived`);
  expect(first.text).not.toContain("omitted");

  const firstReceipt = knowledgeStateKey(first.knowledgeStates![0]!);
  f.memory.config.render.knowledgeBlockTokens = 20_000;
  const second = f.memory.injection(f.target, view({ knowledgeCommitIds: visibleParents, knowledgeStates: new Set([firstReceipt]) }));
  expect(second.knowledgeStates).toEqual([
    { fromCommit: parents[1]!.commit, toCommits: [archives[1]!.commit] },
    { fromCommit: parents[2]!.commit, toCommits: [archives[2]!.commit] },
  ]);
  expect(second.text).not.toContain(`K${parents[0]!.knowledgeId}@${parents[0]!.commit} is archived`);
  expect(second.text).toContain(`K${parents[1]!.knowledgeId}@${parents[1]!.commit} is archived`);
  expect(second.text).toContain(`K${parents[2]!.knowledgeId}@${parents[2]!.commit} is archived`);

  f.memory.config.render.knowledgeBlockTokens = visibleCost + tokens(firstOnly.text) - 1;
  const unfit = f.memory.injection(f.target, view({ knowledgeCommitIds: visibleParents }));
  expect(unfit).toMatchObject({ text: "", knowledgeCommitIds: [] });
  expect(unfit.knowledgeStates).toBeUndefined();
});

test("34c state-prefix budgeting shares exact framing with bodies without acknowledging an omitted body", () => {
  const f = fixture();
  const parent = f.create("retire visible parent", [f.facts[0]!.id]);
  const archive = f.memory.store.commitConsolidationRun({ path: f.target,
    run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: time }, operations: [{ op: "archive",
      knowledgeId: parent.knowledgeId, baseCommit: parent.commit, supports: [f.facts[0]!.id], reason: "retire", createdAt: time }] });
  if (!archive.ok) throw new Error(archive.problems.join("; "));
  const body = f.create("deliver this complete body", [f.facts[1]!.id]);
  const visible = view({ knowledgeCommitIds: new Set([parent.commit]) });
  const full = f.memory.injection(f.target, visible);
  expect(full.knowledgeStates).toEqual([{ fromCommit: parent.commit, toCommits: [archive.committed[0]!.commit] }]);
  expect(full.knowledgeCommitIds).toEqual([body.commit]);
  const parentRevision = f.memory.store.knowledgeRevision(parent.commit)!;
  const parentValue = { knowledge: f.memory.store.getKnowledge(parent.knowledgeId)!, revision: parentRevision };
  const visibleCost = tokens(injectionText({ knowledge: budgetKnowledge([parentValue], Infinity, renderKnowledge).groups, receipts: [] }));
  f.memory.config.render.knowledgeBlockTokens = visibleCost + tokens(full.text);
  expect(f.memory.injection(f.target, visible)).toMatchObject({ knowledgeCommitIds: [body.commit], knowledgeStates: full.knowledgeStates });
  f.memory.config.render.knowledgeBlockTokens--;
  const partial = f.memory.injection(f.target, visible);
  expect(partial.knowledgeCommitIds).toEqual([]);
  expect(partial.knowledgeStates).toEqual(full.knowledgeStates);
  expect(partial.text).not.toContain("deliver this complete body");
});

test("34c merge notices are scoped to visible parents and do not grant the survivor body", () => {
  const f = fixture();
  const first = f.create("first parent", [f.facts[0]!.id]);
  const second = f.create("second parent", [f.facts[1]!.id]);
  const merge = f.memory.store.commitConsolidationRun({ path: f.target, run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: time },
    operations: [{ op: "merge", intoKnowledgeId: first.knowledgeId, intoBaseCommit: first.commit,
      absorb: [{ knowledgeId: second.knowledgeId, baseCommit: second.commit }], text: "merged survivor", category: "constraint", scope: "project",
      supports: [f.facts[0]!.id], topics: [], reason: "merge", createdAt: time }] });
  if (!merge.ok) throw new Error(merge.problems.join());
  const offered = f.memory.injection(f.target, view({ knowledgeCommitIds: new Set([second.commit]) }));
  expect(offered.text).toContain(`K${second.knowledgeId}@${second.commit} is merged into K${first.knowledgeId}@${merge.committed[0]!.commit}`);
  expect(offered.knowledgeStates).toEqual([{ fromCommit: second.commit, toCommits: [merge.committed[0]!.commit] }]);
  expect(offered.knowledgeCommitIds).toEqual([merge.committed[0]!.commit]);
  const noticeOnly = view({ knowledgeCommitIds: new Set([second.commit, merge.committed[0]!.commit]) });
  const state = f.memory.injection(f.target, noticeOnly);
  expect(state.knowledgeCommitIds).toEqual([]);
  expect(state.knowledgeStates).toEqual([{ fromCommit: second.commit, toCommits: [merge.committed[0]!.commit] }]);
});

test("34c split notice names both children while partial budgeting grants body visibility only to the child kept", () => {
  const f = fixture();
  const parent = f.create("compound parent", [f.facts[0]!.id]);
  const range = f.memory.store.retainDreamingRange(f.target, [parent.commit]);
  const claim = f.memory.store.acquireClaim(f.target, "dreaming", "delivery-test")!;
  const executionId = f.memory.store.beginExecution({ sessionId: f.session.id, phase: "dreaming", head: range.anchor, origin: range.origin });
  const run = f.memory.store.bindDreamingRun(f.memory.store.bindRunOrigin({ kind: "dreaming", sessionId: f.session.id, branch: "main",
    dreamingRangeId: range.id, claim, executionId, createdAt: time }, range.origin));
  const split = f.memory.store.commitConsolidationRun({ path: f.target, run, operations: [{ op: "split", knowledgeId: parent.knowledgeId,
    baseCommit: parent.commit, supports: [], reason: "separate", createdAt: time, children: [
      { text: "first child", category: "constraint", topics: [] }, { text: "second child", category: "goal", topics: [] }] }] });
  if (!split.ok) throw new Error(split.problems.join());
  const visible = view({ knowledgeCommitIds: new Set([parent.commit]) });
  let partial: ReturnType<typeof f.memory.injection> | undefined;
  for (let cap = 1; cap < 500; cap++) {
    f.memory.config.render.knowledgeBlockTokens = cap;
    const offered = f.memory.injection(f.target, visible);
    if (offered.knowledgeCommitIds.length === 1 && offered.knowledgeStates?.length === 1) { partial = offered; break; }
  }
  expect(partial?.text).toContain(`split into K${split.committed[0]!.knowledgeId}@${split.committed[0]!.commit} and K${split.committed[1]!.knowledgeId}@${split.committed[1]!.commit}`);
  expect(partial?.knowledgeCommitIds).toHaveLength(1);
  expect(partial?.knowledgeStates).toEqual([{ fromCommit: parent.commit, toCommits: split.committed.map(item => item.commit) }]);
  expect(partial?.text).not.toContain("omitted");
  expect(partial?.text).not.toContain("second child");
});

test("34c delivery check keeps graph/source work bounded as candidate count grows", () => {
  for (const count of [1, 40]) {
    const f = fixture();
    for (let index = 0; index < count; index++) f.create(`knowledge ${index}`, [f.facts[index % 2]!.id]);
    const spy = vi.spyOn(f.memory.store.db, "prepare");
    f.memory.injection(f.target, view({ raw: new Map([["first", "source"], ["second", "source"]]) }));
    const sourceQueries = spy.mock.calls.filter(([sql]) => /source_entries|fact_sources|noted_entries/.test(String(sql))).length;
    process.stdout.write(`34c delivery source queries: ${count} candidates => ${sourceQueries}\n`);
    expect(sourceQueries).toBeLessThanOrEqual(5);
    spy.mockRestore();
  }
});
