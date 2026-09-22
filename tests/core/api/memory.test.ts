import { readHandle } from "../../read-handle-fixture.ts";
import { recorded } from "../../source-fixture.ts";
import { afterEach, expect, test } from "vitest";
import { sourceSeededMemory, type ConsolidationAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
let memory: ReturnType<typeof sourceSeededMemory>, admittedScenarios: AdmittedDreamerScenarios, triggerEntryId: number;
afterEach(() => memory?.close());
const create = { op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"] };
const batch = { operations: [create], skipped: [] };
function setup(agent: (input: ConsolidationAgentInput) => Promise<RunAgentResult>) {
  admittedScenarios = new AdmittedDreamerScenarios(raw => agent(raw as ConsolidationAgentInput));
  memory = sourceSeededMemory(":memory:", admittedScenarios.agent);
  const project = memory.store.createProject({ name: "test", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "test", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Use pnpm", assistantText: "Okay", startedAt: "now" });
  const entries = memory.store.listSourceEntries(s.id);
  memory.selectEntries(s.id, "main", entries.map(entry => entry.id));
  triggerEntryId = entries.at(-1)!.id;
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: ["T1#user"] }] });
  recorded(memory, s.id, "main", t.id); // T1 recorded: its facts may enter an Consolidation batch
  return tools[3]!;
}
const success = (): RunAgentResult => ({ outcome: "success", output: "Done", request: { last: true } });
const integrate = () => memory.consolidate({ sessionId: 1, branch: "main" });
const read = (address: string) => readHandle(memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 }), address);
const dreamPath = () => ({ sessionId: 1, branch: "main", headTurnId: 1, triggerEntryId });

test("payload-free acknowledgement preserves explicit native request-audit unavailability", async () => {
  setup(async input => {
    input.acknowledgeRequest();
    expect(JSON.parse(input.tools[3]!.execute(batch)).committed).toHaveLength(1);
    return { outcome: "success", output: "done", audit: { available: false, reason: "native request body unavailable" } };
  });
  const result = await integrate();
  if (result.outcome !== "success") throw new Error("expected success");
  const run = memory.store.getRun(result.runId)!;
  expect(run.request).toBeNull();
  expect(JSON.parse(run.response!)).toMatchObject({ usage: null, audit: { available: false }, problems: [] });
});

test("Consolidation stopping after its first valid batch keeps the committed batch and receipt", async () => {
  setup(async input => { input.reportRequest({ first: true }); input.tools[3]!.execute(batch); return success(); });
  const result = await integrate();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(memory.store.getKnowledge(1)).not.toBeNull();
  expect(memory.store.listConsolidatedProjectFacts(1)).toEqual([expect.objectContaining({ id: 1 })]);
  const audit = JSON.parse(memory.store.getRun(result.runId)!.response!);
  expect(audit.toolCalls[0].input).toEqual(batch);
  expect(JSON.parse(audit.toolCalls[0].result).committed).toHaveLength(1);
});

test("a rejected batch can be corrected before the first valid submission", async () => {
  setup(async input => {
    const write = input.tools[3]!; input.reportRequest({ first: true });
    expect(write.execute({ operations: [{ ...create, supports: [] }], skipped: [] })).toContain("rejected:");
    expect(memory.store.getKnowledge(1)).toBeNull();
    input.reportRequest({ second: true });
    expect(JSON.parse(write.execute(batch)).committed).toHaveLength(1);
    return success();
  });
  expect((await integrate()).outcome).toBe("success");
  expect(memory.store.getKnowledge(2)).toBeNull();
});

for (const mode of ["failure", "cancelled", "throw", "abort"] as const) test(`Consolidation ${mode} after commit only appends a problem`, async () => {
  setup(async input => {
    input.reportRequest({ provider: "captured" });
    input.tools[3]!.execute(batch);
    const run = memory.store.listRuns(1).at(-1)!;
    expect(run.outcome).toBe("success"); expect(JSON.parse(run.response!).toolCalls).toHaveLength(1);
    if (mode === "throw" || mode === "abort") { const error = new Error("late provider error"); if (mode === "abort") error.name = "AbortError"; throw error; }
    return { outcome: mode, output: "late provider error", request: { final: true } };
  });
  const result = await integrate();
  if (result.outcome !== "success") throw new Error("commit is success");
  expect(memory.store.currentCommit(1)[0]?.id).toBe(1);
  expect(memory.store.consolidatedOnPath(1, memory.store.knowledgePath(1, "main"))).toBe(true);
  const run = memory.store.getRun(result.runId)!;
  expect(run.outcome).toBe("success"); expect(JSON.parse(run.response!).problems).toEqual(["late provider error"]);
  expect(JSON.parse(run.request!)).toEqual(mode === "throw" || mode === "abort" ? { provider: "captured" } : { final: true });
});

for (const mode of ["failure", "cancelled"] as const) test(`Consolidation ${mode} before commit advances nothing`, async () => {
  setup(async () => ({ outcome: mode, output: "stopped", request: {} }));
  expect((await integrate()).outcome).toBe(mode);
  expect(memory.store.getKnowledge(1)).toBeNull(); expect(memory.store.listConsolidatedProjectFacts(1)).toEqual([]);
});

test("Consolidation normal stop without a submission succeeds with zero knowledge", async () => {
  setup(async () => success()); const result = await integrate();
  expect(result.outcome).toBe("success"); expect(memory.store.getKnowledge(1)).toBeNull();
  expect(memory.store.consolidatedOnPath(1, memory.store.knowledgePath(1, "main"))).toBe(true);
});

test("memory rejects malformed items, obsolete fields and invisible evidence without losing ordered results", () => {
  const tool = setup(async () => success());
  for (const invalid of [null, [], { ...create, op: "mark" }, { ...create, supports: ["F999999"] }, { ...create, id: "K1" }, { ...create, because: "reason" }, { ...create, because: undefined }]) {
    const result = JSON.parse(tool.execute({ operations: [create, invalid], skipped: [] }));
    expect(result.results[0]).toBe("ok"); expect(result.results[1]).toContain("rejected:");
    expect(memory.store.getKnowledge(1)).toBeNull();
  }
  const p = memory.store.createProject({ name: "foreign", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "test", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "secret", startedAt: "now" });
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "secret", source: [`T${t.id}#user`] }] });
  expect(tool.execute({ operations: [{ ...create, supports: ["F2"] }], skipped: [] })).toContain("not an available fact");
});

test("skipped validates its range, reason and shape atomically", async () => {
  setup(async input => {
    for (const skipped of [null, { fact: "F999", because: "not durable" }, { fact: "F1", because: "" }, { fact: "F1", because: "skip", id: "F1" }]) {
      expect(input.tools[3]!.execute({ operations: [create], skipped: [skipped] })).toContain("rejected:");
      expect(memory.store.getKnowledge(1)).toBeNull();
    }
    input.tools[3]!.execute(batch); input.reportRequest({ second: true }); input.tools[3]!.execute(batch); return success();
  });
  expect((await integrate()).outcome).toBe("success");
});

test("manual memory accepts create and archive but rejects Dreamer maintenance operations", () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute({ operations: [create, create], skipped: [] })).committed).toHaveLength(2);
  for (const operation of [
    { ...create, op: "update", id: read("K1@1") },
    { ...create, op: "merge", id: read("K1@1"), absorb: [read("K2@2")] },
    { op: "split", id: read("K1@1"), supports: ["F1"], reason: "split", children: [] },
  ]) expect(write.execute({ operations: [operation], skipped: [] })).toContain("belongs to the Dreamer");
  expect(JSON.parse(write.execute({ operations: [{ op: "archive", reason: "Retired by the user.", id: read("K1@1"), supports: ["F1"] }], skipped: [] })).committed).toHaveLength(1);
});

test("2026-09-07: an audit update that fails after the commit is reported, not turned into a business failure", async () => {
  let done = false;
  setup(async input => {
    input.reportRequest({ first: true }); input.tools[3]!.execute(batch);
    input.reportRequest({ second: true }); input.tools[3]!.execute(batch);
    done = true; return success();
  });
  const original = memory.store.updateRun.bind(memory.store);
  memory.store.updateRun = ((...args: Parameters<typeof original>) => { if (done) throw new Error("disk full"); return original(...args); }) as typeof original;
  const result = await integrate();
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.problems).toEqual(["audit update failed after commit: Error: disk full"]);
  expect(memory.store.currentCommit(1)[0]?.id).toBe(1);
  expect(memory.store.getRun(result.runId)!.outcome).toBe("success");
});

// ---- 21a 2026-09-08: one evidence list per knowledge commit, with a reason as its message ----

test("21a 2026-09-08: create, update, merge and archive all carry nonempty supports and a reason", async () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute({ operations: [create, { ...create, text: "Commit the lockfile" }], skipped: [] })).results).toEqual(["ok", "ok"]);
  const path = dreamPath();
  createDreamerTrigger(memory, path, 1, 1, "project");
  const result = await admittedScenarios.run(memory, path, input => {
    const request = { fixture: "supports on merge and archive" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, dream = input.tools.find(tool => tool.name === "memory")!;
    trace.execute({ address: "K1@1,K2@2", itemBudget: null });
    const merge = JSON.parse(dream.execute({ operations: [{ op: "merge", id: "K1@1", absorb: ["K2@2"], text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Two readings of one packaging rule." }], skipped: [] }));
    expect(merge.committed).toHaveLength(1);
    const merged = merge.committed[0]; trace.execute({ address: `K1@${merged.commit}`, itemBudget: null });
    expect(JSON.parse(dream.execute({ operations: [{ op: "archive", id: `K1@${merged.commit}`, supports: ["F1"], reason: "The user withdrew the rule." }], skipped: [] })).committed).toHaveLength(1);
    return { outcome: "success", output: "maintained", request };
  });
  expect(result.outcome).toBe("success");
  // The archive keeps its own evidence and inherits category and scope from the parent revision.
  expect(memory.store.currentCommit(1)[0]).toMatchObject({ op: "archive", text: "", supports: [1],
    reason: "The user withdrew the rule.", category: "constraint", scope: "project" });
});

test("21a 2026-09-08: an omitted, wrongly typed or empty reason or supports rejects the whole batch", () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute(batch)).committed).toHaveLength(1);
  const archive = { op: "archive", id: "K1", supports: ["F1"], reason: "The user withdrew the rule." };
  const drop = (operation: Record<string, unknown>, key: string) => { const copy = { ...operation }; delete copy[key]; return copy; };
  for (const bad of [drop(create, "reason"), drop(create, "supports"), { ...create, reason: "" }, { ...create, reason: "  \n " },
    { ...create, reason: 7 }, { ...create, reason: ["F1"] }, { ...create, supports: [] }, { ...create, supports: "F1" },
    drop(archive, "reason"), drop(archive, "supports"), { ...archive, supports: [] }, { ...archive, reason: " " }]) {
    const result = JSON.parse(write.execute({ operations: [{ ...create, text: "A second rule" }, bad], skipped: [] }));
    expect(result.results[0]).toBe("ok"); expect(result.results[1]).toContain("rejected:");
    expect(memory.store.getKnowledge(2)).toBeNull();
    expect(memory.store.currentCommit(1)[0]?.op).toBe("create");
  }
});

test("21a 2026-09-08: a commit-level because is rejected by name, also beside a valid reason", async () => {
  setup(async input => {
    const write = input.tools[3]!;
    for (const bad of [{ ...create, because: ["F1"] }, { ...create, because: [] }, { ...create, because: "prompted by the user" },
      { op: "archive", id: "K1", supports: ["F1"], reason: "The user withdrew the rule.", because: ["F1"] }]) {
      const result = JSON.parse(write.execute({ operations: [bad], skipped: [] }));
      expect(result.results[0]).toContain("because: removed field");
      expect(result.results[0]).toContain('supply "reason"');
      expect(memory.store.getKnowledge(1)).toBeNull();
    }
    // The declined-fact protocol keeps its own textual because unchanged.
    const declined = { operations: [], skipped: [{ fact: "F1", because: "Not durable on its own." }] };
    expect(write.execute(declined)).toContain("feedback");
    input.reportRequest({ second: true });
    expect(JSON.parse(write.execute(declined)).results).toEqual(["ok"]);
    return success();
  });
  expect((await integrate()).outcome).toBe("success");
});

test("21a 2026-09-08: one supports list holds both the text's grounds and the fact that prompted the change", async () => {
  const write = setup(async () => success());
  memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [
    { category: "decision", actor: "user", text: "npm is banned outright", source: ["T1#user"], negate: [["F1", "strong"]] }] });
  expect(JSON.parse(write.execute(batch)).committed).toHaveLength(1);
  const update = { ...create, op: "update", id: read("K1@1"), text: "Use pnpm; npm is banned outright", supports: ["F1", "F2"],
    reason: "The user withdrew the softer rule; F2 corrects F1." };
  createDreamerTrigger(memory, dreamPath(), 1, 1, "project");
  const result = await admittedScenarios.run(memory, dreamPath(), input => {
    const request = { fixture: "multi-fact supports" }; input.reportRequest(request);
    input.tools[0]!.execute({ address: "K1@1", itemBudget: null });
    expect(input.tools[3]!.execute({ operations: [update], skipped: [] })).toContain("committed");
    return { outcome: "success", output: "updated", request };
  });
  expect(result.outcome).toBe("success");
  // A negating fact among supports is evidence for this commit, not a contradiction, and the
  // addresses in the reason add nothing: the stored evidence is exactly what supports listed.
  expect(memory.store.currentCommit(1)[0]?.supports).toEqual([1, 2]);
});

test("21a 2026-09-08: reason shows in commit history, diffs and the run, never in the knowledge line or the numeric diagnostic", async () => {
  const write = setup(async () => success());
  write.execute(batch);
  createDreamerTrigger(memory, dreamPath(), 1, 1, "project");
  let updatedCommit = 0;
  const result = await admittedScenarios.run(memory, dreamPath(), input => {
    const request = { fixture: "reason history" }; input.reportRequest(request);
    input.tools[0]!.execute({ address: "K1@1", itemBudget: null });
    const receipt = JSON.parse(input.tools[3]!.execute({ operations: [{ op: "update", id: "K1@1", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Re-checked 42 files; wording unchanged." }], skipped: [] }));
    updatedCommit = receipt.committed[0].commit;
    return { outcome: "success", output: "updated", request };
  });
  expect(result.outcome).toBe("success");
  expect(memory.trace("K1", { versions: "history", fields: ["reason"] })).toContain("reason: Re-checked 42 files; wording unchanged.");
  expect(memory.trace(`K1@1..K1@${updatedCommit}`, { fields: ["reason"] })).toContain("reason: Initial admission of this conclusion. -> Re-checked 42 files; wording unchanged.");
  expect(memory.trace(`R${memory.store.listRuns(1).at(-1)!.id}`)).toContain(`K1@${updatedCommit} (update: Re-checked 42 files; wording unchanged.)`);
  const automatic = memory.inject({ sessionId: 1, headTurnId: 1, branch: "main" });
  expect(automatic).toContain("Use pnpm"); expect(automatic).not.toContain("Re-checked 42 files");
});

test("21a 2026-09-08: a reason-only update on a stale base is rejected like any other commit", async () => {
  const write = setup(async () => success());
  write.execute(batch);
  createDreamerTrigger(memory, dreamPath(), 1, 1, "project");
  const result = await admittedScenarios.run(memory, dreamPath(), input => {
    const request = { fixture: "stale reason-only update" }; input.reportRequest(request);
    input.tools[0]!.execute({ address: "K1@1", itemBudget: null });
    const sharpened = JSON.parse(input.tools[3]!.execute({ operations: [{ op: "update", id: "K1@1", text: "Use pnpm, never npm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Sharpened wording." }], skipped: [] })).committed[0];
    expect(input.tools[3]!.execute({ operations: [{ op: "update", id: "K1@1", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Classification cleanup only." }], skipped: [] })).toContain(`base is not the latest effective applicable revision; current: K1@${sharpened.commit}`);
    input.tools[0]!.execute({ address: `K1@${sharpened.commit}`, itemBudget: null });
    expect(input.tools[3]!.execute({ operations: [{ op: "update", id: `K1@${sharpened.commit}`, text: "Use pnpm, never npm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Corrected the stale address without changing the conclusion." }], skipped: [] })).toContain("committed");
    return { outcome: "success", output: "stale corrected", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  expect(memory.store.currentCommit(1)[0]!.text).toBe("Use pnpm, never npm");
});

// ---- 21b 2026-09-08: subject labels on the immutable knowledge revision ----

test("21b 2026-09-08: labels are trimmed, deduplicated and code-point ordered, and a bad label rejects the whole batch", () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute({ operations: [{ ...create, topics: [" storage ", "auth", "storage", "Auth", "认证"] }], skipped: [] })).committed).toHaveLength(1);
  // Case, language and spelling are kept as written: no folding, no translation, no synonym merge,
  // no hierarchy read out of punctuation. Order is the set's own code-point order, so the submitted
  // order carries no primary-topic meaning.
  expect(memory.store.currentCommit(1)[0]!.topics).toEqual(["Auth", "auth", "storage", "认证"]);
  const drop = (operation: Record<string, unknown>, key: string) => { const copy = { ...operation }; delete copy[key]; return copy; };
  for (const bad of [drop(create, "topics"), { ...create, topics: "auth" }, { ...create, topics: null }, { ...create, topics: {} },
    { ...create, topics: ["auth", 7] }, { ...create, topics: [""] }, { ...create, topics: ["auth", "   "] }, { ...create, topics: [["auth"]] },
    { op: "archive", id: "K1", supports: ["F1"], reason: "The user withdrew the rule.", topics: ["auth"] }]) {
    const result = JSON.parse(write.execute({ operations: [{ ...create, text: "A second rule" }, bad], skipped: [] }));
    expect(result.results[0]).toBe("ok"); expect(result.results[1]).toContain("rejected:");
    expect(memory.store.getKnowledge(2)).toBeNull();
    expect(memory.store.currentCommit(1)[0]?.op).toBe("create");
  }
  expect(JSON.parse(write.execute({ operations: [{ op: "archive", id: "K1", supports: ["F1"], reason: "Retired.", topics: ["auth"] }], skipped: [] })).results[0])
    .toContain("topics: inapplicable field");
});

test("21b 2026-09-08: reordering the same label set renders the same metadata, and an empty array renders none", () => {
  const write = setup(async () => success());
  write.execute({ operations: [{ ...create, topics: ["storage", "auth"] }, { ...create, text: "Commit the lockfile", topics: [" auth ", "storage"] },
    { ...create, text: "Run the tests", topics: [] }], skipped: [] }); // the third is explicitly unclassified
  const metadata = (address: string) => memory.trace(address).split("\n")[1];
  expect(metadata("K1@1")).toBe('  change supports: F1 · topics: ["auth","storage"]');
  expect(metadata("K2@2")).toBe(metadata("K1@1")); // the same set, submitted in another order
  expect(metadata("K3@3")).toBe("  change supports: F1"); // unclassified: no metadata at all
});

test("21b 2026-09-08: a topic-only update is an ordinary update; old commits keep their labels, clearing is explicit, merge states the survivor's set and archive inherits", async () => {
  const write = setup(async () => success());
  write.execute({ operations: [{ ...create, topics: ["packaging"] }, { ...create, text: "Commit the lockfile", topics: ["lockfile"] }], skipped: [] });
  const path = dreamPath();
  // Classification cleanup is a normal update: the complete unchanged text, category, scope and
  // evidence, with a reason. There is no metadata-only path around review or conflict checking.
  createDreamerTrigger(memory, path, 1, 1, "project");
  let cleanupCommit = 0, clearedCommit = 0, mergedCommit = 0;
  const result = await admittedScenarios.run(memory, path, input => {
    const request = { fixture: "topic maintenance sequence" }; input.reportRequest(request);
    const trace = input.tools[0]!, dream = input.tools[3]!;
    trace.execute({ address: "K1@1,K2@2", itemBudget: null });
    const cleanup = JSON.parse(dream.execute({ operations: [{ op: "update", id: "K1@1", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], topics: ["packaging", "tooling"], reason: "Classification cleanup: the rule also concerns tooling." }], skipped: [] }));
    cleanupCommit = cleanup.committed[0].commit;
    trace.execute({ address: `K1@${cleanupCommit}`, itemBudget: null });
    const cleared = JSON.parse(dream.execute({ operations: [{ op: "update", id: `K1@${cleanupCommit}`, text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Classification cleanup: the labels named no subject." }], skipped: [] }));
    clearedCommit = cleared.committed[0].commit;
    trace.execute({ address: `K1@${clearedCommit}`, itemBudget: null });
    const merged = JSON.parse(dream.execute({ operations: [{ op: "merge", id: `K1@${clearedCommit}`, absorb: ["K2@2"], topics: ["packaging"], text: "Use pnpm and commit the lockfile", category: "constraint", scope: "project", supports: ["F1"], reason: "Two readings of one packaging rule." }], skipped: [] }));
    mergedCommit = merged.committed[0].commit;
    trace.execute({ address: `K1@${mergedCommit}`, itemBudget: null });
    dream.execute({ operations: [{ op: "archive", id: `K1@${mergedCommit}`, supports: ["F1"], reason: "The user withdrew the rule." }], skipped: [] });
    return { outcome: "success", output: "maintained", request };
  });
  expect(result.outcome).toBe("success");
  expect(memory.store.getKnowledgeRevision(1, cleanupCommit)!.text).toBe(memory.store.getKnowledgeRevision(1, 1)!.text);
  expect(memory.store.getKnowledgeRevision(1, 1)!.topics).toEqual(["packaging"]); // the old commit keeps its old classification
  expect(memory.store.getKnowledgeRevision(1, cleanupCommit)!.topics).toEqual(["packaging", "tooling"]);
  expect(memory.trace(`K1@1..K1@${cleanupCommit}`)).toContain('topics: ["packaging"] -> ["packaging","tooling"]');
  expect(memory.trace("K1@1")).toContain('topics: ["packaging"]');
  // Clearing is explicit: an empty array, never an omitted field.
  expect(memory.store.getKnowledgeRevision(1, clearedCommit)!.topics).toEqual([]);
  expect(memory.trace(`K1@${clearedCommit}`)).not.toContain("topics:");
  expect(memory.trace(`K1@${cleanupCommit}..K1@${clearedCommit}`)).toContain('topics: ["packaging","tooling"] -> []');
  // Merge supplies the survivor's complete set; no implicit union of every parent's labels.
  expect(memory.store.currentCommit(1)[0]!.topics).toEqual(["packaging"]);
  expect(memory.store.getKnowledgeRevision(2, 2)!.topics).toEqual(["lockfile"]); // the absorbed parent keeps its own
  // Archive accepts no labels of its own and inherits the selected parent's array.
  expect(memory.store.currentCommit(1)[0]).toMatchObject({ op: "archive", topics: ["packaging"] });
  const archivedCommit = memory.store.currentCommit(1)[0]!.id;
  expect(archivedCommit).toBeGreaterThan(mergedCommit);
  expect(memory.trace(`K1@${archivedCommit}`)).toContain('topics: ["packaging"]');
});
