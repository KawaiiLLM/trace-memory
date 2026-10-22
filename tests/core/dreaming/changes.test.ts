import { afterEach, expect, test } from "vitest";
import { buildChanges } from "../../../src/core/dreaming/changes.ts";
import { curateNow } from "../../support/dreamer.ts";
import { archive } from "../../support/seed.ts";
import { block, workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";

// The change file verify reads (ticket 144 Stage 4 §5.1): one block per curate operation that applied, with the complete before and
// after bodies. It replaces the Dreamer's end review (spec 10.2 split table "dreaming/end-review.test.ts").
const opened: WorkspaceBatch[] = [];
const batch = () => { const b = workspaceBatch(); opened.push(b); return b; };
afterEach(() => { for (const b of opened.splice(0)) b.memory.close(); });
const longBody = (head: string, tail: string) =>
  `${head}。这条规则的背景是：多个会话反复遇到同类问题，所以把处理方式固定下来，并且要求每次都先核对来源再动手，避免凭印象改写。${tail}`;
const ref = (item: { knowledgeId: number; ordinal: number }) => `K${item.knowledgeId}@v${item.ordinal}`;

test("an update lists the complete body it started from and the complete body it wrote", () => {
  const b = batch();
  const before = longBody("规则甲", "结尾甲"), after = longBody("规则甲", "结尾甲，新增一条边界：不 stash／reset");
  const item = b.item(before, { title: "规则甲" });
  const run = curateNow(b.memory, b.path, block(`update ${ref(item)}`, { reason: "boundary" }, after)).runId;
  const changes = buildChanges(b.store, [run]);
  expect(changes.blocks).toBe(1);
  expect(changes.text).toContain(`update K${item.knowledgeId}`);
  expect(changes.text).toContain(`base: ${ref(item)}`);
  const [, beforePart, afterPart] = /before:\n([\s\S]*?)\n\nafter:\n([\s\S]*)/.exec(changes.text)!;
  expect(beforePart).toContain(before);
  expect(afterPart).toContain(after);
  expect(changes.text).not.toContain("[...]"); // nothing is truncated
});

test("a merge lists the absorbed items with their bodies and says they are consumed; a split lists its children", () => {
  const b = batch();
  const survivor = b.item("Survivor body.", { title: "Survivor" }), absorbed = b.item("Absorbed body to disappear.", { title: "Absorbed" });
  const parent = b.item("Parent body to split.", { title: "Parent" });
  const child = (title: string, text: string) => `\n### child\ntitle: ${title}\ncategory: reference\nscope: project\ntopics:\nsupports: F${parent.supports[0]}\nreason: two rules\n\n${text}\n`;
  const run = curateNow(b.memory, b.path, [
    block(`merge ${ref(survivor)}`, { absorb: ref(absorbed), reason: "same rule" }, "Survivor body, with the absorbed rule."),
    block(`split ${ref(parent)}`, { reason: "two rules" }, "Primary part.") + child("Child one", "Child one.") + child("Child two", "Child two."),
  ].join("\n")).runId;
  const text = buildChanges(b.store, [run]).text;
  expect(text).toContain(`absorbed ${ref(absorbed)}:`);
  expect(text).toContain("Absorbed body to disappear.");
  expect(text).toContain(`K${absorbed.knowledgeId}: consumed by this merge`);
  expect(text).toContain("Survivor body, with the absorbed rule.");
  expect(text.match(/child K\d+@v1:/g)).toHaveLength(2);
  expect(text).toContain("Child one.");
  expect(text).toContain("Child two.");
  expect(text).toContain("Primary part."); // the split item continues as its primary part
});

test("a rewrite made earlier in the cycle is not shown as the original: the later block's before is the earlier result", () => {
  const b = batch();
  const original = "Keep the routine. Never stash or reset the user's work.", rewritten = "Keep the routine.";
  const item = b.item(original, { title: "Routine" });
  const first = curateNow(b.memory, b.path, block(`update ${ref(item)}`, { reason: "trim" }, rewritten));
  const second = curateNow(b.memory, b.path, block(`archive K${item.knowledgeId}@v2`, { kind: "invalid", reason: "contradicted" }, "The user contradicted this rule on the same day; nothing replaces it."));
  const changes = buildChanges(b.store, [first.runId, second.runId]);
  expect(changes.blocks).toBe(2);
  const [updateBlock, archiveBlock] = changes.text.split("\n\n## ").map((part, i) => i === 0 ? part : `## ${part}`);
  expect(updateBlock).toContain(original); // the first block started from the original
  expect(archiveBlock).toContain(`base: K${item.knowledgeId}@v2`);
  expect(archiveBlock).toContain("archive: invalid");
  expect(archiveBlock).toContain("reason: contradicted");
  expect(archiveBlock).not.toContain(original); // the archive's before is the trimmed body, never the original
  expect(archiveBlock).toContain(`\n${rewritten}`);
  expect(changes.results.get(item.knowledgeId)).toBe(b.store.currentCommit(item.knowledgeId, b.path)[0]!.id);
});

test("an archived item revived with a body is listed from its archive explanation to the full new body", () => {
  const b = batch();
  const item = b.item("Rule A body.", { title: "Rule A title" });
  const archived = archive(b.store, b.path, item.knowledgeId, item.commit, item.supports, "invalid", "No longer holds, per the user's later correction, which replaces it");
  expect(b.store.versionOrdinal(item.knowledgeId, archived)).toBe(2);
  const run = curateNow(b.memory, b.path, block(`update K${item.knowledgeId}@v2`, { reason: "revived" }, "Rule A body.")).runId;
  const text = buildChanges(b.store, [run]).text;
  expect(text).toContain(`base: K${item.knowledgeId}@v2`);
  expect(text).toContain("No longer holds, per the user's later correction");
  expect(text).toMatch(/after:\nRule A title\nRule A body\./);
});
