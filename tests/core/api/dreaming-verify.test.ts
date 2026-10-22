// Ticket 144, stage 5 §4: verify before apply in a whole Dreamer run. A scripted model writes curate's batch files and then verify's
// verdict file; the real Store applies nothing until verify passes, then applies the confirmed and edited operations.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeFixture, type DreamerFixture, type DreamerScript } from "../../support/dreamer.ts";
import { updateKnowledge } from "../../support/seed.ts";
import { block } from "../../support/workspace.ts";

const memories: TraceMemory[] = [];
const dirs: string[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const dreamerFixture = (script: DreamerScript = {}, dbPath?: string) => makeFixture(memories, script, dbPath);

const tasks = (f: DreamerFixture) => f.dreamer.inputs.map(input => input.task);
const current = (f: DreamerFixture, knowledgeId: number) => f.store.currentKnowledge(f.path).find(value => value.knowledge.id === knowledgeId)?.revision;
const textOf = (f: DreamerFixture, knowledgeId: number) => current(f, knowledgeId)?.text;
const evidence = (item: { supports: number[] }) => `trace://F${item.supports[0]}`;
const changesOf = (report: string) => readFileSync(/Change file: (\S+)/.exec(report)![1]!, "utf8");
const revisionCount = (f: DreamerFixture) => f.store.listKnowledgeRevisions().length;
const verifyRun = (f: DreamerFixture) => JSON.parse(f.store.listRuns(f.session.id).find(value => JSON.parse(value.response ?? "{}").task === "verify" && JSON.parse(value.response ?? "{}").verdicts)!.response!);
/** An update of `rule` that curate proposes in the constraint batch. */
const proposeUpdate = (f: DreamerFixture, rule: { ref: string }, text: string, fields: Record<string, string> = {}) =>
  f.dreamer.script.curate!.constraint = block(`update ${rule.ref}`, { reason: "tidy", ...fields }, text);

test("verify's first request is curate's byte for byte; nothing curate proposed is applied before verify passes", async () => {
  let changes = "", during = -1, before = -1;
  const f = dreamerFixture({ verify: report => { changes = changesOf(report); during = revisionCount(f); return "## confirm 1\n"; } });
  const rule = f.item("Rule one", { category: "constraint" });
  before = revisionCount(f);
  proposeUpdate(f, rule, "Rule one, tidied");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(tasks(f)).toEqual(["curate", "verify", "classify"]);
  const [curate, verify] = f.dreamer.inputs;
  const sent = (input: typeof curate) => JSON.stringify({ prompt: input!.prompt, text: input!.text, tools: input!.tools.map(tool => [tool.name, tool.description, tool.parameters]) });
  expect(sent(verify)).toBe(sent(curate)); // system prompt, tool list and first user message
  expect(during).toBe(before); // curate's batch kept a proposal, not a revision
  expect(changes).toContain(`## 1 · update K${rule.knowledgeId} · batch constraint`);
  expect(changes).toContain(`current: K${rule.knowledgeId}@v1`);
  expect(changes).toContain("current text:");
  expect(changes).toContain("Rule one, tidied");
  expect(textOf(f, rule.knowledgeId)).toBe("Rule one, tidied"); // applied at verify's pass
  expect(verify!.workspace.read).toHaveLength(2);
  expect(verify!.workspace.write).toEqual([verify!.workspace.read[1]]); // it reads the change file and writes only its own
});

test("a change that touched only supports is listed, and an empty change file means no verify call but still writes coverage", async () => {
  let changes = "";
  const f = dreamerFixture({ verify: report => { changes = changesOf(report); return "## confirm 1\n"; } });
  const rule = f.item("Rule one", { category: "constraint" }), other = f.existingFact("Other support");
  proposeUpdate(f, rule, "Rule one", { reason: "better grounds", supports: `F${other.id}` });
  await f.dream();
  expect(changes).toContain(`supports: F${rule.supports[0]} -> F${other.id}`);
  const g = dreamerFixture();
  const two = g.item("Rule two", { category: "constraint" });
  await g.dream();
  expect(tasks(g)).toEqual(["curate", "classify"]); // curate proposed nothing: verify passes through a no-work run
  expect(g.store.handoff(g.session.id, "dreaming")).toBeNull();
  expect(g.store.db.prepare("SELECT revision_id FROM knowledge_processed").all().map(row => row.revision_id)).toEqual([two.commit]); // coverage is written by that no-work verify
});

test("verify edits a wrong attribution curate proposed, with evidence, and the edit is a Dreamer version", async () => {
  const f = dreamerFixture();
  const rule = f.item("The user required pnpm", { category: "constraint" });
  proposeUpdate(f, rule, "The agent required pnpm.");
  f.dreamer.script.verify = block("edit 1 update " + rule.ref, { evidence: evidence(rule) }, "The user required pnpm.");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(textOf(f, rule.knowledgeId)).toBe("The user required pnpm.");
  expect(current(f, rule.knowledgeId)!.actorRole).toBe("dreaming");
  expect(verifyRun(f).verdicts).toMatchObject([{ n: 1, verdict: "edit", evidence: [evidence(rule)], result: { ok: true } }]);
});

test("a revert drops the proposal: the item is untouched, and the run still completes", async () => {
  const f = dreamerFixture();
  const rule = f.item("The user required pnpm", { category: "constraint" });
  proposeUpdate(f, rule, "The agent required pnpm.");
  f.dreamer.script.verify = block("revert 1", { evidence: evidence(rule), reason: "the facts attribute it to the user" });
  const before = revisionCount(f);
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(textOf(f, rule.knowledgeId)).toBe("The user required pnpm");
  expect(revisionCount(f)).toBe(before);
});

test("a write after curate: the change shows its base as stale, and confirming it is refused at apply and left for the next run", async () => {
  let changes = "";
  const f = dreamerFixture({ verify: report => { changes = changesOf(report); return "## confirm 1\n"; } });
  const rule = f.item("Rule one", { category: "constraint" });
  f.item("A reference note", { category: "reference" });
  proposeUpdate(f, rule, "Rule one, tidied");
  // A manual write lands between curate's batches, before verify starts.
  f.dreamer.script.curate!.reference = () => { updateKnowledge(f.store, f.path, rule.knowledgeId, current(f, rule.knowledgeId)!.id, "Rule one, by hand", rule.supports); return "## none\n"; };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(changes).toContain(`current: K${rule.knowledgeId}@v2`);
  expect(changes).toContain(`curate proposed from K${rule.knowledgeId}@v1; this change will be refused at apply`);
  expect(changes).toMatch(/proposal base K\d+@v1 text:\n[^\n]*\nRule one\n\ncurrent K\d+@v2 text:\n[^\n]*\nRule one, by hand\n/);
  expect(textOf(f, rule.knowledgeId)).toBe("Rule one, by hand");
  expect(verifyRun(f).verdicts[0].result).toMatchObject({ ok: false, stale: true });
});

test("a reverted merge leaves every item untouched; an edited merge applies the edited body and archives the absorbed item", async () => {
  for (const how of ["revert", "edit"] as const) {
    const f = dreamerFixture();
    await f.cycleTo("merge-split");
    const primary = f.item("Pi agent ran the suite on Linux; Windows unverified", { category: "constraint", title: "Suite run" });
    const absorbed = f.item("Pi agent ran the suite on Linux", { category: "constraint", title: "Suite run on Linux" });
    f.dreamer.script.curate!.constraint = block(`merge ${primary.ref}`, { absorb: absorbed.ref, reason: "same run" }, "Pi agent ran the suite on Linux.");
    f.dreamer.script.verify = how === "edit"
      ? block(`edit 1 merge ${primary.ref}`, { evidence: evidence(primary) }, "Pi agent ran the suite on Linux; Windows unverified.")
      : block("revert 1", { evidence: evidence(primary), reason: "nothing of the merge holds" });
    const before = revisionCount(f);
    expect(await f.dream()).toMatchObject({ outcome: "success" });
    if (how === "revert") {
      expect(revisionCount(f)).toBe(before); // no merge revision was ever written
      expect(textOf(f, absorbed.knowledgeId)).toBe("Pi agent ran the suite on Linux");
      expect(textOf(f, primary.knowledgeId)).toContain("Windows unverified");
    } else {
      expect(textOf(f, primary.knowledgeId)).toBe("Pi agent ran the suite on Linux; Windows unverified.");
      expect(textOf(f, absorbed.knowledgeId)).toBeUndefined();
    }
  }
});

test("a verify file that fails twice applies nothing and keeps curate's proposals; the next run resumes at verify with the change file rebuilt and applies after the pass", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule one", { category: "constraint" });
  proposeUpdate(f, rule, "Rule one, tidied");
  f.dreamer.script.verify = ["## bogus\n", "## bogus\n"];
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "verify", class: "check failed twice" } });
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "verify", detail: { pair: "update-archive", groups: [{ batches: [{ category: "constraint", run: expect.any(Number) }] }] } });
  expect(textOf(f, rule.knowledgeId)).toBe("Rule one"); // nothing was applied
  let changes = "";
  f.dreamer.script.verify = report => { changes = changesOf(report); return "## confirm 1\n"; };
  f.item("A later Noter item", { category: "reference" });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(tasks(f).filter(task => task === "curate")).toHaveLength(1); // curate did not run again
  expect(changes).toContain("Rule one, tidied");
  expect(textOf(f, rule.knowledgeId)).toBe("Rule one, tidied");
});

test("curate and verify have the roots of the project's sessions' directories; classify has none", async () => {
  const f = dreamerFixture();
  const dir = mkdtempSync(join(tmpdir(), "tm-144-roots-")); dirs.push(dir);
  f.store.db.prepare("UPDATE sessions SET directory = ? WHERE id = ?").run(dir, f.session.id);
  const rule = f.item("Rule one", { category: "constraint" });
  proposeUpdate(f, rule, "Rule one, tidied");
  await f.dream();
  const roots = Object.fromEntries(f.dreamer.inputs.map(input => [input.task, input.workspace.roots]));
  expect(roots).toEqual({ curate: [realpathSync(dir)], verify: [realpathSync(dir)], classify: [] });
});

// ---- The verdict file's contract: one verdict for every change, an edit that matches its change --------------------------------

/** One update proposal, then the verify script's attempts; returns the repair message the first bad file got and the outcome. */
async function verifying(files: string[], setup?: (f: DreamerFixture, rule: ReturnType<DreamerFixture["item"]>) => void) {
  const f = dreamerFixture();
  const rule = f.item("The user required pnpm", { category: "constraint", title: "pnpm rule" });
  proposeUpdate(f, rule, "The agent required pnpm.", { title: "Package rule", topics: "tooling" });
  setup?.(f, rule);
  f.dreamer.script.verify = files.map(file => file.replaceAll("RULE", rule.ref).replaceAll("EVIDENCE", evidence(rule)));
  const result = await f.dream();
  return { f, rule, result, repair: f.dreamer.messages[0] ?? "" };
}

test("a verdict file is refused unless every change has exactly one verdict", async () => {
  expect((await verifying(["## confirm 1\n\n## confirm 1\n", "## confirm 1\n"])).repair).toContain("change 1 already has a verdict");
  expect((await verifying(["## confirm 2\n", "## confirm 1\n"])).repair).toContain("there is no change 2");
  expect((await verifying(["## confirm 1\n\n## revert 1\nevidence: EVIDENCE\nreason: r\n", "## confirm 1\n"])).repair).toContain("change 1 already has a verdict");
  const none = await verifying(["## none\n", "## confirm 1\n"]);
  expect(none.repair).toContain("is not a verdict");
  expect(none.result).toMatchObject({ outcome: "success" });
  const empty = await verifying([block("confirm 1", { reason: "x" }) + "\n## frobnicate 2\n", "## confirm 1\n"]);
  expect(empty.repair).toContain("is not a verdict");
});

test("an edit cannot change the operation's kind, name another item, or lack evidence, and a revert needs evidence and a reason", async () => {
  expect((await verifying([block("edit 1 merge RULE", { evidence: "EVIDENCE" }, "Text."), "## confirm 1\n"])).repair).toContain("cannot change an operation's kind");
  expect((await verifying([block("edit 1 update K999@v1", { evidence: "EVIDENCE" }, "Text."), "## confirm 1\n"])).repair).toContain("names K999@v1");
  expect((await verifying([block("edit 1 update RULE", {}, "Text."), "## confirm 1\n"])).repair).toContain("missing required field `evidence`");
  expect((await verifying([block("revert 1", { evidence: "EVIDENCE" }), "## confirm 1\n"])).repair).toContain("missing required field `reason`");
  expect((await verifying([block("edit 1 update RULE", { evidence: "trace://F99999" }, "Text."), "## confirm 1\n"])).repair).toContain("no such fact");
});

test("an edit that omits a field keeps the proposal's value, not the base's; one that names it overrides it", async () => {
  // curate proposed a new title and topics; the edit corrects only the body (decision 6, review 3).
  const body = await verifying([block("edit 1 update RULE", { evidence: "EVIDENCE" }, "The user required pnpm.")]);
  const kept = current(body.f, body.rule.knowledgeId)!;
  expect(body.result).toMatchObject({ outcome: "success" });
  expect(kept.title).toBe("Package rule");
  expect(kept.topics).toEqual(["tooling"]);
  expect(kept.text).toBe("The user required pnpm.");
  const named = await verifying([block("edit 1 update RULE", { evidence: "EVIDENCE", title: "Pnpm rule", topics: "" }, "The user required pnpm.")]);
  const overridden = current(named.f, named.rule.knowledgeId)!;
  expect(overridden.title).toBe("Pnpm rule");
  expect(overridden.topics).toEqual([]); // named with an empty value: that is a value
  expect(overridden.category).toBe("constraint"); // not named: the proposal's
  // A curate block that omits the same fields still inherits them from the base.
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint", title: "Base title" });
  proposeUpdate(f, rule, "Rule, tidied");
  await f.dream();
  expect(current(f, rule.knowledgeId)!.title).toBe("Base title");
});

test("an edit of a split changes a child's body, title and supports but not the number of children", async () => {
  const child = (rule: { supports: number[] }, title: string, text: string) =>
    `\n### child\ntitle: ${title}\ncategory: constraint\nscope: project\ntopics: \nsupports: F${rule.supports[0]}\nreason: split\n\n${text}\n`;
  const f = dreamerFixture();
  await f.cycleTo("merge-split");
  const rule = f.item("Package rule and release process", { category: "constraint", title: "Rules" });
  const other = f.existingFact("Other support");
  f.dreamer.script.curate!.constraint = block(`split ${rule.ref}`, { reason: "two topics" }, "Package rule.") + child(rule, "Release process", "Releases are cut from main.");
  // A child added changes the number of children: refused, then the edit that keeps one child applies.
  f.dreamer.script.verify = [block(`edit 1 split ${rule.ref}`, { evidence: evidence(rule) }, "Package rule.") + child(rule, "A", "a") + child(rule, "B", "b"),
    block(`edit 1 split ${rule.ref}`, { evidence: evidence(rule), title: "Package rule" }, "Package rule, corrected.")
      + `\n### child\ntitle: Release steps\nsupports: F${other.id}\n\nReleases are cut from main after the full run.\n`];
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.messages[0]).toContain("keeps the proposal's 1 children; it has 2");
  const values = f.store.currentKnowledge(f.path).map(value => value.revision);
  expect(values.find(revision => revision.knowledgeId === rule.knowledgeId)).toMatchObject({ title: "Package rule", text: "Package rule, corrected." });
  expect(values.find(revision => revision.title === "Release steps")).toMatchObject({ text: "Releases are cut from main after the full run.", supports: [other.id], category: "constraint" }); // the child's omitted category is the proposal's
});

test("an edit of a merge may not change which items it absorbs or its category; an archive takes only confirm or revert", async () => {
  const f = dreamerFixture();
  await f.cycleTo("merge-split");
  const primary = f.item("Suite ran on Linux; Windows unverified", { category: "constraint", title: "Suite run" });
  const absorbed = f.item("Suite ran on Linux", { category: "constraint", title: "Suite run on Linux" });
  const third = f.item("Suite ran in CI", { category: "constraint", title: "Suite in CI" });
  f.dreamer.script.curate!.constraint = block(`merge ${primary.ref}`, { absorb: absorbed.ref, reason: "same run" }, "Suite ran on Linux.");
  f.dreamer.script.verify = [block(`edit 1 merge ${primary.ref}`, { evidence: evidence(primary), absorb: `${absorbed.ref}, ${third.ref}` }, "Suite ran."), "## confirm 1\n"];
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.messages[0]).toContain("cannot change which items the merge absorbs");
  const h = dreamerFixture();
  await h.cycleTo("merge-split");
  const first = h.item("Suite ran on Linux; Windows unverified", { category: "constraint", title: "Suite run" });
  const second = h.item("Suite ran on Linux", { category: "constraint", title: "Suite run on Linux" });
  h.dreamer.script.curate!.constraint = block(`merge ${first.ref}`, { absorb: second.ref, reason: "same run" }, "Suite ran on Linux.");
  h.dreamer.script.verify = [block(`edit 1 merge ${first.ref}`, { evidence: evidence(first), category: "reference" }, "Suite ran."), "## confirm 1\n"];
  expect(await h.dream()).toMatchObject({ outcome: "success" });
  expect(h.dreamer.messages[0]).toContain("merged items share one category"); // refused by the merge rule, which the message names
  const g = dreamerFixture();
  await g.cycleTo("update-archive");
  const old = g.item("Running log of the release", { category: "reference", title: "Log" });
  g.dreamer.script.curate!.reference = block(`archive ${old.ref}`, { kind: "inadmissible", reason: "running log" }, "Only records who did what; nothing lasting remains in it.");
  g.dreamer.script.verify = [block(`edit 1 archive ${old.ref}`, { evidence: evidence(old) }, "A different statement of the grounds."), "## confirm 1\n"];
  expect(await g.dream()).toMatchObject({ outcome: "success" });
  expect(g.dreamer.messages.find(message => message.includes("does not pass the check"))).toContain("an archive takes only confirm or revert");
  expect(textOf(g, old.knowledgeId)).toBeUndefined(); // confirmed: archived at verify's pass
});

test("one verdict per change number: two changes on one item pass the check, and the earlier, on a replaced version, is refused as stale at apply", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule one", { category: "constraint" });
  f.item("A reference note", { category: "reference" }); // gives the run a reference batch
  f.dreamer.script.curate!.constraint = block(`update ${rule.ref}`, { reason: "tidy" }, "Rule one, tidied");
  // Between the batches a Noter write moves the item to `reference` as v2; the reference batch proposes against v2.
  f.dreamer.script.curate!.reference = () => {
    updateKnowledge(f.store, f.path, rule.knowledgeId, current(f, rule.knowledgeId)!.id, "Rule one, moved", rule.supports, "reference");
    return block(`update K${rule.knowledgeId}@v2`, { reason: "tidy again" }, "Rule one, moved and tidied");
  };
  f.dreamer.script.verify = "## confirm 1\n\n## confirm 2\n";
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(verifyRun(f).verdicts).toMatchObject([{ n: 1, result: { ok: false, stale: true } }, { n: 2, result: { ok: true } }]);
  expect(textOf(f, rule.knowledgeId)).toBe("Rule one, moved and tidied");
});

test("the caps in force at apply: a confirmed proposal over the lowered cap is refused with its counts, nothing is rebased, and an edit back under the cap applies", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule one", { category: "constraint" });
  proposeUpdate(f, rule, "Rule one has a rather long tidied wording that is over the lowered cap");
  f.dreamer.script.verify = ["## bogus\n", "## bogus\n"];
  expect(await f.dream()).toMatchObject({ outcome: "failure" });
  f.memory.config.writing.bodyWords = 5; // the caps are lowered while verify is waiting to be resumed
  f.dreamer.script.verify = "## confirm 1\n";
  f.item("A later Noter item", { category: "reference" });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(textOf(f, rule.knowledgeId)).toBe("Rule one"); // refused, left for the next run
  expect(verifyRun(f).verdicts[0].result).toMatchObject({ ok: false, reason: expect.stringContaining("over the limit of 6 (target 5)") });
});

test("a seeded misattribution in a proposed update is edited and a proposed archive of a valid ruling is reverted", async () => {
  const f = dreamerFixture();
  await f.cycleTo("update-archive");
  const ruling = f.item("The user ruled that logs never change their prefix", { category: "constraint", title: "Log prefix rule" });
  f.dreamer.script.curate!.constraint = block(`archive ${ruling.ref}`, { kind: "invalid", reason: "implemented" }, "Implemented, so it no longer applies as a rule; see the specification.");
  f.dreamer.script.verify = block("revert 1", { evidence: evidence(ruling), reason: "the ruling still constrains behavior" });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(textOf(f, ruling.knowledgeId)).toBe("The user ruled that logs never change their prefix");
});
