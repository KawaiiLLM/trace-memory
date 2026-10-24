import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture, finishCurate, scriptedDreamer, writeDecisions } from "../../support/dreamer.ts";
import { REQUEST } from "../../support/noter.ts";
import { block } from "../../support/workspace.ts";
import { knowledgeBatch, session } from "../../support/seed.ts";
import { repositoryHead } from "../../../src/core/dreaming/code-links.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("a keep may publish an immutable metadata version; missing grounds flag it instead of reverting it", async () => {
  const f = dreamerFixture(memories), item = f.item("The supported body remains unchanged", { title: "Old label" });
  f.dreamer.script.instead = { curate: async input => {
    input.reportRequest(REQUEST);
    await input.tools.find(tool => tool.name === "check")!.execute({});
    writeDecisions(input.workspace.dir);
    const decisions = join(input.workspace.dir, "decisions.md");
    writeFileSync(decisions, readFileSync(decisions, "utf8").replace("title: Old label", "title: Precise label").replace("grounds: Recorded facts", "grounds: missing original grounds"));
    writeFileSync(join(input.workspace.dir, "changes.md"), "## none\n");
    expect(await finishCurate(input)).toBeUndefined();
    return { outcome: "success", output: "Done", request: REQUEST };
  } };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const current = f.store.currentCommit(item.knowledgeId, f.path)[0]!;
  expect(current.id).not.toBe(item.commit);
  expect(current).toMatchObject({ title: "Precise label", text: "The supported body remains unchanged", supports: item.supports, files: null });
  expect(f.store.getKnowledgeRevision(item.knowledgeId, item.commit)!.title).toBe("Old label");
  expect(f.store.knowledgeStaleReasons(current.id)).toEqual([{ reason: "missing_grounds", detail: "Preserve the supported understanding" }]);
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBe(75);
});

test("a merge carries a stale reason arriving on an absorbed item during curate to the survivor", async () => {
  const f = dreamerFixture(memories), primary = f.item("Use pnpm"), absorbed = f.item("Keep the lockfile");
  const late = { reason: "negated_fact" as const, detail: `F${absorbed.supports[0]} was negated during curate` };
  f.dreamer.script.curate!.group1 = block(`merge ${primary.ref}`, { absorb: absorbed.ref, reason: "Combine the package manager rules" }, "Use pnpm and keep the lockfile");
  f.dreamer.script.instead = { curate: async input => {
    const result = await scriptedDreamer({ curate: f.dreamer.script.curate }).agent(input);
    f.store.setKnowledgeStale(absorbed.commit, late);
    return result;
  } };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const survivor = f.store.currentCommit(primary.knowledgeId, f.path)[0]!;
  expect(survivor).toMatchObject({ op: "merge", supports: [...primary.supports, ...absorbed.supports] });
  expect(f.store.currentCommit(absorbed.knowledgeId, f.path)).toEqual([]);
  expect(f.store.knowledgeStaleReasons(survivor.id)).toEqual([late]);
});

test("curate refuses a split without primary supports even when the child names its supports", async () => {
  const f = dreamerFixture(memories), item = f.item("Use pnpm and keep the lockfile");
  const split = block(`split ${item.ref}`, { reason: "Separate the package manager rules" }, "Use pnpm")
    + `\n### child\ntitle: Lockfile rule\ncategory: constraint\nscope: project\ntopics:\nsupports: F${item.supports[0]}\nreason: Separate condition\n\nKeep the lockfile\n`;
  f.dreamer.script.curate!.group1 = [split, split.replace("reason:", `supports: F${item.supports[0]}\nreason:`)];
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.messages[0]).toContain("split requires explicit supports for its primary part");
  expect(f.store.currentCommit(item.knowledgeId, f.path)[0]).toMatchObject({ op: "split", text: "Use pnpm", supports: item.supports });
});

test("a linked file absent from the captured commit gets no verified commit, and the processed item is not re-flagged", async () => {
  // Reuse the checkout's HEAD without writing Git metadata.
  const dir = mkdtempSync(fileURLToPath(new URL("../../../.dreamer-untracked-", import.meta.url)));
  try {
    const file = join(dir, "rule.ts");
    writeFileSync(file, "export const manager = 'pnpm';\n");
    if (!repositoryHead(file)) throw new Error("This regression requires a Git checkout");
    const f = dreamerFixture(memories), support = f.existingFact("Package manager rule");
    session(f.store, f.project.id, "pi:file-links", { directory: dir });
    const item = knowledgeBatch(f.store, f.path, [{ scope: "project", category: "constraint", supports: [support.id],
      title: "Package manager", text: "Use pnpm", files: [file] }]).committed[0]!;
    const unverified = { reason: "unverified_file", detail: file };
    expect(f.store.knowledgeStaleReasons(item.commit)).toEqual([unverified]);
    f.dreamer.script.instead = { curate: async input => {
      input.reportRequest(REQUEST);
      await input.tools.find(tool => tool.name === "check")!.execute({});
      writeDecisions(input.workspace.dir);
      const decisions = join(input.workspace.dir, "decisions.md");
      writeFileSync(decisions, readFileSync(decisions, "utf8").replace("files: None", `files: ${file}`));
      writeFileSync(join(input.workspace.dir, "changes.md"), "## none\n");
      expect(await finishCurate(input)).toBeUndefined();
      return { outcome: "success", output: "Done", request: REQUEST };
    } };
    expect(await f.dream()).toMatchObject({ outcome: "success" });
    const current = f.store.currentCommit(item.knowledgeId, f.path)[0]!;
    expect(current.files).toEqual([file]);
    expect(f.store.knowledgeFileVerifications(current.id)).toEqual([]);
    expect(f.store.knowledgeStaleReasons(current.id)).toEqual([]); // processed; a flag it can never clear would recur every run
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oversized repository notes cannot publish a group; retry can replace the notes and finish the saved group", async () => {
  const f = dreamerFixture(memories), item = f.item("Retain this rule");
  f.memory.config.dreaming.notesTokens = 100;
  f.dreamer.script.notes = "Repository-specific detail. ".repeat(500);
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "notes" } });
  expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.id).toBe(item.commit);
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBeNull();
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
  f.dreamer.script.notes = "No additional repository notes.";
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.noterOperations(f.path)).toBe(0);
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBe(75);
});
