// Ticket 144, stage 4 §5: the verify task in a whole Dreamer run. A scripted model writes curate's batch files and then verify's
// file; the real Store applies both.
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
const textOf = (f: DreamerFixture, knowledgeId: number) => f.store.currentKnowledge(f.path).find(value => value.knowledge.id === knowledgeId)?.revision.text;
const evidence = (item: { supports: number[] }) => `trace://F${item.supports[0]}`;

test("verify's first request is curate's byte for byte, and it reads the change file curate's applied blocks produced", async () => {
  let changes = "";
  const f = dreamerFixture({ verify: report => { changes = readFileSync(/Change file: (\S+)/.exec(report)![1]!, "utf8"); return "## none\n"; } });
  const rule = f.item("Rule one", { category: "constraint" });
  f.dreamer.script.curate!.constraint = block(`update ${rule.ref}`, { reason: "tidy" }, "Rule one, tidied");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(tasks(f)).toEqual(["curate", "verify", "classify"]);
  const [curate, verify] = f.dreamer.inputs;
  const sent = (input: typeof curate) => JSON.stringify({ prompt: input!.prompt, text: input!.text, tools: input!.tools.map(tool => [tool.name, tool.description, tool.parameters]) });
  expect(sent(verify)).toBe(sent(curate)); // system prompt, tool list and first user message
  expect(changes).toContain(`## 1 · update K${rule.knowledgeId} · curate batch constraint`);
  expect(changes).toContain(`base: K${rule.knowledgeId}@v1`);
  expect(changes).toContain(`result: K${rule.knowledgeId}@v2 (latest curate result)`);
  expect(changes).toContain("Rule one, tidied");
  expect(verify!.workspace.read).toHaveLength(2);
  expect(verify!.workspace.write).toEqual([verify!.workspace.read[1]]); // it reads the change file and writes only its own
});

test("a change that touched only supports is listed, and an empty change file means no verify call", async () => {
  let changes = "";
  const f = dreamerFixture({ verify: report => { changes = readFileSync(/Change file: (\S+)/.exec(report)![1]!, "utf8"); return "## none\n"; } });
  const rule = f.item("Rule one", { category: "constraint" }), other = f.existingFact("Other support");
  f.dreamer.script.curate!.constraint = block(`update ${rule.ref}`, { reason: "better grounds", supports: `F${other.id}` }, "Rule one");
  await f.dream();
  expect(changes).toContain(`supports: F${rule.supports[0]} -> F${other.id}`);
  const g = dreamerFixture();
  g.item("Rule two", { category: "constraint" });
  await g.dream();
  expect(tasks(g)).toEqual(["curate", "classify"]); // curate wrote nothing: verify passes through a no-work run
  expect(g.store.handoff(g.session.id, "dreaming")).toBeNull();
});

test("verify corrects a wrong attribution curate introduced, with evidence, and the correction is a Dreamer version", async () => {
  const f = dreamerFixture();
  const rule = f.item("The user required pnpm", { category: "constraint" });
  f.dreamer.script.curate!.constraint = block(`update ${rule.ref}`, { reason: "tidy" }, "The agent required pnpm.");
  f.dreamer.script.verify = block(`update K${rule.knowledgeId}@v2`, { reason: "the facts attribute it to the user", evidence: evidence(rule) }, "The user required pnpm.");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(textOf(f, rule.knowledgeId)).toBe("The user required pnpm.");
  expect(f.store.getKnowledgeRevision(rule.knowledgeId, f.store.currentKnowledge(f.path).find(value => value.knowledge.id === rule.knowledgeId)!.revision.id)!.actorRole).toBe("dreaming");
});

test("a curate rewrite that drops an unverified qualifier is restored by verify", async () => {
  const f = dreamerFixture();
  const rule = f.item("Pi agent measured a 30 percent speed-up; unverified on Windows", { category: "understanding" });
  f.dreamer.script.curate!.understanding = block(`update ${rule.ref}`, { reason: "shorter" }, "Pi agent measured a 30 percent speed-up.");
  f.dreamer.script.verify = block(`update K${rule.knowledgeId}@v2`, { reason: "restores the qualifier the fact states", evidence: evidence(rule) }, "Pi agent measured a 30 percent speed-up; unverified on Windows.");
  await f.dream();
  expect(textOf(f, rule.knowledgeId)).toContain("unverified on Windows");
});

test("a write after curate: the version curate wrote is stale at apply and left for the next run; the later version is refused by the check", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule one", { category: "constraint" });
  f.dreamer.script.curate!.constraint = block(`update ${rule.ref}`, { reason: "tidy" }, "Rule one, tidied");
  let calls = 0;
  const fields = { reason: "r", evidence: evidence(rule) };
  f.dreamer.script.verify = () => {
    if (calls++ === 0) updateKnowledge(f.store, f.path, rule.knowledgeId, f.store.currentKnowledge(f.path).find(v => v.knowledge.id === rule.knowledgeId)!.revision.id, "Rule one, by hand", rule.supports);
    return block(`update K${rule.knowledgeId}@v${calls === 1 ? 3 : 2}`, fields, "Verify's text"); // first the later version, then curate's
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.messages[0]).toContain(`K${rule.knowledgeId}@v3 is not curate's latest result`);
  expect(textOf(f, rule.knowledgeId)).toBe("Rule one, by hand"); // the stale correction was refused, not applied
  const run = f.store.listRuns(f.session.id).find(value => JSON.parse(value.response ?? "{}").task === "verify")!;
  expect(JSON.parse(run.response!).blocks[0].result).toMatchObject({ ok: false, stale: true });
});

test("a wrong merge is corrected on the primary: its dropped qualifier is restored, or the primary reverts; the absorbed item stays consumed", async () => {
  for (const how of ["update", "revert"] as const) {
    const f = dreamerFixture();
    const primary = f.item("Pi agent ran the suite on Linux; Windows unverified", { category: "constraint", title: "Suite run" });
    const absorbed = f.item("Pi agent ran the suite on Linux", { category: "constraint", title: "Suite run on Linux" });
    f.dreamer.script.curate!.constraint = block(`merge ${primary.ref}`, { absorb: absorbed.ref, reason: "same run" }, "Pi agent ran the suite on Linux.");
    f.dreamer.script.verify = how === "update"
      ? block(`update K${primary.knowledgeId}@v2`, { reason: "restore the qualifier", evidence: evidence(primary) }, "Pi agent ran the suite on Linux; Windows unverified.")
      : block(`revert K${primary.knowledgeId}@v2 -> K${primary.knowledgeId}@v1`, { reason: "nothing of the merge holds", evidence: evidence(primary) });
    await f.dream();
    expect(textOf(f, primary.knowledgeId)).toContain("Windows unverified");
    expect(textOf(f, absorbed.knowledgeId)).toBeUndefined(); // still consumed: verify has no undo-merge
    expect(f.store.listRuns(f.session.id).find(value => JSON.parse(value.response ?? "{}").task === "verify")).toBeDefined();
  }
});

test("a verify file that fails twice fails the task without losing curate's batches; the next run resumes at verify with the change file rebuilt", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule one", { category: "constraint" });
  f.dreamer.script.curate!.constraint = block(`update ${rule.ref}`, { reason: "tidy" }, "Rule one, tidied");
  f.dreamer.script.verify = ["## bogus\n", "## bogus\n"];
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "verify", class: "check failed twice", transient: false } });
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "verify", detail: { curateRuns: [expect.any(Number)] } });
  expect(textOf(f, rule.knowledgeId)).toBe("Rule one, tidied"); // curate's output is kept
  let changes = "";
  f.dreamer.script.verify = report => { changes = readFileSync(/Change file: (\S+)/.exec(report)![1]!, "utf8"); return "## none\n"; };
  f.item("A later Noter item", { category: "reference" });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(tasks(f).filter(task => task === "curate")).toHaveLength(1); // curate did not run again
  expect(changes).toContain("Rule one, tidied");
});

test("only verify may read repositories: its roots are the directories of the project's sessions", async () => {
  const f = dreamerFixture();
  const dir = mkdtempSync(join(tmpdir(), "tm-144-roots-")); dirs.push(dir);
  f.store.db.prepare("UPDATE sessions SET directory = ? WHERE id = ?").run(dir, f.session.id);
  const rule = f.item("Rule one", { category: "constraint" });
  f.dreamer.script.curate!.constraint = block(`update ${rule.ref}`, { reason: "tidy" }, "Rule one, tidied");
  await f.dream();
  const roots = Object.fromEntries(f.dreamer.inputs.map(input => [input.task, input.workspace.roots]));
  expect(roots).toEqual({ curate: [], verify: [realpathSync(dir)], classify: [] });
});
