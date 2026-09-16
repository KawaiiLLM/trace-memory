import { afterEach, expect, test } from "vitest";
import { noVisibility, TraceMemory, type ConsolidationAgentInput, type DreamingAgentInput, type NotingAgentInput } from "../../../src/core/api/index.ts";
import type { KnowledgeOperationInput } from "../../../src/core/store/index.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

const cancelled = { outcome: "cancelled", output: "fixture stop", request: { offline: true } } as const;

test("47: head and rewind N/C/D material and automatic reviews ignore sibling-only state", async () => {
  const captures = new Map<string, { text: string; material: unknown; feedback?: string; check?: string }>();
  let key = "", source = "";
  const memory = TraceMemory(":memory:", async raw => {
    if ((raw as { kind: string }).kind === "noting") {
      const input = raw as NotingAgentInput;
      const note = input.tools.find(tool => tool.name === "note")!;
      const receipt = note.execute({ facts: [{ category: "observation", actor: "user", text: "shared durable rule", source: [source] }] });
      captures.set(`${key}:N`, { text: input.text, material: structuredClone(input.material), feedback: input.reviewFeedback(receipt) });
      return cancelled;
    }
    if ((raw as { kind: string }).kind === "consolidation") {
      const input = raw as ConsolidationAgentInput;
      const supports = [input.material.factAddresses[0]!];
      const batch = { operations: [{ op: "create", text: "shared durable rule", category: "open", scope: "project", supports,
        topics: [], reason: "isolation review candidate" }],
      skipped: input.material.factAddresses.slice(1).map(fact => ({ fact, because: "Outside this candidate." })) };
      const receipt = input.tools.find(tool => tool.name === "memory")!.execute(batch);
      captures.set(`${key}:C`, { text: input.text, material: structuredClone(input.material), feedback: input.reviewFeedback(receipt) });
      return cancelled;
    }
    const input = raw as DreamingAgentInput;
    captures.set(`${key}:D`, { text: input.text, material: structuredClone(input.material),
      check: input.tools.find(tool => tool.name === "check")!.execute({}) });
    return cancelled;
  }, { noting: { triggerTokens: 1 }, consolidation: { triggerTokens: 1 }, dreaming: { triggerTokens: 1 } });
  memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "isolation", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const rootTurn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: "now" });
  const headTurn = store.appendTurn({ sessionId: session.id, parentTurnId: rootTurn.id, kind: "turn", userPrompt: "head", startedAt: "later" });
  const append = (turnId: number, nativeId: string) => memory.appendEntry({ sessionId: session.id, turnId, nativeLineage: "isolation", nativeId,
    role: "user", text: nativeId, raw: JSON.stringify({ role: "user", content: nativeId }), calls: [] });
  const evidenceEntry = append(rootTurn.id, "evidence"), rootPending = append(rootTurn.id, "root-pending"), headPending = append(headTurn.id, "head-pending");
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
  const write = (path: typeof rootPath, operation: KnowledgeOperationInput, triggerEntryId?: number) => {
    const run = store.bindRunOrigin({ kind: "manual" as const, sessionId: session.id, branch: path.branch, createdAt: "now" },
      triggerEntryId === undefined ? null : store.triggerOrigin(path, triggerEntryId));
    const result = store.commitConsolidationRun({ path, run, operations: [operation] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  const survivor = write(rootPath, { op: "create", handle: "$survivor", author: "test", ...content }, rootPending.id);
  const maintainedBase = write(rootPath, { op: "create", handle: "$maintained", author: "test", ...content, text: "maintained predecessor" }, rootPending.id);
  const maintained = write(rootPath, { op: "update", knowledgeId: maintainedBase.knowledgeId, baseCommit: maintainedBase.commit,
    ...content, text: "maintained common rule" }, rootPending.id);
  const archived = write(rootPath, { op: "create", handle: "$archived", author: "test", ...content, text: "archivable common rule" }, rootPending.id);
  const victim = write(rootPath, { op: "create", handle: "$victim", author: "test", ...content, text: "merge-away common rule" }, rootPending.id);
  const targets = {
    head: { sessionId: session.id, branch: "main", headTurnId: headTurn.id },
    rewind: rootPath,
  };
  const visible = noVisibility();
  visible.knowledgeCommitIds.add(maintainedBase.commit);

  const capture = async (stage: "before" | "after") => {
    const result: Record<string, unknown> = {};
    for (const [name, target] of Object.entries(targets)) {
      result[`${name}:eligibility`] = ["noting", "consolidation", "dreaming"].map(phase =>
        memory.taskEligibility(phase as "noting" | "consolidation" | "dreaming", target));
      key = `${stage}:${name}`;
      source = `T${rootTurn.id}#E${rootPending.entryOrdinal}`;
      expect((await memory.noting({ ...target, mode: "subagent" })).outcome).toBe("cancelled");
      expect((await memory.consolidate({ ...target, mode: "fork", visible })).outcome).toBe("cancelled");
      expect((await memory.dream(target)).outcome).toBe("cancelled");
      for (const phase of ["N", "C", "D"] as const) result[`${name}:${phase}`] = captures.get(`${key}:${phase}`);
    }
    return result;
  };

  const before = await capture("before");
  for (const name of Object.keys(targets)) {
    expect(captures.get(`before:${name}:N`)!.feedback).toContain("NEAR");
    expect(captures.get(`before:${name}:C`)!.feedback).toContain("NEAR");
    expect(captures.get(`before:${name}:C`)!.text).toContain("Inherited knowledge status");
    expect(captures.get(`before:${name}:D`)!.check).toContain("Owner budgets:");
  }

  const siblingTurn = store.appendTurn({ sessionId: session.id, parentTurnId: rootTurn.id, kind: "turn", userPrompt: "sibling", startedAt: "sibling" });
  const siblingEntry = append(siblingTurn.id, "sibling-only");
  memory.selectEntries(session.id, "sibling", [evidenceEntry.id, siblingEntry.id]);
  const siblingNoted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "sibling", createdAt: "sibling" }, entryIds: [siblingEntry.id], facts: [{
    turnId: siblingTurn.id, entryIds: [siblingEntry.id], category: "decision", actor: "user", text: "sibling-only change",
    source: [`T${siblingTurn.id}#E${siblingEntry.entryOrdinal}`], createdAt: "sibling",
    negate: [{ target: `F${rootFact.id}`, strength: "strong" }],
  }] });
  if (!siblingNoted.ok) throw new Error(siblingNoted.problems.join("; "));
  const siblingFact = siblingNoted.facts[0]!;
  const siblingPath = { sessionId: session.id, branch: "sibling", headTurnId: siblingTurn.id };
  const siblingContent = { ...content, supports: [siblingFact.id], reason: "sibling-only mutation", createdAt: "sibling" };
  write(siblingPath, { op: "create", handle: "$sibling", author: "test", ...siblingContent, text: "sibling-only knowledge" }, siblingEntry.id);
  write(siblingPath, { op: "update", knowledgeId: maintained.knowledgeId, baseCommit: maintained.commit, ...siblingContent, text: "sibling-only update" }, siblingEntry.id);
  write(siblingPath, { op: "archive", knowledgeId: archived.knowledgeId, baseCommit: archived.commit,
    supports: [siblingFact.id], reason: "sibling-only archive", createdAt: "sibling" }, siblingEntry.id);
  const siblingRun = store.bindRunOrigin({ kind: "manual" as const, sessionId: session.id, branch: siblingPath.branch, createdAt: "sibling" },
    store.triggerOrigin(siblingPath, siblingEntry.id));
  const merged = store.commitConsolidationRun({ path: siblingPath, run: siblingRun, operations: [{ op: "merge",
      intoKnowledgeId: survivor.knowledgeId, intoBaseCommit: survivor.commit,
      absorb: [{ knowledgeId: victim.knowledgeId, baseCommit: victim.commit }], ...siblingContent, text: "sibling-only merge" }] });
  if (!merged.ok) throw new Error(merged.problems.join("; "));

  const terminalTurn = store.appendTurn({ sessionId: session.id, parentTurnId: rootTurn.id, kind: "turn", userPrompt: "old terminal", startedAt: "terminal" });
  const terminalFact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "terminal", createdAt: "terminal" }, facts: [{
    turnId: terminalTurn.id, category: "observation", actor: "user", text: "older terminal-only fact", source: [`T${terminalTurn.id}#user`], createdAt: "terminal",
  }] });
  if (!terminalFact.ok) throw new Error(terminalFact.problems.join("; "));
  write({ sessionId: session.id, branch: "terminal", headTurnId: terminalTurn.id }, { op: "create", handle: "$terminal", author: "test",
    ...content, supports: [terminalFact.facts[0]!.id], text: "older terminal-only knowledge", reason: "terminal-only", createdAt: "terminal" });

  const after = await capture("after");
  expect(Object.fromEntries(Object.entries(after).map(([name, value]) => [name, value]))).toEqual(
    Object.fromEntries(Object.entries(before).map(([name, value]) => [name, value])));
  expect(JSON.stringify(after)).not.toContain("sibling-only");
  expect(JSON.stringify(after)).not.toContain("older terminal-only");
});
