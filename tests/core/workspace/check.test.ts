import { afterEach, describe, expect, test } from "vitest";
import { checkWorkspace } from "../../../src/core/workspace/index.ts";
import { checkVerify, type Proposal } from "../../../src/core/dreaming/changes.ts";
import type { CurateOperation } from "../../../src/core/store/executions.ts";
import { block, workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";
import { proposalsOf } from "../../support/dreamer.ts";

const opened: WorkspaceBatch[] = [];
const batch = (options?: Parameters<typeof workspaceBatch>[0]) => { const b = workspaceBatch(options); opened.push(b); return b; };
afterEach(() => { for (const b of opened.splice(0)) b.memory.close(); });

const file = (text: string, name = "file.md") => ({ name, text });
const factText = (b: WorkspaceBatch, label = "f1") => block(`fact ${label}`, { title: "pnpm chosen" },
  `${b.source(0, "User asked to use pnpm")}\n${b.source(1, "Pi agent explained the choice")}`);
const create = { title: "Use pnpm", category: "constraint", scope: "project", topics: "tooling", supports: "f1", reason: "User choice" };
const noterFacts = (b: WorkspaceBatch, text: string) => checkWorkspace(b.store, { kind: "noting-facts", scope: b.scope, file: file(text, "facts.md") });
const noterKnowledge = (b: WorkspaceBatch, text: string, factsText = factText(b)) =>
  checkWorkspace(b.store, { kind: "noting-knowledge", scope: b.scope, file: file(text, "knowledge.md"), facts: file(factsText, "facts.md") });
const curate = (b: WorkspaceBatch, text: string, operation: CurateOperation = "update") => checkWorkspace(b.store, { kind: "curate", operation, sessionId: b.session.id, file: file(text, "curate.md") });
const joined = (result: { problems: string[] }) => result.problems.join("\n");

describe("file format", () => {
  test("an explicit empty file is `## none`; an empty file is an error, and `none` beside other blocks is too", () => {
    const b = batch();
    expect(noterFacts(b, "## none\n")).toMatchObject({ ok: true, problems: [], lengths: [] });
    expect(joined(noterFacts(b, ""))).toContain("facts.md:1: file: empty file: write `## none` when there is nothing to write");
    expect(joined(noterFacts(b, `${factText(b)}\n## none\n`))).toContain("`## none` must be the only block of the file");
  });

  test("`## none` is one bare line: no target, fields, body or sections, and no second `none`", () => {
    const b = batch();
    const item = b.item("Rule one");
    const whole = "`## none` is the whole block: no target, fields, body or `###` sections";
    expect(joined(curate(b, `## none ${item.ref}\n`))).toContain(whole);
    expect(joined(curate(b, "## none\nreason: r\n\nA body that apply would drop.\n"))).toContain(whole);
    expect(joined(curate(b, "## none\n\nA body that apply would drop.\n"))).toContain(whole);
    expect(joined(curate(b, "## none\n### child\n\nA child.\n"))).toContain(whole);
    expect(joined(curate(b, "## none\n## none\n"))).toContain("`## none` appears once");
    expect(curate(b, "## none\n\n")).toMatchObject({ ok: true, problems: [] });
  });

  test("a parse problem names the file, the line and the block and says what was expected", () => {
    const b = batch();
    expect(joined(noterFacts(b, "some text\n## fact f1\n"))).toContain("facts.md:1: start of file: expected a `## <operation>` heading before any text");
    const noBlank = `## fact f1\ntitle: pnpm chosen\n${b.source(0, "User asked to use pnpm")}\n`;
    expect(joined(noterFacts(b, noBlank))).toMatch(/facts\.md:3: block 1 `## fact f1`: expected a `key: value` line or a blank line before the body, got "\[T\d+#E1@user\] User asked/);
    expect(joined(noterFacts(b, `## fact f1\ntitle: a\ntitle: b\n\n${b.source(0, "x")}\n`))).toContain("facts.md:3: block 1 `## fact f1`: field `title` is written twice");
  });

  test("a heading without an operation is refused", () => {
    expect(joined(noterFacts(batch(), "##\n\nbody\n"))).toContain("heading: expected `## <operation>`");
  });
});

describe("noting-facts", () => {
  test("a well-formed file passes and reports the host-measured length of every title and body", () => {
    const b = batch();
    const result = noterFacts(b, factText(b));
    expect(result).toMatchObject({ ok: true, problems: [] });
    expect(result.lengths).toEqual([
      { block: "block 1 `## fact f1`", field: "title", count: expect.any(Number), target: 20, limit: 22 },
      { block: "block 1 `## fact f1`", field: "body", count: expect.any(Number), target: 200, limit: 220 },
    ]);
    expect(result.lengths[1]!.count).toBeGreaterThan(result.lengths[0]!.count);
  });

  test("a fact body counts as the sum of its segments, each counted alone", () => {
    const b = batch();
    const one = "User asked to use pnpm", two = "Pi agent explained the choice";
    const count = (text: string) => noterFacts(b, block("fact f1", { title: "t" }, text)).lengths.find(item => item.field === "body")!.count;
    expect(count(`${b.source(0, one)}\n${b.source(1, two)}`)).toBe(count(b.source(0, one)) + count(b.source(1, two)));
  });

  test("an address outside the frozen batch, a repeated entry and a wrong role are refused", () => {
    const b = batch();
    const foreign = noterFacts(b, block("fact f1", { title: "t" }, "[T99999#E1@user] not in this batch"));
    expect(joined(foreign)).toContain("invalid source T99999#E1@user; expected admissible Raw in the eligible entry set");
    const repeated = noterFacts(b, block("fact f1", { title: "t" }, `${b.source(0, "first")}\n${b.source(0, "again")}`));
    expect(joined(repeated)).toContain(`duplicate source entry ${b.address(0)}@user`);
    const wrongRole = noterFacts(b, block("fact f1", { title: "t" }, `[${b.address(0)}@assistant] the user entry, claimed as the agent's`));
    expect(joined(wrongRole)).toContain("invalid source");
  });

  test("a title and a body beyond the limit are refused with field, count and limit; the counts are still reported", () => {
    const b = batch({ bodyWords: 5 });
    const long = noterFacts(b, block("fact f1", { title: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree" },
      b.source(0, "User asked to use pnpm for every package in the workspace today")));
    expect(joined(long)).toMatch(/title: \d+ 字\/词, over the limit of 22 \(target 20\)/);
    expect(joined(long)).toMatch(/sources: \d+ 字\/词, over the limit of 6 \(target 5\) \(segments counted one by one\)/);
    expect(long.lengths.map(item => [item.field, item.count > item.limit])).toEqual([["title", true], ["body", true]]);
  });

  test("a label is required, unique and a plain word; a title is required", () => {
    const b = batch();
    expect(joined(noterFacts(b, block("fact", { title: "t" }, b.source(0, "x"))))).toContain("expected `## fact <label>`");
    expect(joined(noterFacts(b, `${factText(b)}\n${factText(b)}`))).toContain("label `f1` is already used by block 1 `## fact f1`");
    expect(joined(noterFacts(b, block("fact f1", {}, b.source(0, "x"))))).toContain("missing required field `title`");
  });

  test("only fact blocks may be written, and a fact takes only a title", () => {
    const b = batch();
    expect(joined(noterFacts(b, block("create", create, "Use pnpm.")))).toContain("`## create` is not allowed in a noting-facts file; allowed: `fact`, or `## none`");
    expect(joined(noterFacts(b, block("fact f1", { title: "t", reason: "why" }, b.source(0, "x"))))).toContain("field `reason` is not allowed here; a `fact` block takes `title`");
  });
});

describe("noting-knowledge", () => {
  test("create and update pass; supports may cite a label of the facts file and report lengths", () => {
    const b = batch();
    const existing = b.item("Use npm for the build", { title: "Build tool" });
    const text = `${block("create", create, "Use pnpm.")}\n${block(`update ${existing.ref}`, { title: "Build tool", supports: "f1", reason: "User changed it" }, "Use pnpm for the build.")}`;
    const result = noterKnowledge(b, text);
    expect(result).toMatchObject({ ok: true, problems: [] });
    expect(result.lengths.map(item => `${item.block}/${item.field}`)).toEqual(["block 1 `## create`/title", "block 1 `## create`/body", `block 2 \`## update ${existing.ref}\`/title`, `block 2 \`## update ${existing.ref}\`/body`]);
  });

  test("an unknown fact label is refused", () => {
    const b = batch();
    expect(joined(noterKnowledge(b, block("create", { ...create, supports: "f9" }, "Use pnpm.")))).toContain("supports `f9` is neither an F<id> nor a fact label of the facts file");
  });

  test("the Noter writes no parents, merge, split or archive", () => {
    const b = batch();
    const item = b.item("Use npm for the build");
    expect(joined(noterKnowledge(b, block("create", { ...create, parents: item.ref }, "Use pnpm.")))).toContain("field `parents` is not allowed here; a `create` block takes `title`");
    for (const [heading, fields] of [[`merge ${item.ref}`, { absorb: item.ref, reason: "r" }], [`split ${item.ref}`, { reason: "r" }], [`archive ${item.ref}`, { kind: "invalid", reason: "r" }]] as const)
      expect(joined(noterKnowledge(b, block(heading, fields, "Body.")))).toContain(`\`## ${heading.split(" ")[0]}\` is not allowed in a noting-knowledge file; allowed: \`create\`, \`update\``);
  });

  test("a base that does not exist and a second record for one item are refused", () => {
    const b = batch();
    const item = b.item("Use npm for the build");
    expect(joined(noterKnowledge(b, block("update K9999@v1", { supports: "f1", reason: "r" }, "Body.")))).toContain("K9999@v1 does not exist");
    expect(joined(noterKnowledge(b, block("update K1@2", { supports: "f1", reason: "r" }, "Body.")))).toContain("`K1@2` is not a version address; expected `K<id>@v<n>`");
    const twice = `${block(`update ${item.ref}`, { supports: "f1", reason: "one" }, "One.")}\n${block(`update ${item.ref}`, { supports: "f1", reason: "two" }, "Two.")}`;
    expect(joined(noterKnowledge(b, twice))).toContain(`K${item.knowledgeId} already has a record in this file (block 1 \`## update ${item.ref}\`)`);
  });

  test("required fields, an update's supports, over-limit title and body are refused with their counts", () => {
    const b = batch({ bodyWords: 4 });
    expect(joined(noterKnowledge(b, block("create", { title: "t" }, "Body.")))).toContain("missing required field `category`");
    const item = b.item("Short");
    expect(joined(noterKnowledge(b, block(`update ${item.ref}`, { reason: "r" }, "Short.")))).toContain("supports");
    const long = noterKnowledge(b, block("create", { ...create, title: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree" },
      "one two three four five six seven eight"));
    expect(joined(long)).toMatch(/title: \d+ 字\/词, over the limit of 22 \(target 20\)/);
    expect(joined(long)).toMatch(/text: \d+ 字\/词, over the limit of 5 \(target 4\)/);
    expect(long.lengths.every(item => item.count > item.limit)).toBe(true);
  });

  test("a body is required after the blank line", () => {
    expect(joined(noterKnowledge(batch(), block("create", create)))).toContain("missing the complete body after the blank line");
  });
});

describe("curate", () => {
  test("a file holds blocks of the run's one operation; each operation's file passes", () => {
    const b = batch();
    const [update, primary, absorbed, parent, old] = ["u", "p", "a", "s", "o"].map(name => b.item(`Rule ${name}`, { title: `Rule ${name}` }));
    const support = `F${update!.supports[0]}`;
    expect(curate(b, block(`update ${update!.ref}`, { reason: "tidy" }, "Rule u, rewritten."), "update").problems).toEqual([]);
    expect(curate(b, block(`merge ${primary!.ref}`, { absorb: absorbed!.ref, reason: "same rule" }, "Rules p and a, merged."), "merge").problems).toEqual([]);
    const split = curate(b, block(`split ${parent!.ref}`, { reason: "two topics" }, "Rule s, primary part.")
      + "\n### child\ntitle: Child rule\ncategory: reference\nscope: project\ntopics: split\nsupports: " + support + "\nreason: split out\n\nA child.\n", "split");
    expect(split.problems).toEqual([]);
    expect(split.lengths.some(item => item.block.includes("child 1") && item.field === "body")).toBe(true);
    expect(curate(b, block(`archive ${old!.ref}`, { kind: "inadmissible", reason: "a running log" }, "A running log of one session, not an understanding."), "archive").problems).toEqual([]);
  });

  test("a block of another operation, and any create, are refused in a curate file (Dreaming creates no knowledge)", () => {
    const b = batch();
    const item = b.item("Rule one"), other = b.item("Rule two");
    const make = { ...create, supports: `F${item.supports[0]}` };
    for (const operation of ["update", "merge", "split", "archive"] as const)
      expect(joined(curate(b, block("create", make, "A new rule."), operation))).toContain(`\`## create\` is not allowed in a curate file; allowed: \`${operation}\``);
    expect(joined(curate(b, block(`merge ${item.ref}`, { absorb: other.ref, reason: "same" }, "Merged."), "update"))).toContain("`## merge` is not allowed in a curate file; allowed: `update`");
    expect(joined(curate(b, block(`update ${item.ref}`, { reason: "r" }, "Rule."), "archive"))).toContain("`## update` is not allowed in a curate file; allowed: `archive`");
  });

  test("an update inherits what it omits, and may leave supports out", () => {
    const b = batch();
    const item = b.item("Rule one");
    expect(curate(b, block(`update ${item.ref}`, { reason: "tidy" }, "Rule one, tidied."), "update").problems).toEqual([]);
    // The commit message is never inherited: the check names the field.
    expect(joined(curate(b, block(`update ${item.ref}`, {}, "Rule one, tidied."), "update"))).toContain("missing required field `reason`");
  });

  test("merged items share one category and scope; changing a category is an earlier update", () => {
    const b = batch();
    const primary = b.item("Rule p", { category: "constraint" }), other = b.item("Rule a", { category: "reference" });
    const mixed = curate(b, block(`merge ${primary.ref}`, { absorb: other.ref, reason: "same" }, "Merged."), "merge");
    expect(joined(mixed)).toContain(`merged items share one category: K${primary.knowledgeId}@v1 is \`constraint\`, K${other.knowledgeId}@v1 is \`reference\``);
    expect(joined(mixed)).toContain("change a category with an update in an earlier run first");
    const wide = b.item("Rule w", { scope: "global" });
    expect(joined(curate(b, block(`merge ${primary.ref}`, { absorb: wide.ref, reason: "same" }, "Merged."), "merge"))).toContain("merged items share one scope");
    const same = b.item("Rule s");
    expect(joined(curate(b, block(`merge ${primary.ref}`, { absorb: same.ref, category: "reference", reason: "same" }, "Merged."), "merge"))).toContain("the result says `reference`");
  });

  test("an absorbed item counts toward one record per item", () => {
    const b = batch();
    const primary = b.item("Rule p"), absorbed = b.item("Rule a"), third = b.item("Rule t");
    const text = `${block(`merge ${primary.ref}`, { absorb: absorbed.ref, reason: "same" }, "Merged.")}\n${block(`merge ${third.ref}`, { absorb: absorbed.ref, reason: "again" }, "Merged again.")}`;
    expect(joined(curate(b, text, "merge"))).toContain(`K${absorbed.knowledgeId} already has a record in this file (block 1 \`## merge ${primary.ref}\`); a file holds at most one record per item, and an absorbed item counts`);
    expect(joined(curate(b, block(`merge ${primary.ref}`, { absorb: primary.ref, reason: "same" }, "Merged."), "merge"))).toContain(`K${primary.knowledgeId} cannot absorb itself`);
  });

  test("split children may take their own category; a split needs children", () => {
    const b = batch();
    const parent = b.item("Rule s", { category: "constraint" });
    const child = (category: string) => `\n### child\ntitle: Child ${category}\ncategory: ${category}\nscope: project\ntopics:\nsupports: F${parent.supports[0]}\nreason: split\n\nChild body.\n`;
    expect(curate(b, block(`split ${parent.ref}`, { reason: "r" }, "Primary part.") + child("reference") + child("goal"), "split").problems).toEqual([]);
    expect(joined(curate(b, block(`split ${parent.ref}`, { reason: "r" }, "Primary part."), "split"))).toContain("a `split` block needs one or more `### child` sections");
    expect(joined(curate(b, block(`split ${parent.ref}`, { reason: "r" }, "Primary part.") + "\n### child\ntitle: Only a title\n\nBody.\n", "split"))).toContain("child 1: missing required field `category`");
  });

  test("an archive says its kind (invalid or inadmissible) and the explanation; a merged archive is refused in favour of `merge`", () => {
    const b = batch();
    const old = b.item("Rule o");
    const archive = (fields: Record<string, string>, body: string) => curate(b, block(`archive ${old.ref}`, fields, body), "archive");
    expect(archive({ kind: "inadmissible", reason: "r" }, "A running log, not an understanding.").problems).toEqual([]);
    expect(joined(archive({ kind: "gone", reason: "r" }, "No longer holds."))).toContain("kind must be invalid | inadmissible, got `gone`");
    expect(joined(archive({ kind: "invalid", reason: "r" }, "invalid"))).toContain("must state the grounds");
    const merged = joined(archive({ kind: "merged", reason: "r" }, "Held by another."));
    expect(merged).toContain("kind must be invalid | inadmissible, got `merged`");
    expect(merged).toContain("write a `merge` block with `absorb:`");
    const successor = joined(archive({ kind: "invalid", successor: "K1", reason: "r" }, "No longer holds."));
    expect(successor).toContain("field `successor` is not allowed here");
    expect(successor).toContain("write a `merge` block with `absorb:`");
  });

  test("evidence is a verdict field only: a curate block that carries it is refused", () => {
    const b = batch();
    const item = b.item("Rule one");
    expect(joined(curate(b, block(`update ${item.ref}`, { reason: "r", evidence: "trace://F1" }, "Rule."), "update"))).toContain("field `evidence` is not allowed here");
    expect(joined(curate(b, block(`revert ${item.ref} -> ${item.ref}`, { reason: "r" }), "update"))).toContain("`## revert` is not allowed in a curate file");
  });
});

describe("verify's verdict file", () => {
  const proposals = (b: WorkspaceBatch, ...entries: [CurateOperation, string][]): Proposal[] => proposalsOf(b.memory, b.path, ...entries);
  const verdicts = (b: WorkspaceBatch, text: string, changes: Proposal[], resolve: (reference: string) => string | null = () => null) =>
    checkVerify(b.store, b.path, file(text, "verify.md"), changes, resolve);

  test("confirm, edit and revert pass with evidence; a trace address must resolve and a repository reference goes to the resolver", () => {
    const b = batch();
    const [first, second, third] = ["a", "b", "c"].map(name => b.item(`Rule ${name}`));
    const evidence = `trace://F${first!.supports[0]}`;
    const changes = proposals(b, ["update", block(`update ${first!.ref}`, { reason: "tidy" }, "Rule a, tidied.")], ["update", block(`update ${second!.ref}`, { reason: "tidy" }, "Rule b, tidied.")],
      ["update", block(`update ${third!.ref}`, { reason: "tidy" }, "Rule c, tidied.")]);
    const text = [block("confirm 1", { reason: "fine" }), block(`edit 2 update ${second!.ref}`, { evidence: `${evidence}, src/core/store/index.ts:120` }, "Rule b, corrected."),
      block("revert 3", { evidence, reason: "contradicted" })].join("\n");
    const seen: string[] = [];
    const ok = verdicts(b, text, changes, reference => { seen.push(reference); return null; });
    expect(ok.problems).toEqual([]);
    expect(ok.verdicts.map(verdict => verdict.verdict)).toEqual(["confirm", "edit", "revert"]);
    expect(seen).toEqual(["src/core/store/index.ts:120"]);
    expect(verdicts(b, text, changes, () => "is not a file").problems.join("\n")).toContain("evidence `src/core/store/index.ts:120`: is not a file");
    const edit = (evidenceValue: string) => joined(verdicts(b, [block("confirm 1"), block(`edit 2 update ${second!.ref}`, { evidence: evidenceValue }, "Rule b."), block("confirm 3")].join("\n"), changes));
    expect(edit("trace://F99999")).toContain("evidence `trace://F99999`: no such fact");
    expect(edit("trace://raw/S999/T1")).toContain("no such session");
    expect(edit("trace://K99999")).toContain("no such knowledge item");
    expect(edit(`trace://raw/S${b.session.id}/T${b.entries[0]!.turnId}#E1`)).toBe("");
    expect(edit(`trace://raw/S${b.session.id}/T${b.entries[0]!.turnId}#E9`)).toContain("no entry E9 in that turn");
    expect(edit("F1")).toContain("write `trace://F1`");
  });

  test("an edit or revert without evidence, a revert without a reason, and anything but confirm, edit and revert are refused", () => {
    const b = batch();
    const item = b.item("Rule one");
    const changes = proposals(b, ["update", block(`update ${item.ref}`, { reason: "tidy" }, "Rule one, tidied.")]);
    expect(joined(verdicts(b, block(`edit 1 update ${item.ref}`, {}, "Rule."), changes))).toContain("missing required field `evidence`");
    expect(joined(verdicts(b, block(`edit 1 update ${item.ref}`, { evidence: "" }, "Rule."), changes))).toContain("evidence is empty");
    expect(joined(verdicts(b, block("revert 1", { evidence: `trace://F${item.supports[0]}` }), changes))).toContain("missing required field `reason`");
    for (const heading of [`update ${item.ref}`, `archive ${item.ref}`, "create"])
      expect(joined(verdicts(b, block(heading, { reason: "r" }, "Rule."), changes)), heading).toContain("is not a verdict");
    expect(joined(verdicts(b, block(`revert ${item.ref} -> ${item.ref}`, { reason: "r" }), changes))).toContain("expected `## revert <n>`"); // the version-restoring form is gone
    expect(joined(verdicts(b, block("confirm 1", { evidence: "trace://F1" }), changes))).toContain("field `evidence` is not allowed in a `confirm` block");
  });

  test("every change needs exactly one verdict, and a verdict needs a change", () => {
    const b = batch();
    const [first, second] = [b.item("Rule a"), b.item("Rule b")];
    const changes = proposals(b, ["update", block(`update ${first.ref}`, { reason: "tidy" }, "Rule a, tidied.")], ["update", block(`update ${second.ref}`, { reason: "tidy" }, "Rule b, tidied.")]);
    expect(joined(verdicts(b, block("confirm 1"), changes))).toContain("no verdict for change 2");
    expect(joined(verdicts(b, [block("confirm 1"), block("confirm 1"), block("confirm 2")].join("\n"), changes))).toContain("change 1 already has a verdict");
    expect(joined(verdicts(b, [block("confirm 1"), block("confirm 2"), block("confirm 3")].join("\n"), changes))).toContain("there is no change 3; the change file has 2");
    expect(joined(verdicts(b, [block("confirm 1"), block("confirm x")].join("\n"), changes))).toContain("expected `## confirm <n>`");
    expect(verdicts(b, [block("confirm 1"), block("confirm 2")].join("\n"), changes)).toMatchObject({ ok: true, problems: [] });
  });

  test("an edit keeps its change's kind, target, absorbed items and number of children, and may change the item's body, title, category, scope, topics and supports", () => {
    const b = batch();
    const [rule, primary, absorbed, third, parent, old] = ["r", "p", "a", "t", "s", "o"].map(name => b.item(`Rule ${name}`, { title: `Rule ${name}` }));
    const evidence = `trace://F${rule!.supports[0]}`;
    const child = (title: string) => `\n### child\ntitle: ${title}\ncategory: reference\nscope: project\ntopics:\nsupports: F${parent!.supports[0]}\nreason: split\n\nChild body.\n`;
    const changes = proposals(b,
      ["update", block(`update ${rule!.ref}`, { reason: "tidy" }, "Rule r, tidied.")],
      ["merge", block(`merge ${primary!.ref}`, { absorb: absorbed!.ref, reason: "same" }, "Merged.")],
      ["split", block(`split ${parent!.ref}`, { reason: "two" }, "Primary part.") + child("Child")],
      ["archive", block(`archive ${old!.ref}`, { kind: "inadmissible", reason: "log" }, "A running log, not an understanding.")]);
    const all = (...edits: string[]) => joined(verdicts(b, edits.join("\n"), changes));
    // Free: every field of the produced item.
    const update = block(`edit 1 update ${rule!.ref}`, { evidence, title: "New title", category: "reference", scope: "session", topics: "a, b", supports: `F${rule!.supports[0]}` }, "Rule r, corrected.");
    const tail = [block("confirm 2"), block("confirm 3"), block("confirm 4")].join("\n");
    expect(joined(verdicts(b, `${update}\n${tail}`, changes))).toBe("");
    // Fixed: kind, target, absorbed items, number of children, and an archive takes no edit.
    expect(all(block(`edit 1 merge ${rule!.ref}`, { evidence }, "x"), tail)).toContain("cannot change an operation's kind");
    expect(all(block(`edit 1 update ${primary!.ref}`, { evidence }, "x"), tail)).toContain(`change 1 is on ${rule!.ref}`);
    expect(all(block("confirm 1"), block(`edit 2 merge ${primary!.ref}`, { evidence, absorb: `${absorbed!.ref}, ${third!.ref}` }, "x"), block("confirm 3"), block("confirm 4")))
      .toContain("cannot change which items the merge absorbs");
    expect(all(block("confirm 1"), block("confirm 2"), block(`edit 3 split ${parent!.ref}`, { evidence }, "x") + child("A") + child("B"), block("confirm 4")))
      .toContain("keeps the proposal's 1 children; it has 2");
    expect(all(block("confirm 1"), block("confirm 2"), block("confirm 3"), block(`edit 4 archive ${old!.ref}`, { evidence }, "A different statement of the grounds.")))
      .toContain("change 4 is an archive; an archive takes only confirm or revert");
    expect(all(block("confirm 1"), block("confirm 2"), block("confirm 3"), block("revert 4", { evidence, reason: "still holds" }))).toBe("");
    // A merge edit cannot change the result's category: the merge rule refuses it and the message names the rule.
    expect(all(block("confirm 1"), block(`edit 2 merge ${primary!.ref}`, { evidence, category: "reference" }, "x"), block("confirm 3"), block("confirm 4")))
      .toContain("merged items share one category");
  });

  test("an edit that omits a field keeps the proposal's value; one that names it, even empty, overrides it", () => {
    const b = batch();
    const item = b.item("Rule one", { title: "Base title" });
    const evidence = `trace://F${item.supports[0]}`;
    const changes = proposals(b, ["update", block(`update ${item.ref}`, { reason: "retitle", title: "Proposed title", category: "reference", topics: "tooling" }, "Rule one, tidied.")]);
    const compiled = (fields: Record<string, string>) => {
      const result = verdicts(b, block(`edit 1 update ${item.ref}`, { evidence, ...fields }, "Rule one, corrected."), changes);
      expect(result.problems).toEqual([]);
      return result.verdicts[0]!.operation as Extract<Proposal["operation"], { op: "update" }>;
    };
    expect(compiled({})).toMatchObject({ title: "Proposed title", category: "reference", topics: ["tooling"], text: "Rule one, corrected." });
    expect(compiled({ title: "Mine", topics: "" })).toMatchObject({ title: "Mine", category: "reference", topics: [] });
  });

  test("an over-cap edit is refused with its count and limit, and the counts are still reported", () => {
    const b = batch({ bodyWords: 4 });
    const item = b.item("one two three four five six seven eight"); // seeded before the caps, as production rows are
    const changes = proposals(b, ["update", block(`update ${item.ref}`, { title: "Short rule", reason: "shorten" }, "Short.")]);
    const result = verdicts(b, block(`edit 1 update ${item.ref}`, { evidence: `trace://F${item.supports[0]}` }, "one two three four five six seven eight"), changes);
    expect(joined(result)).toMatch(/text: 8 字\/词, over the limit of 5 \(target 4\)/);
    expect(result.lengths).toContainEqual({ block: "block 1 `## edit 1 update " + item.ref + "`", field: "body", count: 8, target: 4, limit: 5 });
  });
});

describe("classify", () => {
  const classify = (b: WorkspaceBatch, text: string, items = [1, 2, 3]) => checkWorkspace(b.store, { kind: "classify", items, file: file(text, "scores.md") });
  test("one `K<id> <score>` line per item of the set passes", () => {
    expect(classify(batch(), "K1 75\nK2 1\nK3 100\n")).toMatchObject({ ok: true, problems: [], lengths: [] });
  });
  test("the file scores the whole set: a missing item is a problem listing its id, and an empty file fits only an empty set", () => {
    expect(joined(classify(batch(), "K1 75\nK3 20\n"))).toContain("scores.md:1: classify file: no score for K2; every item of the set is scored exactly once");
    expect(joined(classify(batch(), ""))).toContain("no score for K1, K2, K3");
    expect(classify(batch(), "", [])).toMatchObject({ ok: true, problems: [] });
    expect(joined(classify(batch(), "K1 5\n", []))).toContain("that item is not in the set to score");
  });
  test("a malformed line, a score outside 1-100, an item outside the set and a repeated item are refused", () => {
    const text = joined(classify(batch(), "K1 75\nK1 80\nK9 50\nK2 101\nK3 0\nfoo\nK2 4.5\n"));
    expect(text).toContain("scores.md:2: score line K1: scored twice (lines 1 and 2)");
    expect(text).toContain("scores.md:3: score line K9: that item is not in the set to score");
    expect(text).toContain("scores.md:4: score line K2: the score must be an integer from 1 to 100, got 101");
    expect(text).toContain("scores.md:5: score line K3: the score must be an integer from 1 to 100, got 0");
    expect(text).toContain('scores.md:6: score line: expected `K<id> <score>`, got "foo"');
    expect(text).toContain('scores.md:7: score line: expected `K<id> <score>`, got "K2 4.5"');
  });
});

describe("fact relations (ticket 144, Q3-A)", () => {
  const fact = (b: WorkspaceBatch, label: string, fields: Record<string, string>, index = 0) =>
    block(`fact ${label}`, { title: `fact ${label}`, ...fields }, b.source(index, `evidence for ${label}`));

  test("`support:` and `negate:` accept an existing F id or an earlier label with a strength, separated by commas", () => {
    const b = batch();
    const old = b.existingFact();
    expect(noterFacts(b, `${fact(b, "f1", { support: `F${old.id} strong` })}\n${fact(b, "f2", { support: "f1 weak", negate: `F${old.id} strong` }, 2)}`))
      .toMatchObject({ ok: true, problems: [] });
  });

  test("a relation is refused when its target is unknown, later in the file, itself, or has no strength, in the label the file wrote", () => {
    const b = batch();
    const refused = (fields: Record<string, string>, other = "") => joined(noterFacts(b, `${fact(b, "f1", fields)}${other ? `\n${other}` : ""}`));
    expect(refused({ support: "F99999 strong" })).toContain("F99999");
    expect(refused({ support: "f1 strong" })).toContain("f1");              // itself
    expect(refused({ negate: "f2 weak" }, fact(b, "f2", {}, 2))).toContain("f2"); // later in the file
    expect(refused({ support: "f9 weak" })).toContain("is not `<F id or fact label> strong|weak`");
    expect(refused({ support: "F1" })).toContain("is not `<F id or fact label> strong|weak`");
  });

  test("a relation field of another block is not a field of that block", () => {
    const b = batch();
    expect(joined(noterKnowledge(b, block("create", { ...create, negate: "f1 weak" }, "Use pnpm.")))).toContain("negate");
  });
});
