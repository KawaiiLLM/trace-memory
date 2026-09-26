import { afterEach, expect, test } from "vitest";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { readFileSync } from "node:fs";
import { TraceMemory } from "../../../src/core/api/index.ts";
import type { KnowledgeCategory, KnowledgeScope } from "../../../src/core/model/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

interface ParentExample { text: string; category: KnowledgeCategory; scope: KnowledgeScope; topics: string[] }
interface WorkflowExample {
  id: string; judgment: "faithful" | "avoid" | "honest-loss";
  archived?: ParentExample & { reason: string }; parents: ParentExample[]; result: Record<string, unknown>; review: string;
}
interface WorkflowFixture {
  provenance: string; semanticReview: { authority: string; limitations: string[] };
  promptOrder: string[]; examples: WorkflowExample[];
}
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/dreaming-workflow.json", import.meta.url), "utf8")) as WorkflowFixture;
const prompt = loadPrompt("dreaming.md"), active: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of active.splice(0)) memory.close(); });
const success = { outcome: "success", output: "scripted fixture complete", request: { fixture: "dreaming-workflow" } } as const;
const example = (id: string) => { const found = fixture.examples.find(value => value.id === id); if (!found) throw new Error(`Missing ${id}`); return found; };
const handle = (state: ReturnType<typeof seeded>, item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}#${state.store.versionTag(item.knowledgeId, item.commit)}`;
const history = (state: ReturnType<typeof seeded>, item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@v${state.store.versionOrdinal(item.knowledgeId, item.commit)}`;

function seeded(parents: ParentExample[]) {
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected phase"); });
  const memory = TraceMemory(":memory:", scenarios.agent); active.push(memory);
  const store = memory.store, project = store.createProject({ name: "workflow-fixture", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "review", startedAt: "now" });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "workflow", role: "user", text: "review", raw: "review", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: parents.map(parent => ({
    turnId: turn.id, entryIds: [entry.id], actor: "user" as const, category: "decision" as const, text: parent.text, source: [`T${turn.id}#E1`], createdAt: "now",
  })) });
  if (!facts.ok) throw new Error(facts.problems.join("; "));
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
  const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: parents.map((parent, index) => ({
    op: "create" as const, handle: `$${index + 1}`, author: "workflow-fixture", ...parent, supports: [facts.facts[index]!.id], reason: "Seed reviewed parent", createdAt: "now",
  })) });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const trigger = createDreamerTrigger(memory, path, facts.facts[0]!.id, 1, "project");
  return { memory, store, scenarios, items: created.committed, trigger, target: path };
}

test("35c reviewed fixtures label semantic judgments and non-semantic limits honestly", () => {
  expect(fixture.semanticReview.authority).toContain("historical human semantic-review");
  expect(fixture.semanticReview.authority).toContain("mechanical fixture maintenance only");
  expect(fixture.semanticReview.authority).toContain("not runtime validation");
  expect(fixture.semanticReview.limitations.join(" ")).toContain("not that a real model will follow");
  expect(fixture.semanticReview.limitations.join(" ")).toContain("does not prove improved recall");
  expect(fixture.semanticReview.limitations.join(" ")).toContain("not new human gold or real-model approval");
  expect(fixture.provenance).toContain("Magic Context 246a1c390e9a81944b867c1cd94ae5b7166e26e3");
  expect(fixture.provenance).toContain("pi-observational-memory ce9fc982b3a219a7839f07c9f4a3e054e81a2b21");
});

test("64c prompt and fixture use only the current maintenance contract", () => {
  let previous = -1;
  for (const heading of fixture.promptOrder) {
    const position = prompt.indexOf(heading);
    expect(position, `missing prompt stage: ${heading}`).toBeGreaterThan(previous);
    expect(prompt.indexOf(heading, position + heading.length), `duplicate prompt stage: ${heading}`).toBe(-1);
    previous = position;
  }
  const renderedFixture = JSON.stringify(fixture);
  for (const retired of [
    "archivePriority", "### Intensity, set by the failed check", "Second intensity",
    "second intensity", "frozen family", "successor-free", "shortening-only",
    "qualified-open-reminder", "readable-body-left-alone",
    "finished-reference-archived-on-completion-fact", "finished-status-folded-into-ruling",
  ]) expect(renderedFixture).not.toContain(retired);
  expect(prompt).not.toContain("### Intensity, set by the failed check");
  expect(prompt).toContain("over budget: another round of Archiving on it, then `check` again");
  expect(prompt).toContain("then `check` again, until it fits");
  expect(prompt).toContain("Another pool over budget is reported, not acted on");
});

test("85: a pending-triggered deterministic Dreamer still archives until its selected pool fits", async () => {
  const state = seeded([{ text: "Routine progress record ".repeat(600), category: "reference", scope: "project", topics: [] }]);
  const pool = `project:${state.store.getSession(state.target.sessionId)!.projectId}`;
  const size = state.store.poolSizes(state.target).find(value => value.pool === pool)!.tokens;
  const weight = state.store.pendingPoolWeight(pool, state.target);
  expect(weight).toBeGreaterThan(5_000);
  state.store.setKnowledgeBudget("project", Math.max(5_700, Math.floor(size * 0.75)));
  expect(state.store.poolSizes(state.target).find(value => value.pool === pool)!.tokens).toBeGreaterThan(state.store.knowledgeBudgets().project);
  expect(state.store.duePools(state.target, state.memory.config.dreaming.triggerTokens).map(value => value.pool)).toContain(pool);
  const outcome = await state.scenarios.run(state.memory, state.target, task => {
    task.acknowledgeRequest();
    const receipt = JSON.parse(task.tools.find(tool => tool.name === "memory")!.execute({ operations: [
      { op: "archive", id: handle(state, state.items[0]!), supports: [], reason: "Reviewed low-value routine progress retired to fit budget" }],
      skipped: [] }));
    expect(receipt.committed).toHaveLength(1);
    expect(task.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return success;
  });
  expect(outcome.outcome, JSON.stringify(outcome)).toBe("success");
  const final = state.store.poolSizes(state.target).find(value => value.pool === pool)!;
  expect(final.tokens).toBeLessThanOrEqual(final.budget);
  expect(state.store.currentCommit(state.items[0]!.knowledgeId, state.target)[0]!.op).toBe("archive");
});

test("35c faithful merge keeps authority, conditions, exception and rendered topics through a real pool run", async () => {
  const reviewed = example("faithful-authority-merge"), body = reviewed.result as unknown as ParentExample, state = seeded(reviewed.parents);
  let merged!: { knowledgeId: number; version: string };
  const outcome = await state.scenarios.run(state.memory, state.target, task => {
    const write = task.tools.find(tool => tool.name === "memory")!;
    merged = JSON.parse(write.execute({ operations: [{ op: "merge", id: handle(state, state.items[0]!), absorb: [handle(state, state.items[1]!)],
      ...body, supports: [], reason: "Reviewed complete claims retain authority, condition, exception, and subjects" }],
      skipped: [{ knowledge: history(state, state.trigger), because: "fixture trigger has no maintenance meaning" }] })).committed[0];
    expect(task.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return success;
  });
  expect(outcome.outcome).toBe("success");
  const current = state.store.currentCommit(merged.knowledgeId, state.target)[0]!;
  expect(current).toMatchObject({ text: body.text, category: body.category, scope: body.scope, topics: [...body.topics].sort() });
  const rendered = state.memory.trace(merged.version);
  expect(rendered).toContain("artifacts may be prepared before deployment");
  expect(rendered).toContain('topics: ["artifact-preparation","deployment","offline-runtime"]');
});

test("35c archive and no-op skip preserve the compared survivor and original no-op body", async () => {
  const reviewed = example("equivalent-information-retirement");
  const disposition = reviewed.result as { archiveParent: number; survivorParent: number; reason: string };
  const state = seeded(reviewed.parents), archived = state.items[disposition.archiveParent]!, survivor = state.items[disposition.survivorParent]!;
  const outcome = await state.scenarios.run(state.memory, state.target, task => {
    const receipt = JSON.parse(task.tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "archive", id: handle(state, archived), supports: [], reason: disposition.reason }],
      skipped: [{ knowledge: history(state, survivor), because: "Compared survivor already states the claim" },
        { knowledge: history(state, state.trigger), because: "fixture trigger has no maintenance meaning" }] }));
    expect(receipt.committed).toHaveLength(1);
    return success;
  });
  expect(outcome.outcome).toBe("success");
  expect(state.store.currentCommit(survivor.knowledgeId, state.target)[0]).toMatchObject({ text: reviewed.parents[disposition.survivorParent]!.text });
  expect(state.store.currentCommit(archived.knowledgeId, state.target)[0]).toMatchObject({ op: "archive", text: "" });
  const processed = state.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ? ORDER BY revision_id")
    .all(`project:${state.store.getSession(state.target.sessionId)!.projectId}`).map(row => Number(row.revision_id));
  expect(processed).toContain(survivor.commit); // accepted skip
  expect(processed).not.toContain(archived.commit); // superseded parent needs no processing row
});

test("58 reconstructed decision-provenance fixtures remain split by object and never archive the design", () => {
  const result = (value: WorkflowExample) => value.result as { children: { text: string; category: string }[]; operations: string[] };
  const mixed = example("reconstructed-mixed-decision-objects-split");
  expect(mixed.review).toContain("F1841");
  expect(result(mixed).children.map(child => child.category)).toEqual(["mechanism", "open"]);
  expect(result(mixed).operations.join(" ")).toContain("no archive");
  const snapshot = example("reconstructed-architecture-decision-not-an-implementation-snapshot");
  expect(result(snapshot).children[0]!.text).toContain("用户提案并采纳");
  expect(result(snapshot).operations.join(" ")).toContain("no archive of the implementation item");
});
