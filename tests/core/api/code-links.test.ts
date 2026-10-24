import { afterEach, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture, decisionText, writeDecisions } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { knowledgeBatch, session } from "../../support/seed.ts";
import { REQUEST } from "../../support/noter.ts";
import { checkCurate, decisionsTemplate } from "../../../src/core/dreaming/curate.ts";
import { projectItems } from "../../../src/core/dreaming/candidates.ts";
import { checkWorkspace } from "../../../src/core/workspace/index.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = join(root, "src/core/dreaming/roots.ts"), anchor = `${source}#allowedRoots`;
function fixture() {
  const f = dreamerFixture(memories);
  session(f.store, f.project.id, "pi:repository", { directory: root });
  return f;
}


test("Noter preserves an anchor while curate requires its symbol at HEAD, including split children", () => {
  const f = fixture(), item = f.item("Two independently maintained facets");
  const facts = { name: "facts.md", text: "## none\n" };
  const noter = checkWorkspace(f.store, { kind: "noting-knowledge", scope: f.scope, facts, file: { name: "knowledge.md", text:
    block("create", { title: "File facet", category: "constraint", scope: "project", topics: "", supports: `F${item.supports[0]}`, files: anchor, reason: "Grounded in this code" }, "Preserve the facet") } });
  expect(noter.problems).toEqual([]);
  const group = projectItems(f.store, f.path);
  const decisions = decisionText(decisionsTemplate(group)).replace("files: None", `files: ${source}#missingSymbol`);
  expect(checkCurate(f.store, f.path, group, { name: "decisions.md", text: decisions }, { name: "changes.md", text: "## none\n" }).problems)
    .toEqual([expect.stringContaining("symbol missing at HEAD")]);
  const split = block(`split ${item.ref}`, { supports: `F${item.supports[0]}`, reason: "Separate facets" }, "Primary facet") +
    `\n### child\ntitle: Second facet\ncategory: constraint\nscope: project\ntopics:\nsupports: F${item.supports[0]}\nfiles: ${source}#missingSymbol\nreason: Independent condition\n\nSecond facet\n`;
  expect(checkCurate(f.store, f.path, group, { name: "decisions.md", text: decisionText(decisionsTemplate(group), split) }, { name: "changes.md", text: split }).problems)
    .toEqual(expect.arrayContaining([expect.stringContaining("symbol missing at HEAD")]));
});

test("split children count toward the projected cap and merge removes consumed mappings", () => {
  const f = fixture(), a = f.item("Primary and child facets"), b = f.item("Other facet");
  const items = projectItems(f.store, f.path), split = block(`split ${a.ref}`, { supports: `F${a.supports[0]}`, reason: "Independent facets" }, "Primary facet") +
    `\n### child\ntitle: Child facet\ncategory: constraint\nscope: project\ntopics:\nsupports: F${a.supports[0]}\nfiles: ${source}\nreason: Independent facet\n\nChild facet\n`;
  const decisions = decisionText(decisionsTemplate(items), split).replaceAll("files: None", `files: ${source}`);
  expect(checkCurate(f.store, f.path, items, { name: "decisions.md", text: decisions }, { name: "changes.md", text: split }, 2).problems)
    .toEqual([expect.stringContaining("has 3 current items (whole-file limit 2)")]);
  const merge = block(`merge ${a.ref}`, { absorb: b.ref, reason: "Equivalent facets" }, "Combined facet");
  const merged = decisionText(decisionsTemplate(items), merge).replaceAll("files: None", `files: ${source}`);
  expect(checkCurate(f.store, f.path, items, { name: "decisions.md", text: merged }, { name: "changes.md", text: merge }, 1).problems).toEqual([]);
});

test("parallel groups recheck the whole-file cap at publication and roll back the losing group's changes, scores and coverage", async () => {
  const f = fixture(); f.memory.config.dreaming.groupItems = 1; f.memory.config.dreaming.wholeFileLimit = 1;
  const a = f.item("First facet"), b = f.item("Second facet");
  let arrived = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.dreamer.script.instead = { curate: async input => {
    input.reportRequest(REQUEST);
    await input.tools.find(tool => tool.name === "check")!.execute({});
    writeDecisions(input.workspace.dir);
    const file = join(input.workspace.dir, "decisions.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("files: None", `files: ${source}`));
    writeFileSync(join(input.workspace.dir, "changes.md"), "## none\n");
    const scoring = input.passEnd();
    expect(scoring).toContain("Curate passes.");
    const labels = /Items: ([^\n]*)/.exec(scoring!)![1]!.split(", ");
    writeFileSync(join(input.workspace.dir, "scores.md"), labels.map(label => `${label} 61`).join("\n"));
    expect(input.passEnd()).toBeDefined();
    expect(input.passEnd()).toBeUndefined();
    if (++arrived === 2) release();
    await barrier;
    return { outcome: "success", output: "Done", request: REQUEST };
  } };
  const result = await f.dream();
  expect(result).toMatchObject({ outcome: "failure", problems: [expect.stringContaining("has 2 current items (whole-file limit 1)")] });
  const current = [a, b].map(item => f.store.currentCommit(item.knowledgeId, f.path)[0]!);
  expect(current.filter(r => r.files?.includes(source))).toHaveLength(1);
  const loser = current.find(r => !r.files?.includes(source))!;
  expect(loser.id).toBe([a, b].find(item => item.knowledgeId === loser.knowledgeId)!.commit);
  expect(f.store.getKnowledge(loser.knowledgeId)!.score).toBeNull();
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed WHERE revision_id=?").all(loser.id)).toEqual([]);
});
