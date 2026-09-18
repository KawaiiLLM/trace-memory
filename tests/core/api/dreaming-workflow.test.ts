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

function seeded(parents: ParentExample[], agent: (task: DreamingAgentInput) => Promise<RunAgentResult>) {
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
  const created = store.commitConsolidationRun({
    run: { kind: "manual", sessionId: session.id, createdAt: "now" },
    operations: parents.map((parent, index) => ({ op: "create" as const, handle: `$${index + 1}`, author: "workflow-fixture",
      ...parent, supports: [facts.facts[index]!.id], reason: "Seed reviewed parent", createdAt: "now" })),
  });
  if (!created.ok) throw new Error(created.problems.join("; "));
  return { memory, store, items: created.committed,
    target: { sessionId: session.id, branch: "main", headTurnId: turn.id } };
}

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
    expect(check.execute({})).toContain("Blockers: none");
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
    actions.push("check"); expect(check.execute({})).toContain("Blockers: none");
    const archived = state.items[disposition.archiveParent]!;
    actions.push("memory");
    expect(JSON.parse(memory.execute({ operations: [{ op: "archive", id: `K${archived.knowledgeId}@${archived.commit}`,
      supports: [], reason: disposition.reason }], skipped: [] })).committed).toHaveLength(1);
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

test("35c scripted no-op uses an empty batch and checks actual state before and after", async () => {
  const reviewed = example("qualified-open-reminder");
  const actions: string[] = [];
  const state = seeded(reviewed.parents, async task => {
    const check = task.tools.find(tool => tool.name === "check")!;
    const memory = task.tools.find(tool => tool.name === "memory")!;
    actions.push("check"); expect(check.execute({})).toContain("Blockers: none");
    actions.push("empty-memory"); expect(JSON.parse(memory.execute({ operations: [], skipped: [] }))).toMatchObject({ committed: [] });
    actions.push("check"); expect(check.execute({})).toContain("Blockers: none");
    return success;
  });

  expect((await state.memory.dream(state.target)).outcome).toBe("success");
  expect(actions).toEqual(["check", "empty-memory", "check"]);
  expect(state.store.listKnowledgeRevisions()).toHaveLength(1);
  expect(state.store.listCurrentKnowledge(state.target)[0]!.revision).toMatchObject(reviewed.parents[0]!);
});
