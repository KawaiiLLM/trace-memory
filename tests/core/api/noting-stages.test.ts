// Ticket 155 supersedes the two tasks/two steps contract with four independently resumed stages.
import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { REQUEST, factsFile, knowledgeFile, submit, verifyUnchanged, withVerdicts } from "../../support/noter.ts";
import { facts, knowledge } from "../../support/seed.ts";
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
    expect(f.memory.store.listSessionFacts(1)).toEqual([]);
    expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
    await submit(input, f.memory, { noteInput: [fact], memoryInput: create });
    return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "failure", problems: ["provider failed"] });
  const stage = NOTING_TASKS.indexOf(failed);
  expect(calls.map(input => input.task)).toEqual(NOTING_TASKS.slice(0, stage + 1));
  expect(f.memory.store.listSessionFacts(1)).toEqual([]);
  expect(f.memory.store.pendingEntries(1, "main", 1)).toHaveLength(2);
  expect(f.memory.store.taskFailures(1).find(row => row.phase === "noting")?.count).toBe(1);
  const kept = f.memory.store.handoff(1, "noting");
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
  expect(f.memory.store.listSessionFacts(1)).toEqual([]);
  expect(f.memory.store.handoff(1, "noting")?.nextTask).toBe(task);
});

for (const task of ["write-knowledge", "check-knowledge"] as const) test(`${task} cannot alter checked facts, including after passing its stop`, async () => {
  const f = fixture(async input => {
    await submit(input, f.memory, { noteInput: [fact], memoryInput: create });
    if (input.task === task) writeFileSync(input.workspace.facts, withVerdicts(factsFile([{ ...fact, sources: "[T1#E1] Use npm", objects: ["npm"] }])));
    return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "failure", problems: expect.arrayContaining(["facts.md: changed after check facts passed; restore it as it was"]) });
  expect(f.memory.store.listSessionFacts(1)).toEqual([]);
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
  expect(f.memory.store.listSessionFacts(1)).toEqual([]);
  expect(f.memory.store.currentKnowledge(f.path)).toEqual([]);
});

test("retrieval uses fact-title and Raw-only hits, knowledge titles, and configured result caps", () => {
  const f = fixture(async () => OK);
  const entry = f.memory.store.getSourceEntry(f.memory.store.listSourceEntries(1)[0]!.id)!;
  const [raw, lexical] = facts(f.memory, f.path, [
    { title: "Opaque history", sources: [{ entry, text: "opaque baseline" }] },
    { title: "lexicalneedle", sources: [{ entry, text: "another baseline" }] },
  ]);
  const scope = { ...f.path, range: { from: "S1/T1", to: "S1/T1" } };
  const seed = (title: string) => ({ name: "facts.md", text: factsFile([{ title, sources: "[T1#E1] unrelated current summary" }]) });
  expect(relatedFacts(f.memory.store, scope, seed("lexicalneedle"), 20)).toContain(`## F${lexical!.id}`);
  const fromRaw = relatedFacts(f.memory.store, scope, seed("pnpm"), 20);
  expect(fromRaw).toContain(`## F${raw!.id}`);
  expect(fromRaw).toContain(`## F${lexical!.id}`);
  expect(relatedFacts(f.memory.store, scope, seed("pnpm"), 1).match(/^## F/gm)).toEqual(["## F"]);
  const item = knowledge(f.memory.store, f.path, "session", "constraint", [raw!.id], "Existing conclusion", { operation: { title: "knowledgeneedle" } });
  const files = { facts: seed("no-match"), knowledge: { name: "knowledge.md", text: knowledgeFile(f.memory, { ...create, title: "knowledgeneedle", supports: [`F${raw!.id}`] }) } };
  expect(relatedKnowledge(f.memory.store, scope, files, 20)).toContain(`## K${item.knowledgeId}@v1`);
});
