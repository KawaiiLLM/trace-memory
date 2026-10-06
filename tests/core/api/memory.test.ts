import { readHandle } from "../../read-handle-fixture.ts";
import { fact as seedFact } from "../../support/seed.ts";
import { afterEach, expect, test, vi } from "vitest";
import { sourceSeededMemory, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { dreamerWrite, skipRest } from "../../dreaming-skips.ts";
import { memoryFiles } from "../../../src/core/api/files.ts";
let memory: ReturnType<typeof sourceSeededMemory>, admittedScenarios: AdmittedDreamerScenarios, triggerEntryId: number;
afterEach(() => memory?.close());
const create = { op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"] };
const batch = create;
function setup(agent: (input: NotingAgentInput) => Promise<RunAgentResult>) {
  admittedScenarios = new AdmittedDreamerScenarios(raw => agent(raw as NotingAgentInput));
  memory = sourceSeededMemory(":memory:", admittedScenarios.agent);
  const project = memory.store.createProject({ name: "test", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "test", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Use pnpm", assistantText: "Okay", startedAt: "now" });
  const entries = memory.store.listSourceEntries(s.id);
  memory.selectEntries(s.id, "main", entries.map(entry => entry.id));
  triggerEntryId = entries.at(-1)!.id;
  const source = memory.store.getSourceEntry(entries[0]!.id)!;
  const evidence = seedFact(memory, { sessionId: s.id, branch: "main", headTurnId: t.id }, "Use pnpm", [{ entry: source, text: "Use pnpm" }]);
  expect(evidence.text).toBe("Use pnpm");
  return memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "memory")!;
}
const success = (): RunAgentResult => ({ outcome: "success", output: "Done", request: { last: true } });
const integrate = () => memory.noting({ sessionId: 1, branch: "main", headTurnId: 1 });
const read = (id: number, version = 1) => readHandle(path => memoryFiles(memory, { sessionId: 1, branch: "main", headTurnId: 1 }).read(path).content, `K${id}@v${version}`);
const dreamPath = () => ({ sessionId: 1, branch: "main", headTurnId: 1, triggerEntryId });

test("payload-free acknowledgement preserves explicit native request-audit unavailability", async () => {
  setup(async input => {
    input.acknowledgeRequest();
    input.tools.find(tool => tool.name === "note")!.execute({});
    expect(JSON.parse(input.tools.find(tool => tool.name === "memory")!.execute(batch)).held).toHaveLength(1);
    return { outcome: "success", output: "done", audit: { available: false, reason: "native request body unavailable" } };
  });
  const result = await integrate();
  if (result.outcome !== "success") throw new Error("expected success");
  const run = memory.store.getRun(result.runId)!;
  expect(run.request).toBeNull();
  expect(JSON.parse(run.response!)).toMatchObject({ usage: null, audit: { available: false }, problems: [] });
});

test("N publishes its held batch only on normal terminal success", async () => {
  setup(async input => {
    input.reportRequest({ first: true });
    input.tools.find(tool => tool.name === "note")!.execute({});
    expect(input.tools.find(tool => tool.name === "memory")!.execute(batch)).toContain("held");
    expect(memory.store.getKnowledge(1)).toBeNull();
    expect(memory.pendingEntries(1, "main", 1)).toHaveLength(2);
    return success();
  });
  const result = await integrate();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(memory.store.getKnowledge(1)).not.toBeNull();
  expect(memory.pendingEntries(1, "main", 1)).toEqual([]);
  expect(memory.store.listConsolidatedProjectFacts(1)).toEqual([]);
  const audit = JSON.parse(memory.store.getRun(result.runId)!.response!);
  expect(audit.toolCalls[1].input).toEqual(batch);
  expect(JSON.parse(audit.toolCalls[1].result).held).toHaveLength(1);
});

test("a rejected batch can be corrected before the first valid submission", async () => {
  setup(async input => {
    const write = input.tools.find(tool => tool.name === "memory")!; input.reportRequest({ first: true });
    input.tools.find(tool => tool.name === "note")!.execute({});
    expect(write.execute({ ...create, supports: [] })).toContain("rejected:");
    expect(memory.store.getKnowledge(1)).toBeNull();
    input.reportRequest({ second: true });
    expect(JSON.parse(write.execute({ ...create, slot: "M1" })).held).toHaveLength(1);
    return success();
  });
  expect((await integrate()).outcome).toBe("success");
  expect(memory.store.getKnowledge(2)).toBeNull();
});

for (const mode of ["failure", "cancelled", "throw", "abort"] as const) test(`N ${mode} after staging publishes nothing`, async () => {
  setup(async input => {
    input.reportRequest({ provider: "captured" });
    input.tools.find(tool => tool.name === "note")!.execute({ title: "Additional evidence", sources: "[T1#E1] Additional evidence" });
    expect(input.tools.find(tool => tool.name === "memory")!.execute(batch)).toContain("held");
    expect(memory.store.getKnowledge(1)).toBeNull();
    if (mode === "throw" || mode === "abort") { const error = new Error("late provider error"); if (mode === "abort") error.name = "AbortError"; throw error; }
    return { outcome: mode, output: "late provider error", request: { final: true } };
  });
  const result = await integrate();
  const expected = mode === "cancelled" || mode === "abort" ? "cancelled" : "failure";
  expect(result.outcome).toBe(expected);
  if (result.outcome !== "failure" && result.outcome !== "cancelled") throw new Error("expected no publication");
  expect(memory.store.currentCommit(1)).toEqual([]);
  expect(memory.store.listSessionFacts(1)).toHaveLength(1);
  expect(memory.pendingEntries(1, "main", 1)).toHaveLength(2);
  const run = memory.store.getRun(result.runId)!;
  expect(run.outcome).toBe(expected); expect(JSON.parse(run.response!).problems).toEqual(["late provider error"]);
  expect(JSON.parse(run.request!)).toEqual(mode === "throw" || mode === "abort" ? { provider: "captured" } : { final: true });
});

for (const mode of ["failure", "cancelled"] as const) test(`N ${mode} before staging advances nothing`, async () => {
  setup(async () => ({ outcome: mode, output: "stopped", request: {} }));
  expect((await integrate()).outcome).toBe(mode);
  expect(memory.store.getKnowledge(1)).toBeNull(); expect(memory.store.listConsolidatedProjectFacts(1)).toEqual([]);
});

test("N normal stop without explicit tools is incomplete", async () => {
  setup(async () => success()); const result = await integrate();
  expect(result.outcome).toBe("failure"); expect(memory.store.getKnowledge(1)).toBeNull();
  expect(memory.pendingEntries(1, "main", 1)).toHaveLength(2);
});

test("116: manual memory rejects malformed operations independently of valid commits", () => {
  const tool = setup(async () => success());
  expect(JSON.parse(tool.execute(create)).committed).toHaveLength(1);
  for (const invalid of [null, [], { ...create, op: "mark" }, { ...create, supports: ["F999999"] }, { ...create, id: "K1" }, { ...create, because: "reason" }, { ...create, because: undefined }]) {
    expect(tool.execute(invalid)).toContain("rejected:");
    expect(memory.store.currentCommit(1)).toHaveLength(1);
  }
  const p = memory.store.createProject({ name: "foreign", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "test", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "secret", startedAt: "now" });
  const foreign = memory.store.listSourceEntries(s.id)[0]!;
  seedFact(memory, { sessionId: s.id, branch: "main", headTurnId: t.id }, "secret", [{ entry: memory.store.getSourceEntry(foreign.id)!, text: "secret" }]);
  expect(tool.execute({ ...create, supports: ["F2"] })).toContain("not an available fact");
});

test("116: N rejects skipped without publishing its held operation", async () => {
  setup(async input => {
    for (const skipped of [null, { fact: "F999", because: "not durable" }, { fact: "F1", because: "" }, { fact: "F1", because: "skip", id: "F1" }]) {
      expect(input.tools.find(tool => tool.name === "memory")!.execute({ operations: [create], skipped: [skipped] })).toContain("rejected:");
      expect(memory.store.getKnowledge(1)).toBeNull();
    }
    input.tools.find(tool => tool.name === "note")!.execute({});
    return success();
  });
  const result = await integrate();
  expect(result.outcome, JSON.stringify(result)).toBe("failure");
  if (result.outcome !== "failure") throw new Error("expected incomplete rejected batch");
  expect(result.problems.join(" ")).toContain("expects one item");
  expect(memory.store.getKnowledge(1)).toBeNull();
  expect(memory.pendingEntries(1, "main", 1)).toHaveLength(2);
});

test("manual memory accepts create and archive but rejects Dreamer maintenance operations", () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute(create)).committed).toHaveLength(1);
  expect(JSON.parse(write.execute(create)).committed).toHaveLength(1);
  for (const operation of [
    { ...create, op: "update", id: read(1) },
    { ...create, op: "merge", id: read(1), absorb: [read(2)] },
    { op: "split", id: read(1), supports: ["F1"], reason: "split", children: [] },
  ]) expect(write.execute(operation)).toContain("belongs to the Dreamer");
  expect(JSON.parse(write.execute({ op: "archive", kind: "budget", reason: "Retired by the user.", id: read(1), supports: ["F1"] })).committed).toHaveLength(1);
});

test("N terminal success-audit failure rolls back facts, knowledge and Raw progress", async () => {
  setup(async input => {
    input.reportRequest({ first: true });
    expect(input.tools.find(tool => tool.name === "note")!.execute({ title: "New evidence", sources: "[T1#E1] New evidence" })).toContain("held");
    expect(input.tools.find(tool => tool.name === "memory")!.execute({ ...create, supports: ["$1"] })).toContain("held");
    return success();
  });
  memory.store.db.exec(`CREATE TEMP TRIGGER reject_success_audit BEFORE INSERT ON runs
    WHEN NEW.outcome = 'success' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
  const result = await integrate();
  expect(result.outcome).toBe("failure");
  if (result.outcome !== "failure") throw new Error("expected terminal failure");
  expect(result.problems.join(" ")).toContain("audit unavailable");
  expect(memory.store.getKnowledge(1)).toBeNull();
  expect(memory.store.listSessionFacts(1)).toHaveLength(1);
  expect(memory.pendingEntries(1, "main", 1)).toHaveLength(2);
  expect(memory.store.getRun(result.runId)!.outcome).toBe("failure");
  memory.store.db.exec("DROP TRIGGER reject_success_audit");
  expect((await integrate()).outcome).toBe("success");
  expect(memory.store.listSessionFacts(1)).toHaveLength(2);
  expect(memory.store.currentCommit(1)[0]!.supports).toEqual([2]);
  expect(memory.pendingEntries(1, "main", 1)).toEqual([]);
});

test("N post-success claim-release failure reports cleanup without undoing terminal publication", async () => {
  setup(async input => {
    input.reportRequest({ exact: "terminal request" });
    input.tools.find(tool => tool.name === "note")!.execute({ title: "New evidence", sources: "[T1#E1] New evidence" });
    input.tools.find(tool => tool.name === "memory")!.execute({ ...create, supports: ["$1"] });
    return success();
  });
  const release = vi.spyOn(memory.store, "releaseClaim").mockImplementation(() => { throw new Error("cleanup unavailable"); });
  try {
    const result = await integrate();
    expect(result.outcome).toBe("success");
    if (result.outcome !== "success") throw new Error("expected durable success");
    expect(result.problems).toEqual(["claim release failed: Error: cleanup unavailable"]);
    expect(release).toHaveBeenCalledOnce();
    expect(memory.store.listSessionFacts(1)).toHaveLength(2);
    expect(memory.store.currentCommit(1)[0]!.supports).toEqual([2]);
    expect(memory.pendingEntries(1, "main", 1)).toEqual([]);
    expect(memory.store.getRun(result.runId)!.outcome).toBe("success");
    expect(memory.store.db.prepare("SELECT outcome FROM task_executions").all()).toEqual([{ outcome: "success" }]);
  } finally { release.mockRestore(); }
});

// ---- 21a 2026-09-08: one evidence list per knowledge commit, with a reason as its message ----

test("21a 2026-09-08: create, update, merge and archive all carry nonempty supports and a reason", async () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute(create)).results).toEqual(["ok"]);
  expect(JSON.parse(write.execute({ ...create, text: "Commit the lockfile" })).results).toEqual(["ok"]);
  const path = dreamPath();
  createDreamerTrigger(memory, path, 1, 1, "project");
  const result = await admittedScenarios.run(memory, path, input => {
    const request = { fixture: "supports on merge and archive" }; input.reportRequest(request);
    const dream = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, path);
    expect(files.read("/tm/K1@v1").content).toContain("Use pnpm");
    expect(files.read("/tm/K2@v1").content).toContain("Commit the lockfile");
    const merge = JSON.parse(dreamerWrite(dream, { operations: [{ op: "merge", id: read(1), absorb: [read(2)], text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Two readings of one packaging rule." }], skipped: [] }));
    expect(merge.committed).toHaveLength(1);
    const merged = merge.committed[0]; expect(merged.version).toBe("K1@v2");
    expect(JSON.parse(dreamerWrite(dream, { operations: [{ op: "archive", kind: "budget", id: read(1, 2), supports: ["F1"], reason: "The user withdrew the rule." }], skipped: [] })).committed).toHaveLength(1);
    expect(skipRest(input, ["K1@v1", "K2@v1"])).toContain("committed"); // 104: the untouched trigger is deliberated too
    return { outcome: "success", output: "maintained", request };
  });
  expect(result.outcome).toBe("success");
  // The archive keeps its own evidence and inherits category and scope from the parent revision.
  expect(memory.store.currentCommit(1)[0]).toMatchObject({ op: "archive", archiveKind: "budget", text: "Use pnpm", supports: [1],
    reason: "The user withdrew the rule.", category: "constraint", scope: "project" });
});

for (const mode of ["failure", "cancelled", "throw", "abort"] as const) test(`D ${mode} after an immediate update preserves the committed revision`, async () => {
  const manual = setup(async () => success());
  expect(JSON.parse(manual.execute(create)).committed).toHaveLength(1);
  createDreamerTrigger(memory, dreamPath(), 1, 1, "project");
  let finished = false;
  const result = await admittedScenarios.run(memory, dreamPath(), input => {
    input.reportRequest({ exact: "D request" });
    const receipt = JSON.parse(dreamerWrite(input.tools.find(tool => tool.name === "memory")!, { operations: [{
      ...create, op: "update", id: read(1), text: "Use pnpm and its lockfile", reason: "Clarified rule",
    }], skipped: [] }));
    expect(receipt.committed).toHaveLength(1);
    expect(memory.store.currentCommit(1)[0]!.text).toBe("Use pnpm and its lockfile");
    finished = true; // the run's expected failure must not hide an assertion error above
    if (mode === "throw" || mode === "abort") {
      const error = new Error("provider stopped after D commit");
      if (mode === "abort") error.name = "AbortError";
      throw error;
    }
    return { outcome: mode, output: "provider stopped after D commit", request: { exact: "D request" } };
  });
  expect(finished).toBe(true);
  expect(result.outcome).toBe(mode === "cancelled" || mode === "abort" ? "cancelled" : "failure");
  expect(memory.store.listKnowledgeRevisions(1)).toHaveLength(2);
  const revision = memory.store.currentCommit(1)[0]!;
  expect(revision.text).toBe("Use pnpm and its lockfile");
  expect(memory.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ? AND revision_id = ?")
    .get("project:1", revision.id)).toEqual({ revision_id: revision.id });
  expect(memory.store.getClaim(1, "dreaming")).toBeNull();
});

test("21a 2026-09-08: an omitted, wrongly typed or empty reason or supports rejects the whole batch", () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute(batch)).committed).toHaveLength(1);
  const archive = { op: "archive", kind: "budget", id: read(1), supports: ["F1"], reason: "The user withdrew the rule." };
  const drop = (operation: Record<string, unknown>, key: string) => { const copy = { ...operation }; delete copy[key]; return copy; };
  for (const bad of [drop(create, "reason"), drop(create, "supports"), { ...create, reason: "" }, { ...create, reason: "  \n " },
    { ...create, reason: 7 }, { ...create, reason: ["F1"] }, { ...create, supports: [] }, { ...create, supports: "F1" },
    drop(archive, "reason"), drop(archive, "supports"), { ...archive, supports: [] }, { ...archive, reason: " " }]) {
    expect(write.execute(bad)).toContain("rejected:");
    expect(memory.store.getKnowledge(2)).toBeNull();
    expect(memory.store.currentCommit(1)[0]?.op).toBe("create");
  }
});

test("21a/116: removed because is rejected and cannot satisfy a required N memory call", async () => {
  setup(async input => {
    const write = input.tools.find(tool => tool.name === "memory")!;
    for (const bad of [{ ...create, because: ["F1"] }, { ...create, because: [] }, { ...create, because: "prompted by the user" },
      { op: "archive", kind: "budget", id: "K1", supports: ["F1"], reason: "The user withdrew the rule.", because: ["F1"] }]) {
      const result = JSON.parse(write.execute(bad));
      expect(result.results[0]).toContain("because: removed field");
      expect(result.results[0]).toContain('supply "reason"');
      expect(memory.store.getKnowledge(1)).toBeNull();
    }
    // Invalid call syntax cannot satisfy the mandatory knowledge-tool call.
    input.tools.find(tool => tool.name === "note")!.execute({});
    return success();
  });
  expect((await integrate()).outcome).toBe("failure");
});

test("21a 2026-09-08: one supports list holds both the text's grounds and the fact that prompted the change", async () => {
  const write = setup(async () => success());
  const source = memory.store.getSourceEntry(memory.store.listSourceEntries(1)[0]!.id)!;
  const correction = seedFact(memory, { sessionId: 1, branch: "main", headTurnId: 1 }, "npm is banned outright",
    [{ entry: source, text: "npm is banned outright" }], [[1, "strong"]]);
  expect(correction.id).toBe(2);
  expect(memory.store.listFactRelations(correction.id)).toContainEqual({ fromFact: 2, toFact: 1, kind: "negate", strength: "strong" });
  expect(JSON.parse(write.execute(batch)).committed).toHaveLength(1);
  const update = { ...create, op: "update", id: read(1), text: "Use pnpm; npm is banned outright", supports: ["F1", "F2"],
    reason: "The user withdrew the softer rule; F2 corrects F1." };
  createDreamerTrigger(memory, dreamPath(), 1, 1, "project");
  const result = await admittedScenarios.run(memory, dreamPath(), input => {
    const request = { fixture: "multi-fact supports" }; input.reportRequest(request);
    expect(memoryFiles(memory, dreamPath()).read("/tm/K1@v1").content).toContain("Use pnpm");
    expect(dreamerWrite(input.tools.find(tool => tool.name === "memory")!, { operations: [update], skipped: [] })).toContain("committed");
    expect(skipRest(input, ["K1@v1"])).toContain("committed"); // 104: the untouched trigger is deliberated too
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
    expect(memoryFiles(memory, dreamPath()).read("/tm/K1@v1").content).toContain("Use pnpm");
    const receipt = JSON.parse(dreamerWrite(input.tools.find(tool => tool.name === "memory")!, { operations: [{ op: "update", id: read(1), text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Re-checked 42 files; wording unchanged." }], skipped: [] }));
    expect(receipt.committed[0].version).toBe("K1@v2");
    updatedCommit = memory.store.resolveVersionOrdinal(1, 2);
    expect(skipRest(input, ["K1@v1"])).toContain("committed"); // 104: the untouched trigger is deliberated too
    return { outcome: "success", output: "updated", request };
  });
  expect(result.outcome).toBe("success");
  expect(memory.trace("K1", { versions: "history", fields: ["reason"] })).toContain("reason: Re-checked 42 files; wording unchanged.");
  expect(memory.trace("K1@v1..v2", { fields: ["reason"] })).toContain("reason: Initial admission of this conclusion. -> Re-checked 42 files; wording unchanged.");
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
    const original = read(1);
    const sharpened = JSON.parse(dreamerWrite(input.tools.find(tool => tool.name === "memory")!, { operations: [{ op: "update", id: original, text: "Use pnpm, never npm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Sharpened wording." }], skipped: [] })).committed[0];
    expect(sharpened.version).toBe("K1@v2");
    expect(dreamerWrite(input.tools.find(tool => tool.name === "memory")!, { operations: [{ op: "update", id: original, text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Classification cleanup only." }], skipped: [] })).toContain("base is not the latest effective applicable revision; current: K1@v2");
    expect(dreamerWrite(input.tools.find(tool => tool.name === "memory")!, { operations: [{ slot: "M1", op: "update", id: read(1, 2), text: "Use pnpm, never npm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Corrected the stale address without changing the conclusion." }], skipped: [] })).toContain("committed");
    expect(skipRest(input, ["K1@v1"])).toContain("committed"); // 104: the untouched trigger is deliberated too
    return { outcome: "success", output: "stale corrected", request };
  });
  if (result.outcome !== "success") throw new Error(JSON.stringify(result));
  expect(memory.store.currentCommit(1)[0]!.text).toBe("Use pnpm, never npm");
});

// ---- 21b 2026-09-08: subject labels on the immutable knowledge revision ----

test("21b 2026-09-08: labels are trimmed, deduplicated and code-point ordered, and a bad label rejects the whole batch", () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute({ ...create, topics: [" storage ", "auth", "storage", "Auth", "认证"] })).committed).toHaveLength(1);
  // Case, language and spelling are kept as written: no folding, no translation, no synonym merge,
  // no hierarchy read out of punctuation. Order is the set's own code-point order, so the submitted
  // order carries no primary-topic meaning.
  expect(memory.store.currentCommit(1)[0]!.topics).toEqual(["Auth", "auth", "storage", "认证"]);
  const drop = (operation: Record<string, unknown>, key: string) => { const copy = { ...operation }; delete copy[key]; return copy; };
  for (const bad of [drop(create, "topics"), { ...create, topics: "auth" }, { ...create, topics: null }, { ...create, topics: {} },
    { ...create, topics: ["auth", 7] }, { ...create, topics: [""] }, { ...create, topics: ["auth", "   "] }, { ...create, topics: [["auth"]] },
    { op: "archive", kind: "budget", id: "K1", supports: ["F1"], reason: "The user withdrew the rule.", topics: ["auth"] }]) {
    expect(write.execute(bad)).toContain("rejected:");
    expect(memory.store.getKnowledge(2)).toBeNull();
    expect(memory.store.currentCommit(1)[0]?.op).toBe("create");
  }
  expect(JSON.parse(write.execute({ op: "archive", kind: "budget", id: "K1", supports: ["F1"], reason: "Retired.", topics: ["auth"] })).results[0])
    .toContain("topics: inapplicable field");
});

test("21b 2026-09-08: reordering the same label set stores the same topics; an empty array stays unclassified", () => {
  const write = setup(async () => success());
  for (const operation of [{ ...create, topics: ["storage", "auth"] },
    { ...create, text: "Commit the lockfile", topics: [" auth ", "storage"] },
    { ...create, text: "Run the tests", topics: [] }])
    expect(JSON.parse(write.execute(operation)).committed).toHaveLength(1);
  expect(memory.store.currentCommit(1)[0]!.topics).toEqual(["auth", "storage"]);
  expect(memory.store.currentCommit(2)[0]!.topics).toEqual(memory.store.currentCommit(1)[0]!.topics);
  expect(memory.store.currentCommit(3)[0]!.topics).toEqual([]);
  expect(memory.store.currentCommit(3)[0]!.supports).toEqual([1]);
});

test("21b 2026-09-08: a topic-only update is an ordinary update; old commits keep their labels, clearing is explicit, merge states the survivor's set and archive inherits", async () => {
  const write = setup(async () => success());
  write.execute({ ...create, topics: ["packaging"] });
  write.execute({ ...create, text: "Commit the lockfile", topics: ["lockfile"] });
  const path = dreamPath();
  // Classification cleanup is a normal update: the complete unchanged text, category, scope and
  // evidence, with a reason. There is no metadata-only path around review or conflict checking.
  createDreamerTrigger(memory, path, 1, 1, "project");
  let cleanupCommit = 0, clearedCommit = 0, mergedCommit = 0;
  const result = await admittedScenarios.run(memory, path, input => {
    const request = { fixture: "topic maintenance sequence" }; input.reportRequest(request);
    const dream = input.tools.find(tool => tool.name === "memory")!;
    const files = memoryFiles(memory, path);
    expect(files.read("/tm/K1@v1").content).toContain("Use pnpm");
    expect(files.read("/tm/K2@v1").content).toContain("Commit the lockfile");
    const cleanup = JSON.parse(dreamerWrite(dream, { operations: [{ op: "update", id: read(1), text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], topics: ["packaging", "tooling"], reason: "Classification cleanup: the rule also concerns tooling." }], skipped: [] }));
    expect(cleanup.committed[0].version).toBe("K1@v2");
    cleanupCommit = memory.store.resolveVersionOrdinal(1, 2);
    const cleared = JSON.parse(dreamerWrite(dream, { operations: [{ op: "update", id: read(1, 2), text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Classification cleanup: the labels named no subject." }], skipped: [] }));
    expect(cleared.committed[0].version).toBe("K1@v3");
    clearedCommit = memory.store.resolveVersionOrdinal(1, 3);
    const merged = JSON.parse(dreamerWrite(dream, { operations: [{ op: "merge", id: read(1, 3), absorb: [read(2)], topics: ["packaging"], text: "Use pnpm and commit the lockfile", category: "constraint", scope: "project", supports: ["F1"], reason: "Two readings of one packaging rule." }], skipped: [] }));
    expect(merged.committed[0].version).toBe("K1@v4");
    mergedCommit = memory.store.resolveVersionOrdinal(1, 4);
    dreamerWrite(dream, { operations: [{ op: "archive", kind: "budget", id: read(1, 4), supports: ["F1"], reason: "The user withdrew the rule." }], skipped: [] });
    expect(skipRest(input, ["K1@v1", "K2@v1"])).toContain("committed"); // 104: the untouched trigger is deliberated too
    return { outcome: "success", output: "maintained", request };
  });
  expect(result.outcome).toBe("success");
  expect(memory.store.getKnowledgeRevision(1, cleanupCommit)!.text).toBe(memory.store.getKnowledgeRevision(1, 1)!.text);
  expect(memory.store.getKnowledgeRevision(1, 1)!.topics).toEqual(["packaging"]); // the old commit keeps its old classification
  expect(memory.store.getKnowledgeRevision(1, cleanupCommit)!.topics).toEqual(["packaging", "tooling"]);
  // Clearing is explicit: an empty array, never an omitted field.
  expect(memory.store.getKnowledgeRevision(1, clearedCommit)!.topics).toEqual([]);
  // Merge supplies the survivor's complete set; no implicit union of every parent's labels.
  expect(memory.store.currentCommit(1)[0]!.topics).toEqual(["packaging"]);
  expect(memory.store.getKnowledgeRevision(2, 2)!.topics).toEqual(["lockfile"]); // the absorbed parent keeps its own
  // Archive accepts no labels of its own and inherits the selected parent's array.
  expect(memory.store.currentCommit(1)[0]).toMatchObject({ op: "archive", archiveKind: "budget", topics: ["packaging"] });
  const archivedCommit = memory.store.currentCommit(1)[0]!.id;
  expect(archivedCommit).toBeGreaterThan(mergedCommit);
});
