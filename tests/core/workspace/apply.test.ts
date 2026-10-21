import { afterEach, describe, expect, test } from "vitest";
import { memoryFiles } from "../../../src/core/api/files.ts";
import { applyWorkspace, type ApplyResult } from "../../../src/core/workspace/index.ts";
import { block, workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";

const opened: WorkspaceBatch[] = [];
const batch = () => { const b = workspaceBatch(); opened.push(b); return b; };
afterEach(() => { for (const b of opened.splice(0)) b.memory.close(); });

const file = (text: string, name = "file.md") => ({ name, text });
const noting = (b: WorkspaceBatch, facts: string, knowledge: string) =>
  applyWorkspace(b.store, { kind: "noting", scope: b.scope, facts: file(facts, "facts.md"), knowledge: file(knowledge, "knowledge.md") });
const dreaming = (b: WorkspaceBatch, kind: "curate" | "verify", text: string) =>
  applyWorkspace(b.store, { kind, sessionId: b.session.id, path: b.path, file: file(text, `${kind}.md`) });
const ok = (result: ApplyResult) => { if (!result.ok) throw new Error(result.problems.join("\n")); return result; };
const current = (b: WorkspaceBatch, knowledgeId: number) => b.store.currentCommit(knowledgeId, b.path);
const read = (b: WorkspaceBatch, address: string) => memoryFiles(b.memory, b.path).read(address).content;
/** Another writer's update of an item, as a manual `memory update` would commit it. */
const concurrentUpdate = (b: WorkspaceBatch, item: { knowledgeId: number; commit: number; supports: number[] }, text: string) => {
  const result = b.store.commitConsolidationRun({ path: b.path, run: { kind: "manual", sessionId: b.session.id, branch: "main", createdAt: "now" }, operations: [{ op: "update",
    knowledgeId: item.knowledgeId, baseCommit: item.commit, text, category: "constraint", scope: "project", supports: item.supports, topics: [], reason: "concurrent", createdAt: "now" }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!;
};
const support = (item: { supports: number[] }) => `F${item.supports[0]}`;

const factFile = (b: WorkspaceBatch, label = "f1") => block(`fact ${label}`, { title: "pnpm chosen" }, `${b.source(0, "User asked to use pnpm")}\n${b.source(1, "Pi agent explained the choice")}`);
const create = { title: "Use pnpm", category: "constraint", scope: "project", topics: "tooling", supports: "f1", reason: "User choice" };

describe("the Noter's two files", () => {
  test("facts are published and the knowledge file's labels resolve to the new fact ids in the same transaction", () => {
    const b = batch();
    const existing = b.item("Use npm for the build", { title: "Build tool" });
    const result = ok(noting(b, `${factFile(b)}\n${block("fact f2", { title: "lockfile condition" }, b.source(2, "User added the lockfile condition"))}`,
      `${block("create", { ...create, supports: "f1, f2" }, "Use pnpm and commit the lockfile.")}\n${block(`update ${existing.ref}`, { supports: "f2", reason: "User changed it" }, "Use pnpm for the build.")}`));
    expect(Object.keys(result.factIds)).toEqual(["f1", "f2"]);
    const [f1, f2] = [result.factIds.f1!, result.factIds.f2!];
    expect(b.store.getFact(f1)).toMatchObject({ title: "pnpm chosen", source: [`${b.address(0)}@user`, `${b.address(1)}@assistant`] });
    expect(result.blocks.map(item => [item.status, item.versions.length])).toEqual([["applied", 1], ["applied", 1]]);
    const created = current(b, Number(result.blocks[0]!.versions[0]!.match(/^K(\d+)/)![1]))[0]!;
    expect(created).toMatchObject({ op: "create", title: "Use pnpm", supports: [f1, f2], actorRole: "noting" });
    // An update keeps the identity and adds a version.
    expect(current(b, existing.knowledgeId)[0]).toMatchObject({ op: "update", supports: [f2], text: "Use pnpm for the build." });
    expect(result.blocks[1]!.versions).toEqual([`K${existing.knowledgeId}@v2`]);
    // The batch is published once: its entries are processed.
    expect(b.entries.every(entry => b.store.entryNoted(entry.id))).toBe(true);
  });

  test("a stale update becomes a create through the Noter's conflict path; it does not fail the file", () => {
    const b = batch();
    const item = b.item("Use npm for the build", { title: "Build tool" });
    const files = [factFile(b), block(`update ${item.ref}`, { supports: "f1", reason: "User changed it" }, "Use pnpm for the build.")] as const;
    concurrentUpdate(b, item, "Use yarn for the build");
    const result = ok(noting(b, files[0], `${files[1]}\n${block("create", create, "Use pnpm.")}`));
    expect(result.blocks[0]).toMatchObject({ status: "applied", converted: true });
    const created = current(b, Number(result.blocks[0]!.versions[0]!.match(/^K(\d+)/)![1]))[0]!;
    expect(created.knowledgeId).not.toBe(item.knowledgeId);
    expect(created.op).toBe("create");
    expect(created.text).toContain("Use pnpm for the build.");
    expect(created.text).toContain(`originally targeted K${item.knowledgeId}#`);
    expect(current(b, item.knowledgeId)[0]!.text).toBe("Use yarn for the build");
    expect(result.blocks[1]).toMatchObject({ status: "applied" });
  });

  test("a file with problems publishes nothing", () => {
    const b = batch();
    const before = b.store.listSessionFacts(b.session.id).length;
    const result = noting(b, factFile(b), block("create", { ...create, supports: "f9" }, "Use pnpm."));
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.problems.join("\n")).toContain("supports `f9` is neither an F<id> nor a fact label");
    expect(b.store.listSessionFacts(b.session.id)).toHaveLength(before);
    expect(b.entries.some(entry => b.store.entryNoted(entry.id))).toBe(false);
  });

  test("an empty batch publishes zero facts and zero knowledge", () => {
    const b = batch();
    const result = ok(noting(b, "## none\n", "## none\n"));
    expect(result).toMatchObject({ blocks: [], factIds: {} });
  });
});

describe("curate", () => {
  test("update keeps the identity and adds a version; create gets a new identity", () => {
    const b = batch();
    const item = b.item("Rule one");
    const result = ok(dreaming(b, "curate", `${block(`update ${item.ref}`, { reason: "tidy" }, "Rule one, tidied.")}\n${block("create", { ...create, supports: support(item) }, "A new rule.")}`));
    expect(result.blocks.map(entry => entry.status)).toEqual(["applied", "applied"]);
    expect(result.blocks[0]!.versions).toEqual([`K${item.knowledgeId}@v2`]);
    expect(current(b, item.knowledgeId)[0]).toMatchObject({ op: "update", text: "Rule one, tidied.", supports: item.supports, actorRole: "dreaming" });
    const created = Number(result.blocks[1]!.versions[0]!.match(/^K(\d+)/)![1]);
    expect(created).not.toBe(item.knowledgeId);
    expect(current(b, created)[0]).toMatchObject({ op: "create", title: "Use pnpm" });
  });

  test("a merge keeps the primary's identity, even the newer one, and consumes the absorbed items with successor links", () => {
    const b = batch();
    const older = b.item("Rule a"), newer = b.item("Rule b"), third = b.item("Rule c");
    const result = ok(dreaming(b, "curate", block(`merge ${newer.ref}`, { absorb: `${older.ref}, ${third.ref}`, reason: "same rule" }, "Rules a, b and c, merged.")));
    expect(result.blocks[0]).toMatchObject({ status: "applied", versions: [`K${newer.knowledgeId}@v2`] });
    expect(current(b, newer.knowledgeId)[0]).toMatchObject({ op: "merge", text: "Rules a, b and c, merged." });
    for (const absorbed of [older, third]) {
      expect(current(b, absorbed.knowledgeId)).toEqual([]);
      expect(b.store.listKnowledgeLinks(absorbed.knowledgeId)).toMatchObject([{ kind: "merged_into", toKnowledge: newer.knowledgeId }]);
      expect(read(b, `trace://K${absorbed.knowledgeId}`)).toContain(`merged_into: K${newer.knowledgeId}@v2`);
    }
  });

  test("a split keeps the identity as the primary part, creates the children and does not archive the item", () => {
    const b = batch();
    const item = b.item("Rule one and rule two");
    const child = (category: string, title: string) => `\n### child\ntitle: ${title}\ncategory: ${category}\nscope: project\ntopics: split\nsupports: ${support(item)}\nreason: split out\n\n${title} body.\n`;
    const result = ok(dreaming(b, "curate", block(`split ${item.ref}`, { reason: "two topics" }, "Rule one.") + child("reference", "Child ref") + child("goal", "Child goal")));
    expect(result.blocks[0]).toMatchObject({ status: "applied" });
    const [primary, ...children] = result.blocks[0]!.versions;
    expect(primary).toBe(`K${item.knowledgeId}@v2`);
    expect(children).toHaveLength(2);
    expect(current(b, item.knowledgeId)[0]).toMatchObject({ op: "split", text: "Rule one." });
    const ids = children.map(entry => Number(entry.match(/^K(\d+)/)![1]));
    expect(ids.map(id => current(b, id)[0]!.category)).toEqual(["reference", "goal"]);
    expect(b.store.listKnowledgeLinks(item.knowledgeId).map(link => [link.kind, link.toKnowledge])).toEqual(ids.map(id => ["split_from", id]));
    // Views: the children say where they were split from; the item is not archived.
    expect(read(b, `trace://K${ids[0]}`)).toContain(`parents: K${item.knowledgeId}@v1`);
    expect(read(b, `trace://K${item.knowledgeId}@v1`)).toContain(`children: K${item.knowledgeId}@v2, K${ids[0]}@v1, K${ids[1]}@v1`);
    expect(b.store.listKnowledgeRevisions(item.knowledgeId).some(revision => revision.op === "archive")).toBe(false);
  });

  test("archives: invalid and inadmissible write an archive version with the explanation; merged consumes the item into its successor", () => {
    const b = batch();
    const [invalid, inadmissible, merged, successor] = ["i", "n", "m", "s"].map(name => b.item(`Rule ${name}`));
    const result = ok(dreaming(b, "curate", [
      block(`archive ${invalid!.ref}`, { kind: "invalid", reason: "contradicted" }, "The user withdrew the rule on the same day."),
      block(`archive ${inadmissible!.ref}`, { kind: "inadmissible", reason: "a running log" }, "A running log of one session, not an understanding."),
      block(`archive ${merged!.ref}`, { kind: "merged", successor: `K${successor!.knowledgeId}`, reason: "held elsewhere" }, "Rule s holds this rule now."),
    ].join("\n")));
    expect(result.blocks.map(entry => entry.status)).toEqual(["applied", "applied", "applied"]);
    expect(current(b, invalid!.knowledgeId)[0]).toMatchObject({ op: "archive", archiveKind: "invalid", text: "The user withdrew the rule on the same day." });
    expect(current(b, inadmissible!.knowledgeId)[0]).toMatchObject({ op: "archive", archiveKind: "inadmissible" });
    expect(current(b, merged!.knowledgeId)).toEqual([]);
    expect(b.store.listKnowledgeLinks(merged!.knowledgeId)).toMatchObject([{ kind: "merged_into", toKnowledge: successor!.knowledgeId, toCommit: successor!.commit }]);
    expect(read(b, `trace://K${merged!.knowledgeId}`)).toContain(`merged_into: K${successor!.knowledgeId}@v1`);
    expect(current(b, successor!.knowledgeId)[0]!.text).toBe("Rule s");
  });

  test("a merged archive names the successor's version written by the same file", () => {
    const b = batch();
    const old = b.item("Rule o"), successor = b.item("Rule s");
    ok(dreaming(b, "curate", [
      block(`archive ${old.ref}`, { kind: "merged", successor: `K${successor.knowledgeId}`, reason: "held elsewhere" }, "Rule s holds this rule now."),
      block(`update ${successor.ref}`, { reason: "absorbs o" }, "Rule s, with rule o."),
    ].join("\n")));
    const [link] = b.store.listKnowledgeLinks(old.knowledgeId);
    expect(link!.toCommit).toBe(current(b, successor.knowledgeId)[0]!.id);
    expect(current(b, old.knowledgeId)).toEqual([]);
  });

  test("a stale base is refused and reported, left for the next run; the rest of the file is applied", () => {
    const b = batch();
    const stale = b.item("Rule a"), fresh = b.item("Rule b");
    concurrentUpdate(b, stale, "Rule a, changed by another writer");
    const result = ok(dreaming(b, "curate", `${block(`update ${stale.ref}`, { reason: "tidy" }, "Rule a, tidied.")}\n${block(`update ${fresh.ref}`, { reason: "tidy" }, "Rule b, tidied.")}`));
    expect(result.blocks[0]).toMatchObject({ status: "refused", stale: true, versions: [] });
    expect(result.blocks[0]!.reason).toContain(`K${stale.knowledgeId}@v1: base is not the latest effective applicable revision`);
    expect(result.blocks[0]!.reason).toContain("left for the next run");
    expect(result.blocks[1]).toMatchObject({ status: "applied" });
    expect(current(b, stale.knowledgeId)[0]!.text).toBe("Rule a, changed by another writer");
    expect(current(b, fresh.knowledgeId)[0]!.text).toBe("Rule b, tidied.");
  });

  test("a merge or split with any stale base is refused whole, and an archive naming a refused successor goes with it", () => {
    const b = batch();
    const primary = b.item("Rule p"), absorbed = b.item("Rule a"), parent = b.item("Rule s"), old = b.item("Rule o"), fine = b.item("Rule f");
    concurrentUpdate(b, absorbed, "Rule a, changed by another writer");
    const child = `\n### child\ntitle: Child\ncategory: reference\nscope: project\ntopics:\nsupports: ${support(parent)}\nreason: split out\n\nChild body.\n`;
    const result = ok(dreaming(b, "curate", [
      block(`merge ${primary.ref}`, { absorb: absorbed.ref, reason: "same rule" }, "Rules p and a."),
      block(`archive ${old.ref}`, { kind: "merged", successor: `K${primary.knowledgeId}`, reason: "held by p" }, "Rule p holds this rule now."),
      block(`split ${parent.ref}`, { reason: "two" }, "Rule s.") + child,
      block(`archive ${fine.ref}`, { kind: "invalid", reason: "r" }, "Does not hold any more, per the user."),
    ].join("\n")));
    expect(result.blocks.map(entry => entry.status)).toEqual(["refused", "refused", "applied", "applied"]);
    expect(result.blocks[0]).toMatchObject({ stale: true });
    expect(result.blocks[1]!.reason).toContain(`its successor K${primary.knowledgeId} was refused (block 1 \`## merge ${primary.ref}\`); left for the next run`);
    expect(current(b, primary.knowledgeId)[0]!.text).toBe("Rule p");
    expect(current(b, old.knowledgeId)[0]!.text).toBe("Rule o");
    expect(b.store.listKnowledgeLinks(old.knowledgeId)).toEqual([]);
    // A stale split is refused the same way.
    const other = b.item("Rule x");
    concurrentUpdate(b, other, "Rule x, changed by another writer");
    const again = ok(dreaming(b, "curate", block(`split ${other.ref}`, { reason: "two" }, "Rule x.") + child));
    expect(again.blocks[0]).toMatchObject({ status: "refused", stale: true });
  });

  test("a file with problems writes nothing", () => {
    const b = batch();
    const item = b.item("Rule one");
    const result = dreaming(b, "curate", `${block(`update ${item.ref}`, { reason: "tidy" }, "Rule one, tidied.")}\n${block("archive K9999@v1", { kind: "invalid", reason: "r" }, "Gone for good.")}`);
    expect(result.ok).toBe(false);
    expect(current(b, item.knowledgeId)[0]!.text).toBe("Rule one");
  });
});

describe("verify", () => {
  test("a revert writes a new version whose content is the earlier version's", () => {
    const b = batch();
    const item = b.item("Rule one");
    const changed = concurrentUpdate(b, item, "Rule one, wrongly changed");
    const result = ok(dreaming(b, "verify", block(`revert K${item.knowledgeId}@v2 -> K${item.knowledgeId}@v1`, { reason: "the change misread the user", evidence: `trace://F${item.supports[0]}` })));
    expect(result.blocks[0]).toMatchObject({ status: "applied", versions: [`K${item.knowledgeId}@v3`] });
    expect(current(b, item.knowledgeId)[0]).toMatchObject({ text: "Rule one", parentId: changed.commit, title: b.store.getKnowledgeRevision(item.knowledgeId, item.commit)!.title });
  });

  test("a correction and an archive with evidence are applied", () => {
    const b = batch();
    const [wrong, gone] = [b.item("Rule w"), b.item("Rule g")];
    const evidence = `trace://F${wrong.supports[0]}`;
    const result = ok(dreaming(b, "verify", [
      block(`update ${wrong.ref}`, { reason: "attribution", evidence }, "Rule w, as the user said it."),
      block(`archive ${gone.ref}`, { kind: "invalid", reason: "contradicted", evidence }, "The repository shows it does not hold."),
    ].join("\n")));
    expect(result.blocks.map(entry => entry.status)).toEqual(["applied", "applied"]);
    expect(current(b, wrong.knowledgeId)[0]!.text).toBe("Rule w, as the user said it.");
    expect(current(b, gone.knowledgeId)[0]!.op).toBe("archive");
  });
});
