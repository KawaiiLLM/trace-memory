// Ticket 144 stage 5 §4: what a Dreaming verify file may cite, and what an edit leaves in the Store. Its evidence is a trace:// address or a
// repository file under the allowed roots (one deny list); an edit that omits a field keeps the proposal's value; a curate update that omits
// supports still inherits the base's.
// Superseded 2026-10-22 (「只需要确认、编辑（不改变操作类型）、回退」, 「核查通过后才发生」): the named-version authority checks, the version-restoring
// `revert K@v -> K@v` and its supports-restoring `replaceSupports` are gone. Their scope contract (verify is limited to curate's proposals) is
// `check.test.ts` ("every change needs exactly one verdict"), the stale case is `dreaming-verify.test.ts`.
import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVerify } from "../../../src/core/dreaming/changes.ts";
import { repositoryEvidenceProblem, resolveRepositoryPath } from "../../../src/core/dreaming/roots.ts";
import { block, workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";
import { proposalsOf } from "../../support/dreamer.ts";

const opened: WorkspaceBatch[] = [];
const dirs: string[] = [];
const batch = () => { const b = workspaceBatch(); opened.push(b); return b; };
afterEach(() => { for (const b of opened.splice(0)) b.memory.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), "tm-144-verify-")); dirs.push(dir); return dir; };

describe("an edit that omits supports (decision 6)", () => {
  test("a curate update that omits supports inherits the base's; an edit that omits them keeps the proposal's, at the apply boundary", () => {
    const b = batch();
    const item = b.item("Rule one");
    const other = b.existingFact("Another fact");
    const evidence = `trace://F${item.supports[0]}`;
    // The proposal moves the item onto another fact; the edit corrects the body only.
    const changes = proposalsOf(b.memory, b.path, ["update", block(`update ${item.ref}`, { reason: "better grounds", supports: `F${other.id}` }, "Rule one, regrounded.")]);
    const checked = checkVerify(b.store, b.path, { name: "verify.md", text: block(`edit 1 update ${item.ref}`, { evidence }, "Rule one, corrected.") }, changes, () => null);
    expect(checked.problems).toEqual([]);
    const applied = b.store.commitWorkspaceRun({ run: { kind: "dreaming", sessionId: b.session.id, branch: "main", createdAt: "now" }, path: b.path, operations: [checked.verdicts[0]!.operation!] }).results[0]!;
    expect(applied.ok && b.store.getKnowledgeRevision(item.knowledgeId, applied.committed[0]!.commit)).toMatchObject({ text: "Rule one, corrected.", supports: [other.id] });
    // A plain curate update without supports: the base's.
    const plain = proposalsOf(b.memory, b.path, ["update", block(`update K${item.knowledgeId}@v2`, { reason: "tidy" }, "Rule one, tidied.")])[0]!.operation;
    const kept = b.store.commitWorkspaceRun({ run: { kind: "dreaming", sessionId: b.session.id, branch: "main", createdAt: "now" }, path: b.path, operations: [plain] }).results[0]!;
    expect(kept.ok && b.store.getKnowledgeRevision(item.knowledgeId, kept.committed[0]!.commit)!.supports).toEqual([other.id]);
  });
});

describe("evidence (5.4)", () => {
  test("a bare address is refused with the form to write; a repository file must exist under a root and clear the deny list", () => {
    const b = batch();
    const item = b.item("Rule one");
    const root = tmp();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "store.ts"), "export {};\n");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    const outside = tmp();
    writeFileSync(join(outside, "other.ts"), "export {};\n");
    symlinkSync(join(outside, "other.ts"), join(root, "src", "link.ts"));
    const changes = proposalsOf(b.memory, b.path, ["update", block(`update ${item.ref}`, { reason: "tidy" }, "Rule one, tidied.")]);
    const evidence = (value: string) => checkVerify(b.store, b.path, { name: "verify.md", text: block("revert 1", { evidence: value, reason: "r" }) }, changes, reference => repositoryEvidenceProblem(reference, [root])).problems.join("\n");
    expect(evidence("F12")).toContain("write `trace://F12`");
    expect(evidence("K3@v2")).toContain("write `trace://K3@v2`");
    expect(evidence("S1/T2#E3")).toContain("write `trace://S1/T2#E3`");
    expect(evidence("src/store.ts:10-20")).toBe("");
    expect(evidence(join(root, "src", "store.ts"))).toBe("");
    expect(evidence("src/missing.ts")).toContain("does not exist");
    expect(evidence(join(outside, "other.ts"))).toContain("outside the repositories you may read");
    expect(evidence("src/link.ts")).toContain("outside the repositories you may read"); // a symlink out of the root
    expect(evidence(".env")).toContain("secret file");
    expect(evidence("src")).toContain("is not a file");
  });

  test("the one deny list covers the memory database, the agent directory and secret keys, for every tool", () => {
    const root = tmp();
    for (const name of ["id_rsa", "server.pem", ".env.local"]) writeFileSync(join(root, name), "x");
    mkdirSync(join(root, ".ssh")); writeFileSync(join(root, ".ssh", "config"), "x");
    for (const name of ["id_rsa", "server.pem", ".env.local", ".ssh/config"]) expect(resolveRepositoryPath(name, [root]), name).toMatchObject({ reason: expect.stringContaining("secret") });
    expect(resolveRepositoryPath("anything", [])).toMatchObject({ reason: "this session has no repository to read" });
  });
});

describe("children belong to an edit of a split", () => {
  test("a confirm, a revert or an edit of anything but a split that carries a `### child` section is refused, not accepted with the child dropped", () => {
    const b = batch();
    const item = b.item("Rule one"), evidence = `trace://F${item.supports[0]}`;
    const proposals = proposalsOf(b.memory, b.path, ["update", block(`update ${item.ref}`, { reason: "tidy" }, "Rule one, tidied.")]);
    const child = "\n### child\ntitle: Extra\ncategory: reference\nscope: project\ntopics:\nsupports: F1\nreason: extra\n\nExtra body.\n";
    const refuse = (text: string) => {
      const checked = checkVerify(b.store, b.path, { name: "verify.md", text }, proposals, () => null);
      expect(checked.ok).toBe(false);
      expect(checked.problems.join("\n")).toMatch(/`### child` sections belong only to an edit of a split/);
      expect(checked.problems.join("\n")).not.toMatch(/does not pass/); // refused before the overlay is compiled
    };
    refuse(block("confirm 1", { reason: "fine" }) + child);
    refuse(block("revert 1", { reason: "wrong", evidence }) + child);
    refuse(block(`edit 1 update ${item.ref}`, { evidence }, "Rule one, corrected.") + child);
    // The same edit without the child still passes.
    expect(checkVerify(b.store, b.path, { name: "verify.md", text: block(`edit 1 update ${item.ref}`, { evidence }, "Rule one, corrected.") }, proposals, () => null).problems).toEqual([]);
  });
});
