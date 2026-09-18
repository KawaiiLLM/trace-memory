import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { TraceMemory, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";
import type { KnowledgeCategory, KnowledgeScope } from "../../../src/core/model/index.ts";

interface ParentExample {
  text: string;
  category: KnowledgeCategory;
  scope: KnowledgeScope;
  topics: string[];
}
interface WorkflowExample {
  id: string;
  judgment: "faithful" | "avoid" | "honest-loss";
  archivePriority?: number;
  /** 59: an older identity created and archived before the parents, for a revival round. */
  archived?: ParentExample & { reason: string };
  parents: ParentExample[];
  result: Record<string, unknown>;
  review: string;
}
interface WorkflowFixture {
  provenance: string;
  semanticReview: { authority: string; limitations: string[] };
  promptOrder: string[];
  examples: WorkflowExample[];
}

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/dreaming-workflow.json", import.meta.url), "utf8")) as WorkflowFixture;
const prompt = readFileSync(new URL("../../../src/core/prompts/dreaming.md", import.meta.url), "utf8");
const active: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of active.splice(0)) memory.close(); });
const success = { outcome: "success", output: "scripted fixture complete", request: { fixture: "dreaming-workflow" } } as const satisfies RunAgentResult;

function example(id: string): WorkflowExample {
  const found = fixture.examples.find(value => value.id === id);
  if (!found) throw new Error(`Missing Dreamer workflow fixture ${id}`);
  return found;
}

function seeded(parents: ParentExample[], agent: (task: DreamingAgentInput) => Promise<RunAgentResult>, archived?: WorkflowExample["archived"]) {
  const memory = TraceMemory(":memory:", raw => agent(raw as DreamingAgentInput), { dreaming: { triggerTokens: 1 } });
  active.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "workflow-fixture", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "review maintenance candidates", startedAt: "now" });
  const facts = store.commitNotingRun({
    run: { kind: "manual", sessionId: session.id, createdAt: "now" },
    facts: parents.map(parent => ({ turnId: turn.id, actor: "user" as const, category: "decision" as const,
      text: parent.text, source: [`T${turn.id}#user`], createdAt: "now" })),
  });
  if (!facts.ok) throw new Error(facts.problems.join("; "));
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  let archive: { knowledgeId: number; commit: number; parent: number } | undefined;
  if (archived) {
    // The older identity is created, then archived and settled by an earlier trusted Dreamer run (48's shape).
    const { reason, ...body } = archived;
    const old = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, createdAt: "now" },
      operations: [{ op: "create", handle: "$old", author: "workflow-fixture", ...body, supports: [facts.facts[0]!.id], reason: "Seed archived identity", createdAt: "now" }] });
    if (!old.ok) throw new Error(old.problems.join("; "));
    const range = store.retainDreamingRange(path, [old.committed[0]!.commit]);
    const claim = store.acquireClaim(path, "dreaming", "archive")!;
    const execution = store.beginExecution({ sessionId: session.id, phase: "dreaming", head: range.anchor, origin: range.origin });
    const run = store.bindDreamingRun(store.bindRunOrigin({ kind: "dreaming", sessionId: session.id, branch: "main",
      dreamingRangeId: range.id, claim, executionId: execution, createdAt: "now" }, range.origin));
    const result = store.commitConsolidationRun({ path, run, operations: [{ op: "archive", knowledgeId: old.committed[0]!.knowledgeId,
      baseCommit: old.committed[0]!.commit, supports: [], reason, createdAt: "now" }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    const runId = store.dreamingRunId(run)!;
    store.updateRun(runId, { ...run, outcome: "success" });
    store.completeDreaming(runId, [old.committed[0]!.commit], [result.committed[0]!.commit]);
    store.releaseClaim(claim);
    archive = { knowledgeId: old.committed[0]!.knowledgeId, commit: result.committed[0]!.commit, parent: old.committed[0]!.commit };
  }
  const created = store.commitConsolidationRun({
    run: { kind: "manual", sessionId: session.id, createdAt: "now" },
    operations: parents.map((parent, index) => ({ op: "create" as const, handle: `$${index + 1}`, author: "workflow-fixture",
      ...parent, supports: [facts.facts[index]!.id], reason: "Seed reviewed parent", createdAt: "now" })),
  });
  if (!created.ok) throw new Error(created.problems.join("; "));
  return { memory, store, items: created.committed, archive, target: path };
}
const handle = (item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@${item.commit}`;

// These are reviewed semantic expectations, not executable equivalence rules. The assertions keep
// that boundary explicit while ensuring every required comparison example remains in the corpus.
test("35c reviewed fixtures label semantic judgments and non-semantic limits honestly", () => {
  expect(fixture.semanticReview.authority).toContain("human semantic-review");
  expect(fixture.semanticReview.authority).toContain("not runtime validation");
  expect(fixture.semanticReview.limitations.join(" ")).toContain("not that a real model will follow");
  expect(fixture.semanticReview.limitations.join(" ")).toContain("does not prove improved recall");
  expect(fixture.provenance).toContain("Magic Context 246a1c390e9a81944b867c1cd94ae5b7166e26e3");
  expect(fixture.provenance).toContain("pi-observational-memory ce9fc982b3a219a7839f07c9f4a3e054e81a2b21");
  expect(fixture.examples.map(value => value.id)).toEqual(expect.arrayContaining([
    "faithful-authority-merge", "qualified-open-reminder", "budget-only-topic-stripping",
    "obsolete-topic-correction", "same-topic-independent-claims", "equivalent-information-retirement",
    "verified-obsolete-progress-retirement", "deliberate-valid-information-loss",
    "avoidable-rewrite-then-archive", "legitimate-disposition-correction",
    "spec-clauses-kept-whole", "readable-body-left-alone", "finished-reference-archived-on-completion-fact",
    "split-piece-merges-into-existing-home", "finished-status-folded-into-ruling", "over-detailed-body-trimmed-to-claim",
  ]));
  expect(fixture.examples.filter(value => value.archivePriority !== undefined).map(value => value.archivePriority)).toEqual([1, 2, 3]);
});

test("35c prompt states the reviewed maintenance stages in one unambiguous order", () => {
  let previous = -1;
  for (const heading of fixture.promptOrder) {
    const position = prompt.indexOf(heading);
    expect(position, `missing prompt stage: ${heading}`).toBeGreaterThan(previous);
    expect(prompt.indexOf(heading, position + heading.length), `duplicate prompt stage: ${heading}`).toBe(-1);
    previous = position;
  }
  expect(prompt).not.toMatch(/global 4,000|project 10,000|session 1,000|applicable block within 15,000/);
});

test("35c scripted faithful merge keeps authority, conditions, exception, and rendered topics", async () => {
  const reviewed = example("faithful-authority-merge");
  const result = reviewed.result as unknown as ParentExample;
  const actions: string[] = [];
  let state!: ReturnType<typeof seeded>;
  state = seeded(reviewed.parents, async task => {
    const check = task.tools.find(tool => tool.name === "check")!;
    const memory = task.tools.find(tool => tool.name === "memory")!;
    actions.push("check");
    expect(check.execute({})).toContain(`unaccounted: ${handle(state.items[0]!)}, ${handle(state.items[1]!)}`);
    actions.push("memory");
    expect(JSON.parse(memory.execute({ operations: [{ op: "merge",
      id: `K${state.items[0]!.knowledgeId}@${state.items[0]!.commit}`,
      absorb: [`K${state.items[1]!.knowledgeId}@${state.items[1]!.commit}`],
      ...result, supports: [], reason: "Reviewed complete claims retain authority, condition, exception, and subjects" }], skipped: [] })).committed).toHaveLength(1);
    actions.push("check");
    expect(check.execute({})).toContain("Blockers: none");
    return success;
  });

  expect((await state.memory.dream(state.target)).outcome).toBe("success");
  expect(actions).toEqual(["check", "memory", "check"]);
  const current = state.store.listCurrentKnowledge(state.target);
  expect(current).toHaveLength(1);
  expect(current[0]!.revision).toMatchObject({ text: result.text, category: result.category, scope: result.scope,
    topics: [...result.topics].sort() });
  const rendered = state.memory.trace(`K${current[0]!.knowledge.id}@${current[0]!.revision.id}`);
  expect(rendered).toContain("The user decided");
  expect(rendered).toContain("artifacts may be prepared before deployment");
  expect(rendered).toContain('topics: ["artifact-preparation","deployment","offline-runtime"]');
});

test("35c scripted equivalent retirement checks around the archive and preserves the compared survivor", async () => {
  const reviewed = example("equivalent-information-retirement");
  const disposition = reviewed.result as { archiveParent: number; survivorParent: number; reason: string };
  const actions: string[] = [];
  let state!: ReturnType<typeof seeded>;
  state = seeded(reviewed.parents, async task => {
    const check = task.tools.find(tool => tool.name === "check")!;
    const memory = task.tools.find(tool => tool.name === "memory")!;
    actions.push("check"); expect(check.execute({})).toContain("unaccounted: ");
    const archived = state.items[disposition.archiveParent]!;
    actions.push("memory");
    expect(JSON.parse(memory.execute({ operations: [{ op: "archive", id: `K${archived.knowledgeId}@${archived.commit}`,
      supports: [], reason: disposition.reason }], skipped: [{ knowledge: handle(state.items[disposition.survivorParent]!), because: "The compared survivor already states the claim; nothing to change" }] })).committed).toHaveLength(1);
    actions.push("check"); expect(check.execute({})).toContain("Blockers: none");
    return success;
  });

  expect((await state.memory.dream(state.target)).outcome).toBe("success");
  expect(actions).toEqual(["check", "memory", "check"]);
  const survivor = state.items[disposition.survivorParent]!;
  const current = state.store.currentCommit(survivor.knowledgeId, state.target)[0]!;
  expect(current).toMatchObject({ text: reviewed.parents[disposition.survivorParent]!.text,
    topics: reviewed.parents[disposition.survivorParent]!.topics });
  const archivedId = state.items[disposition.archiveParent]!.knowledgeId;
  expect(state.store.currentCommit(archivedId, state.target)[0]).toMatchObject({ op: "archive", text: "" });
  expect(state.store.listCurrentKnowledge(state.target).every(value => value.knowledge.id !== archivedId)).toBe(true);
});

test("35c scripted no-op skips the item with a reason and checks actual state before and after", async () => {
  const reviewed = example("qualified-open-reminder");
  const actions: string[] = [];
  let state!: ReturnType<typeof seeded>;
  state = seeded(reviewed.parents, async task => {
    const check = task.tools.find(tool => tool.name === "check")!;
    const memory = task.tools.find(tool => tool.name === "memory")!;
    actions.push("check"); expect(check.execute({})).toContain(`unaccounted: ${handle(state.items[0]!)}`);
    actions.push("empty-memory"); expect(JSON.parse(memory.execute({ operations: [], skipped: [{ knowledge: handle(state.items[0]!), because: reviewed.review }] }))).toMatchObject({ committed: [] });
    actions.push("check"); expect(check.execute({})).toContain("Blockers: none");
    return success;
  });

  expect((await state.memory.dream(state.target)).outcome).toBe("success");
  expect(actions).toEqual(["check", "empty-memory", "check"]);
  expect(state.store.listKnowledgeRevisions()).toHaveLength(1);
  expect(state.store.listCurrentKnowledge(state.target)[0]!.revision).toMatchObject(reviewed.parents[0]!);
});

test("59 scripted round: two items skipped with reasons, one New item revives the archived identity the batched search found", async () => {
  const reviewed = example("two-skipped-one-revived");
  const result = reviewed.result as { search: { queries: string[]; layer: "knowledge"; versions: "history"; cap: number };
    skipped: { parent: number; because: string }[]; merge: { absorb: number; text: string; category: KnowledgeCategory; scope: KnowledgeScope; topics: string[]; reason: string } };
  const actions: string[] = [];
  let state!: ReturnType<typeof seeded>;
  state = seeded(reviewed.parents, async task => {
    const tool = (name: string) => task.tools.find(value => value.name === name)!;
    const archive = state.archive!;
    // One batched history search before the first New item is decided: no hit is named, a current
    // self-hit is not a revival, the archived identity is the revival candidate.
    actions.push("search");
    const found = tool("search").execute(result.search);
    expect(found).toContain(`no hit: ${JSON.stringify(result.search.queries[0])}`);
    expect(found).toContain(`${JSON.stringify(result.search.queries[1])}: [${handle(state.items[1]!)}]`);
    // 59b: hits come in similarity order, so the New item's own self-hit may lead; with cap 2 the
    // archived identity is still listed and is the revival candidate.
    expect(found).toContain(`${JSON.stringify(result.search.queries[2])}: [K${archive.knowledgeId}@`);
    actions.push("trace");
    tool("trace").execute({ address: `K${archive.knowledgeId}@${archive.commit}`, itemBudget: null });
    tool("trace").execute({ address: `K${archive.knowledgeId}@${archive.parent}`, itemBudget: null });
    actions.push("memory");
    const receipt = JSON.parse(tool("memory").execute({ operations: [{ op: "merge", id: `K${archive.knowledgeId}@${archive.commit}`,
      absorb: [handle(state.items[result.merge.absorb]!)], text: result.merge.text, category: result.merge.category, scope: result.merge.scope,
      topics: result.merge.topics, supports: [], reason: result.merge.reason }],
      skipped: result.skipped.map(skip => ({ knowledge: handle(state.items[skip.parent]!), because: skip.because })) }));
    expect(receipt.committed).toHaveLength(1);
    actions.push("check");
    expect(tool("check").execute({})).toContain("Blockers: none");
    return success;
  }, reviewed.archived);

  const outcome = await state.memory.dream(state.target);
  expect(outcome.outcome).toBe("success");
  expect(actions).toEqual(["search", "trace", "memory", "check"]);
  if (!("runId" in outcome)) throw new Error("missing run id");
  const response = JSON.parse(state.store.getRun(outcome.runId)!.response!);
  expect(response.skipped).toEqual(result.skipped.map(skip => ({ knowledge: handle(state.items[skip.parent]!), because: skip.because })));
  expect(response.check.problems).toEqual([]);
  const current = state.store.listCurrentKnowledge(state.target);
  expect(current.map(value => value.knowledge.id).sort((a, b) => a - b)).toEqual([state.items[0]!.knowledgeId, state.items[1]!.knowledgeId, state.archive!.knowledgeId].sort((a, b) => a - b));
  const revived = current.find(value => value.knowledge.id === state.archive!.knowledgeId)!;
  expect(revived.revision.parentId).toBe(state.archive!.commit);
  expect(revived.revision.text).toBe(result.merge.text);
  // A skip accounts and never certifies: the skipped leaves are certified because they are successor-free.
  for (const skip of result.skipped) expect(state.store.isKnowledgeProcessed(state.items[skip.parent]!.commit)).toBe(true);
  expect(state.store.isKnowledgeProcessed(revived.revision.id)).toBe(true);
  expect(state.store.isKnowledgeProcessed(state.items[result.merge.absorb]!.commit)).toBe(false);
  expect(state.store.pendingKnowledgeEvents(state.target)).toEqual([]);
});
