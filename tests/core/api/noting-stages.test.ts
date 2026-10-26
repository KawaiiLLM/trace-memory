// Four independently resumed stages; ticket 179 publishes facts after their check, knowledge after its own.
import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { REQUEST, factsFile, knowledgeFile, submit, verifyUnchanged, withVerdicts } from "../../support/noter.ts";
import { entry as sourceEntry, facts, knowledge, knowledgeBatch, session } from "../../support/seed.ts";
import { NOTING_TASKS } from "../../../src/core/noting/workspace.ts";
import { relatedFacts, relatedKnowledge } from "../../../src/core/noting/retrieval.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const fact = { title: "Package manager ruling", objects: ["pnpm"], sources: "[T1#E1] Use pnpm" };
const create = { files: null, op: "create", title: "Package manager", text: "Use pnpm", category: "constraint", scope: "session", supports: ["$1"], reason: "User ruling", topics: [] };
const OK: RunAgentResult = { outcome: "success", output: "done", request: REQUEST };
function fixture(agent: (input: NotingAgentInput) => Promise<RunAgentResult>, resolvedRoot = false) {
  const dir = mkdtempSync(join(tmpdir(), "tm-noter-stages-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "memory.sqlite");
  let memory = sourceSeededMemory(dbPath, raw => agent(raw as NotingAgentInput));
  cleanup.push(() => memory.close());
  const project = memory.store.createProject({ name: "four-stages", declaredBy: "mark" });
  const session = memory.store.createSession({ projectId: project.id, host: "pi:four-stages", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now",
    startDirectory: dir, directory: resolvedRoot ? join(dir, "resolved") : null });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Use pnpm", assistantText: "Pi agent explained pnpm", startedAt: "now" });
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  return { get memory() { return memory; }, dir, path, session, run: () => memory.noting(path),
    restart: () => { memory.close(); memory = sourceSeededMemory(dbPath, raw => agent(raw as NotingAgentInput)); } };
}
const check = async (input: NotingAgentInput) => String(await input.tools.find(tool => tool.name === "check")!.execute({}));

for (const failed of NOTING_TASKS) test(`failure in ${failed} resumes only that stage and successors, publishing once`, async () => {
  let fail = true;
  const calls: NotingAgentInput[] = [];
  const f = fixture(async input => {
    calls.push(input);
    if (fail && input.task === failed) { input.reportRequest(REQUEST); return { ...OK, outcome: "failure", output: "provider failed" }; }
    expect(f.memory.store.listSessionFacts(1).map(value => value.text)).toEqual(input.task.endsWith("knowledge") ? ["Use pnpm"] : []);
    expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
    await submit(input, f.memory, { noteInput: [fact], memoryInput: create });
    return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "failure", problems: ["provider failed"] });
  const stage = NOTING_TASKS.indexOf(failed);
  expect(calls.map(input => input.task)).toEqual(NOTING_TASKS.slice(0, stage + 1));
  expect(f.memory.store.listSessionFacts(1).map(value => value.text)).toEqual(stage >= 2 ? ["Use pnpm"] : []);
  expect(f.memory.progress(1, "main", 1).entries).toBe(2);
  expect(f.memory.store.taskFailures(1).find(row => row.phase === "noting")?.count).toBe(1);
  const kept = f.memory.store.handoff(1, "noting", stage >= 2 ? "knowledge" : "facts");
  expect(kept?.nextTask).toBe(stage ? failed : undefined);
  calls.length = 0; fail = false; f.restart();
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(calls.map(input => input.task)).toEqual(NOTING_TASKS.slice(stage));
  expect(f.memory.store.listSessionFacts(1).map(value => value.text)).toEqual(["Use pnpm"]);
  expect(f.memory.store.currentKnowledge(f.path).map(item => item.revision.text)).toEqual(["Use pnpm"]);
  expect(f.memory.store.pendingEntries(1, "main", 1)).toEqual([]);
  expect(f.memory.store.handoff(1, "noting")).toBeNull();
  for (const input of calls) expect(existsSync(input.workspace.dir)).toBe(false);
});

test("four conversations share their first request and each stage owns exactly one deliverable", async () => {
  const inputs: NotingAgentInput[] = [];
  const f = fixture(async input => { inputs.push(input); await submit(input, f.memory, { noteInput: [fact], memoryInput: create }); return OK; });
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(inputs.map(input => input.task)).toEqual(NOTING_TASKS);
  for (const input of inputs) {
    expect([input.prompt, input.promptHash, input.text, input.tools.map(({ execute, ...schema }) => schema)]).toEqual(
      [inputs[0]!.prompt, inputs[0]!.promptHash, inputs[0]!.text, inputs[0]!.tools.map(({ execute, ...schema }) => schema)]);
    expect(input.workspace.write).toEqual([input.task.endsWith("facts") ? input.workspace.facts : input.workspace.knowledge]);
  }
});

for (const hasFacts of [false, true]) test(`empty knowledge publishes with ${hasFacts ? "a checked fact" : "both checks skipped"}`, async () => {
  const calls: string[] = [];
  const f = fixture(async input => {
    calls.push(input.task);
    await submit(input, f.memory, { noteInput: hasFacts ? [fact] : [] });
    return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "success", facts: hasFacts ? [expect.objectContaining({ text: "Use pnpm" })] : [] });
  expect(calls).toEqual(hasFacts ? ["extract-facts", "check-facts", "write-knowledge"] : ["extract-facts", "write-knowledge"]);
  const runs = f.memory.store.listRuns(1).filter(run => run.kind === "noting");
  expect(runs.map(run => run.outcome)).toEqual(["success", "success", "success", "success"]);
  for (const run of runs.filter(run => !calls.includes(JSON.parse(run.response!).task))) {
    expect(JSON.parse(run.response!)).toMatchObject({ noWork: true, problems: [], budget: { steps: 0 }, files: { knowledge: expect.any(String) } });
    expect(run.request).toBeNull();
    expect(JSON.parse(run.response!).nativeLog).toBeUndefined();
  }
  expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
  expect(f.memory.store.pendingEntries(1, "main", 1)).toEqual([]);
  expect(f.memory.store.handoff(1, "noting")).toBeNull();
  expect(f.memory.store.taskFailures(1).find(row => row.phase === "noting")?.count ?? 0).toBe(0);
  expect(f.memory.spend(1).unknown).toBe(0);
});

test("empty facts skip their check without skipping a nonempty knowledge check", async () => {
  let support = 0;
  const calls: string[] = [];
  const f = fixture(async input => {
    calls.push(input.task);
    await submit(input, f.memory, { memoryInput: { ...create, supports: [`F${support}`] } });
    return OK;
  });
  const entry = f.memory.store.getSourceEntry(f.memory.store.sourcePath(1, "main", 1)[0]!.id)!;
  support = facts(f.memory, f.path, [{ title: "Prior ruling", sources: [{ entry, text: "Use pnpm" }] }])[0]!.id;
  expect(await f.run()).toMatchObject({ outcome: "success", facts: [] });
  expect(calls).toEqual(["extract-facts", "write-knowledge", "check-knowledge"]);
  expect(f.memory.store.currentKnowledge(f.path).map(item => item.revision.supports)).toEqual([[support]]);
  expect(f.memory.store.pendingEntries(1, "main", 1)).toEqual([]);
});

for (const passed of ["extract-facts", "write-knowledge"] as const) test(`resume after ${passed} skips its empty check and publishes once`, async () => {
  const calls: string[] = [];
  const f = fixture(async input => { calls.push(input.task); await submit(input, f.memory); return OK; });
  const commit = f.memory.store.commitNotingStage.bind(f.memory.store);
  const interruption = vi.spyOn(f.memory.store, "commitNotingStage").mockImplementation(input => {
    const result = commit(input);
    if (JSON.parse(input.run.response!).task === passed) throw new Error("interrupted after durable handoff");
    return result;
  });
  await expect(f.run()).rejects.toThrow("interrupted after durable handoff");
  interruption.mockRestore();
  expect(f.memory.store.handoff(1, "noting", passed === "write-knowledge" ? "knowledge" : "facts")?.nextTask).toBe(passed === "extract-facts" ? "check-facts" : "check-knowledge");
  expect(f.memory.progress(1, "main", 1).entries).toBe(2);
  calls.length = 0;
  f.restart();
  expect(await f.run()).toMatchObject({ outcome: "success", facts: [] });
  expect(calls).toEqual(passed === "extract-facts" ? ["write-knowledge"] : []);
  const runs = f.memory.store.listRuns(1).filter(run => run.kind === "noting");
  expect(runs.map(run => JSON.parse(run.response!).task)).toEqual(NOTING_TASKS);
  expect(runs.map(run => run.outcome)).toEqual(["success", "success", "success", "success"]);
  expect(f.memory.store.pendingEntries(1, "main", 1)).toEqual([]);
  expect(f.memory.store.handoff(1, "noting")).toBeNull();
  expect(f.memory.store.taskFailures(1).find(row => row.phase === "noting")?.count ?? 0).toBe(0);
});

test("a skipped facts check hands off to knowledge writing and a later failure counts only once", async () => {
  let fail = true;
  const calls: string[] = [];
  const f = fixture(async input => {
    calls.push(input.task);
    if (input.task === "write-knowledge") {
      expect(f.memory.store.handoff(1, "noting", "knowledge")?.nextTask).toBe("write-knowledge");
      if (fail) { input.reportRequest(REQUEST); return { ...OK, outcome: "failure", output: "provider failed" }; }
    }
    await submit(input, f.memory);
    return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "failure", problems: ["provider failed"] });
  expect(calls).toEqual(["extract-facts", "write-knowledge"]);
  expect(f.memory.store.taskFailures(1).find(row => row.phase === "noting")?.count).toBe(1);
  expect(f.memory.progress(1, "main", 1).entries).toBe(2);
  fail = false; calls.length = 0; f.restart();
  expect(await f.run()).toMatchObject({ outcome: "success", facts: [] });
  expect(calls).toEqual(["write-knowledge"]);
  expect(f.memory.store.pendingEntries(1, "main", 1)).toEqual([]);
  expect(f.memory.store.taskFailures(1).find(row => row.phase === "noting")?.count ?? 0).toBe(0);
});

for (const task of ["check-facts", "check-knowledge"] as const) test(`${task} refuses a missing verdict and a second failed stop is terminal`, async () => {
  const f = fixture(async input => {
    if (input.task !== task) { await submit(input, f.memory, { noteInput: [fact], memoryInput: create }); return OK; }
    input.reportRequest(REQUEST);
    expect(await check(input)).toContain("expected `verdict: ok`");
    expect(input.passEnd()).toContain("Your files do not pass the check");
    expect(input.passEnd()).toBeUndefined();
    const file = task === "check-facts" ? input.workspace.facts : input.workspace.knowledge;
    writeFileSync(file, withVerdicts(readFileSync(file, "utf8")));
    expect(input.passEnd()).toBeUndefined();
    return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "failure", problems: expect.arrayContaining([`check failed twice: ${task}`]) });
  expect(f.memory.store.listSessionFacts(1).map(value => value.text)).toEqual(task === "check-knowledge" ? ["Use pnpm"] : []);
  expect(f.memory.store.handoff(1, "noting", task === "check-knowledge" ? "knowledge" : "facts")?.nextTask).toBe(task);
});

for (const task of ["write-knowledge", "check-knowledge"] as const) test(`${task} cannot alter checked facts, including after passing its stop`, async () => {
  const f = fixture(async input => {
    await submit(input, f.memory, { noteInput: [fact], memoryInput: create });
    if (input.task === task) writeFileSync(input.workspace.facts, withVerdicts(factsFile([{ ...fact, sources: "[T1#E1] Use npm", objects: ["npm"] }])));
    return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "failure", problems: expect.arrayContaining(["facts.md: changed after check facts passed; restore it as it was"]) });
  expect(f.memory.store.listSessionFacts(1).map(value => value.text)).toEqual(["Use pnpm"]);
});

test("reverted blocks never publish and a surviving local fact label still resolves", async () => {
  const f = fixture(async input => {
    if (input.task === "check-facts") {
      input.reportRequest(REQUEST);
      writeFileSync(input.workspace.facts, factsFile([fact]).trimEnd() + "\nverdict: reverted — unsupported\n\n" + withVerdicts(factsFile([{ ...fact, title: "Kept ruling" }]).replace("fact f1", "fact f2")));
      expect(input.passEnd()).toBeUndefined(); return OK;
    }
    if (input.task === "write-knowledge") {
      input.reportRequest(REQUEST);
      writeFileSync(input.workspace.knowledge, knowledgeFile(f.memory, { ...create, supports: ["f2"] }) + "\n" + knowledgeFile(f.memory, { ...create, title: "Reverted claim" }).trimEnd() + "\nverdict: reverted — unsupported\n");
      expect(input.passEnd()).toBeUndefined(); return OK;
    }
    await submit(input, f.memory, { noteInput: [fact], memoryInput: create }); return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(f.memory.store.listSessionFacts(1).map(value => value.title)).toEqual(["Kept ruling"]);
  expect(f.memory.store.currentKnowledge(f.path).map(item => item.revision.title)).toEqual(["Package manager"]);
});

test("code retrieves facts and knowledge, checker replaces duplicate create, propagates overturn and flags unresolved work", async () => {
  let oldFact = 0, duplicate = 0, overturned = 0, unresolved = 0;
  const f = fixture(async input => {
    if (input.task === "check-facts") {
      expect(readFileSync(join(input.workspace.dir, "related-facts.md"), "utf8")).toContain(`## F${oldFact}`);
      input.reportRequest(REQUEST);
      writeFileSync(input.workspace.facts, withVerdicts(factsFile([{ ...fact, negate: [[`F${oldFact}`, "strong"]] }])));
      expect(input.passEnd()).toBeUndefined(); return OK;
    }
    if (input.task === "check-knowledge") {
      const related = readFileSync(join(input.workspace.dir, "related-knowledge.md"), "utf8");
      for (const id of [duplicate, overturned, unresolved]) expect(related).toContain(`## K${id}@v1`);
      input.reportRequest(REQUEST);
      const update = (id: number) => knowledgeFile(f.memory, { ...create, op: "update", id: `K${id}#${f.memory.store.versionTag(id, f.memory.store.currentKnowledge(f.path).find(item => item.knowledge.id === id)!.revision.id)}` });
      writeFileSync(input.workspace.knowledge, withVerdicts(`${update(duplicate)}\n${update(overturned)}\n## flag K${unresolved}\nreason: needs merge\n`));
      expect(input.passEnd()).toBeUndefined(); return OK;
    }
    await submit(input, f.memory, { noteInput: [fact], memoryInput: create }); return OK;
  });
  const entry = f.memory.store.getSourceEntry(f.memory.store.sourcePath(1, "main", 1)[0]!.id)!;
  oldFact = facts(f.memory, f.path, [{ title: "Old pnpm decision", sources: [{ entry, text: "pnpm was optional" }], objects: ["pnpm"] }])[0]!.id;
  duplicate = knowledge(f.memory.store, f.path, "session", "constraint", [oldFact], "Use pnpm").knowledgeId;
  overturned = knowledge(f.memory.store, f.path, "session", "constraint", [oldFact], "pnpm is optional").knowledgeId;
  unresolved = knowledge(f.memory.store, f.path, "session", "constraint", [oldFact], "Another pnpm rule").knowledgeId;
  expect(await f.run()).toMatchObject({ outcome: "success" });
  const current = f.memory.store.currentKnowledge(f.path);
  expect(current).toHaveLength(3);
  const newFact = f.memory.store.listSessionFacts(1).filter(value => value.id !== oldFact)[0]!;
  expect(f.memory.store.listFactRelations(newFact.id)).toContainEqual(expect.objectContaining({ toFact: oldFact, kind: "negate" }));
  for (const id of [duplicate, overturned]) {
    const revision = current.find(item => item.knowledge.id === id)!.revision;
    expect(revision.text).toBe("Use pnpm"); expect(revision.supports).toEqual([newFact.id]);
  }
  expect(f.memory.store.knowledgeStaleReasons(current.find(item => item.knowledge.id === unresolved)!.revision.id)).toContainEqual({ reason: "unresolved_check", detail: "needs merge" });
});

test("a Noter negation on a held branch flags its supporting knowledge when the latest Turn is a sibling", async () => {
  let oldFact = 0, source = "";
  const f = fixture(async input => {
    await submit(input, f.memory, { noteInput: [{ title: "Package manager replaced", sources: source, negate: [[`F${oldFact}`, "strong"]] }] });
    return OK;
  });
  const store = f.memory.store, rootEntries = store.sourcePath(f.session.id, "main", f.path.headTurnId);
  oldFact = facts(f.memory, f.path, [{ title: "Use pnpm", sources: [{ entry: store.getSourceEntry(rootEntries[0]!.id)!, text: "Use pnpm" }] }])[0]!.id;
  const item = knowledge(store, f.path, "session", "constraint", [oldFact], "Use pnpm");
  const held = store.appendTurn({ sessionId: f.session.id, parentTurnId: f.path.headTurnId, kind: "turn", userPrompt: "Use npm instead", startedAt: "now" });
  const sibling = store.appendTurn({ sessionId: f.session.id, parentTurnId: f.path.headTurnId, kind: "turn", userPrompt: "Keep using pnpm here", startedAt: "now" });
  const heldEntry = store.listSourceEntries(f.session.id).find(entry => entry.turnId === held.id)!;
  store.selectSourcePath(f.session.id, "held", [...rootEntries.map(entry => entry.id), heldEntry.id]);
  const heldPath = { ...f.path, branch: "held", headTurnId: held.id };
  source = `[T${held.id}#E${heldEntry.entryOrdinal}] Use npm instead`;
  expect(store.knowledgePath(f.session.id).headTurnId).toBe(sibling.id);
  const result = await f.memory.noting(heldPath);
  expect(result).toMatchObject({ outcome: "success" });
  if (result.outcome !== "success") throw new Error("Noter did not publish");
  expect(result.facts).toEqual([expect.objectContaining({ turnId: held.id })]);
  expect(store.knowledgeStaleReasons(item.commit).map(value => value.reason)).toEqual(["negated_fact"]);
});

test("budgets count responses rather than tool calls and report growth without stopping at the budget", async () => {
  const f = fixture(async input => {
    input.reportResponse!("first", 1000);
    input.reportResponse!("first", 1000);
    input.reportResponse!("second", 1800);
    expect(await check(input)).toContain("steps 2 of 1, context +800 of +1");
    expect(await check(input)).toContain("steps 2 of 1, context +800 of +1");
    await submit(input, f.memory, { noteInput: [fact], memoryInput: create }); return OK;
  });
  Object.assign(f.memory.config.noting, { extractFactsSteps: 1, checkFactsSteps: 1, writeKnowledgeSteps: 1, checkKnowledgeSteps: 1,
    extractFactsContextTokens: 1, checkFactsContextTokens: 1, writeKnowledgeContextTokens: 1, checkKnowledgeContextTokens: 1 });
  expect(await f.run()).toMatchObject({ outcome: "success" });
});

for (const resolvedRoot of [false, true]) test(`knowledge files resolve from ${resolvedRoot ? "directory before startDirectory" : "startDirectory"}`, async () => {
  const f = fixture(async input => {
    await submit(input, f.memory, { noteInput: [fact], memoryInput: { ...create, files: ["named.ts"] } }); return OK;
  }, resolvedRoot);
  writeFileSync(join(f.dir, "named.ts"), "fallback source");
  if (f.session.directory) { mkdirSync(f.session.directory); writeFileSync(join(f.session.directory, "named.ts"), "resolved source"); }
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(f.memory.store.currentKnowledge(f.path)[0]!.revision.files).toEqual([join(f.session.directory ?? f.dir, "named.ts")]);
});

for (const missing of ["field", "path"]) test(`knowledge rejects a missing files ${missing} without publication`, async () => {
  const f = fixture(async input => {
    let text = knowledgeFile(f.memory, missing === "path" ? { ...create, files: ["not-present.ts"] } : create);
    if (missing === "field") text = text.replace("files: None\n", "");
    await submit(input, f.memory, { noteInput: [fact], files: { knowledge: text } }); return OK;
  });
  const result = await f.run();
  expect(result).toMatchObject({ outcome: "failure", problems: expect.arrayContaining([expect.stringContaining(missing === "field" ? "missing required field `files`" : "path does not exist")]) });
  expect(f.memory.store.listSessionFacts(1).map(value => value.text)).toEqual(["Use pnpm"]);
  expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
});

test("fact retrieval finds rephrased CJK titles and full bodies without mapping unrelated Raw", () => {
  const f = fixture(async () => OK), store = f.memory.store;
  const entry = store.getSourceEntry(store.listSourceEntries(1)[0]!.id)!;
  const [cjk, body, opaque] = facts(f.memory, f.path, [
    { title: "整理分批由代理自己推进", sources: [{ entry, text: "旧方案" }] },
    { title: "Opaque history", sources: [{ entry, text: "Earlier context. Noter checks facts in independent conversations." }] },
    { title: "Opaque baseline", sources: [{ entry, text: "Unrelated historical record" }] },
  ]);
  const scope = { ...f.path, range: { from: "S1/T1", to: "S1/T1" } };
  const seed = (title: string, text = "新内容") => ({ name: "facts.md", text: factsFile([{ title, sources: `[T1#E1] ${text}` }]) });
  const ids = (text: string) => [...text.matchAll(/^## F(\d+)$/gm)].map(match => Number(match[1]));
  expect(ids(relatedFacts(store, scope, seed("整理分批的推进方式"), 1))).toEqual([cjk!.id]);
  expect(ids(relatedFacts(store, scope, seed("New episode", "New context. Noter checks facts in separate conversations."), 1))).toEqual([body!.id]);
  // The Turn's Raw mentions pnpm, but none of its facts do.
  expect(ids(relatedFacts(store, scope, seed("pnpm"), 20))).toEqual([]);
  expect(ids(relatedFacts(store, scope, seed("整理分批的推进方式"), 0))).toEqual([]);
  expect(ids(relatedFacts(store, scope, { name: "facts.md", text: "## none\n" }, 20))).toEqual([]);
  expect(ids(relatedFacts(store, scope, seed("整理分批的推进方式"), 20))).not.toContain(opaque!.id);
});

test("fact retrieval scopes object and ranked matches before the cap, including same-Turn sibling entries", () => {
  const f = fixture(async () => OK), store = f.memory.store;
  const root = store.getSourceEntry(store.listSourceEntries(1)[0]!.id)!;
  const sibling = sourceEntry(store, 1, 1, "sibling", "user", "整理分批的推进方式 Noter");
  store.selectSourcePath(1, "sibling", [sibling.id]);
  const text = "整理分批的推进方式 Noter";
  const [offBranch] = facts(f.memory, { ...f.path, branch: "sibling" }, [{ title: text, objects: ["Noter"], sources: [{ entry: sibling, text }] }]);
  const project = store.createProject({ name: "other-project", declaredBy: "mark" });
  const other = session(store, project.id, "pi:other");
  const turn = store.appendTurn({ sessionId: other.id, kind: "turn", userPrompt: text, startedAt: "now" });
  const foreignEntry = store.getSourceEntry(store.listSourceEntries(other.id)[0]!.id)!;
  facts(f.memory, { sessionId: other.id, branch: "main", headTurnId: turn.id }, [{ title: text, objects: ["Noter"], sources: [{ entry: foreignEntry, text }] }]);
  store.selectSourcePath(1, "main", [root.id]);
  const [onPath] = facts(f.memory, f.path, [{ title: "整理分批由代理自己推进", objects: ["Noter"], sources: [{ entry: root, text: "Noter uses the old plan" }] }]);
  const scope = { ...f.path, range: { from: "S1/T1", to: "S1/T1" } };
  for (const objects of [[], ["Noter"]]) {
    const file = { name: "facts.md", text: factsFile([{ title: text, objects, sources: "[T1#E1] Current plan" }]) };
    const result = relatedFacts(store, scope, file, 1);
    expect([...result.matchAll(/^## F(\d+)$/gm)].map(match => Number(match[1]))).toEqual([onPath!.id]);
    expect(result).not.toContain(`## F${offBranch!.id}\n`);
  }
});

test("fact retrieval round-robins distinct seeds, ranks shared objects, and ignores reverted blocks", () => {
  const f = fixture(async () => OK), store = f.memory.store;
  const entry = store.getSourceEntry(store.listSourceEntries(1)[0]!.id)!;
  const [one, both, second, reverted] = facts(f.memory, f.path, [
    { title: "First partial", objects: ["Noter"], sources: [{ entry, text: "Noter extracts" }] },
    { title: "First complete", objects: ["Noter", "SQLite"], sources: [{ entry, text: "Noter writes SQLite" }] },
    { title: "Second topic", sources: [{ entry, text: "独立核实事实的会话" }] },
    { title: "Dropped topic", sources: [{ entry, text: "独角兽失效记录" }] },
  ]);
  const scope = { ...f.path, range: { from: "S1/T1", to: "S1/T1" } };
  const file = { name: "facts.md", text: factsFile([
    { title: "New first", objects: ["Noter", "SQLite"], sources: "[T1#E1] Noter writes SQLite" },
    { title: "独立核实事实的新方案", sources: "[T1#E1] unrelated body" },
    { title: "独角兽失效记录", sources: "[T1#E1] unrelated body", verdict: "reverted — not admitted" },
  ]) };
  const ids = (cap: number) => [...relatedFacts(store, scope, file, cap).matchAll(/^## F(\d+)$/gm)].map(match => Number(match[1]));
  expect(ids(2)).toEqual([both!.id, second!.id]);
  expect(ids(3)).toEqual([both!.id, second!.id, one!.id]);
  expect(ids(20)).not.toContain(reverted!.id);
});

test("knowledge retrieval uses new knowledge, not new facts, and finds rephrased CJK titles", () => {
  const f = fixture(async () => OK);
  const entry = f.memory.store.getSourceEntry(f.memory.store.listSourceEntries(1)[0]!.id)!;
  const [raw] = facts(f.memory, f.path, [{ title: "Opaque history", sources: [{ entry, text: "opaque baseline" }] }]);
  const scope = { ...f.path, range: { from: "S1/T1", to: "S1/T1" } };
  const seed = (title: string) => ({ name: "facts.md", text: factsFile([{ title, sources: "[T1#E1] unrelated current summary" }]) });
  knowledgeBatch(f.memory.store, f.path, Array.from({ length: 4 }, (_, i) => ({
    title: `Background ${i}`, text: "Unrelated background", category: "constraint", scope: "session", supports: [raw!.id],
  })));
  const item = knowledge(f.memory.store, f.path, "session", "constraint", [raw!.id], "Existing conclusion", { operation: { title: "knowledgeneedle" } });
  const files = { facts: seed("no-match"), knowledge: { name: "knowledge.md", text: knowledgeFile(f.memory, { ...create, title: "knowledgeneedle", supports: [`F${raw!.id}`] }) } };
  expect(relatedKnowledge(f.memory.store, scope, files, 20)).toContain(`## K${item.knowledgeId}@v1`);
  // New knowledge retrieves old knowledge; new facts alone retrieve none. Word segmentation also finds rephrased CJK titles.
  const cjk = knowledge(f.memory.store, f.path, "session", "constraint", [raw!.id], "旧结论", { operation: { title: "整理分批由代理自己推进" } });
  const factOnly = { facts: seed("整理分批由代理自己推进"), knowledge: { name: "knowledge.md", text: "## none\n" } };
  expect(relatedKnowledge(f.memory.store, scope, factOnly, 20)).not.toContain(`## K${cjk.knowledgeId}@v1`);
  const similar = { facts: seed("no-match"), knowledge: { name: "knowledge.md", text: knowledgeFile(f.memory, { ...create, title: "整理分批的推进方式", supports: [`F${raw!.id}`] }) } };
  expect(relatedKnowledge(f.memory.store, scope, similar, 20)).toContain(`## K${cjk.knowledgeId}@v1`);
});

test("fact and knowledge lanes overlap, each excludes duplicates, and knowledge publishes FIFO without advancing partial-batch progress", async () => {
  const factEntered = Promise.withResolvers<void>(), releaseFacts = Promise.withResolvers<void>();
  const knowledgeEntered = Promise.withResolvers<void>(), releaseKnowledge = Promise.withResolvers<void>();
  const starts: { task: string; batch: number }[] = [];
  const f = fixture(async input => {
    const batch = input.entryIds[0]!;
    starts.push({ task: input.task, batch });
    if (batch === 1 && input.task === "extract-facts") { factEntered.resolve(); await releaseFacts.promise; }
    if (batch === 1 && input.task === "write-knowledge") { knowledgeEntered.resolve(); await releaseKnowledge.promise; }
    const entry = f.memory.store.getSourceEntry(batch)!;
    await submit(input, f.memory, { noteInput: [{ title: `Batch ${batch}`, sources: `[T${entry.turnId}#E${entry.entryOrdinal}] ${entry.text}` }],
      memoryInput: { ...create, title: `Rule ${batch}`, text: entry.text } });
    return OK;
  });
  const other = sourceSeededMemory(join(f.dir, "memory.sqlite"), async () => { throw new Error("duplicate executor must not call the model"); });
  cleanup.push(() => other.close());
  const sibling = { ...f.path, branch: "sibling" };
  other.store.selectSourcePath(1, sibling.branch, other.store.sourcePath(1, "main", 1).map(entry => entry.id));
  const firstFacts = f.memory.noting({ ...f.path, lane: "facts" });
  await factEntered.promise;
  expect(await f.memory.noting({ ...f.path, lane: "facts" })).toMatchObject({ outcome: "dropped" });
  expect(await other.noting({ ...sibling, lane: "facts" })).toMatchObject({ outcome: "dropped" });
  expect(f.memory.store.listSessionFacts(1)).toEqual([]);
  releaseFacts.resolve();
  expect(await firstFacts).toMatchObject({ outcome: "success" });
  expect(f.memory.store.listSessionFacts(1).map(value => value.text)).toEqual(["Use pnpm"]);
  expect(f.memory.progress(1, "main", 1).entries).toBe(2);
  const firstKnowledge = f.memory.noting({ ...f.path, lane: "knowledge" });
  await knowledgeEntered.promise;
  const second = f.memory.store.appendTurn({ sessionId: 1, parentTurnId: 1, kind: "turn", userPrompt: "Use yarn", assistantText: "Agreed", startedAt: "later" });
  const path = { ...f.path, headTurnId: second.id };
  expect(await f.memory.noting({ ...path, lane: "facts" })).toMatchObject({ outcome: "success" });
  expect(await f.memory.noting({ ...path, lane: "knowledge" })).toMatchObject({ outcome: "dropped" });
  expect(await other.noting({ ...sibling, lane: "knowledge" })).toMatchObject({ outcome: "dropped" });
  expect(f.memory.store.listSessionFacts(1).map(value => value.text).sort()).toEqual(["Use pnpm", "Use yarn"]);
  expect(f.memory.store.currentKnowledge(path)).toEqual([]);
  expect(f.memory.progress(1, "main", second.id).entries).toBe(4);
  expect(starts.filter(value => value.task === "write-knowledge")).toEqual([{ task: "write-knowledge", batch: 1 }]);
  releaseKnowledge.resolve();
  expect(await firstKnowledge).toMatchObject({ outcome: "success" });
  expect(f.memory.progress(1, "main", second.id).entries).toBe(2);
  expect(await f.memory.noting({ ...path, lane: "knowledge" })).toMatchObject({ outcome: "success" });
  expect(f.memory.store.currentKnowledge(path).map(value => value.revision.text)).toEqual(["Use pnpm", "Use yarn"]);
  expect(f.memory.progress(1, "main", second.id).entries).toBe(0);
});

test.each([{ wait: 5_000, reuse: true }, { wait: 5_001, reuse: false }])("knowledge prefix at configured boundary +$wait ms (reuse=$reuse) survives a failed lane and restart", async ({ wait, reuse }) => {
  const inputs: NotingAgentInput[] = [];
  let fail = true;
  const f = fixture(async input => {
    inputs.push(input);
    if (input.task === "write-knowledge" && fail) { input.reportRequest(REQUEST); return { ...OK, outcome: "failure", output: "knowledge transport failed" }; }
    await submit(input, f.memory, { noteInput: [fact], memoryInput: create });
    return OK;
  });
  f.memory.config.noting.knowledgePrefixReuseMs = 5_000;
  const entry = f.memory.store.getSourceEntry(1)!;
  const prior = facts(f.memory, f.path, [{ title: "Earlier evidence", sources: [{ entry, text: "Earlier evidence body" }] }])[0]!;
  knowledge(f.memory.store, f.path, "session", "constraint", [prior.id], "Keep existing knowledge");
  expect(await f.memory.noting({ ...f.path, lane: "facts" })).toMatchObject({ outcome: "success" });
  const committed = f.memory.store.handoff(1, "noting", "knowledge")!.detail!.noting!.committedAt;
  const clock = vi.spyOn(Date, "now").mockReturnValue(committed + wait);
  try {
    expect(await f.memory.noting({ ...f.path, lane: "knowledge" })).toMatchObject({ outcome: "failure", problems: ["knowledge transport failed"] });
    const first = inputs.find(value => value.task === "extract-facts")!, lane = inputs.find(value => value.task === "write-knowledge")!;
    expect(lane.material.knowledge).toEqual(first.material.knowledge);
    if (reuse) expect(lane.text).toBe(first.text);
    else {
      expect(lane.material.entries).toEqual([]);
      expect(lane.material.factTitles).toBeUndefined();
      expect(lane.material.earlierUsers).toBeUndefined();
      expect(lane.material.receipts).toEqual([]);
      expect(lane.supplied.entries).toEqual([]);
      expect(lane.supplied.factIds).toEqual([prior.id + 1]);
      expect(lane.material.facts!.join("\n")).toContain(`[F${prior.id + 1}]`);
      expect(lane.text).not.toContain("Earlier evidence body");
    }
    const prefix = lane.text;
    clock.mockReturnValue(committed + wait + 60 * 60_000);
    fail = false; f.restart();
    expect(await f.run()).toMatchObject({ outcome: "success" });
    expect(inputs.filter(value => value.task === "write-knowledge").at(-1)!.text).toBe(prefix);
    expect(f.memory.store.listSessionFacts(1).map(value => value.text).sort()).toEqual(["Earlier evidence body", "Use pnpm"]);
    expect(f.memory.store.handoff(1, "noting", "knowledge")).toBeNull();
  } finally { clock.mockRestore(); }
});

test("a knowledge claim taken over after its lease expired runs in its own execution and workspace; the predecessor returning late disturbs neither", async () => {
  const entered = Promise.withResolvers<void>(), releaseStale = Promise.withResolvers<void>();
  const replacementEntered = Promise.withResolvers<void>(), releaseReplacement = Promise.withResolvers<void>();
  const writers: NotingAgentInput[] = [];
  const f = fixture(async input => {
    if (input.task === "write-knowledge") {
      writers.push(input);
      if (writers.length === 1) { entered.resolve(); await releaseStale.promise; }
      else { replacementEntered.resolve(); await releaseReplacement.promise; }
    }
    await submit(input, f.memory, { noteInput: [fact], memoryInput: create });
    return OK;
  });
  expect(await f.memory.noting({ ...f.path, lane: "facts" })).toMatchObject({ outcome: "success" });
  const stale = f.memory.noting({ ...f.path, lane: "knowledge" });
  await entered.promise;
  f.memory.store.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE session_id = ? AND phase = 'noting' AND lane = 'knowledge'").run(f.session.id);
  const replacement = f.memory.noting({ ...f.path, lane: "knowledge" });
  await replacementEntered.promise;
  const [first, second] = writers as [NotingAgentInput, NotingAgentInput];
  expect(second.workspace.dir).not.toBe(first.workspace.dir);
  expect(second.executionId).not.toBe(first.executionId);
  releaseStale.resolve();
  expect(await stale).toMatchObject({ outcome: "failure" });
  expect(existsSync(second.workspace.dir)).toBe(true); // the late predecessor's cleanup removed only its own directory
  releaseReplacement.resolve();
  expect(await replacement).toMatchObject({ outcome: "success" });
  expect(f.memory.store.currentKnowledge(f.path).map(item => item.revision.text)).toEqual(["Use pnpm"]);
  expect(f.memory.store.handoff(1, "noting", "knowledge")).toBeNull();
  expect(f.memory.progress(1, "main", 1).entries).toBe(0);
});

/** Batch 1's fact commits; batch 2's fact "Use npm" then negates it while batch 1's knowledge lane has not yet run. */
async function laterBatchNegates(knowledgeOps: (prior: number) => Record<string, unknown>[]) {
  let pnpm = 0;
  const inputs: NotingAgentInput[] = [];
  const f = fixture(async input => {
    inputs.push(input);
    const batch = input.entryIds[0]!, entry = f.memory.store.getSourceEntry(batch)!;
    const sources = `[T${entry.turnId}#E${entry.entryOrdinal}] ${entry.text}`;
    await submit(input, f.memory, batch === 1
      ? { noteInput: [{ title: "Use pnpm", sources, caused_by: [[`F${prior.id}`, "strong"]] }], memoryInput: knowledgeOps(prior.id) }
      : { noteInput: [{ title: "Use npm", sources, negate: [[`F${pnpm}`, "strong"]] }] });
    return OK;
  });
  const entry = f.memory.store.getSourceEntry(1)!;
  const prior = facts(f.memory, f.path, [{ title: "Earlier evidence", sources: [{ entry, text: "Earlier evidence body" }] }])[0]!;
  expect(await f.memory.noting({ ...f.path, lane: "facts" })).toMatchObject({ outcome: "success" });
  pnpm = f.memory.store.listSessionFacts(1).find(value => value.text === "Use pnpm")!.id;
  const second = f.memory.store.appendTurn({ sessionId: 1, parentTurnId: 1, kind: "turn", userPrompt: "Use npm", assistantText: "Agreed", startedAt: "later" });
  const path = { ...f.path, headTurnId: second.id };
  expect(await f.memory.noting({ ...path, lane: "facts" })).toMatchObject({ outcome: "success" });
  return { f, path, inputs, prior, pnpm, npm: f.memory.store.listSessionFacts(1).find(value => value.text === "Use npm")!.id };
}

test("knowledge published after a later batch negated a fact it cites is flagged, as sequential publication would; a revision that does not cite it is not", async () => {
  const s = await laterBatchNegates(prior => [{ ...create, supports: ["$1"] }, { ...create, title: "Earlier evidence", text: "Earlier evidence", supports: [`F${prior}`] }]);
  expect(await s.f.memory.noting({ ...s.path, lane: "knowledge" })).toMatchObject({ outcome: "success" });
  expect(await s.f.memory.noting({ ...s.path, lane: "knowledge" })).toMatchObject({ outcome: "success" });
  const stale = (text: string) => s.f.memory.store.knowledgeStaleReasons(s.f.memory.store.currentKnowledge(s.path).find(item => item.revision.text === text)!.revision.id);
  expect(stale("Use pnpm")).toEqual([{ reason: "negated_fact", detail: expect.stringContaining(`F${s.pnpm} negated`) }]);
  expect(stale("Earlier evidence")).toEqual([]);
});

test("a delayed knowledge prefix shows its facts with the relations they had when published, not those of later batches", async () => {
  const s = await laterBatchNegates(() => [{ ...create, supports: ["$1"] }]);
  s.f.memory.config.noting.knowledgePrefixReuseMs = 5_000;
  const committed = s.f.memory.store.handoff(1, "noting", "knowledge")!.detail!.noting!.committedAt;
  const clock = vi.spyOn(Date, "now").mockReturnValue(committed + 5_001);
  try {
    expect(await s.f.memory.noting({ ...s.path, lane: "knowledge" })).toMatchObject({ outcome: "success" });
    const writer = s.inputs.find(input => input.task === "write-knowledge")!, shown = writer.material.facts!.join("\n");
    expect(writer.supplied.factIds).toEqual([s.pnpm]);
    expect(shown).toContain(`F${s.prior.id}`); // its own relation, made at publication
    expect(shown).not.toContain(`F${s.npm}`); // the later batch's negation of it
  } finally { clock.mockRestore(); }
});
