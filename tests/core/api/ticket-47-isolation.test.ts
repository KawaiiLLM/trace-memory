import { afterEach, expect, test } from "vitest";
import { noVisibility, TraceMemory, type ConsolidationAgentInput, type DreamingAgentInput, type NotingAgentInput } from "../../../src/core/api/index.ts";
import type { KnowledgeOperationInput } from "../../../src/core/store/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

const cancelled = { outcome: "cancelled", output: "fixture stop", request: { offline: true } } as const;

type Capture = {
  text: string;
  material: unknown;
  feedback?: string;
  hasReviewFeedback?: boolean;
  operationEnum?: unknown;
  hasId?: boolean;
  hasAbsorb?: boolean;
};

function completeRead(tool: { execute(input: unknown): string }, address: string) {
  let page = tool.execute({ address, full: true, itemBudget: null });
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1])
    page = tool.execute({ address: `cursor=${cursor}`, itemBudget: null });
}

test("47: head and rewind N/C material and eligibility ignore sibling-only and terminal-only state", async () => {
  const captures = new Map<string, Capture>();
  let key = "", source = "";
  const scenarios = new AdmittedDreamerScenarios(async raw => {
    if ((raw as { kind: string }).kind === "noting") {
      const input = raw as NotingAgentInput;
      const note = input.tools.find(tool => tool.name === "note")!;
      const receipt = note.execute({ facts: [{ category: "observation", actor: "user", text: "shared durable rule", source: [source] }] });
      captures.set(`${key}:N`, { text: input.text, material: structuredClone(input.material), feedback: input.reviewFeedback(receipt) });
      return cancelled;
    }
    if ((raw as { kind: string }).kind === "consolidation") {
      const input = raw as ConsolidationAgentInput;
      const memory = input.tools.find(tool => tool.name === "memory")!;
      const operation = ((memory.parameters.properties as any).operations.items as any);
      captures.set(`${key}:C`, {
        text: input.text,
        material: structuredClone(input.material),
        hasReviewFeedback: "reviewFeedback" in input,
        operationEnum: structuredClone(operation.properties.op.enum),
        hasId: "id" in operation.properties,
        hasAbsorb: "absorb" in operation.properties,
      });
      return cancelled;
    }
    throw new Error("unexpected Dreamer call outside an admitted fixture scenario");
  });
  const memory = TraceMemory(":memory:", scenarios.agent, {
    noting: { triggerTokens: 1 }, consolidation: { triggerTokens: 1 },
  });
  memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "isolation", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const rootTurn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: "now" });
  const headTurn = store.appendTurn({ sessionId: session.id, parentTurnId: rootTurn.id, kind: "turn", userPrompt: "head", startedAt: "later" });
  const append = (turnId: number, nativeId: string) => memory.appendEntry({ sessionId: session.id, turnId, nativeLineage: "isolation", nativeId,
    role: "user", text: nativeId, raw: JSON.stringify({ role: "user", content: nativeId }), calls: [] });
  const evidenceEntry = append(rootTurn.id, "evidence");
  const rootPending = append(rootTurn.id, "root-pending");
  const headPending = append(headTurn.id, "head-pending");
  memory.selectEntries(session.id, "main", [evidenceEntry.id, rootPending.id, headPending.id]);
  memory.selectEntries(session.id, "rewind", [evidenceEntry.id, rootPending.id]);

  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" }, entryIds: [evidenceEntry.id], facts: [{
    turnId: rootTurn.id, entryIds: [evidenceEntry.id], category: "decision", actor: "user", text: "shared durable rule",
    source: [`T${rootTurn.id}#E${evidenceEntry.entryOrdinal}`], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const rootFact = noted.facts[0]!;
  const rootPath = { sessionId: session.id, branch: "rewind", headTurnId: rootTurn.id };
  const content = { text: "shared durable rule", category: "open" as const, scope: "project" as const, supports: [rootFact.id],
    topics: [] as string[], reason: "root state", createdAt: "now" };
  const create = (path: typeof rootPath, operation: KnowledgeOperationInput, triggerEntryId?: number) => {
    if (operation.op !== "create") throw new Error("this setup helper is create-only");
    const run = store.bindRunOrigin({ kind: "manual" as const, sessionId: session.id, branch: path.branch, createdAt: "now" },
      triggerEntryId === undefined ? null : store.triggerOrigin(path, triggerEntryId));
    const result = store.commitConsolidationRun({ path, run, operations: [operation] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  const survivor = create(rootPath, { op: "create", handle: "$survivor", author: "test", ...content }, rootPending.id);
  const maintained = create(rootPath, { op: "create", handle: "$maintained", author: "test", ...content, text: "maintained common rule" }, rootPending.id);
  const archived = create(rootPath, { op: "create", handle: "$archived", author: "test", ...content, text: "archivable common rule" }, rootPending.id);
  const victim = create(rootPath, { op: "create", handle: "$victim", author: "test", ...content, text: "merge-away common rule" }, rootPending.id);
  const targets = {
    head: { sessionId: session.id, branch: "main", headTurnId: headTurn.id },
    rewind: rootPath,
  };
  const visible = noVisibility();
  visible.knowledgeCommitIds.add(maintained.commit);
  store.setCurrentPath(session.id, rootPath.branch, rootPath.headTurnId, "test-lineage");

  const capture = async (stage: "before" | "after") => {
    const result: Record<string, unknown> = {};
    for (const [name, target] of Object.entries(targets)) {
      result[`${name}:eligibility`] = ["noting", "consolidation"].map(phase =>
        memory.taskEligibility(phase as "noting" | "consolidation", target));
      key = `${stage}:${name}`;
      source = `T${rootTurn.id}#E${rootPending.entryOrdinal}`;
      expect((await memory.noting({ ...target, mode: "subagent" })).outcome).toBe("cancelled");
      expect((await memory.consolidate({ ...target, mode: "fork", visible })).outcome).toBe("cancelled");
      for (const phase of ["N", "C"] as const) result[`${name}:${phase}`] = captures.get(`${key}:${phase}`);
    }
    return result;
  };

  const before = await capture("before");
  for (const name of Object.keys(targets)) {
    const notingCapture = captures.get(`before:${name}:N`)!;
    const consolidationCapture = captures.get(`before:${name}:C`)!;
    expect(notingCapture.feedback).toContain("NEAR:");
    expect(consolidationCapture.text).toContain("<knowledge>");
    expect(consolidationCapture.text).not.toMatch(/\b(?:NEAR|CLOSER)\b/);
    expect(consolidationCapture.hasReviewFeedback).toBe(false);
    expect(consolidationCapture.operationEnum).toEqual(["create"]);
    expect(consolidationCapture.hasId).toBe(false);
    expect(consolidationCapture.hasAbsorb).toBe(false);
  }

  const siblingTurn = store.appendTurn({ sessionId: session.id, parentTurnId: rootTurn.id, kind: "turn", userPrompt: "sibling", startedAt: "sibling" });
  const siblingEntry = append(siblingTurn.id, "sibling-only source");
  memory.selectEntries(session.id, "sibling", [evidenceEntry.id, rootPending.id, siblingEntry.id]);
  const siblingNoted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "sibling", createdAt: "sibling" }, entryIds: [siblingEntry.id], facts: [{
    turnId: siblingTurn.id, entryIds: [siblingEntry.id], category: "decision", actor: "user", text: "sibling-only fact",
    source: [`T${siblingTurn.id}#E${siblingEntry.entryOrdinal}`], createdAt: "sibling",
    negate: [{ target: `F${rootFact.id}`, strength: "strong" }],
  }] });
  if (!siblingNoted.ok) throw new Error(siblingNoted.problems.join("; "));
  const siblingFact = siblingNoted.facts[0]!;
  const siblingPath = { sessionId: session.id, branch: "sibling", headTurnId: siblingTurn.id };
  const siblingContent = { ...content, supports: [siblingFact.id], reason: "sibling-only mutation", createdAt: "sibling" };
  const siblingOnly = create(siblingPath, { op: "create", handle: "$sibling", author: "test", ...siblingContent, text: "sibling-only knowledge" }, siblingEntry.id);
  store.setCurrentPath(session.id, siblingPath.branch, siblingPath.headTurnId, "test-lineage");
  const trigger = createDreamerTrigger(memory, siblingPath, siblingFact.id, 1);
  let maintenanceReceipt: any;
  const dreamed = await scenarios.run(memory, siblingPath, input => {
    const request = { fixture: "ticket-47 sibling maintenance" };
    input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!;
    const write = input.tools.find(tool => tool.name === "memory")!;
    const addressed = [
      `K${maintained.knowledgeId}@${maintained.commit}`,
      `K${archived.knowledgeId}@${archived.commit}`,
      `K${survivor.knowledgeId}@${survivor.commit}`,
      `K${victim.knowledgeId}@${victim.commit}`,
      `K${trigger.knowledgeId}@${trigger.commit}`,
    ];
    for (const address of addressed) completeRead(trace, address);
    const change = { category: "open", scope: "project", topics: [] as string[], supports: [`F${siblingFact.id}`], reason: "sibling-only mutation" };
    maintenanceReceipt = JSON.parse(write.execute({ operations: [
      { op: "update", id: addressed[0], ...change, text: "sibling-only update" },
      { op: "archive", id: addressed[1], supports: [`F${siblingFact.id}`], reason: "sibling-only archive" },
      { op: "merge", id: addressed[2], absorb: [addressed[3]], ...change, text: "sibling-only merge" },
      { op: "archive", id: addressed[4], supports: [`F${siblingFact.id}`], reason: "retire the explicit sibling trigger" },
    ], skipped: [{ knowledge: `K${siblingOnly.knowledgeId}@${siblingOnly.commit}`,
      because: "The new sibling-only identity is left unchanged; its visibility is asserted separately." }] }));
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "sibling maintenance complete", request };
  });
  if (dreamed.outcome !== "success") throw new Error(JSON.stringify({ dreamed, maintenanceReceipt }));
  expect(maintenanceReceipt.committed).toHaveLength(4);
  expect(store.listFactRelations(rootFact.id)).toContainEqual({ fromFact: siblingFact.id, toFact: rootFact.id, kind: "negate", strength: "strong" });
  expect(store.currentCommit(maintained.knowledgeId, siblingPath).at(-1)?.text).toBe("sibling-only update");
  const siblingCurrent = store.currentKnowledge(siblingPath);
  expect(siblingCurrent.some(item => item.knowledge.id === siblingOnly.knowledgeId && item.revision.text === "sibling-only knowledge")).toBe(true);
  expect(siblingCurrent.some(item => item.knowledge.id === survivor.knowledgeId && item.revision.text === "sibling-only merge")).toBe(true);
  expect(siblingCurrent.some(item => item.knowledge.id === archived.knowledgeId)).toBe(false);
  expect(siblingCurrent.some(item => item.knowledge.id === victim.knowledgeId)).toBe(false);
  store.setCurrentPath(session.id, rootPath.branch, rootPath.headTurnId, "test-lineage");
  for (const target of Object.values(targets)) {
    expect(store.currentCommit(maintained.knowledgeId, target).at(-1)?.id).toBe(maintained.commit);
    expect(store.currentKnowledge(target).some(item => item.knowledge.id === archived.knowledgeId)).toBe(true);
    expect(store.currentKnowledge(target).some(item => item.knowledge.id === victim.knowledgeId)).toBe(true);
  }

  const terminalTurn = store.appendTurn({ sessionId: session.id, parentTurnId: rootTurn.id, kind: "turn", userPrompt: "old terminal", startedAt: "terminal" });
  const terminalEntry = append(terminalTurn.id, "older terminal-only source");
  memory.selectEntries(session.id, "terminal", [evidenceEntry.id, terminalEntry.id]);
  const terminalNoted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "terminal", createdAt: "terminal" }, entryIds: [terminalEntry.id], facts: [{
    turnId: terminalTurn.id, entryIds: [terminalEntry.id], category: "observation", actor: "user", text: "older terminal-only fact",
    source: [`T${terminalTurn.id}#E${terminalEntry.entryOrdinal}`], createdAt: "terminal",
  }] });
  if (!terminalNoted.ok) throw new Error(terminalNoted.problems.join("; "));
  create({ sessionId: session.id, branch: "terminal", headTurnId: terminalTurn.id }, { op: "create", handle: "$terminal", author: "test",
    ...content, supports: [terminalNoted.facts[0]!.id], text: "older terminal-only knowledge", reason: "terminal-only", createdAt: "terminal" }, terminalEntry.id);

  const after = await capture("after");
  expect(after).toEqual(before);
  const rendered = JSON.stringify(after);
  expect(rendered).not.toContain("sibling-only");
  expect(rendered).not.toContain("older terminal-only");
});

// 64b restores the Dreamer-material half. The processed partition and pool eligibility remain deferred to 64c.
test("64b/47: D head and rewind material follows the owner's foreground and ignores sibling-only state", async () => {
  const captured: DreamingAgentInput[] = [];
  const memory = TraceMemory(":memory:", async raw => {
    const input = raw as DreamingAgentInput;
    captured.push(input);
    input.tools.find(tool => tool.name === "check")!.execute({});
    return cancelled;
  });
  memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "deferred-d-isolation", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const root = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: "now" });
  const head = store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "head", startedAt: "head" });
  const sibling = store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "sibling-only source", startedAt: "sibling" });
  const addEntry = (turnId: number, nativeId: string) => memory.appendEntry({ sessionId: session.id, turnId, nativeLineage: "deferred-d",
    nativeId, role: "user", text: nativeId, raw: JSON.stringify({ role: "user", content: nativeId }), calls: [] });
  const rootEntry = addEntry(root.id, "root-source");
  const headEntry = addEntry(head.id, "head-source");
  const siblingEntry = addEntry(sibling.id, "sibling-only source");
  memory.selectEntries(session.id, "main", [rootEntry.id, headEntry.id]);
  memory.selectEntries(session.id, "rewind", [rootEntry.id]);
  memory.selectEntries(session.id, "sibling", [rootEntry.id, siblingEntry.id]);
  const commitFact = (turnId: number, entryId: number, branch: string, text: string) => {
    const result = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch, createdAt: branch }, entryIds: [entryId], facts: [{
      turnId, entryIds: [entryId], category: "observation" as const, actor: "user" as const, text,
      source: [`T${turnId}#E${store.getSourceEntry(entryId)!.entryOrdinal}`], createdAt: branch,
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.facts[0]!;
  };
  const rootFact = commitFact(root.id, rootEntry.id, "main", "root fact");
  const siblingFact = commitFact(sibling.id, siblingEntry.id, "sibling", "sibling-only fact");
  const create = (path: { sessionId: number; branch: string; headTurnId: number }, factId: number, text: string) => {
    const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, branch: path.branch, createdAt: path.branch }, operations: [{
      op: "create", handle: text.startsWith("root") ? "$root" : "$sibling", author: "test", text, category: "open", scope: "project", supports: [factId], topics: [], reason: "D isolation fixture", createdAt: path.branch,
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
  };
  const headPath = { sessionId: session.id, branch: "main", headTurnId: head.id };
  const rewindPath = { sessionId: session.id, branch: "rewind", headTurnId: root.id };
  create(rewindPath, rootFact.id, "root knowledge");
  create({ sessionId: session.id, branch: "sibling", headTurnId: sibling.id }, siblingFact.id, "sibling-only knowledge");

  store.setCurrentPath(session.id, headPath.branch, headPath.headTurnId, "test-lineage");
  createDreamerTrigger(memory, { ...headPath, triggerEntryId: headEntry.id }, rootFact.id, 1, "project");
  expect((await memory.dream(headPath)).outcome).toBe("cancelled");
  store.setCurrentPath(session.id, rewindPath.branch, rewindPath.headTurnId, "test-lineage");
  expect((await memory.dream(rewindPath)).outcome).toBe("cancelled");
  expect(captured).toHaveLength(2);
  for (const input of captured) {
    expect(input.material.changed).toContain("root knowledge");
    expect(input.material.changed).not.toContain("sibling-only");
    expect(input.material.facts).not.toContain("sibling-only");
  }
});
