// What `note`, `memory` and the Noter's check refuse for length and title, for every writer: the Noter (its files),
// the Dreamer (one operation per call) and the manual tools. Title and body limits come from `writing`.
import { afterEach, expect, test } from "vitest";
import { sourceSeededMemory, type NotingAgentInput, type RunAgent, type RunAgentResult } from "../../source-fixture.ts";
import { checkWorkspace } from "../../../src/core/workspace/index.ts";
import { block, workspaceBatch } from "../../support/workspace.ts";
import { fact as seedFact, legacyKnowledge, receiptCommit } from "../../support/seed.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { writeFileSync } from "node:fs";
import { factsFile, finishKnowledgeStep, knowledgeFile, submit, toKnowledgeStep, verifyUnchanged, type Files } from "../../support/noter.ts";
import { operationOfText } from "../../support/dreamer.ts";

let memory: ReturnType<typeof sourceSeededMemory>, triggerEntryId: number;
afterEach(() => memory?.close());

/** Text of exactly `size` estimated tokens. */
function sized(size: number, prefix = ""): string {
  let text = prefix + "word ".repeat(size);
  while (tokens(text) > size) text = text.slice(0, -1);
  while (tokens(text) < size) text += "x";
  expect(tokens(text)).toBe(size);
  return text;
}

const success = (): RunAgentResult => ({ outcome: "success", output: "done", request: { fixture: "writing limits" } });

/** The scripted write task of the case under test; the default ends without writing. */
let script: (input: NotingAgentInput) => Promise<RunAgentResult> = async () => success();
function setup() {
  script = async () => success();
  const agent: RunAgent = raw => (raw as NotingAgentInput).kind === "noting" && (raw as NotingAgentInput).task === "verify"
    ? verifyUnchanged(raw, { request: { fixture: "writing limits" } }) : script(raw as NotingAgentInput);
  memory = sourceSeededMemory(":memory:", agent);
  const project = memory.store.createProject({ name: "limits", declaredBy: "mark" });
  const session = memory.store.createSession({ enrollmentChoice: true, host: "pi:limits", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Use pnpm", assistantText: "Okay", startedAt: "now" });
  const entries = memory.store.listSourceEntries(session.id);
  memory.selectEntries(session.id, "main", entries.map(entry => entry.id));
  triggerEntryId = entries.at(-1)!.id;
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  seedFact(memory, path, "Use pnpm", [{ entry: memory.store.getSourceEntry(entries[0]!.id)!, text: "Use pnpm" }]);
  const tools = memory.tools({ kind: "manual", ...path, currentTurnId: turn.id });
  return { path, turn, tools, note: tools.find(tool => tool.name === "note")!, write: tools.find(tool => tool.name === "memory")!,
    dreamPath: { ...path, triggerEntryId } };
}

const rule = { topics: [], category: "constraint", scope: "project", supports: ["F1"], reason: "test" };
const create = (title: string, text: string) => ({ op: "create", title, text, ...rule });
const tag = (id: number, ordinal = 1) => `K${id}#${memory.store.versionTag(id, memory.store.resolveVersionOrdinal(id, ordinal))}`;
const stored = (id: number) => memory.store.currentCommit(id)[0]!;

test("a manual note refuses an over-limit title and an over-limit body, naming the field, its count and the limit", () => {
  const { note, turn } = setup();
  const source = (...segments: string[]) => segments.map((text, index) => `[T${turn.id}#E${index + 1}] ${text}`).join("\n");
  expect(note.execute({ title: sized(21), sources: source("fine") })).toContain("title: 21 tokens, over the 20-token limit");
  expect(note.execute({ title: "fine", sources: source(sized(201)) })).toContain("sources: 201 tokens, over the 200-token limit");
  // The body is the sum of its segments, each counted on its own: two segments of 120 are 240.
  expect(note.execute({ title: "fine", sources: source(sized(120), sized(120)) })).toContain("sources: 240 tokens, over the 200-token limit");
  expect(memory.store.listTurnFacts(turn.id)).toHaveLength(1); // only the seeded fact
  expect(note.execute({ title: sized(20), sources: source(sized(100), sized(100)) })).toContain("ok: F2");
});

test("a manual create refuses a missing title and an over-limit title or body", () => {
  const { write } = setup();
  const before = memory.store.listKnowledgeRevisions();
  expect(write.execute({ ...create("x", "Use pnpm"), title: undefined })).toContain("title: expected a nonempty single-line string");
  expect(write.execute(create("two\nlines", "Use pnpm"))).toContain("title: expected a nonempty single-line string");
  expect(write.execute(create(sized(21), "Use pnpm"))).toContain("title: 21 tokens, over the 20-token limit");
  expect(write.execute(create("Package manager", sized(201)))).toContain("text: 201 tokens, over the 200-token limit");
  expect(memory.store.listKnowledgeRevisions()).toEqual(before);
  expect(JSON.parse(write.execute(create(sized(20), sized(200)))).committed).toHaveLength(1);
  expect(stored(1).title).toBe(sized(20));
});

test("the limits are configuration", () => {
  const { write } = setup();
  memory.config.writing.bodyTokens = 10;
  memory.config.writing.titleTokens = 3;
  expect(write.execute(create("Package manager rule for the whole team", "Use pnpm"))).toContain("title:");
  expect(write.execute(create("Package manager", sized(11)))).toContain("text: 11 tokens, over the 10-token limit");
  expect(write.execute(create("Package manager", sized(10)))).toContain("committed");
});

test("an update is checked on its resulting body, with text or with edits, and a long legacy item must also fit", () => {
  const { write, path } = setup();
  const long = legacyKnowledge(memory.store, path, { text: sized(300, "Legacy rule. "), category: "constraint", scope: "project", supports: [1] });
  const base = tag(long.knowledgeId);
  const update = { op: "update", id: base, title: "Legacy rule", supports: ["F1"], reason: "Shorten it" };
  // An edit that leaves it over the cap is refused with the resulting count; the stored item is untouched.
  const refused = write.execute({ ...update, edits: [{ old: "Legacy rule.", new: "Rule." }] });
  expect(refused).toMatch(/text: \d{3} tokens, over the 200-token limit/);
  expect(write.execute({ ...update, text: sized(201), category: "constraint", scope: "project", topics: [] })).toContain("text: 201 tokens");
  expect(memory.store.currentCommit(long.knowledgeId)).toHaveLength(1);
  expect(stored(long.knowledgeId).title).toBeNull();
  // The same update with a shortened body fits and is stored.
  expect(JSON.parse(write.execute({ ...update, text: "Legacy rule, shortened.", category: "constraint", scope: "project", topics: [] })).committed).toHaveLength(1);
  // Growing a body that fits past the cap by edits is refused too.
  const grown = write.execute({ op: "update", id: tag(long.knowledgeId, 2), supports: ["F1"], reason: "Grow it", edits: [{ old: "shortened", new: sized(200) }] });
  expect(grown).toMatch(/text: \d{3} tokens, over the 200-token limit/);
});

test("an update inherits its base's title; a base without one asks for it; an archive keeps the base's title or none", () => {
  const { write, path } = setup();
  expect(JSON.parse(write.execute(create("Package manager", "Use pnpm"))).committed).toHaveLength(1);
  const update = { op: "update", supports: ["F1"], reason: "Clarify" };
  expect(JSON.parse(write.execute({ ...update, id: tag(1), edits: [{ old: "pnpm", new: "corepack pnpm" }] })).committed).toHaveLength(1);
  expect(stored(1)).toMatchObject({ title: "Package manager", text: "Use corepack pnpm" });
  expect(JSON.parse(write.execute({ ...update, id: tag(1, 2), title: "Corepack", edits: [{ old: "Use", new: "Always use" }] })).committed).toHaveLength(1);
  expect(stored(1).title).toBe("Corepack");
  const archived = JSON.parse(write.execute({ op: "archive", kind: "invalid", id: tag(1, 3), supports: ["F1"], reason: "No longer true",
    text: "The rule no longer holds because the user withdrew it; nothing replaces it." }));
  expect(memory.store.getKnowledgeRevision(1, receiptCommit(memory.store, archived.committed[0]))).toMatchObject({ op: "archive", title: "Corepack" });
  // A legacy version has no title to inherit: the update is refused until it supplies one.
  const legacy = legacyKnowledge(memory.store, path, { text: "Legacy rule", category: "constraint", scope: "project", supports: [1] });
  const refused = write.execute({ ...update, id: tag(legacy.knowledgeId), edits: [{ old: "Legacy", new: "Old" }] });
  expect(refused).toContain("title: the base version has no title; supply one");
  expect(memory.store.currentCommit(legacy.knowledgeId)).toHaveLength(1);
  expect(JSON.parse(write.execute({ ...update, id: tag(legacy.knowledgeId), title: "Old rule", edits: [{ old: "Legacy", new: "Old" }] })).committed).toHaveLength(1);
  // Archiving a legacy version keeps it untitled.
  const second = legacyKnowledge(memory.store, path, { text: "Another legacy rule", category: "constraint", scope: "project", supports: [1] });
  const gone = JSON.parse(write.execute({ op: "archive", kind: "invalid", text: "Withdrawn: the user retired this and nothing replaces it, per the cited fact.", id: tag(second.knowledgeId), supports: ["F1"], reason: "Retire" }));
  expect(memory.store.getKnowledgeRevision(second.knowledgeId, receiptCommit(memory.store, gone.committed[0]))!.title).toBeNull();
});

/** What `check` says about these files: written to the workspace, then asked for, as a model does while it works. */
async function checked(input: NotingAgentInput, files: Partial<Files>): Promise<string> {
  if (files.facts !== undefined) writeFileSync(input.workspace.facts, files.facts);
  if (files.knowledge !== undefined) writeFileSync(input.workspace.knowledge, files.knowledge);
  return String(await input.tools.find(tool => tool.name === "check")!.execute({}));
}
test("the Noter's check refuses length and title with their counts, and a corrected file publishes", async () => {
  const seen: string[] = [];
  setup();
  script = async input => {
    const address = "T1#E1";
    seen.push(await checked(input, { facts: factsFile([{ title: sized(21), sources: `[${address}] fine` }]) }));
    seen.push(await checked(input, { facts: factsFile([{ title: "Fits", sources: `[${address}] ${sized(201)}` }]) }));
    // Knowledge problems are read at step 2, after the facts file has passed step 1.
    toKnowledgeStep(input, { noteInput: [{ title: "Fits", sources: `[${address}] Use pnpm` }] });
    seen.push(await checked(input, { knowledge: knowledgeFile(memory, create(sized(21), "Use pnpm")) }));
    seen.push(await checked(input, { knowledge: knowledgeFile(memory, { ...create("Package manager", "Use pnpm"), title: undefined }) }));
    seen.push(await checked(input, { knowledge: knowledgeFile(memory, create("Package manager", sized(201))) }));
    expect(finishKnowledgeStep(input, memory, { memoryInput: create("Package manager", "Use pnpm") })).toBeUndefined();
    return success();
  };
  const result = await memory.noting({ sessionId: 1, branch: "main", headTurnId: 1 });
  expect(seen[0]).toContain("title: 21 tokens, over the 20-token limit");
  expect(seen[0]).toContain("title 21/20 (over)"); // and the count is reported with the others
  expect(seen[1]).toContain("sources: 201 tokens, over the 200-token limit");
  expect(seen[2]).toContain("title: 21 tokens, over the 20-token limit");
  expect(seen[3]).toContain("missing required field `title`");
  expect(seen[4]).toContain("text: 201 tokens, over the 200-token limit");
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  expect(stored(1)).toMatchObject({ title: "Package manager", text: "Use pnpm" });
});
test("a Noter update is checked on its resulting body and needs a title when its base has none", async () => {
  const { path } = setup();
  const legacy = legacyKnowledge(memory.store, path, { text: sized(250, "Legacy rule. "), category: "constraint", scope: "project", supports: [1] });
  const seen: string[] = [];
  script = async input => {
    const update = { op: "update", id: tag(legacy.knowledgeId), supports: ["F1"], reason: "Compress", category: "constraint", scope: "project", topics: [] };
    toKnowledgeStep(input, { files: { facts: "## none\n" } });
    seen.push(await checked(input, { knowledge: knowledgeFile(memory, { ...update, text: "Rule, compressed." }) }));
    seen.push(await checked(input, { knowledge: knowledgeFile(memory, { ...update, title: "Legacy rule", text: sized(250, "Legacy rule. ") }) }));
    expect(finishKnowledgeStep(input, memory, { memoryInput: { ...update, title: "Legacy rule", text: "Rule, compressed." } })).toBeUndefined();
    return success();
  };
  const result = await memory.noting({ sessionId: 1, branch: "main", headTurnId: 1 });
  expect(seen[0]).toContain("title: the base version has no title; supply one");
  expect(seen[1]).toMatch(/text: \d{3} tokens, over the 200-token limit/);
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  expect(stored(legacy.knowledgeId)).toMatchObject({ title: "Legacy rule", text: "Rule, compressed." });
});

test("the Dreamer's curate operations are refused for length and title, each in its own file", () => {
  const b = workspaceBatch();
  memory = b.memory;
  const base = b.item("Use pnpm", { title: "Package manager" });
  const long = legacyKnowledge(b.store, b.path, { text: sized(300, "Legacy rule. "), category: "constraint", scope: "project", supports: [base.supports[0]!] });
  const longRef = `K${long.knowledgeId}@v1`;
  const problems = (text: string) => checkWorkspace(b.store, { kind: "curate", operation: operationOfText(text), sessionId: b.session.id, file: { name: "curate.md", text } }).problems.join("\n");
  const child = (fields: Record<string, string>, text: string) => `\n### child\n${Object.entries({ category: "constraint", scope: "project", topics: "", supports: `F${base.supports[0]}`, reason: "split", ...fields }).map(([key, value]) => `${key}: ${value}`).join("\n")}\n\n${text}\n`;
  expect(problems(block(`update ${base.ref}`, { reason: "Grow" }, sized(201)))).toContain("over the 200-token limit");
  expect(problems(block(`update ${base.ref}`, { title: sized(21), reason: "Retitle" }, "Use pnpm"))).toContain("title: 21 tokens, over the 20-token limit");
  expect(problems(block(`update ${longRef}`, { reason: "Shorten" }, "Rule."))).toContain("the base version has no title; supply one");
  expect(problems(block(`update ${longRef}`, { title: "Legacy rule", reason: "Shorten" }, sized(300)))).toMatch(/text: \d{3} tokens, over the 200-token limit/);
  expect(problems(block(`merge ${base.ref}`, { absorb: longRef, title: "Merged", reason: "Merge" }, sized(201)))).toMatch(/text: 201 tokens, over the 200-token limit/);
  expect(problems(block(`split ${base.ref}`, { reason: "Split" }, "Primary.") + child({ title: "One" }, sized(201)) + child({ title: "Two" }, "Two.")))
    .toContain("child 1: text: 201 tokens, over the 200-token limit");
  expect(problems(block(`split ${base.ref}`, { reason: "Split" }, "Primary.") + child({}, "One.") + child({ title: sized(21) }, "Two.")))
    .toMatch(/child 1: .*title.*child 2: title: 21 tokens, over the 20-token limit/s);
  // The split item continues as its primary part, which obeys the same cap.
  expect(problems(block(`split ${base.ref}`, { reason: "Split" }, sized(201)) + child({ title: "One" }, "One."))).toContain("text: 201 tokens, over the 200-token limit");
  expect(problems(block(`archive ${base.ref}`, { kind: "invalid", reason: "Withdrawn" }, sized(201, "No longer holds: ")))).toContain("body: 201 tokens, over the 200-token limit");
});
