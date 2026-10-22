// Ticket 146: groups of at most 100 items that curate and verify side by side, batches of 20 that the agent paces, and the failure,
// resume and coverage rules across groups. A scripted model (tests/support/dreamer.ts) writes the files a host's model would.
import { afterEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import type { DreamingAgentInput, RunAgentResult } from "../../../src/core/api/index.ts";
import { sourceSeededMemory, type TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture, listedBatches, noterWrittenItem, type DreamerFixture, type DreamerScript } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { REQUEST } from "../../support/noter.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
const dreamerFixture = (script: DreamerScript = {}) => makeDreamerFixture(memories, script);

const items = (f: DreamerFixture, category: "constraint" | "reference" | "open" | "goal" | "understanding", n: number) =>
  Array.from({ length: n }, (_, i) => f.item(`${category} rule ${i}`, { category, title: `${category} ${i}` }));
const ref = (f: DreamerFixture, item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@v${f.store.versionOrdinal(item.knowledgeId, item.commit)}`;
const update = (item: { ref: string }, text = "tidied") => block(`update ${item.ref}`, { reason: "tidy" }, text);
const covered = (f: DreamerFixture) => f.store.db.prepare("SELECT revision_id FROM knowledge_processed ORDER BY revision_id").all().map(row => Number(row.revision_id));
const count = (f: DreamerFixture) => Number(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")?.count ?? 0);
const execution = (f: DreamerFixture) => f.store.db.prepare("SELECT outcome, reason FROM task_executions ORDER BY rowid").all() as { outcome: string | null; reason: string | null }[];
const keptRuns = (f: DreamerFixture) => f.store.listRuns(f.session.id).filter(run => JSON.parse(run.response ?? "{}").proposed !== undefined);
const groupsOf = (f: DreamerFixture) => f.store.handoff(f.session.id, "dreaming")!.detail!.groups!;
/** A runner that waits until `n` calls are in flight together, then runs the scripted conversation: calls that arrive one at a time fail it. */
function barrier(f: DreamerFixture, n: number) {
  let arrived = 0;
  const all = new Promise<void>((resolve, reject) => {
    const open = () => { if (++arrived === n) resolve(); };
    (barrier as unknown as { open: () => void }).open = open;
    setTimeout(() => reject(new Error(`only ${arrived} of ${n} calls were in flight together`)), 2000);
  });
  const open = (barrier as unknown as { open: () => void }).open;
  for (let i = 0; i < n; i++) f.next(async raw => { open(); await all; return f.dreamer.agent(raw); });
}

test("2026-10-22, 146: 「相同的知识类型尽量分在一起」 — 230 items (90/80/60) are three groups run side by side; each item is shown whole in exactly one group's first message and its verify's equals its curate's", async () => {
  const f = dreamerFixture();
  const constraint = items(f, "constraint", 90), reference = items(f, "reference", 80), open = items(f, "open", 60);
  for (const set of [constraint, reference, open]) f.dreamer.script.curate![set === constraint ? "constraint" : set === reference ? "reference" : "open"] = update(set[0]!);
  barrier(f, 3);
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const curates = f.dreamer.inputs.filter(input => input.task === "curate"), verifies = f.dreamer.inputs.filter(input => input.task === "verify");
  expect(curates).toHaveLength(3);
  expect(verifies.map(input => input.text).sort()).toEqual(curates.map(input => input.text).sort());
  for (const item of [...constraint, ...reference, ...open])
    expect(curates.filter(input => input.text.includes(`${item.ref} (`) || input.text.includes(`${item.ref}\n`) || input.text.includes(`${item.ref}]`)).length, item.ref).toBe(1);
  const categories = curates.map(input => ["constraint", "reference", "open"].filter(category => input.text.includes(`## ${category} (`)));
  expect(categories.every(list => list.length === 1)).toBe(true); // no category is split and none is mixed here
  expect(f.dreamer.reports.filter(report => report.startsWith("Task: curate")).map(report => /group (\d) of 3/.exec(report)![1]).sort()).toEqual(["1", "2", "3"]);
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
}, 60_000);

test("2026-10-22, 146: 「以20条为一批，且不代表只能处理这20条，例如合并一定要看其他知识」 — the first check lists batches of 20, 20 and 5; a merge in batch 1 absorbs a same-category item of batch 3, a merge that absorbs another category's item is refused", async () => {
  const f = dreamerFixture();
  const rules = items(f, "constraint", 45);
  const reference = f.item("A reference item", { category: "reference", title: "Reference" });
  await f.cycleTo("merge");
  f.dreamer.inputs.length = 0; f.dreamer.reports.length = 0;
  const merge = (absorb: { ref: string }) => block(`merge ${rules[0]!.ref}`, { absorb: absorb.ref, reason: "repeats" }, "Merged constraint rule");
  f.dreamer.script.curate!.constraint = merge(rules[42]!); // batch 1 absorbs an item of batch 3
  f.item("Noter trigger", { category: "reference" });
  noterWrittenItem(f.memory, f.path as never, f.existingFact("Trigger").id);
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const listing = listedBatches(f.dreamer.reports[0]!);
  expect(listing.map(batch => [batch.no, batch.of, batch.category])).toEqual([[1, 4, "constraint"], [2, 4, "constraint"], [3, 4, "constraint"], [4, 4, "reference"]]);
  const live = f.store.currentKnowledge(f.path).map(value => value.knowledge.id);
  expect(live).toContain(rules[0]!.knowledgeId);
  expect(live).not.toContain(rules[42]!.knowledgeId); // absorbed after verify passed
}, 60_000);

test("2026-10-22, 146: 「合并还需要同类别」 — a merge that absorbs another category's item is refused by the merge rule", async () => {
  const f = dreamerFixture();
  const [rule] = items(f, "constraint", 2);
  const reference = f.item("A reference item", { category: "reference", title: "Reference" });
  await f.cycleTo("merge");
  const merge = block(`merge ${rule!.ref}`, { absorb: reference.ref, reason: "repeats" }, "Merged");
  f.dreamer.script.curate!.constraint = [merge, merge];
  noterWrittenItem(f.memory, f.path as never, f.existingFact("Trigger 2").id);
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { class: "check failed twice" } });
});

// ---- ruling 12: the agent paces its batches --------------------------------------------------------------------------------

/** One group of three batches of one category (45 items): the file of batch b proposes an update of its first item. */
function threeBatches() {
  const f = dreamerFixture();
  const rules = items(f, "constraint", 45);
  const firsts = [rules[0]!, rules[20]!, rules[40]!];
  const files = firsts.map((rule, i) => update(rule, `batch ${i + 1} text`));
  return { f, rules, firsts, files };
}
const textOf = (f: DreamerFixture, knowledgeId: number) => f.store.currentCommit(knowledgeId, f.path)[0]!.text;

test("2026-10-22, 146: 「让agent自己分批处理，每批交付一个文件」 (a) — the agent writes three files in order and stops once; one final check covers all three, `check` reports on every file, no next-batch message exists, and the three files are kept", async () => {
  const { f, firsts, files } = threeBatches();
  const reports: string[] = [];
  const messages: (string | undefined)[] = [];
  f.dreamer.script.instead = { curate: async raw => {
    const input = raw as DreamingAgentInput;
    input.reportRequest(REQUEST);
    const check = async () => String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    reports.push(await check());
    const batches = listedBatches(reports[0]!);
    for (const [i, batch] of batches.entries()) { writeFileSync(batch.file, files[i]!); reports.push(await check()); }
    messages.push(input.passEnd());
    return { outcome: "success", output: "Done.", request: REQUEST } as RunAgentResult;
  } };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(reports[0]!.match(/not written/g)).toHaveLength(3); // check reports on every file, written or not
  expect(reports[1]!.match(/not written/g)).toHaveLength(2);
  expect(reports[3]).not.toContain("not written");
  expect(messages).toEqual([undefined]); // one stop, no repair, no next-batch message
  const runs = keptRuns(f);
  expect(runs).toHaveLength(3); // three kept files, each with its covers
  expect(runs.map(run => JSON.parse(run.response!).batch)).toEqual([1, 2, 3]);
  expect(JSON.parse(runs.at(-1)!.response!).stopChecks).toEqual([{ ok: true, problems: [], files: expect.arrayContaining([expect.stringMatching(/curate-3-constraint\.md$/)]) }]);
  expect(JSON.parse(runs.at(-1)!.response!).stopChecks[0].files).toHaveLength(3);
  expect(JSON.stringify(f.dreamer.messages)).not.toContain("Next: batch");
  for (const [i, first] of firsts.entries()) expect(textOf(f, first.knowledgeId)).toBe(`batch ${i + 1} text`); // applied after verify passed
});

test("2026-10-22, 146: 「让agent自己分批处理，每批交付一个文件」 (b) — one repair message lists the failing file only; if it still fails the task fails naming batch 2 and files 1 and 3 are kept", async () => {
  const fixed = threeBatches();
  fixed.f.dreamer.script.curate = { batch1: fixed.files[0]!, batch2: ["## bogus\n", fixed.files[1]!], batch3: fixed.files[2]! };
  expect(await fixed.f.dream()).toMatchObject({ outcome: "success" });
  expect(fixed.f.dreamer.messages).toHaveLength(1);
  expect(fixed.f.dreamer.messages[0]).toContain("batch 2 of 3");
  expect(fixed.f.dreamer.messages[0]).not.toContain("batch 1 of 3");
  expect(fixed.f.dreamer.messages[0]).not.toContain("batch 3 of 3");
  expect(keptRuns(fixed.f)).toHaveLength(3);

  const broken = threeBatches();
  broken.f.dreamer.script.curate = { batch1: broken.files[0]!, batch2: ["## bogus\n"], batch3: broken.files[2]! };
  const result = await broken.f.dream();
  expect(result).toMatchObject({ outcome: "failure", failure: { task: "curate", class: "check failed twice" } });
  expect(result.outcome === "failure" && result.problems.join(" ")).toContain("2/3");
  expect(broken.f.dreamer.messages).toHaveLength(1);
  const batches = groupsOf(broken.f)[0]!.batches;
  expect(batches.map(batch => batch.run !== undefined)).toEqual([true, false, true]); // kept batches need not be a prefix
});

test("2026-10-22, 146: 「失败时前面的产出保留」 (c, d) — files that passed are kept when the task fails or times out; the next check does only the remaining batch, verify sees all three in batch order, and the run finishes once", async () => {
  for (const ending of ["failure", "timeout"] as const) {
    const { f, firsts, files } = threeBatches();
    f.memory.config.dreaming.timeoutMs = 200;
    f.next(async raw => {
      const input = raw as DreamingAgentInput;
      input.reportRequest(REQUEST);
      const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
      const batches = listedBatches(report);
      writeFileSync(batches[0]!.file, files[0]!); writeFileSync(batches[1]!.file, files[1]!); // batch 3 is never written
      if (ending === "timeout") return new Promise<RunAgentResult>(() => {});
      return { outcome: "failure", output: "provider error", request: REQUEST } as RunAgentResult;
    });
    expect(await f.dream(), ending).toMatchObject({ outcome: "failure", failure: { task: "curate" } });
    expect(keptRuns(f), ending).toHaveLength(2);
    expect(groupsOf(f)[0]!.batches.map(batch => batch.run !== undefined), ending).toEqual([true, true, false]);
    expect(textOf(f, firsts[0]!.knowledgeId)).toBe(firsts[0]!.ref ? "constraint rule 0" : ""); // nothing is applied
    expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "curate" });
    // The next check, with no new Noter operation, does batch 3 only.
    f.dreamer.inputs.length = 0; f.dreamer.reports.length = 0;
    f.dreamer.script.curate = { batch3: files[2]! };
    const changes: string[] = [];
    f.dreamer.script.verify = report => { const path = /Change file: (\S+?\.md)/.exec(report)![1]!; changes.push(String(require("node:fs").readFileSync(path, "utf8"))); return "## confirm 1\n## confirm 2\n## confirm 3\n"; };
    expect(await f.dream(), ending).toMatchObject({ outcome: "success" });
    const listing = listedBatches(f.dreamer.reports[0]!);
    expect(listing.map(batch => batch.no)).toEqual([3]); // only `batch 3 of 3`
    expect(f.dreamer.reports[0]).toContain("batch 3 of 3");
    expect(f.dreamer.reports[0]).not.toContain("batch 1 of 3");
    const order = ["batch 1 text", "batch 2 text", "batch 3 text"].map(text => changes[0]!.indexOf(text));
    expect(order.every(at => at >= 0) && [...order].sort((a, b) => a - b).join() === order.join()).toBe(true);
    expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
    expect(execution(f).map(row => row.outcome)).toEqual(["failure", "success"]);
  }
});

test("2026-10-22, 146: 「失败时前面的产出保留」 — a deadline after all three files pass keeps all three, and the resume starts at verify; a cancellation keeps nothing", async () => {
  const { f, files } = threeBatches();
  f.memory.config.dreaming.timeoutMs = 200;
  f.next(async raw => {
    const input = raw as DreamingAgentInput;
    input.reportRequest(REQUEST);
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    listedBatches(report).forEach((batch, i) => writeFileSync(batch.file, files[i]!));
    return new Promise<RunAgentResult>(() => {});
  });
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { class: "timeout" } });
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "verify" });
  expect(groupsOf(f)[0]!.batches.every(batch => batch.run !== undefined)).toBe(true);
  f.dreamer.inputs.length = 0;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs.map(input => input.task)).toEqual(["verify", "classify"]); // curate did not run again
});

test("2026-10-22, 146: 「让agent自己分批处理，每批交付一个文件」 (e) — an earlier file revised after a later one passed is accepted with no repair, and the kept run holds the revised text; order is not enforced", async () => {
  const { f, rules, files } = threeBatches();
  const messages: (string | undefined)[] = [];
  f.next(async raw => {
    const input = raw as DreamingAgentInput;
    input.reportRequest(REQUEST);
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    const batches = listedBatches(report);
    writeFileSync(batches[2]!.file, files[2]!); writeFileSync(batches[1]!.file, files[1]!); writeFileSync(batches[0]!.file, files[0]!); // out of order
    writeFileSync(batches[0]!.file, update(rules[1]!, "batch 1 revised")); // an earlier file revised after the later ones passed
    messages.push(input.passEnd());
    return { outcome: "success", output: "Done.", request: REQUEST } as RunAgentResult;
  });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(messages).toEqual([undefined]);
  expect(JSON.parse(keptRuns(f)[0]!.response!).text).toContain("batch 1 revised");
  expect(textOf(f, rules[1]!.knowledgeId)).toBe("batch 1 revised");
});

test("2026-10-22, 146: 「让agent自己分批处理，每批交付一个文件」 (f) — a file never written fails the final check as `not written` and is not read as `## none`", async () => {
  const { f, files } = threeBatches();
  const messages: (string | undefined)[] = [];
  f.next(async raw => {
    const input = raw as DreamingAgentInput;
    input.reportRequest(REQUEST);
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    const batches = listedBatches(report);
    writeFileSync(batches[0]!.file, files[0]!); writeFileSync(batches[2]!.file, files[2]!);
    messages.push(input.passEnd(), input.passEnd());
    return { outcome: "success", output: "Done.", request: REQUEST } as RunAgentResult;
  });
  const result = await f.dream();
  expect(messages[0]).toContain("not written");
  expect(messages[0]).toContain("batch 2 of 3");
  expect(messages[1]).toBeUndefined();
  expect(result).toMatchObject({ outcome: "failure", failure: { class: "check failed twice" } });
  expect(groupsOf(f)[0]!.batches.map(batch => batch.run !== undefined)).toEqual([true, false, true]);
});

// ---- failure, resume and coverage across groups ---------------------------------------------------------------------------

/** Sessions A and B of one project, 60 + 50 Noter-written items in two groups (constraint, reference). */
function twoGroups() {
  const f = dreamerFixture();
  const second = f.store.createSession({ projectId: f.project.id, host: "pi:second", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = f.store.appendTurn({ sessionId: second.id, kind: "turn", userPrompt: "Second session", assistantText: "ok", startedAt: "now" });
  const pathB = { sessionId: second.id, branch: "main", headTurnId: turn.id };
  const fact = f.existingFact("Support");
  const make = (category: "constraint" | "reference", n: number) => Array.from({ length: n }, (_, i) =>
    noterWrittenItem(f.memory, f.path as never, f.existingFact(`Support ${category} ${i}`).id, "project", category));
  const constraint = make("constraint", 60), reference = make("reference", 50);
  void fact;
  return { f, pathB, constraint, reference };
}

test("2026-10-22, 146: 「知识可能处理失败」 (processed means verified) — a group whose curate fails keeps counting in the other session; the group that passed counts 0; after the resume everything counts 0", async () => {
  const { f, pathB, constraint, reference } = twoGroups();
  expect(f.store.noterOperations(pathB)).toBe(110);
  f.dreamer.script.curate = { reference: ["## bogus\n", "## bogus\n"] }; // group 2 fails its first batch twice
  const result = await f.dream();
  expect(result).toMatchObject({ outcome: "failure", failure: { groups: [{ group: 2, task: "curate", class: "check failed twice" }] } });
  // Group 1's 60 constraint items are covered (its verify passed); group 2's items are not.
  expect(f.store.noterOperations(pathB)).toBe(50);
  expect(f.store.noterOperations(f.path)).toBe(50);
  expect(covered(f)).toEqual(expect.arrayContaining(constraint.map(item => item.commit)));
  expect(covered(f).some(id => reference.some(item => item.commit === id))).toBe(false);
  expect(count(f)).toBe(1);
  f.dreamer.script.curate = {};
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.noterOperations(pathB)).toBe(0);
  expect(count(f)).toBe(0);
});

test("2026-10-22, 146: 「重试等下一个检查点」 across groups — group 2's final check fails twice on batch 1 only; groups pass and fail independently, classify does not run, the next check redoes only group 2's batch 1, then its verify, then classify, and the run finishes once", async () => {
  const { f, constraint } = twoGroups();
  f.dreamer.script.curate = { constraint: update({ ref: ref(f, constraint[0]!) }, "group 1 tidied"), reference: ["## bogus\n"] };
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "curate", groups: [{ group: 2, task: "curate", class: "check failed twice" }] } });
  expect(f.dreamer.inputs.map(input => input.task)).not.toContain("classify");
  const groups = groupsOf(f);
  expect(groups[0]!.verifyRun).toEqual(expect.any(Number));
  expect(groups[1]!.verifyRun).toBeUndefined();
  expect(groups[1]!.batches.map(batch => batch.run !== undefined)).toEqual([false, true, true]);
  expect(count(f)).toBe(1);
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "curate" });
  f.dreamer.inputs.length = 0; f.dreamer.reports.length = 0;
  f.dreamer.script.curate = {};
  expect(await f.dream()).toMatchObject({ outcome: "success" }); // due by the hand-off alone
  const tasks = f.dreamer.inputs.map(input => input.task);
  expect(tasks.filter(task => task === "curate")).toHaveLength(1);
  expect(listedBatches(f.dreamer.reports[0]!).map(batch => batch.no)).toEqual([1]);
  expect(tasks.at(-1)).toBe("classify");
  expect(count(f)).toBe(0);
  const finished = f.store.listRuns(f.session.id).filter(run => JSON.parse(run.response ?? "{}").finished);
  expect(finished).toHaveLength(1);
});

test("2026-10-22, 146: 「连续失败自动关闭trace」 — two groups fail in one run: the reason names both, the streak grows by one; a lost claim joins the reason", async () => {
  const { f } = twoGroups();
  f.dreamer.script.curate = { constraint: ["## bogus\n"], reference: ["## bogus\n"] };
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { groups: [{ group: 1 }, { group: 2 }] } });
  expect(execution(f)).toEqual([{ outcome: "failure", reason: "curate g1: check failed twice; curate g2: check failed twice" }]);
  expect(count(f)).toBe(1);
});

test("deadline isolation (146 §3.3): one group's call passes its deadline while its runner ignores abort; the other group's workspace stays open, its files are kept and its verify applies", async () => {
  const { f, constraint } = twoGroups();
  f.memory.config.dreaming.timeoutMs = 300;
  f.dreamer.script.curate = { constraint: update({ ref: ref(f, constraint[0]!) }, "group 1 tidied") };
  f.next(() => new Promise<RunAgentResult>(() => {})); // the first call to arrive (group 1's curate) never answers and ignores abort
  const result = await f.memory.dream({ ...f.target });
  void result;
  const tasks = f.dreamer.inputs.map(input => input.task);
  expect(tasks).toContain("curate"); // group 2 ran its conversation to the end
  expect(execution(f)[0]).toMatchObject({ outcome: "failure" });
  expect(execution(f)[0]!.reason).toMatch(/curate g\d: timeout/);
  const kept = groupsOf(f);
  expect(kept.some(group => group.verifyRun !== undefined)).toBe(true); // the other group went on to verify and applied
}, 30_000);
