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

test("passes share the task's one absolute deadline", async () => {
  const f = dreamerFixture();
  manyItems(f, 130);
  f.memory.config.dreaming.timeoutMs = 4000;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const classify = f.dreamer.inputs.filter(input => input.task === "classify");
  expect(classify).toHaveLength(2);
  expect(classify[1]!.deadline).toBe(classify[0]!.deadline);
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
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "classify", class: "timeout" } });
  expect(Date.now() - started).toBeLessThan(2000); // its own deadline, not the execution backstop (timeout plus two gaps)
  const rows = f.store.db.prepare("SELECT outcome, reason FROM task_executions ORDER BY rowid").all() as { outcome: string; reason: string }[];
  expect(rows.at(-1)).toMatchObject({ outcome: "failure", reason: expect.stringContaining("classify: timeout") });
  expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM task_claims WHERE phase = 'dreaming'").get()).toEqual({ n: 0 }); // settled and released
});

test("an empty frozen set passes through a no-work run: above 100 items, all scored, and curate archived the cycle's only change", async () => {
  const f = dreamerFixture();
  manyItems(f, 101);
  await f.dream(); // scores all 101
  await f.cycleTo("update-archive"); // the rotation, run for real, reaches update+archive again
  const fresh = f.item("A new rule", { category: "reference", title: "New rule" });
  f.dreamer.script.curate!.reference = block(`archive ${fresh.ref}`, { kind: "invalid", reason: "does not meet admission" },
    "The facts show this only records an implementation step, which fails admission; no other item replaces it.");
  f.dreamer.inputs.length = 0;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  // 102 items are two groups (146), each with its own curate; the scripted text goes to the first reference batch of each group, so both propose and both verify; classify has no model call
  const tasks = f.dreamer.inputs.map(input => input.task);
  expect(tasks.filter(task => task === "curate")).toHaveLength(2);
  expect(tasks.filter(task => task === "verify")).toHaveLength(2);
  expect(tasks).not.toContain("classify");
  expect(JSON.parse(f.store.getRun(f.store.db.prepare("SELECT MAX(id) AS id FROM runs WHERE kind = 'dreaming'").get()!.id as number)!.response!)).toMatchObject({ task: "classify", passes: 0, pair: "update-archive", finished: { pair: "update-archive", advanced: true } });
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
  expect(f.store.db.prepare("SELECT outcome FROM task_executions ORDER BY rowid DESC LIMIT 1").get()).toEqual({ outcome: "success" });
});

// ---- 146 §9: parallel passes, the self-check step, the finish by the last commit ---------------------------------------------

// 「评分可以并行」 「评分写完文件后加内容自查步骤，用 Edit 改分数」
test("2026-10-22, 146 — above 100 items the passes are in flight together; each writes, meets the self-check, edits, and the edited scores are the ones stored; a self-check without edits stores the step-1 scores", async () => {
  const f = dreamerFixture();
  const items = manyItems(f, 105);
  let arrived = 0;
  const together = new Promise<void>((resolve, reject) => { f.next(async raw => { if (++arrived === 2) resolve(); await together; return f.dreamer.agent(raw); });
    f.next(async raw => { if (++arrived === 2) resolve(); await together; return f.dreamer.agent(raw); });
    setTimeout(() => reject(new Error("passes did not start together")), 2000); });
  f.dreamer.script.classify = (pass, ids) => pass === 1
    ? { write: ids.map(id => `K${id} 40`).join("\n") + "\n", edit: ids.map(id => `K${id} 77`).join("\n") + "\n" }
    : ids.map(id => `K${id} 33`).join("\n") + "\n"; // no edit: the default self-check stops again
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const first = classifyInputs(f)[0]!;
  expect(classifyInputs(f)).toHaveLength(2);
  expect(f.dreamer.selfChecks).toHaveLength(2);
  expect(f.dreamer.selfChecks[0]).toContain("Step 2 of 2");
  expect(first.deadline).toBe(classifyInputs(f)[1]!.deadline); // one absolute deadline for all passes
  expect(items.filter(item => scoreOf(f, item.knowledgeId).score === 77)).toHaveLength(100); // pass 1: the Edit's scores
  expect(items.filter(item => scoreOf(f, item.knowledgeId).score === 33)).toHaveLength(5); // pass 2: the step-1 scores
  const run = f.store.getRun(scoreOf(f, items[0]!.knowledgeId).run!)!;
  expect(JSON.parse(run.response!).firstScores).toEqual(items.slice(0, 100).map(item => [item.knowledgeId, 40]));
  expect(JSON.parse(run.response!).stopChecks.map((check: { step: number }) => check.step)).toEqual([1, 2]);
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
});

// 「评分写完文件后加内容自查步骤」
test("2026-10-22, 146 — a file that fails at step 2 gets one repair; a second failure fails the pass, the passes that applied keep their scores and the hand-off stays at classify", async () => {
  const f = dreamerFixture();
  const items = manyItems(f, 105);
  f.dreamer.script.classify = (pass, ids) => pass === 1 ? { write: ids.map(id => `K${id} 40`).join("\n") + "\n", edit: ["## bogus\n", "## bogus\n"] } : undefined;
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "classify", class: "check failed twice" } });
  expect(f.dreamer.messages).toHaveLength(1); // one repair at step 2
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "classify" });
  expect(items.filter(item => scoreOf(f, item.knowledgeId).score === 50)).toHaveLength(5); // pass 2 applied
  expect(items.filter(item => scoreOf(f, item.knowledgeId).score !== null)).toHaveLength(5);
  // The resume freezes the set again: only the 100 unscored items are left, one pass, and it finishes the run.
  f.dreamer.script.classify = undefined; f.dreamer.inputs.length = 0;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(classifyInputs(f).map(input => shown(input.text.slice(input.text.indexOf("Items to score"))))).toEqual([100]);
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
});

test.each([[[0, 1, 2]], [[2, 0, 1]], [[1, 2, 0]]])("2026-10-22, 146: three classify passes that finish in the order %j write `finished` once and advance the rotation once; only the last commit finishes", async order => {
  const f = dreamerFixture();
  manyItems(f, 205); // 205 unscored items: passes of 100, 100 and 5
  const gates = [0, 1, 2].map(() => { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { open, wait }; });
  let started = 0;
  const finishedNow = () => f.store.listRuns(f.session.id).filter(run => JSON.parse(run.response ?? "{}").finished !== undefined).length;
  const seen: number[] = [];
  f.dreamer.script.instead = { classify: async raw => {
    const input = raw as import("../../../src/core/dreaming/index.ts").DreamingAgentInput;
    input.reportRequest({ r: 1 });
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    const pass = Number(/pass (\d+)/.exec(report)![1]) - 1;
    const ids = [...(/Items: (.*)/.exec(report)![1]!).matchAll(/K(\d+)/g)].map(match => match[1]!);
    (await import("node:fs")).writeFileSync(/File: (\S+?\.md)/.exec(report)![1]!, ids.map(id => `K${id} 50`).join("\n") + "\n");
    started++;
    await gates[pass]!.wait;
    input.passEnd(); input.passEnd();
    seen.push(finishedNow());
    return { outcome: "success", output: "Done.", request: { r: 1 }, usage: { tokens: 1 } } as never;
  } };
  const running = f.dream();
  while (started < 3) await new Promise(resolve => setTimeout(resolve, 2));
  for (const pass of order) { gates[pass]!.open(); await new Promise(resolve => setTimeout(resolve, 20)); }
  expect(await running).toMatchObject({ outcome: "success" });
  expect(seen).toEqual([0, 0, 1]); // only the last commit finishes
  expect(finishedNow()).toBe(1);
  expect(f.store.nextCuratePair(f.project.id)).toBe("merge-split");
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
});
