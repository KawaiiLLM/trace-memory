import { readHandle } from "../../read-handle-fixture.ts";
import { fact as seedFact, legacyKnowledge, receiptCommit } from "../../support/seed.ts";
import { afterEach, expect, test, vi } from "vitest";
import { sourceSeededMemory, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { memoryFiles } from "../../../src/core/api/files.ts";
import { submit, verifyUnchanged } from "../../support/noter.ts";
import { renderKnowledge, tokens } from "../../../src/core/render/index.ts";
import { applyWorkspace } from "../../../src/core/workspace/index.ts";
import { block } from "../../support/workspace.ts";
import { operationOfText } from "../../support/dreamer.ts";
let memory: ReturnType<typeof sourceSeededMemory>, triggerEntryId: number;
afterEach(() => memory?.close());
const create = { op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"] };
const batch = create;
/** `reply` is what the verify task answers; the scripted `agent` is the write task. */
function setup(agent: (input: NotingAgentInput) => Promise<RunAgentResult>, reply?: Partial<RunAgentResult>) {
  memory = sourceSeededMemory(":memory:", async raw => (raw as NotingAgentInput).kind === "noting" && (raw as NotingAgentInput).task === "verify"
    ? verifyUnchanged(raw, reply) : agent(raw as NotingAgentInput));
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
/** What a live item costs in the pool, rendered independently of the receipt: its tagged form without the cost annotation. */
const liveTokens = (knowledgeId: number) => {
  const item = memory.store.curateItems(dreamPath()).find(entry => entry.value.knowledge.id === knowledgeId)!;
  return tokens(renderKnowledge(item.value, `K${knowledgeId}#${memory.store.versionTag(knowledgeId, item.value.revision.id)}`, false, memory.store.writing));
};
const dreamPath = () => ({ sessionId: 1, branch: "main", headTurnId: 1, triggerEntryId });
/** A curate file applied as a Dreamer's batch would be: the Dreamer's writes are files, checked and applied by core. */
const curate = (text: string) => {
  const result = applyWorkspace(memory.store, { kind: "curate", operation: operationOfText(text), sessionId: 1, path: dreamPath(), file: { name: "curate.md", text } });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result;
};

test("payload-free acknowledgement preserves explicit native request-audit unavailability", async () => {
  setup(async input => {
    input.acknowledgeRequest();
    await submit(input, memory, { noteInput: [], memoryInput: batch });
    return { outcome: "success", output: "done", audit: { available: false, reason: "native request body unavailable" } };
  }, { request: undefined, audit: { available: false, reason: "native request body unavailable" } });
  const result = await integrate();
  if (result.outcome !== "success") throw new Error("expected success");
  const run = memory.store.getRun(result.runId)!;
  expect(run.request).toBeNull();
  expect(JSON.parse(run.response!)).toMatchObject({ usage: null, audit: { available: false }, problems: [] });
});

test("N publishes its batch only after task 2 passes", async () => {
  setup(async input => {
    input.reportRequest({ first: true });
    await submit(input, memory, { noteInput: [], memoryInput: batch });
    expect(memory.store.getKnowledge(1)).toBeNull();
    expect(memory.pendingEntries(1, "main", 1)).toHaveLength(2);
    return success();
  }, { request: { last: true } });
  const result = await integrate();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(memory.store.getKnowledge(1)).not.toBeNull();
  expect(memory.pendingEntries(1, "main", 1)).toEqual([]);
  expect(memory.store.listConsolidatedProjectFacts(1)).toEqual([]);
  const audit = JSON.parse(memory.store.getRun(result.runId)!.response!);
  expect(audit).toMatchObject({ task: "verify", files: { knowledge: expect.stringContaining("## create") } });
  expect(audit.writeRun).toBe(memory.store.listRuns(1).find(run => run.kind === "noting")!.id);
});

test("a rejected batch can be corrected once, at the stop check", async () => {
  setup(async input => {
    input.reportRequest({ first: true });
    const message = await submit(input, memory, { noteInput: [], memoryInput: { ...create, supports: [] },
      fix: () => ({ knowledge: "## create\ntitle: Fixture title\ncategory: constraint\nscope: project\ntopics: \nsupports: F1\nreason: Initial admission\n\nUse pnpm\n" }) });
    expect(message).toContain("supports");
    expect(memory.store.getKnowledge(1)).toBeNull();
    return success();
  });
  expect((await integrate()).outcome).toBe("success");
  expect(memory.store.getKnowledge(1)).not.toBeNull();
});

for (const mode of ["failure", "cancelled", "throw", "abort"] as const) test(`N ${mode} after writing its files publishes nothing`, async () => {
  setup(async input => {
    input.reportRequest({ provider: "captured" });
    await submit(input, memory, { noteInput: [{ title: "Additional evidence", sources: "[T1#E1] Additional evidence" }], memoryInput: batch });
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

test("N normal stop without writing its files fails the check", async () => {
  setup(async () => success()); const result = await integrate();
  expect(result.outcome).toBe("failure"); expect(memory.store.getKnowledge(1)).toBeNull();
  expect(memory.pendingEntries(1, "main", 1)).toHaveLength(2);
});

test("135: a manual exact update applies sequential edits and deletion, inherits metadata and stores the full result", () => {
  const write = setup(async () => success());
  const original = "Use pnpm; retain the lockfile. Legacy clause.";
  const created = JSON.parse(write.execute({ ...create, text: original, topics: ["lockfiles", "package-tools"] }));
  const base = read(1);
  const result = JSON.parse(write.execute({ op: "update", id: base, supports: ["F1"], reason: "Clarify the invocation and remove an obsolete clause",
    edits: [{ old: "pnpm", new: "bun" }, { old: "bun", new: "corepack pnpm" }, { old: "Legacy clause.", new: "" }] }));
  expect(result.committed).toMatchObject([{ op: "update", knowledgeId: 1, version: expect.stringMatching(/^K1#[a-z]{4,}$/) }]);
  const revision = memory.store.currentCommit(1)[0]!;
  expect(revision).toMatchObject({ text: "Use corepack pnpm; retain the lockfile. ", category: "constraint", scope: "project",
    topics: ["lockfiles", "package-tools"], supports: [1], reason: "Clarify the invocation and remove an obsolete clause" });
  expect(receiptCommit(memory.store, result.committed[0])).toBe(revision.id);
  expect(result.tokens.before).toEqual(created.tokens.after);
  expect(result.tokens.after).toEqual([liveTokens(1)]);
  expect(result).not.toHaveProperty("text");
  expect(result.committed[0]).not.toHaveProperty("text");
  expect(result.committed[0].version).not.toBe(base);
});

test.each([
  { old: "absent clause", matches: /nothing|0 occurrences/ },
  { old: "duplicate", matches: /several|multiple occurrences/ },
  { old: "aa", matches: /several|multiple occurrences/ },
])("135: a manual update refuses edit 2 matching $old atomically, including overlapping matches", ({ old, matches }) => {
  const write = setup(async () => success());
  const original = "Use pnpm; aaa; duplicate duplicate.";
  write.execute({ ...create, text: original });
  const base = read(1);
  const before = memory.store.listKnowledgeRevisions();
  const refused = JSON.parse(write.execute({ op: "update", id: base, supports: ["F1"], reason: "Attempt an exact edit",
    edits: [{ old: "Use", new: "Prefer" }, { old, new: "replacement" }] }));
  expect(refused.results[0]).toContain("rejected:");
  expect(refused.results[0]).toContain("edit 2");
  expect(refused.results[0]).toMatch(matches);
  expect(memory.store.listKnowledgeRevisions()).toEqual(before);
  expect(memory.store.currentCommit(1)[0]!.text).toBe(original);
});

test("135: update rejects both body forms, neither, malformed edits and missing full-text metadata without changing the base", () => {
  const write = setup(async () => success());
  write.execute(create);
  const base = read(1), before = memory.store.listKnowledgeRevisions();
  const update = { op: "update", id: base, supports: ["F1"], reason: "Exact update" };
  for (const body of [
    { text: create.text, category: create.category, scope: create.scope, topics: [], edits: [{ old: "pnpm", new: "yarn" }] },
    {},
    { edits: [] }, { edits: null }, { edits: [{ old: "", new: "yarn" }] },
    { edits: [{ old: "pnpm" }] }, { edits: [{ old: "pnpm", new: null }] },
    { edits: [{ old: "pnpm", new: "yarn", extra: true }] }, { edits: ["pnpm"] },
    { edits: [{ old: create.text, new: "" }] },
    { edits: [{ old: "pnpm", new: "yarn" }], supports: [] },
    { edits: [{ old: "pnpm", new: "yarn" }], reason: "" },
    { text: "Use yarn" },
    { edits: [{ old: "pnpm", new: "" }], category: undefined },
    { edits: [{ old: "pnpm", new: "" }], scope: undefined },
    { edits: [{ old: "pnpm", new: "" }], topics: undefined },
  ]) {
    expect(write.execute({ ...update, ...body })).toContain("rejected:");
    expect(memory.store.listKnowledgeRevisions()).toEqual(before);
  }
});

test("135: supplied edit metadata replaces the inherited fields", () => {
  const write = setup(async () => success());
  write.execute({ ...create, topics: ["packaging"] });
  const base = read(1);
  const update = { op: "update", supports: ["F1"], reason: "Clarify the package manager" };
  const result = JSON.parse(write.execute({ ...update, id: base, edits: [{ old: "pnpm", new: "corepack pnpm" }],
    category: "reference", scope: "session", topics: [] }));
  expect(memory.store.getKnowledgeRevision(1, receiptCommit(memory.store, result.committed[0]))).toMatchObject({
    text: "Use corepack pnpm", category: "reference", scope: "session", topics: [], supports: [1],
  });
});

test("135: an edited full body is held to the cap (144, counted in units since 145: target 200, limit 220) and a corrected resubmission inherits metadata and parent supports", () => {
  const write = setup(async () => success());
  write.execute({ ...create, topics: ["packaging"] });
  const base = read(1);
  const before = memory.store.listKnowledgeRevisions();
  const update = { op: "update", id: base, supports: ["F1"], reason: "Clarify the invocation" };
  const refused = write.execute({ ...update, edits: [{ old: "pnpm", new: "word ".repeat(300) }] });
  expect(refused).toContain("text: 301 units, over the limit of 220 (target 200)");
  expect(memory.store.listKnowledgeRevisions()).toEqual(before);
  const committed = JSON.parse(write.execute({ ...update, edits: [{ old: "pnpm", new: "corepack pnpm" }] }));
  expect(committed.committed[0].version).toMatch(/^K1#[a-z]{4,}$/);
  expect(committed.tokens.before).toHaveLength(1);
  expect(committed.tokens.after).toHaveLength(1);
  expect(memory.store.getKnowledgeRevision(1, receiptCommit(memory.store, committed.committed[0]))).toMatchObject({
    text: "Use corepack pnpm", category: "constraint", scope: "project", topics: ["packaging"], supports: [1],
  });
  expect(committed.committed[0]).not.toHaveProperty("text");
});

test("134: an update receipt carries its new tag for another write and counts metadata in its cost", () => {
  const write = setup(async () => success());
  const created = JSON.parse(write.execute(create));
  const first = JSON.parse(write.execute({ ...create, op: "update", id: read(1), topics: ["classification ".repeat(200).trim()], reason: "Retain retrieval context" }));
  expect(first.committed[0].version).toMatch(/^K1#[a-z]{4,}$/);
  expect(first.tokens.before).toEqual(created.tokens.after);
  expect(first.tokens.after[0] - first.tokens.before[0]).toBeGreaterThan(100);
  const second = JSON.parse(write.execute({ ...create, op: "update", id: first.committed[0].version,
    text: "Use pnpm and keep the lockfile", reason: "Clarify the result just written" }));
  expect(second.committed[0].version).toMatch(/^K1#[a-z]{4,}$/);
  expect(second.committed[0].version).not.toBe(first.committed[0].version);
  expect(memory.store.currentCommit(1)[0]!.text).toBe("Use pnpm and keep the lockfile");
});

test("134: committed manual receipts report pool item cost and the cost removed by archive", () => {
  const write = setup(async () => success());
  const created = JSON.parse(write.execute(create));
  expect(created.tokens.before).toEqual([]);
  expect(created.tokens.after[0]).toBeGreaterThan(tokens(create.text));
  const archived = JSON.parse(write.execute({ op: "archive", kind: "invalid", text: "The user withdrew the rule; nothing replaces it.", id: read(1),
    supports: ["F1"], reason: "No longer needed in the pool" }));
  expect(archived.tokens.before).toEqual(created.tokens.after);
  expect(archived.tokens.after).toEqual([0]);
  expect(memory.store.curateItems(dreamPath())).toEqual([]);
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

test("135: manual memory accepts create/update/archive but rejects merge and split", () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute(create)).committed).toHaveLength(1);
  expect(JSON.parse(write.execute(create)).committed).toHaveLength(1);
  const updated = JSON.parse(write.execute({ ...create, op: "update", id: read(1), text: "Use pnpm and retain the lockfile" }));
  expect(memory.store.getKnowledgeRevision(1, receiptCommit(memory.store, updated.committed[0]))!.text).toBe("Use pnpm and retain the lockfile");
  for (const operation of [
    { ...create, op: "merge", id: updated.committed[0].version, absorb: [read(2)] },
    { op: "split", id: updated.committed[0].version, supports: ["F1"], reason: "split", children: [] },
  ]) expect(write.execute(operation)).toContain("belongs to the Dreamer");
  expect(JSON.parse(write.execute({ op: "archive", kind: "invalid", text: "The user withdrew the rule; nothing replaces it.", reason: "Retired by the user.", id: updated.committed[0].version, supports: ["F1"] })).committed).toHaveLength(1);
});

test("N terminal success-audit failure rolls back facts, knowledge and Raw progress", async () => {
  setup(async input => {
    input.reportRequest({ first: true });
    await submit(input, memory, { noteInput: [{ title: "New evidence", sources: "[T1#E1] New evidence" }], memoryInput: { ...create, supports: ["$1"] } });
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
    await submit(input, memory, { noteInput: [{ title: "New evidence", sources: "[T1#E1] New evidence" }], memoryInput: { ...create, supports: ["$1"] } });
    return success();
  }, { request: { exact: "terminal request" } });
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

test("21a 2026-09-08: merge and archive of a curate file carry their supports and a reason", () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute(create)).results).toEqual(["ok"]);
  expect(JSON.parse(write.execute({ ...create, text: "Commit the lockfile" })).results).toEqual(["ok"]);
  expect(memory.store.getFact(1)!.text).toBe("Use pnpm");
  const merged = curate(block("merge K1@v1", { absorb: "K2@v1", supports: "F1", reason: "Two readings of one packaging rule." }, "Use pnpm"));
  expect(merged.blocks).toMatchObject([{ status: "applied", versions: ["K1@v2"] }]);
  expect(memory.store.currentCommit(1)[0]).toMatchObject({ op: "merge", text: "Use pnpm", supports: [1], reason: "Two readings of one packaging rule." });
  expect(memory.store.currentCommit(2)).toEqual([]);
  curate(block("archive K1@v2", { kind: "invalid", reason: "The user withdrew the rule." }, "The user withdrew the rule; nothing replaces it."));
  // The archive keeps its own evidence and inherits category and scope from the parent revision.
  expect(memory.store.currentCommit(1)[0]).toMatchObject({ op: "archive", archiveKind: "invalid", text: "The user withdrew the rule; nothing replaces it.",
    supports: [1], reason: "The user withdrew the rule.", category: "constraint", scope: "project" });
  // A block without a reason is a check problem, and nothing is written.
  const bare = applyWorkspace(memory.store, { kind: "curate", operation: "update", sessionId: 1, path: dreamPath(), file: { name: "curate.md", text: block("update K1@v3", {}, "Use pnpm") } });
  expect(bare).toMatchObject({ ok: false, problems: [expect.stringContaining("missing required field `reason`")] });
});

test("21a 2026-09-08: an omitted, wrongly typed or empty reason or supports rejects the whole batch", () => {
  const write = setup(async () => success());
  expect(JSON.parse(write.execute(batch)).committed).toHaveLength(1);
  const archive = { op: "archive", kind: "invalid", text: "The user withdrew the rule; nothing replaces it.", id: read(1), supports: ["F1"], reason: "The user withdrew the rule." };
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
      { op: "archive", kind: "invalid", text: "The user withdrew the rule; nothing replaces it.", id: "K1", supports: ["F1"], reason: "The user withdrew the rule.", because: ["F1"] }]) {
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

test("21a 2026-09-08: one supports list holds both the text's grounds and the fact that prompted the change", () => {
  const write = setup(async () => success());
  const source = memory.store.getSourceEntry(memory.store.listSourceEntries(1)[0]!.id)!;
  const correction = seedFact(memory, { sessionId: 1, branch: "main", headTurnId: 1 }, "npm is banned outright",
    [{ entry: source, text: "npm is banned outright" }], [[1, "strong"]]);
  expect(correction.id).toBe(2);
  expect(memory.store.listFactRelations(correction.id)).toContainEqual({ fromFact: 2, toFact: 1, kind: "negate", strength: "strong" });
  expect(JSON.parse(write.execute(batch)).committed).toHaveLength(1);
  curate(block("update K1@v1", { supports: "F1, F2", reason: "The user withdrew the softer rule; F2 corrects F1." }, "Use pnpm; npm is banned outright"));
  // A negating fact among supports is evidence for this commit, not a contradiction, and the
  // addresses in the reason add nothing: the stored evidence is exactly what supports listed.
  expect(memory.store.currentCommit(1)[0]?.supports).toEqual([1, 2]);
});

test("21a 2026-09-08: reason shows in commit history, diffs and the run, never in the knowledge line or the numeric diagnostic", () => {
  const write = setup(async () => success());
  write.execute(batch);
  curate(block("update K1@v1", { reason: "Re-checked 42 files; wording unchanged." }, "Use pnpm"));
  const updatedCommit = memory.store.currentCommit(1)[0]!.id;
  expect(memory.trace("K1", { versions: "history", fields: ["reason"] })).toContain("reason: Re-checked 42 files; wording unchanged.");
  expect(memory.trace("K1@v1..v2", { fields: ["reason"] })).toContain("reason: Initial admission of this conclusion. -> Re-checked 42 files; wording unchanged.");
  expect(memory.trace(`R${memory.store.listRuns(1).at(-1)!.id}`)).toContain(`K1@${updatedCommit} (update: Re-checked 42 files; wording unchanged.)`);
  const automatic = memory.inject({ sessionId: 1, headTurnId: 1, branch: "main" });
  expect(automatic).toContain("Use pnpm"); expect(automatic).not.toContain("Re-checked 42 files");
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
    { op: "archive", kind: "invalid", text: "The user withdrew the rule; nothing replaces it.", id: "K1", supports: ["F1"], reason: "The user withdrew the rule.", topics: ["auth"] }]) {
    expect(write.execute(bad)).toContain("rejected:");
    expect(memory.store.getKnowledge(2)).toBeNull();
    expect(memory.store.currentCommit(1)[0]?.op).toBe("create");
  }
  expect(JSON.parse(write.execute({ op: "archive", kind: "invalid", text: "The user withdrew the rule; nothing replaces it.", id: "K1", supports: ["F1"], reason: "Retired.", topics: ["auth"] })).results[0])
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

test("21b 2026-09-08: a topic-only update is an ordinary update; old commits keep their labels, clearing is explicit, merge states the survivor's set and archive inherits", () => {
  const write = setup(async () => success());
  write.execute({ ...create, topics: ["packaging"] });
  write.execute({ ...create, text: "Commit the lockfile", topics: ["lockfile"] });
  // Classification cleanup is a normal update: the complete unchanged text with a reason. There is no
  // metadata-only path around review or conflict checking.
  const cleanup = curate(block("update K1@v1", { topics: "packaging, tooling", reason: "Classification cleanup: the rule also concerns tooling." }, "Use pnpm"));
  const cleanupCommit = memory.store.currentCommit(1)[0]!.id;
  const cleared = curate(block("update K1@v2", { topics: "", reason: "Classification cleanup: the labels named no subject." }, "Use pnpm"));
  const clearedCommit = memory.store.currentCommit(1)[0]!.id;
  const merged = curate(block("merge K1@v3", { absorb: "K2@v1", topics: "packaging", reason: "Two readings of one packaging rule." }, "Use pnpm and commit the lockfile"));
  const mergedCommit = memory.store.currentCommit(1)[0]!.id;
  expect([cleanup, cleared, merged].map(result => result.blocks[0]!.status)).toEqual(["applied", "applied", "applied"]);
  curate(block("archive K1@v4", { kind: "inadmissible", reason: "The user withdrew the rule." }, "The user withdrew the rule; nothing replaces it."));
  expect(memory.store.getKnowledgeRevision(1, cleanupCommit)!.text).toBe(memory.store.getKnowledgeRevision(1, 1)!.text);
  expect(memory.store.getKnowledgeRevision(1, 1)!.topics).toEqual(["packaging"]); // the old commit keeps its old classification
  expect(memory.store.getKnowledgeRevision(1, cleanupCommit)!.topics).toEqual(["packaging", "tooling"]);
  // Clearing is explicit: an empty list, never an omitted field.
  expect(memory.store.getKnowledgeRevision(1, clearedCommit)!.topics).toEqual([]);
  // Merge supplies the survivor's complete set; no implicit union of every parent's labels.
  expect(memory.store.getKnowledgeRevision(1, mergedCommit)!.topics).toEqual(["packaging"]);
  expect(memory.store.getKnowledgeRevision(2, 2)!.topics).toEqual(["lockfile"]); // the absorbed parent keeps its own
  // Archive takes no labels of its own and inherits the selected parent's list.
  expect(memory.store.currentCommit(1)[0]).toMatchObject({ op: "archive", archiveKind: "inadmissible", topics: ["packaging"] });
  expect(memory.store.currentCommit(1)[0]!.id).toBeGreaterThan(mergedCommit);
});

test("a merge keeps the identity of the primary it names, the newer one included", () => {
  const write = setup(async () => success());
  const older = JSON.parse(write.execute({ ...create, text: "Use pnpm.", topics: ["old"] }));
  const newer = JSON.parse(write.execute({ ...create, text: "Use corepack pnpm.", topics: ["new"] }));
  const olderCommit = receiptCommit(memory.store, older.committed[0]), newerCommit = receiptCommit(memory.store, newer.committed[0]);
  const expected = "Use pnpm and retain the lockfile.";
  const applied = curate(block("merge K2@v1", { absorb: "K1@v1", reason: "Unify without losing the older identity", topics: "packages" }, expected));
  expect(applied.blocks).toMatchObject([{ status: "applied", versions: ["K2@v2"] }]);
  const commit = memory.store.currentCommit(2)[0]!.id;
  expect(memory.store.getKnowledgeRevision(2, commit)).toMatchObject({ op: "merge", parentId: newerCommit, text: expected, supports: [1],
    reason: "Unify without losing the older identity", category: "constraint", scope: "project", topics: ["packages"] });
  expect(memory.store.listKnowledgeLinks(1)).toContainEqual({ fromKnowledge: 1, fromCommit: olderCommit, kind: "merged_into", toKnowledge: 2, toCommit: commit });
  expect(memory.store.currentCommit(1)).toEqual([]);
});
