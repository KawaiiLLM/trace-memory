import { afterEach, expect, test, vi } from "vitest";
import { TraceMemory, knowledgeStateKey, noVisibility, type VisibleView } from "../../../src/core/api/index.ts";
import { budgetKnowledge, renderEntry, renderKnowledge, tokens } from "../../../src/core/render/index.ts";
import { injectionText } from "../../../src/core/render/material.ts";
import { setKnowledgeCapacity } from "../../knowledge-budget-fixture.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const time = "2026-09-12T00:00:00Z";

function fullRead(tool: { execute(input: unknown): string }, address: string) {
  let page = tool.execute({ address, full: true, itemBudget: null });
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1])
    page = tool.execute({ address: `cursor=${cursor}`, itemBudget: null });
}
const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { while (memories.length) memories.pop()!.close(); });

function fixture(config: Record<string, unknown> = {}) {
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("offline only"); });
  const memory = TraceMemory(":memory:", scenarios.agent, config);
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
  return { memory, session, turn, entries, facts: noted.facts, create, target, scenarios };
}

/** These tests directly rewrite otherwise immutable rows. Simulate a cold Store read after the
 * unsupported out-of-band mutation; a budget edit must not invalidate knowledge selection (88). */
function coldGraph(f: { memory: ReturnType<typeof TraceMemory> }) {
  (f.memory.store as unknown as { graphInputCache?: unknown }).graphInputCache = undefined;
}

const view = (over: Partial<VisibleView> = {}): VisibleView => ({ ...noVisibility(), ...over });

async function maintain(f: ReturnType<typeof fixture>, operation: Record<string, unknown>, addresses: string[], needsTrigger = true) {
  const factId = f.facts[0]!.id;
  const trigger = needsTrigger ? createDreamerTrigger(f.memory, f.target, factId, f.memory.store.listKnowledgeRevisions().length + 1) : null;
  let committed: { knowledgeId: number; commit: number }[] = [];
  const result = await f.scenarios.run(f.memory, f.target, input => {
    input.reportRequest({ fixture: "knowledge delivery maintenance" });
    const trace = input.tools.find(tool => tool.name === "trace")!;
    for (const address of addresses) fullRead(trace, address);
    const triggerAddress = trigger ? `K${trigger.knowledgeId}@${trigger.commit}` : null;
    const supplied = new Set(input.material.changed.match(/K\d+@\d+/g) ?? []);
    if (triggerAddress) supplied.delete(triggerAddress); for (const address of addresses) supplied.delete(address);
    const receipt = JSON.parse(input.tools.find(tool => tool.name === "memory")!.execute({ operations: [operation,
      ...(triggerAddress ? [{ op: "archive", id: triggerAddress, supports: [`F${factId}`], reason: "Retire the explicit delivery trigger." }] : [])],
      skipped: [...supplied].map(knowledge => ({ knowledge, because: "No maintenance is needed for this supplied item." })) }));
    committed = receipt.committed.filter((item: { knowledgeId: number }) => item.knowledgeId !== trigger?.knowledgeId);
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "delivery maintenance complete", request: { fixture: "knowledge delivery maintenance" } };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  return committed;
}

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

  // Losing one persisted binding makes Raw proof incomplete and restores eligibility. `fact_sources`
  // is insert-only in production; cold-read after this unsupported mutation.
  f.memory.store.db.prepare("DELETE FROM fact_sources WHERE fact_id = ?").run(f.facts[0]!.id);
  coldGraph(f);
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

test("34c empty supports are never evidence-suppressed and only current-change supports are inspected", async () => {
  const f = fixture();
  const parent = f.create("parent", [f.facts[0]!.id]);
  const update = await maintain(f, { op: "update", id: `K${parent.knowledgeId}@${parent.commit}`, text: "changed", category: "constraint", scope: "project",
    supports: [`F${f.facts[1]!.id}`], topics: [], reason: "change" }, [`K${parent.knowledgeId}@${parent.commit}`]);
  const coveredParentOnly = view({ factIds: new Set([f.facts[0]!.id]) });
  expect(f.memory.injection(f.target, coveredParentOnly).knowledgeCommitIds).toEqual([update[0]!.commit]);

  // A trusted empty-support maintenance row is represented directly to isolate delivery semantics.
  // A revision's `supports` is immutable in production; cold-read after this unsupported mutation.
  f.memory.store.db.prepare("UPDATE knowledge_revisions SET supports = '[]' WHERE id = ?").run(update[0]!.commit);
  coldGraph(f);
  expect(f.memory.injection(f.target, view({ factIds: new Set(f.facts.map(fact => fact.id)) })).knowledgeCommitIds)
    .toEqual([update[0]!.commit]);
});

test("34c remaining rendered allowance counts retained historical bodies and exact whole-item fit", () => {
  const f = fixture();
  const old = f.create("old body ".repeat(3_000), [f.facts[0]!.id]);
  const newer = f.create("new body ".repeat(3_000), [f.facts[1]!.id]);
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
  setKnowledgeCapacity(f.memory, exact);
  expect(f.memory.injection(f.target, visible).knowledgeCommitIds).toEqual([newer.commit]);
  setKnowledgeCapacity(f.memory, exact - 1);
  expect(f.memory.injection(f.target, visible).text).toBe(""); // no omission-only message
  setKnowledgeCapacity(f.memory, oldCost);
  expect(f.memory.injection(f.target, visible).text).toBe(""); // zero remainder
});

test("64c an oversized old body cannot displace a fitting newer body, and omission is receipted", () => {
  const f = fixture();
  const old = f.create("large first ".repeat(6_000), [f.facts[0]!.id]);
  const latest = f.create("small later", [f.facts[1]!.id]);
  setKnowledgeCapacity(f.memory, 5_000);
  const result = f.memory.injection(f.target);
  expect(result.knowledgeCommitIds).toEqual([latest.commit]);
  expect(result.text).toContain("small later");
  expect(result.text).toContain(`omitted 1 constraint knowledge; expand: K${old.knowledgeId}`);
  expect(result.text).not.toContain("large first");
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
  setKnowledgeCapacity(f.memory, 20_000);
  expect(f.memory.injection(f.target, view({ knowledgeCommitIds: new Set([old.commit]) })).text).toBe("");
  f.memory.store.db.prepare("UPDATE knowledge_revisions SET text = ? WHERE id = ?").run(body + " x", old.commit);
  expect(f.memory.injection(f.target, view({ knowledgeCommitIds: new Set([old.commit]) })).text).toBe("");
});

test("68 untouched frozen and post-freeze versions remain pending without affecting delivery eligibility", async () => {
  const f = fixture({ dreaming: { triggerTokens: 1 } });
  const processed = f.create("processed", [f.facts[1]!.id]);
  const pool = `project:${f.session.projectId}`;
  f.memory.setKnowledgeBudget("project", f.memory.store.pendingPoolWeight(pool, f.target) * 2);
  let unprocessed!: ReturnType<typeof f.create>;
  const result = await f.scenarios.run(f.memory, f.target, () => {
    // This new version arrives after the range froze; only the original version is handled.
    unprocessed = f.create("unprocessed", [f.facts[0]!.id]);
    return { outcome: "success", output: "reviewed", request: { fixture: "delivery is independent" } };
  });
  expect(result.outcome).toBe("success");
  expect(f.memory.store.pendingVersions(pool, f.target).map(value => value.revisionId)).toEqual([processed.commit, unprocessed.commit]);
  expect(f.memory.injection(f.target).knowledgeCommitIds).toEqual([processed.commit, unprocessed.commit]);
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
  f.create("remaining candidate ".repeat(6_000), [f.facts[1]!.id]);
  const candidate = f.memory.injection(f.target);
  setKnowledgeCapacity(f.memory, tokens(candidate.text));
  const state = { fromCommit: parent.commit, toCommits: [archive.committed[0]!.commit] };
  expect(f.memory.injection(f.target, view({ knowledgeStates: new Set([knowledgeStateKey(state)]) })).text).toBe("");
});

test("34c state transitions are whole deterministic prefix items and only selected receipts persist", () => {
  const f = fixture();
  const parents = [f.create("retire first ".repeat(4_000), [f.facts[0]!.id]), f.create("retire second ".repeat(4_000), [f.facts[1]!.id]), f.create("retire third ".repeat(4_000), [f.facts[0]!.id])];
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
  setKnowledgeCapacity(f.memory, visibleCost + tokens(firstOnly.text));

  const first = f.memory.injection(f.target, view({ knowledgeCommitIds: visibleParents }));
  expect(first.knowledgeCommitIds).toEqual([]);
  expect(first.knowledgeStates).toEqual([{ fromCommit: parents[0]!.commit, toCommits: [archives[0]!.commit] }]);
  expect(first.text).toContain(`K${parents[0]!.knowledgeId}@${parents[0]!.commit} is archived`);
  expect(first.text).not.toContain(`K${parents[1]!.knowledgeId}@${parents[1]!.commit} is archived`);
  expect(first.text).not.toContain("omitted");

  const firstReceipt = knowledgeStateKey(first.knowledgeStates![0]!);
  setKnowledgeCapacity(f.memory, 100_000);
  const second = f.memory.injection(f.target, view({ knowledgeCommitIds: visibleParents, knowledgeStates: new Set([firstReceipt]) }));
  expect(second.knowledgeStates).toEqual([
    { fromCommit: parents[1]!.commit, toCommits: [archives[1]!.commit] },
    { fromCommit: parents[2]!.commit, toCommits: [archives[2]!.commit] },
  ]);
  expect(second.text).not.toContain(`K${parents[0]!.knowledgeId}@${parents[0]!.commit} is archived`);
  expect(second.text).toContain(`K${parents[1]!.knowledgeId}@${parents[1]!.commit} is archived`);
  expect(second.text).toContain(`K${parents[2]!.knowledgeId}@${parents[2]!.commit} is archived`);

  setKnowledgeCapacity(f.memory, visibleCost + tokens(firstOnly.text) - 1);
  const unfit = f.memory.injection(f.target, view({ knowledgeCommitIds: visibleParents }));
  expect(unfit).toMatchObject({ text: "", knowledgeCommitIds: [] });
  expect(unfit.knowledgeStates).toBeUndefined();
});

test("34c state-prefix budgeting shares exact framing with bodies without acknowledging an omitted body", () => {
  const f = fixture();
  const parent = f.create("retire visible parent ".repeat(6_000), [f.facts[0]!.id]);
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
  const exact = visibleCost + tokens(full.text);
  setKnowledgeCapacity(f.memory, exact);
  expect(f.memory.injection(f.target, visible)).toMatchObject({ knowledgeCommitIds: [body.commit], knowledgeStates: full.knowledgeStates });
  setKnowledgeCapacity(f.memory, exact - 1);
  const partial = f.memory.injection(f.target, visible);
  expect(partial.knowledgeCommitIds).toEqual([]);
  expect(partial.knowledgeStates).toEqual(full.knowledgeStates);
  expect(partial.text).not.toContain("deliver this complete body");
});

test("34c merge notices are scoped to visible parents and do not grant the survivor body", async () => {
  const f = fixture();
  const first = f.create("first parent", [f.facts[0]!.id]);
  const second = f.create("second parent", [f.facts[1]!.id]);
  const merge = await maintain(f, { op: "merge", id: `K${first.knowledgeId}@${first.commit}`,
    absorb: [`K${second.knowledgeId}@${second.commit}`], text: "merged survivor", category: "constraint", scope: "project",
    supports: [`F${f.facts[0]!.id}`], topics: [], reason: "merge" },
  [`K${first.knowledgeId}@${first.commit}`, `K${second.knowledgeId}@${second.commit}`]);
  const offered = f.memory.injection(f.target, view({ knowledgeCommitIds: new Set([second.commit]) }));
  expect(offered.text).toContain(`K${second.knowledgeId}@${second.commit} is merged into K${first.knowledgeId}@${merge[0]!.commit}`);
  expect(offered.knowledgeStates).toEqual([{ fromCommit: second.commit, toCommits: [merge[0]!.commit] }]);
  expect(offered.knowledgeCommitIds).toEqual([merge[0]!.commit]);
  const noticeOnly = view({ knowledgeCommitIds: new Set([second.commit, merge[0]!.commit]) });
  const state = f.memory.injection(f.target, noticeOnly);
  expect(state.knowledgeCommitIds).toEqual([]);
  expect(state.knowledgeStates).toEqual([{ fromCommit: second.commit, toCommits: [merge[0]!.commit] }]);
});

test("34c split notice names both children while partial budgeting grants body visibility only to the child kept", async () => {
  const f = fixture();
  const parent = f.create("compound parent ".repeat(4_000), [f.facts[0]!.id]);
  const split = await maintain(f, { op: "split", id: `K${parent.knowledgeId}@${parent.commit}`,
    supports: [], reason: "separate", children: [
      { text: "first child ".repeat(450), category: "constraint", topics: [] }, { text: "second child ".repeat(450), category: "goal", topics: [] }] },
  [`K${parent.knowledgeId}@${parent.commit}`], false);
  const visible = view({ knowledgeCommitIds: new Set([parent.commit]) });
  let partial: ReturnType<typeof f.memory.injection> | undefined;
  for (let cap = 4_000; cap < 10_000; cap += 10) {
    setKnowledgeCapacity(f.memory, cap);
    const offered = f.memory.injection(f.target, visible);
    if (offered.knowledgeCommitIds.length === 1 && offered.knowledgeStates?.length === 1) { partial = offered; break; }
  }
  expect(partial?.text).toContain(`split into K${split[0]!.knowledgeId}@${split[0]!.commit} and K${split[1]!.knowledgeId}@${split[1]!.commit}`);
  expect(partial?.knowledgeCommitIds).toHaveLength(1);
  expect(partial?.knowledgeStates).toEqual([{ fromCommit: parent.commit, toCommits: split.map(item => item.commit) }]);
  expect(partial?.knowledgeCommitIds).toEqual([split[1]!.commit]);
  expect(partial?.text).toContain(`omitted 1 constraint knowledge; expand: K${split[0]!.knowledgeId}`);
  expect(partial?.text).not.toContain("first child");
  expect(partial?.text).toContain("second child");
});

test("34c delivery check keeps graph/source work bounded as candidate count grows", () => {
  let previous: [number, number] | undefined;
  for (const count of [1, 40]) {
    const f = fixture();
    for (let index = 0; index < count; index++) f.create(`knowledge ${index}`, [f.facts[index % 2]!.id]);
    const spy = vi.spyOn(f.memory.store.db, "prepare");
    f.memory.injection(f.target, view({ raw: new Map([["first", "source"], ["second", "source"]]) }));
    const statements = spy.mock.calls.map(([sql]) => String(sql));
    const sourceQueries = statements.filter(sql => !/noted_entries/.test(sql) && /source_entries|fact_sources/.test(sql)).length;
    const watermarkQueries = statements.filter(sql => /noted_entries/.test(sql)).length;
    expect(statements.some(sql => /source_entry_raw/.test(sql))).toBe(false);
    expect(sourceQueries).toBeLessThanOrEqual(5);
    expect(watermarkQueries).toBeLessThanOrEqual(4);
    if (previous) expect([sourceQueries, watermarkQueries]).toEqual(previous);
    previous = [sourceQueries, watermarkQueries];
    spy.mockRestore();
  }
});
