import { afterEach, expect, test } from "vitest";
import { TraceMemory as openMemory, type TraceMemory } from "../../../src/core/api/index.ts";
import { dreamerFixture, scriptedDreamer } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { updateKnowledge } from "../../support/seed.ts";
import { checkScores } from "../../../src/core/dreaming/classify.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const memories: TraceMemory[] = [], directories: string[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// Ticket 169 supersedes ticket 167's isolated scoring and scoring-batch lease contracts.
test("each group scores in its curate conversation and publishes changes and ratings in the same run", async () => {
  const f = dreamerFixture(memories); f.memory.config.dreaming.groupItems = 1;
  const a = f.item("Original first rule"), b = f.item("Second rule");
  f.dreamer.script.curate!.group1 = block(`update ${a.ref}`, { reason: "clarify" }, "Updated first rule");
  const scored: number[] = [];
  f.dreamer.script.scoring = (group, labels, message) => {
    scored.push(group);
    const input = f.dreamer.inputs.at(-1)!;
    expect(input.task).toBe("curate");
    expect(input.workspace.write).toContain(`${input.workspace.dir}/scores.md`);
    expect(input.tools.map(tool => tool.name)).toContain("search");
    expect(message).toContain("<scoring_input>");
    const scoring = message.split("<scoring_input>")[1]!;
    expect(scoring).not.toMatch(/Curate verdict|accuracy:|anchors/);
    if (group === 1) {
      expect(f.store.currentCommit(a.knowledgeId, f.path)[0]!.text).toBe("Original first rule");
      expect(scoring).toContain("Updated first rule");
      expect(labels).toEqual([`K${a.knowledgeId}`]);
      return `${labels[0]} 5 1 1`;
    }
    expect(labels).toEqual([`K${b.knowledgeId}`]);
    return `${labels[0]} 4 4 4`;
  };
  const result = await f.memory.dream({ ...f.target, toolNames: { ...canonicalToolNames, search: "mcp__t__search", note: "mcp__t__note", memory: "mcp__t__memory", check: "mcp__t__check" } });
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "success" });
  expect(scored.sort()).toEqual([1, 2]);
  expect(f.dreamer.inputs.map(input => input.task)).toEqual(["notes", "clustering", "curate", "curate"]);
  expect(f.store.getKnowledge(a.knowledgeId)).toMatchObject({ score: 81, ratings: { consequence: 5, frequency: 1, current: 1 } });
  expect(f.store.getKnowledge(b.knowledgeId)).toMatchObject({ score: 75, ratings: { consequence: 4, frequency: 4, current: 4 } });
  const revision = f.store.currentCommit(a.knowledgeId, f.path)[0]!;
  const row = f.store.db.prepare("SELECT scored_run, scored_commit FROM knowledge WHERE id=?").get(a.knowledgeId)!;
  expect(row.scored_commit).toBe(revision.id);
  expect(f.store.db.prepare("SELECT run_id FROM knowledge_processed WHERE revision_id=?").get(revision.id)!.run_id).toBe(row.scored_run);
});

test("failed scoring publishes nothing from its group and a reopened executor retries only that group", async () => {
  const directory = mkdtempSync("/private/tmp/scoring-resume-"); directories.push(directory);
  const file = join(directory, "memory.sqlite");
  const f = dreamerFixture(memories, {}, file); f.memory.config.dreaming.groupItems = 1;
  const a = f.item("First rule"), item = f.item("Original rule");
  f.dreamer.script.curate!.group2 = block(`update ${item.ref}`, { reason: "clarify" }, "Updated rule");
  let repairs = 0;
  f.dreamer.script.scoring = (group, labels) => group === 2 ? (repairs++, "K9999 3 3 3\n") : labels.map(label => `${label} 4 4 4`).join("\n");
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "scoring", groups: [{ group: 2 }] } });
  expect(repairs).toBe(2);
  expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.id).toBe(item.commit);
  expect(f.store.getKnowledge(item.knowledgeId)).toMatchObject({ score: null, ratings: null });
  expect(f.store.getKnowledge(a.knowledgeId)!.score).toBe(75);
  expect(f.store.handoff(f.session.id, "dreaming")!.nextTask).toBe("curate");
  f.memory.close();
  const replacement = scriptedDreamer({ curate: { group2: block(`update ${item.ref}`, { reason: "clarify" }, "Updated rule") } });
  const next = openMemory(file, replacement.agent, { dreaming: { triggerOperations: 1 } }); memories.push(next);
  expect(await next.dream(f.target)).toMatchObject({ outcome: "success" });
  expect(replacement.inputs.map(input => input.task)).toEqual(["curate"]);
  expect(next.store.currentCommit(item.knowledgeId, f.path)[0]!.text).toBe("Updated rule");
  expect(next.store.getKnowledge(item.knowledgeId)).toMatchObject({ score: 75, ratings: { consequence: 4, frequency: 4, current: 4 } });
});

test("a version changed during scoring cannot receive the old version's ratings", async () => {
  const f = dreamerFixture(memories), a = f.item("First rule"), b = f.item("Second rule");
  let concurrent = 0;
  f.dreamer.script.scoring = (_group, labels) => {
    concurrent = updateKnowledge(f.store, f.path, a.knowledgeId, a.commit, "User changed rule", a.supports).commit;
    return labels.map(label => `${label} 4 4 4`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.currentCommit(a.knowledgeId, f.path)[0]!.id).toBe(concurrent);
  expect(f.store.getKnowledge(a.knowledgeId)).toMatchObject({ score: null, ratings: null });
  expect(f.store.getKnowledge(b.knowledgeId)!.score).toBe(75);
  expect(f.store.db.prepare("SELECT 1 FROM knowledge_processed WHERE revision_id=?").get(concurrent)).toBeUndefined();
});

test("changing sealed curate files blocks scoring and rolls back the group after one repair", async () => {
  const f = dreamerFixture(memories), item = f.item("Original rule");
  f.dreamer.script.curate!.group1 = block(`update ${item.ref}`, { reason: "clarify" }, "Updated rule");
  let attempts = 0;
  f.dreamer.script.scoring = (_group, labels, message) => {
    if (attempts++) expect(message).toContain("Curate files changed after passing");
    const dir = f.dreamer.inputs.at(-1)!.workspace.dir;
    writeFileSync(`${dir}/changes.md`, "## none\n");
    return labels.map(label => `${label} 4 4 4`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "failure", problems: ["Curate files changed after passing; restore them before scoring"] });
  expect(attempts).toBe(2);
  expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.id).toBe(item.commit);
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBeNull();
});

test("scoring has its own repair and budget after curate repairs", async () => {
  const f = dreamerFixture(memories), item = f.item("Supported rule");
  f.memory.config.dreaming.scoringSteps = 2;
  f.memory.config.dreaming.scoringContextTokens = 1_000;
  f.dreamer.script.curate!.group1 = ["## bogus\n", "## none\n"];
  let attempts = 0;
  f.dreamer.script.scoring = (_group, labels, message) => {
    if (!attempts++) {
      const budget = /Budget: steps (\d+) of (\d+); context \+(\d+) of \+(\d+)/.exec(message)!;
      expect(budget.slice(1).map(Number)).toEqual([0, 2, 0, 1_000]);
      return "invalid";
    }
    return labels.map(label => `${label} 4 4 4`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(attempts).toBe(2);
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBe(75);
});

test.each([1, 200])("split primary and %i children receive ratings in their allocating group commit", async children => {
  const f = dreamerFixture(memories), item = f.item("Independent supported facets");
  f.dreamer.script.curate!.group1 = block(`split ${item.ref}`, { supports: `F${item.supports[0]}`, reason: "independent facets" }, "Primary facet")
    + Array.from({ length: children }, (_, i) => `\n### child\ntitle: Facet ${i + 1}\ncategory: reference\nscope: project\ntopics:\nsupports: F${item.supports[0]}\nreason: Independent facet\n\nSupported facet ${i + 1}\n`).join("");
  f.dreamer.script.scoring = (_group, labels, message) => {
    expect(labels).toEqual([`K${item.knowledgeId}`, ...Array.from({ length: children }, (_, i) => `K${item.knowledgeId}.child${i + 1}`)]);
    expect(f.store.liveKnowledge(f.path).map(revision => revision.knowledgeId)).toEqual([item.knowledgeId]);
    expect(readFileSync(`${f.dreamer.inputs.at(-1)!.workspace.dir}/scoring.md`, "utf8")).toContain("Primary facet");
    expect(message).toContain("Supported facet 1");
    return labels.map(label => `${label} 4 4 4`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.liveKnowledge(f.path).map(revision => f.store.getKnowledge(revision.knowledgeId)!.score)).toEqual(Array(children + 1).fill(75));
  expect(f.dreamer.inputs.map(input => input.task)).toEqual(["notes", "clustering", "curate"]);
});

test("incremental scoring excludes scored keeps, archives and absorbed items but rates changed scored versions", async () => {
  const f = dreamerFixture(memories);
  const primary = f.item("Use pnpm"), absorbed = f.item("Keep the lockfile"), archived = f.item("A withdrawn rule"),
    kept = f.item("Unscored surviving rule"), scored = f.item("Already scored surviving rule"), changed = f.item("Rule needing clarification");
  for (const item of [scored, changed])
    f.store.db.prepare("UPDATE knowledge SET score=90,scored_commit=? WHERE id=?").run(item.commit, item.knowledgeId);
  f.dreamer.script.curate!.group1 = [
    block(`merge ${primary.ref}`, { absorb: absorbed.ref, reason: "Combine package rules" }, "Use pnpm and keep the lockfile"),
    block(`archive ${archived.ref}`, { kind: "invalid", reason: "The user withdrew this rule" }, "The user withdrew this rule and nothing replaces it."),
    block(`update ${changed.ref}`, { reason: "Clarify" }, "Clarified supported rule"),
  ].join("\n");
  f.dreamer.script.scoring = (_group, labels, message) => {
    expect(new Set(labels)).toEqual(new Set([`K${primary.knowledgeId}`, `K${kept.knowledgeId}`, `K${changed.knowledgeId}`]));
    expect(message).toContain("Use pnpm and keep the lockfile");
    expect(message).toContain("Clarified supported rule");
    return labels.map(label => `${label} 4 4 4`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect([primary, kept, changed].map(item => f.store.getKnowledge(item.knowledgeId)!.score)).toEqual([75, 75, 75]);
  expect(f.store.getKnowledge(scored.knowledgeId)!.score).toBe(90);
  expect(f.store.currentCommit(absorbed.knowledgeId, f.path)).toEqual([]);
  expect(f.store.currentCommit(archived.knowledgeId, f.path)[0]!.op).toBe("archive");
  expect([absorbed, archived].map(item => f.store.getKnowledge(item.knowledgeId)!.score)).toEqual([null, null]);
});

test("rating files reject duplicate, foreign, missing, fractional and out-of-range ratings", () => {
  const target = { label: "K1", title: "Rule", text: "Rule", category: "constraint" as const, scope: "project" as const, knowledgeId: 1, commit: 1 };
  for (const text of ["K1 0 3 3", "K1 3 6 3", "K1 3 3 1.5", "K2 3 3 3", "", "K1 3 3 3\nK1 4 4 4", "K1 81"])
    expect(checkScores(text, [target]).problems.length).toBeGreaterThan(0);
  expect(checkScores("K1 2 4 5", [target])).toEqual({ scores: new Map([["K1", { consequence: 2, frequency: 4, current: 5 }]]), problems: [] });
});
