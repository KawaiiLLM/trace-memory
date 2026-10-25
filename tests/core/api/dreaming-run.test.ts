import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import type { TraceMemory } from "../../source-fixture.ts";
import { decisionText, dreamerFixture, scriptedDreamer } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import type { DreamingAgentInput } from "../../../src/core/dreaming/index.ts";
import { boundaryOf, incrementalCandidates, projectItems } from "../../../src/core/dreaming/candidates.ts";
import { checkCurate, decisionsTemplate } from "../../../src/core/dreaming/curate.ts";
import { updateKnowledge } from "../../support/seed.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("a due incremental run covers processed project items and ends the handoff", async () => {
  const f = dreamerFixture(memories), a = f.item("Use pnpm"), b = f.item("Commit lockfiles", { category: "reference" });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.noterOperations(f.path)).toBe(0);
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
  for (const item of [a,b]) expect(f.store.currentCommit(item.knowledgeId, f.path)[0]).toMatchObject({ text: item === a ? "Use pnpm" : "Commit lockfiles", files: null });
  expect(await f.dream()).toMatchObject({ outcome: "empty" });
});

test("one pass can update archive merge and split but never create", async () => {
  const f = dreamerFixture(memories);
  const [a,b,c,d,e] = Array.from({ length: 5 }, (_, i) => f.item(`Supported rule ${i}`));
  f.dreamer.script.curate!.group1 = [block(`update ${a!.ref}`, { reason: "clarify" }, "Updated supported rule"),
    block(`archive ${b!.ref}`, { kind: "invalid", reason: "expired" }, "This time-limited rule expired according to the recorded facts."),
    block(`merge ${c!.ref}`, { absorb: d!.ref, reason: "duplicates" }, "The common supported rule"),
    block(`split ${e!.ref}`, { supports: `F${e!.supports[0]}`, reason: "independent facets" }, "The primary facet") + `\n### child\ntitle: Other facet\ncategory: reference\nscope: project\ntopics:\nsupports: F${e!.supports[0]}\nreason: Independent facet\n\nThe other facet\n`].join("\n");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.currentCommit(a!.knowledgeId, f.path)[0]!.text).toBe("Updated supported rule");
  expect(f.store.currentCommit(b!.knowledgeId, f.path)[0]!.op).toBe("archive");
  expect(f.store.liveKnowledge(f.path).some(r => r.knowledgeId === d!.knowledgeId)).toBe(false);
  expect(f.store.liveKnowledge(f.path).some(r => r.text === "The other facet")).toBe(true);
  expect(incrementalCandidates(f.store, f.path)).toMatchObject({ background: "No new background material.", candidates: [] });
});

test("a failure is counted once per execution and the persisted groups retry without reaching the trigger again", async () => {
  const f = dreamerFixture(memories); f.item("Original rule");
  f.dreamer.script.curate!.group1 = "## bogus\n";
  expect(await f.dream()).toMatchObject({ outcome: "failure" });
  expect(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")?.count).toBe(1);
  f.dreamer.script.curate!.group1 = "## none\n";
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")?.count).toBe(0);
});

test("group material contains current bodies and fact titles, with one diff since the last successful run", async () => {
  const f = dreamerFixture(memories), changed = f.item("Obsolete body before the covered version");
  const baseline = updateKnowledge(f.store, f.path, changed.knowledgeId, changed.commit, "Covered baseline。Stable context。", changed.supports);
  const flagged = f.item("Flagged current body");
  const boundary = boundaryOf(f.store, projectItems(f.store, f.path));
  f.store.recordRun({ kind: "dreaming", sessionId: f.session.id, branch: "main", createdAt: "now", outcome: "success", response: JSON.stringify({ finished: { boundary } }) });
  const middle = updateKnowledge(f.store, f.path, changed.knowledgeId, baseline.commit, "Intermediate body not in the final diff", changed.supports);
  const current = updateKnowledge(f.store, f.path, changed.knowledgeId, middle.commit, "Current replacement。Stable context。", changed.supports);
  const added = f.item("New current body");
  f.store.setKnowledgeStale(flagged.commit, { reason: "unresolved_check", detail: "Recheck recorded grounds" });
  let material = "";
  f.dreamer.script.instead = { curate: async input => {
    material = readFileSync(`${input.workspace.dir}/group.md`, "utf8");
    return scriptedDreamer().agent(input);
  } };
  expect(await f.memory.dream({ ...f.target, manual: true })).toMatchObject({ outcome: "success" });
  expect(material).toContain(`[K${changed.knowledgeId}@v4]`);
  expect(material).toContain("Current replacement。Stable context。");
  expect(material).toContain(`- F${changed.supports[0]} Support for Obsolete body before the covered version`);
  expect(material).not.toContain(f.store.getFact(changed.supports[0]!)!.text);
  expect(material).not.toContain("Intermediate body not in the final diff");
  expect(material).not.toMatch(new RegExp(`^\\[K${changed.knowledgeId}@v[123]\\]`, "m"));
  expect(material).toContain(`[K${changed.knowledgeId}@v2..K${changed.knowledgeId}@v4]`);
  expect(material).toMatch(/^- Covered baseline。$/m);
  expect(material).toMatch(/^\+ Current replacement。$/m);
  expect(material).toContain(`K${changed.knowledgeId}@${current.commit} update`);
  expect(material).not.toContain(`K${changed.knowledgeId}@${baseline.commit} update`);
  const [newSection, flaggedSection] = [added, flagged].map(item =>
    material.split(new RegExp(`^# K${item.knowledgeId}@v\\d+[^\\n]*\\n`, "m"))[1]!.split(/^# /m)[0]!);
  expect(newSection).toContain("New since the last successful Dreamer run.");
  expect(newSection).not.toContain("  text:");
  expect(flaggedSection).toContain("Unchanged since the last successful Dreamer run.");
  expect(flaggedSection).toContain("Recheck recorded grounds");
});

test("a late Noter version stays pending when its frozen predecessor is processed", async () => {
  const f = dreamerFixture(memories), original = f.item("Original rule"), scripted = scriptedDreamer();
  f.dreamer.script.instead = { curate: async input => {
    f.item("New rule after group admission");
    return scripted.agent(input);
  } };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.noterOperations(f.path)).toBe(1);
  expect(f.store.getKnowledge(original.knowledgeId)?.score).toBe(75);
});

test("a runner ignoring its own deadline fails without publishing the group", async () => {
  const f = dreamerFixture(memories), original = f.item("Original rule");
  f.memory.config.dreaming.timeoutMs = 20;
  f.dreamer.script.instead = { curate: async (_input: DreamingAgentInput) => new Promise(() => {}) };
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { class: "timeout" } });
  expect(f.store.currentCommit(original.knowledgeId, f.path)[0]!.id).toBe(original.commit);
});

test("incremental groups freeze marks and references, share background, and resume only unpublished candidates", async () => {
  const f = dreamerFixture(memories);
  f.memory.config.dreaming.groupItems = 3;
  f.memory.config.dreaming.parallelGroups = 1;
  const items = Array.from({ length: 8 }, (_, i) => f.item(`Supported body ${i + 1}`, { title: `Rule ${i + 1}` }));
  const boundary = boundaryOf(f.store, projectItems(f.store, f.path));
  f.store.recordRun({ kind: "dreaming", sessionId: f.session.id, branch: "main", createdAt: "now", outcome: "success", response: JSON.stringify({ finished: { boundary } }) });
  updateKnowledge(f.store, f.path, items[3]!.knowledgeId, items[3]!.commit, "Changed body after coverage", items[3]!.supports);
  for (const item of [items[0]!, items[1]!, items[3]!, items[4]!]) f.store.setKnowledgeStale(item.commit, { reason: "unresolved_check", detail: "Review this ruling" });
  const ids = items.map(item => item.knowledgeId);
  f.dreamer.script.clustering = `# Group 1\n## Cluster First\n- K${ids[0]}\n- K${ids[1]}\n- K${ids[2]}\n# Group 2\n## Cluster Second\n- K${ids[3]}\n- K${ids[4]}\n- K${ids[5]}\n# Group 3\n## Cluster Extra\n- K${ids[6]} ! duplicate: Check overlapping rule\n- K${ids[7]}\n`;
  const inputs: { prefix: string; group: string; decisions: string }[] = [];
  f.dreamer.script.instead = { curate: async input => {
    inputs.push({ prefix: input.text.split("\n\nGroup ")[0]!, group: readFileSync(`${input.workspace.dir}/group.md`, "utf8"), decisions: readFileSync(`${input.workspace.dir}/decisions.md`, "utf8") });
    return scriptedDreamer({ curate: { group2: "## bogus\n" } }).agent(input);
  } };
  expect(await f.memory.dream({ ...f.target, manual: true })).toMatchObject({ outcome: "failure" });
  const saved = f.store.handoff(f.session.id, "dreaming")!.detail!;
  // Five candidates with the marked item exceed the group size of 3: parts per clustering group, merged while they fit (2026-10-24).
  expect(saved.groups!.map(group => group.items)).toEqual([[ids[0], ids[1]], [ids[3], ids[4], ids[6]]]);
  expect(saved.groups![1]!.clusters!.at(-1)!.marks).toEqual({ [ids[6]!]: { kind: "duplicate", reason: "Check overlapping rule" } });
  expect(inputs[0]!.prefix).toBe(inputs[1]!.prefix);
  expect(inputs[0]!.prefix.indexOf("</repository_notes>")).toBeLessThan(inputs[0]!.prefix.indexOf("<background_material>"));
  expect(inputs[0]!.group).toContain(`- K${ids[2]}: Rule 3`);
  expect(inputs[0]!.group).not.toContain("Supported body 3");
  expect(inputs[0]!.decisions).not.toContain(`K${ids[2]}@`);
  expect(f.store.getKnowledge(ids[0]!)!.score).toBe(75);
  expect(f.store.getKnowledge(ids[6]!)!.score).toBeNull(); // the marked item sits in the failed group 2
  const laterBoundary = boundaryOf(f.store, projectItems(f.store, f.path));
  f.store.recordRun({ kind: "dreaming", sessionId: f.session.id, branch: "main", createdAt: "later", outcome: "success", response: JSON.stringify({ finished: { boundary: laterBoundary } }) });
  let resumedMaterial = "";
  f.dreamer.script.instead = { curate: async input => {
    resumedMaterial = readFileSync(`${input.workspace.dir}/group.md`, "utf8");
    return scriptedDreamer().agent(input);
  } };
  f.dreamer.script.clustering = "invalid if called again";
  const before = f.dreamer.inputs.length;
  expect(await f.memory.dream({ ...f.target, manual: true })).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs.slice(before).map(input => input.task)).toEqual(["curate"]);
  expect(resumedMaterial).toBe(inputs[1]!.group);
  expect(resumedMaterial).toContain(`[K${ids[3]}@v1..K${ids[3]}@v2]`);
  expect(f.store.getKnowledge(ids[6]!)!.score).toBe(75);
  expect(f.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE revision_id=? AND pool=?").get(items[6]!.commit, `project:${f.project.id}`)).toEqual({ revision_id: items[6]!.commit });
  expect(f.store.getKnowledge(ids[2]!)!.score).toBeNull(); // A title-only reference is not this group's target (169).
});

test("curate refuses a reference item as a decision, mutation target or absorbed merge parent", () => {
  const f = dreamerFixture(memories), candidate = f.item("Candidate body"), reference = f.item("Reference body");
  const items = projectItems(f.store, f.path), selected = items.filter(item => item.value.knowledge.id === candidate.knowledgeId);
  const decisions = decisionText(decisionsTemplate(selected, false));
  for (const changes of [
    block(`update ${reference.ref}`, { reason: "Attempted reference write" }, "Changed reference"),
    block(`merge ${candidate.ref}`, { absorb: reference.ref, reason: "Attempted reference absorption" }, "Combined rule"),
  ]) {
    expect(checkCurate(f.store, f.path, selected, { name: "decisions.md", text: decisions }, { name: "changes.md", text: changes }).problems.join("\n")).toContain("outside this group");
  }
  expect(checkCurate(f.store, f.path, selected, { name: "decisions.md", text: decisionText(decisionsTemplate(items, false)) }, { name: "changes.md", text: "## none\n" }).problems.join("\n")).toContain("expected an item of this group");
  expect(f.store.currentCommit(reference.knowledgeId, f.path)[0]!.id).toBe(reference.commit);
});

test("repository notes and full-pool clustering overlap, but neither alone admits curate", async () => {
  const f = dreamerFixture(memories), item = f.item("A supported rule"), scripted = scriptedDreamer();
  const notes = Promise.withResolvers<void>(), clustering = Promise.withResolvers<void>(), clustered = Promise.withResolvers<void>();
  const started: string[] = [];
  f.dreamer.script.instead = {
    notes: async input => { started.push("notes"); await notes.promise; return scripted.agent(input); },
    clustering: async input => {
      started.push("clustering");
      expect(readFileSync(`${input.workspace.dir}/batch-1.md`, "utf8")).toContain("A supported rule");
      await clustering.promise;
      const result = await scripted.agent(input);
      clustered.resolve();
      return result;
    },
  };
  const running = f.dream();
  expect(new Set(started)).toEqual(new Set(["notes", "clustering"]));
  clustering.resolve();
  await clustered.promise;
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBeNull();
  expect(f.dreamer.inputs.some(input => input.task === "curate")).toBe(false);
  notes.resolve();
  expect(await running).toMatchObject({ outcome: "success" });
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBe(75);
});
