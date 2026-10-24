import { afterEach, expect, test } from "vitest";
import type { TraceMemory } from "../../source-fixture.ts";
import { decisionText, dreamerFixture } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { checkCurate, decisionsTemplate } from "../../../src/core/dreaming/curate.ts";
import { projectItems } from "../../../src/core/dreaming/candidates.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test.each(["None", "/missing/file.ts"])("curate without a repository refuses files: %s", files => {
  const f = dreamerFixture(memories);
  f.item("Keep the supported rule");
  const items = projectItems(f.store, f.path);
  const decisions = decisionText(decisionsTemplate(items, false)).replace("decision:", `files: ${files}\ndecision:`);
  const checked = checkCurate(f.store, f.path, items, { name: "decisions.md", text: decisions }, { name: "changes.md", text: "## none\n" });
  expect(checked.problems).toContainEqual(expect.stringContaining("no readable repository"));
});

test.each(["update", "split child"])("curate without a repository refuses files in a %s change", operation => {
  const f = dreamerFixture(memories), item = f.item("Two independent supported conditions");
  const changes = operation === "update"
    ? block(`update ${item.ref}`, { files: "None", reason: "Clarify this condition" }, "Clarified supported condition")
    : block(`split ${item.ref}`, { supports: `F${item.supports[0]}`, reason: "Separate conditions" }, "Primary condition") +
      `\n### child\ntitle: Independent condition\ncategory: constraint\nscope: project\ntopics:\nsupports: F${item.supports[0]}\nfiles: None\nreason: Separate condition\n\nSecondary condition\n`;
  const items = projectItems(f.store, f.path);
  const checked = checkCurate(f.store, f.path, items,
    { name: "decisions.md", text: decisionText(decisionsTemplate(items, false), changes) }, { name: "changes.md", text: changes });
  expect(checked.problems).toContainEqual(expect.stringContaining("no readable repository"));
});

test.each(["keep", "update", "merge", "split", "archive"] as const)("a no-repository full check preserves mapped, None and unmapped records through %s", async operation => {
  const f = dreamerFixture(memories, { notes: "None" });
  f.memory.config.dreaming.wholeFileLimit = 1;
  const states = [undefined, null, ["/missing/old.ts"]] as const;
  const items = states.map((files, i) => {
    const item = f.item(`Supported rule ${i}`);
    // Historical SQL NULL means not mapped; JSON null means explicitly no files.
    f.store.db.prepare("UPDATE knowledge_revisions SET files = ? WHERE id = ?").run(files === undefined ? null : JSON.stringify(files), item.commit);
    return item;
  });
  const changes = items.map(item => {
    if (operation === "keep") return "";
    if (operation === "update") return block(`update ${item.ref}`, { reason: "Clarify the supported rule" }, "Clarified supported rule");
    if (operation === "archive") return block(`archive ${item.ref}`, { kind: "invalid", reason: "The user withdrew the rule" }, "The recorded rule no longer applies, as the user withdrew it.");
    if (operation === "merge") {
      const absorbed = f.item("Additional supported condition");
      return block(`merge ${item.ref}`, { absorb: absorbed.ref, reason: "Combine equivalent rules" }, "Combined supported rule");
    }
    return block(`split ${item.ref}`, { supports: `F${item.supports[0]}`, reason: "Separate independent conditions" }, "Primary supported condition") +
      `\n### child\ntitle: Separate condition\ncategory: constraint\nscope: project\ntopics:\nsupports: F${item.supports[0]}\nreason: Independent condition\n\nSecondary supported condition\n`;
  }).filter(Boolean).join("\n");
  f.dreamer.script.curate!.group1 = changes || "## none\n";
  const result = await f.memory.dream({ ...f.target, fullCheck: true });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "success" });
  for (const [index, item] of items.entries()) {
    const revisions = f.store.listKnowledgeRevisions(item.knowledgeId);
    const latest = revisions.at(-1)!;
    expect(latest.files).toEqual(states[index]);
    if (operation === "keep") expect(latest.id).toBe(item.commit);
  }
  if (operation === "split") {
    const children = projectItems(f.store, f.path).filter(item => !items.some(parent => parent.knowledgeId === item.value.knowledge.id));
    expect(children.map(item => item.value.revision.files)).toEqual(states);
  }
});
