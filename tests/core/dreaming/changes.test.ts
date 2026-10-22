import { afterEach, expect, test } from "vitest";
import { buildChanges } from "../../../src/core/dreaming/changes.ts";
import { keptBatch } from "../../support/dreamer.ts";
import { archive, updateKnowledge } from "../../support/seed.ts";
import { block, workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";

// The change file verify reads (ticket 144 stage 5 §4.3): one numbered block per proposal curate kept, with the complete current and
// proposed bodies. It is built from the kept proposals, applies nothing, and replaces the Dreamer's end review.
const opened: WorkspaceBatch[] = [];
const batch = () => { const b = workspaceBatch(); opened.push(b); return b; };
afterEach(() => { for (const b of opened.splice(0)) b.memory.close(); });
const longBody = (head: string, tail: string) =>
  `${head}。这条规则的背景是：多个会话反复遇到同类问题，所以把处理方式固定下来，并且要求每次都先核对来源再动手，避免凭印象改写。${tail}`;

test("an update lists the complete body it started from and the complete body it proposes, and changes nothing", () => {
  const b = batch();
  const before = longBody("规则甲", "结尾甲"), after = longBody("规则甲", "结尾甲，新增一条边界：不 stash／reset");
  const item = b.item(before, { title: "规则甲" });
  const run = keptBatch(b.memory, b.path, "constraint", ["update", block(`update ${item.ref}`, { reason: "boundary" }, after)]);
  const changes = buildChanges(b.store, b.path, [run]);
  expect(changes.blocks).toBe(1);
  expect(changes.text).toContain(`## 1 · update K${item.knowledgeId} · batch constraint`);
  expect(changes.text).toContain(`current: ${item.ref}`);
  const [, currentPart, proposedPart] = /current text:\n([\s\S]*?)\n\nproposed:\n([\s\S]*)/.exec(changes.text)!;
  expect(currentPart).toContain(before);
  expect(proposedPart).toContain(after);
  expect(changes.text).not.toContain("[...]"); // nothing is truncated
  expect(b.store.currentCommit(item.knowledgeId, b.path)[0]!.text).toBe(before); // a change file is not an application
});

test("a merge lists the absorbed items with their bodies; a split lists its children; changes are numbered across batches", () => {
  const b = batch();
  const survivor = b.item("Survivor body.", { title: "Survivor" }), absorbed = b.item("Absorbed body to disappear.", { title: "Absorbed" });
  const parent = b.item("Parent body to split.", { title: "Parent" });
  const child = (title: string, text: string) => `\n### child\ntitle: ${title}\ncategory: reference\nscope: project\ntopics:\nsupports: F${parent.supports[0]}\nreason: two rules\n\n${text}\n`;
  const first = keptBatch(b.memory, b.path, "constraint", ["merge", block(`merge ${survivor.ref}`, { absorb: absorbed.ref, reason: "same rule" }, "Survivor body, with the absorbed rule.")]);
  const second = keptBatch(b.memory, b.path, "reference", ["split", block(`split ${parent.ref}`, { reason: "two rules" }, "Primary part.") + child("Child one", "Child one.") + child("Child two", "Child two.")]);
  const text = buildChanges(b.store, b.path, [first, second]).text;
  expect(text).toContain(`## 1 · merge K${survivor.knowledgeId} · batch constraint`);
  expect(text).toContain(`## 2 · split K${parent.knowledgeId} · batch reference`);
  expect(text).toContain(`absorbed ${absorbed.ref} (archived into the primary if confirmed):`);
  expect(text).toContain("Absorbed body to disappear.");
  expect(text).toContain("Survivor body, with the absorbed rule.");
  expect(text.match(/proposed child \d:/g)).toHaveLength(2);
  expect(text).toContain("Child one.");
  expect(text).toContain("Primary part."); // the split item continues as its primary part
});

test("a split lists each child with the category, scope, topics and supports it will be written with", () => {
  const b = batch();
  const parent = b.item("Parent body to split.", { title: "Parent", scope: "project" }), other = b.existingFact("Another fact");
  const child = (title: string, fields: string) => `\n### child\ntitle: ${title}\n${fields}\nreason: two rules\n\n${title} body.\n`;
  const run = keptBatch(b.memory, b.path, "constraint", ["split", block(`split ${parent.ref}`, { reason: "two rules" }, "Primary part.")
    + child("Own child", `category: reference\nscope: session\ntopics: tooling\nsupports: F${other.id}`)
    + child("Bare child", `category: understanding\nscope: project\ntopics:\nsupports: F${parent.supports[0]}`)]);
  const [, first, second] = buildChanges(b.store, b.path, [run]).text.split(/^proposed child \d:\n/m);
  expect(first).toMatch(new RegExp(`^category: reference\nscope: session\ntopics: \\["tooling"\\]\nsupports: F${other.id}\n\nOwn child\nOwn child body\\.`));
  expect(second).toMatch(new RegExp(`^category: understanding\nscope: project\ntopics: \\[\\]\nsupports: F${parent.supports[0]}\n\nBare child\nBare child body\\.`));
});

test("title, scope and topics are shown only when the proposal changes them; supports show what the proposal writes, inherited ones included", () => {
  const b = batch();
  const item = b.item("Rule one", { title: "Old title" });
  const kept = (fields: Record<string, string>) => buildChanges(b.store, b.path, [keptBatch(b.memory, b.path, "constraint", ["update", block(`update ${item.ref}`, { reason: "tidy", ...fields }, "Rule one, tidied.")])]).text;
  const plain = kept({});
  expect(plain).not.toMatch(/^(title|scope|topics):/m);
  expect(plain).toContain(`supports: F${item.supports[0]}`); // inherited from the base, shown as what is written
  const changed = kept({ title: "New title", topics: "tooling" });
  expect(changed).toContain("title: Old title -> New title");
  expect(changed).toContain('topics: [] -> ["tooling"]');
});

test("the current version is the live one: a proposal whose base a later write replaced is shown as stale", () => {
  const b = batch();
  const item = b.item("Rule one");
  const run = keptBatch(b.memory, b.path, "constraint", ["update", block(`update ${item.ref}`, { reason: "tidy" }, "Rule one, tidied.")]);
  updateKnowledge(b.store, b.path, item.knowledgeId, item.commit, "Rule one, by hand", item.supports);
  const text = buildChanges(b.store, b.path, [run]).text;
  expect(text).toContain(`current: K${item.knowledgeId}@v2`);
  expect(text).toContain(`curate proposed from ${item.ref}; this change will be refused at apply`);
  // The proposal's base and the live version are shown apart, each with its own text; the proposed body is neither.
  expect(text).toMatch(new RegExp(`proposal base ${item.ref} text:\\n[^\\n]*\\nRule one\\n\\ncurrent K${item.knowledgeId}@v2 text:\\n[^\\n]*\\nRule one, by hand\\n\\nproposed:\\n[^\\n]*\\nRule one, tidied`));
  expect(text).not.toContain("current text:");
});

test("an update of an archived base lists the archive explanation as the current text", () => {
  const b = batch();
  const item = b.item("Rule A body.", { title: "Rule A title" });
  const archived = archive(b.store, b.path, item.knowledgeId, item.commit, item.supports, "invalid", "No longer holds, per the user's later correction, which replaces it");
  expect(b.store.versionOrdinal(item.knowledgeId, archived)).toBe(2);
  const run = keptBatch(b.memory, b.path, "constraint", ["update", block(`update K${item.knowledgeId}@v2`, { reason: "revived" }, "Rule A body.")]);
  const text = buildChanges(b.store, b.path, [run]).text;
  expect(text).toContain("No longer holds, per the user's later correction");
  expect(text).toMatch(/proposed:\nRule A title\nRule A body\./);
});
