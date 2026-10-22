// Ticket 144, stage 4 §6: the classify task. Scores are columns outside the version chain; the set is frozen when the task starts;
// each pass of at most 100 items is its own clean conversation under the task's single deadline.
import { afterEach, expect, test } from "vitest";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeFixture, type DreamerFixture, type DreamerScript } from "../../support/dreamer.ts";
import { updateKnowledge } from "../../support/seed.ts";
import { block } from "../../support/workspace.ts";
import { classifyAnchors, classifySet, CLASSIFY_ANCHORS } from "../../../src/core/dreaming/classify.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
const dreamerFixture = (script: DreamerScript = {}) => makeFixture(memories, script);

const scoreOf = (f: DreamerFixture, knowledgeId: number) =>
  f.store.db.prepare("SELECT score, scored_commit AS scoredCommit, scored_run AS run FROM knowledge WHERE id = ?").get(knowledgeId) as { score: number | null; scoredCommit: number | null; run: number | null };
const manyItems = (f: DreamerFixture, n: number) => Array.from({ length: n }, (_, i) => f.item(`Rule number ${i}`, { category: "reference", title: `Rule ${i}` }));
const classifyInputs = (f: DreamerFixture) => f.dreamer.inputs.filter(input => input.task === "classify");
const shown = (text: string) => (text.match(/^K\d+ \[/gm) ?? []).length;

test("up to 100 items are scored in one pass: the score, the version shown and the run are stored, and the hand-off ends", async () => {
  const f = dreamerFixture({ classify: (_pass, ids) => ids.map((id, i) => `K${id} ${10 + i}`).join("\n") + "\n" });
  const [a, b] = manyItems(f, 2);
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(classifyInputs(f)).toHaveLength(1);
  expect(classifyInputs(f)[0]!.text).not.toContain("Already scored"); // anchors exist above 100 items only
  expect(scoreOf(f, a!.knowledgeId)).toMatchObject({ score: 10, scoredCommit: a!.commit });
  expect(scoreOf(f, b!.knowledgeId)).toMatchObject({ score: 11, scoredCommit: b!.commit });
  const run = f.store.getRun(scoreOf(f, a!.knowledgeId).run!)!;
  expect(JSON.parse(run.response!)).toMatchObject({ task: "classify", pass: 1, passes: 1 });
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
});

test("above 100 items only the new and changed are scored, in passes of 100, with 30 scored items shown for scale", async () => {
  const f = dreamerFixture();
  const items = manyItems(f, 105);
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(classifyInputs(f).map(input => shown(input.text))).toEqual([100, 5]); // two clean conversations
  expect(classifyInputs(f)[1]!.text).not.toBe(classifyInputs(f)[0]!.text);
  expect(items.every(item => scoreOf(f, item.knowledgeId).score === 50)).toBe(true);
  // One item changes and one is new: only those two are scored, beside 30 anchors.
  const changed = updateKnowledge(f.store, f.path, items[0]!.knowledgeId, items[0]!.commit, "Rule number 0, changed", items[0]!.supports, "reference");
  expect(f.store.curateItems(f.path).find(item => item.value.knowledge.id === items[0]!.knowledgeId)).toMatchObject({ score: 50, scoredCommit: items[0]!.commit }); // keeps its score
  const fresh = f.item("A new rule", { category: "reference", title: "New rule" });
  f.dreamer.script.classify = (_pass, ids) => ids.map(id => `K${id} 70`).join("\n") + "\n";
  f.dreamer.inputs.length = 0;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const text = classifyInputs(f)[0]!.text;
  expect(classifyInputs(f)).toHaveLength(1);
  expect(shown(text.slice(text.indexOf("Items to score")))).toBe(2);
  expect(shown(text.slice(0, text.indexOf("Items to score")))).toBe(CLASSIFY_ANCHORS);
  expect(scoreOf(f, items[0]!.knowledgeId)).toMatchObject({ score: 70, scoredCommit: changed.commit });
  expect(scoreOf(f, fresh.knowledgeId)).toMatchObject({ score: 70 });
});

test("an item changed while classify runs keeps its score and joins the next set", async () => {
  const f = dreamerFixture();
  const items = manyItems(f, 3);
  await f.dream();
  f.item("A later Noter item", { category: "reference", title: "Later" });
  f.dreamer.script.classify = (_pass, ids) => {
    updateKnowledge(f.store, f.path, items[1]!.knowledgeId, items[1]!.commit, "Rule number 1, edited mid-run", items[1]!.supports, "reference");
    return ids.map(id => `K${id} 90`).join("\n") + "\n";
  };
  await f.dream();
  expect(scoreOf(f, items[1]!.knowledgeId)).toMatchObject({ score: 50, scoredCommit: items[1]!.commit }); // the 90 was not applied: the version shown is no longer current
  expect(scoreOf(f, items[0]!.knowledgeId).score).toBe(90);
});

test("anchors: every scored item up to 30, otherwise 30 spread over the scores; none at or below 100 items", () => {
  const item = (id: number, score: number | null) => ({ score, scoredCommit: score === null ? null : id, value: { revision: { id, knowledgeId: id } } }) as never;
  const unscored = Array.from({ length: 101 }, (_, i) => item(1000 + i, null));
  const withScored = (n: number) => [...unscored, ...Array.from({ length: n }, (_, i) => item(i + 1, 1 + (i * 3) % 100))];
  expect([0, 1, 29, 30, 31].map(n => classifyAnchors(withScored(n)).length)).toEqual([0, 1, 29, 30, 30]);
  const spread = classifyAnchors(withScored(31)) as unknown as { score: number }[];
  expect(new Set(spread.map(anchor => anchor.score)).size).toBe(30);
  expect(spread.map(anchor => anchor.score)).toEqual([...spread.map(anchor => anchor.score)].sort((a, b) => a - b));
  expect(classifyAnchors([...unscored.slice(0, 50), item(1, 40)])).toEqual([]); // 51 items
  expect(classifySet(unscored.slice(0, 100)).map(pass => pass.length)).toEqual([100]);
  expect(classifySet([...unscored, item(1, 40)]).map(pass => pass.length)).toEqual([100, 1]); // the scored one is not in the set
});

test("passes share the task's one deadline: a later pass gets only the time left", async () => {
  const starts: number[] = [];
  const f = dreamerFixture({ classify: (pass, ids) => { starts.push(Date.now()); if (pass === 1) { const end = Date.now() + 60; while (Date.now() < end); } return ids.map(id => `K${id} 50`).join("\n") + "\n"; } });
  manyItems(f, 130);
  f.memory.config.dreaming.timeoutMs = 4000;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const classify = f.dreamer.inputs.filter(input => input.task === "classify");
  expect(classify).toHaveLength(2);
  expect(classify[1]!.deadline).toBe(classify[0]!.deadline); // one absolute deadline for the whole task
  expect(classify[1]!.deadline - starts[1]!).toBeLessThan(4000 - 55); // pass 1 spent 60 ms of it
});

test("a resumed run with only classify left fails at the task's own deadline when its model ignores abort", async () => {
  const f = dreamerFixture();
  manyItems(f, 2);
  f.dreamer.script.instead = { classify: () => Promise.resolve({ outcome: "failure", output: "429 rate limit" } as never) };
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "classify", class: "provider error" } });
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "classify" });
  f.memory.config.dreaming.timeoutMs = 40;
  f.dreamer.script.instead = { classify: () => new Promise(() => {}) }; // never settles and never looks at the signal
  const started = Date.now();
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "classify", class: "timeout", transient: true } });
  expect(Date.now() - started).toBeLessThan(2000); // its own deadline, not the execution backstop (timeout plus two gaps)
  const rows = f.store.db.prepare("SELECT outcome, reason FROM task_executions ORDER BY rowid").all() as { outcome: string; reason: string }[];
  expect(rows.at(-1)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("classify: timeout") });
  expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM task_claims WHERE phase = 'dreaming'").get()).toEqual({ n: 0 }); // settled and released
});

test("an empty frozen set passes through a no-work run: above 100 items, all scored, and curate archived the cycle's only change", async () => {
  const f = dreamerFixture();
  manyItems(f, 101);
  await f.dream(); // scores all 101
  const fresh = f.item("A new rule", { category: "reference", title: "New rule" });
  f.dreamer.script.curate!.reference = block(`archive ${fresh.ref}`, { kind: "invalid", reason: "does not meet admission" },
    "The facts show this only records an implementation step, which fails admission; no other item replaces it.");
  f.dreamer.inputs.length = 0;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs.map(input => input.task)).toEqual(["curate", "verify"]); // curate changed something, so verify runs; classify has no model call
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
  expect(f.store.db.prepare("SELECT outcome FROM task_executions ORDER BY rowid DESC LIMIT 1").get()).toEqual({ outcome: "success" });
});
