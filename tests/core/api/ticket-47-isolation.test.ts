import { afterEach, expect, test } from "vitest";
import { TraceMemory, memoryFiles, type DreamingAgentInput, type NotingAgentInput } from "../../../src/core/api/index.ts";
import type { KnowledgeOperationInput } from "../../../src/core/store/index.ts";
import { commitDreamerOps } from "../../support/dreamer.ts";
import { knowledge } from "../../support/seed.ts";
import { submit } from "../../support/noter.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

const cancelled = { outcome: "cancelled", output: "fixture stop", request: { offline: true } } as const;

type Capture = {
  text: string;
  material: unknown;
  feedback?: string;
  hasReviewFeedback?: boolean;
  tools?: string[];
};


test("47: head and rewind N material and eligibility ignore sibling-only and terminal-only state", async () => {
  const captures = new Map<string, Capture>();
  let key = "", source = "";
  const agent = async (raw: unknown) => {
    if ((raw as { kind: string }).kind === "noting") {
      const input = raw as NotingAgentInput;
      expect(await submit(input, memory, { noteInput: [{ title: "Shared durable rule", sources: `[${source}] shared durable rule` }], memoryInput: {} })).toBeUndefined();
      captures.set(`${key}:N`, {
        text: input.text,
        material: structuredClone(input.material),
        hasReviewFeedback: "reviewFeedback" in input,
        tools: input.tools.map(tool => tool.name),
      });
      return cancelled;
    }
    throw new Error("unexpected Dreamer call outside an admitted fixture scenario");
  };
  const memory = TraceMemory(":memory:", agent, {
    noting: { triggerTokens: 1 },
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
  const survivor = create(rootPath, { op: "create", title: "Fixture title", handle: "$survivor", author: "test", ...content }, rootPending.id);
  const maintained = create(rootPath, { op: "create", title: "Fixture title", handle: "$maintained", author: "test", ...content, text: "maintained common rule" }, rootPending.id);
  const archived = create(rootPath, { op: "create", title: "Fixture title", handle: "$archived", author: "test", ...content, text: "archivable common rule" }, rootPending.id);
  const victim = create(rootPath, { op: "create", title: "Fixture title", handle: "$victim", author: "test", ...content, text: "merge-away common rule" }, rootPending.id);
  const targets = {
    head: { sessionId: session.id, branch: "main", headTurnId: headTurn.id },
    rewind: rootPath,
  };
  store.setCurrentPath(session.id, rootPath.branch, rootPath.headTurnId, "test-lineage");

  const capture = async (stage: "before" | "after") => {
    const result: Record<string, unknown> = {};
    for (const [name, target] of Object.entries(targets)) {
      result[`${name}:eligibility`] = memory.taskEligibility("noting", target);
      key = `${stage}:${name}`;
      source = `T${rootTurn.id}#E${rootPending.entryOrdinal}`;
      expect((await memory.noting({ ...target })).outcome).toBe("cancelled");
      result[`${name}:N`] = captures.get(`${key}:N`);
    }
    return result;
  };

  const before = await capture("before");
  for (const name of Object.keys(targets)) {
    const notingCapture = captures.get(`before:${name}:N`)!;
    expect(notingCapture.hasReviewFeedback).toBe(false);
    expect(notingCapture.text).not.toMatch(/\b(?:NEAR|CLOSER)\b/);
    // The Noter's only core tools are search and check; it writes files, and its knowledge operations are the file format's.
    expect(notingCapture.tools).toEqual(["search", "check"]);
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
  const siblingOnly = create(siblingPath, { op: "create", title: "Fixture title", handle: "$sibling", author: "test", ...siblingContent, text: "sibling-only knowledge" }, siblingEntry.id);
  store.setCurrentPath(session.id, siblingPath.branch, siblingPath.headTurnId, "test-lineage");
  // The Dreamer's pass on the sibling branch: its operations commit with the sibling's own evidence (so they stay sibling-only).
  const change = { category: "open" as const, scope: "project" as const, topics: [] as string[], supports: [siblingFact.id], reason: "sibling-only mutation", createdAt: "sibling" };
  const maintenanceReceipt = commitDreamerOps(memory, siblingPath, [
    { op: "update", knowledgeId: maintained.knowledgeId, baseCommit: maintained.commit, ...change, text: "sibling-only update" },
    { op: "archive", kind: "invalid", knowledgeId: archived.knowledgeId, baseCommit: archived.commit, supports: [siblingFact.id], reason: "sibling-only archive",
      text: "The sibling branch withdrew this rule and nothing replaces it; the sibling-only evidence says so.", createdAt: "sibling" },
    { op: "merge", intoKnowledgeId: survivor.knowledgeId, intoBaseCommit: survivor.commit, absorb: [{ knowledgeId: victim.knowledgeId, baseCommit: victim.commit }], ...change, text: "sibling-only merge" },
  ]);
  expect(maintenanceReceipt.length).toBeGreaterThanOrEqual(3);
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
  create({ sessionId: session.id, branch: "terminal", headTurnId: terminalTurn.id }, { op: "create", title: "Fixture title", handle: "$terminal", author: "test",
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
  }, { dreaming: { triggerOperations: 1 } });
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
  // Noter-written items: only those make the Dreamer due.
  const create = (path: { sessionId: number; branch: string; headTurnId: number }, factId: number, text: string) =>
    knowledge(store, path, "project", "open", [factId], text);
  const headPath = { sessionId: session.id, branch: "main", headTurnId: head.id };
  const rewindPath = { sessionId: session.id, branch: "rewind", headTurnId: root.id };
  create(rewindPath, rootFact.id, "root knowledge");
  create({ sessionId: session.id, branch: "sibling", headTurnId: sibling.id }, siblingFact.id, "sibling-only knowledge");

  store.setCurrentPath(session.id, headPath.branch, headPath.headTurnId, "test-lineage");
  await memory.dream(headPath);
  store.setCurrentPath(session.id, rewindPath.branch, rewindPath.headTurnId, "test-lineage");
  await memory.dream(rewindPath);
  expect(captured.length).toBeGreaterThanOrEqual(2);
  for (const input of captured) {
    expect(input.text).toContain("root knowledge");
    expect(input.text).not.toContain("sibling-only");
  }
});
