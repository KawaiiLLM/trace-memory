// Ticket 144 stage 4 §5: what a Dreaming verify file may name. Its authority is curate's latest results; its evidence is a trace://
// address or a repository file under the allowed roots; a revert restores the target's supports exactly.
import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan, type VerifyAuthority } from "../../../src/core/workspace/index.ts";
import { repositoryEvidenceProblem, resolveRepositoryPath } from "../../../src/core/dreaming/roots.ts";
import { block, workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";
import { updateKnowledge } from "../../support/seed.ts";

const opened: WorkspaceBatch[] = [];
const dirs: string[] = [];
const batch = () => { const b = workspaceBatch(); opened.push(b); return b; };
afterEach(() => { for (const b of opened.splice(0)) b.memory.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const authority = (results: [number, number][], bases: [number, number][] = [], roots: string[] = []): VerifyAuthority =>
  ({ results: new Map(results), bases: new Map(bases), resolveRepository: reference => repositoryEvidenceProblem(reference, roots) });
const check = (b: WorkspaceBatch, text: string, bound?: VerifyAuthority) =>
  plan(b.store, { kind: "verify", sessionId: b.session.id, path: b.path, file: { name: "verify.md", text }, authority: bound });
const joined = (result: { problems: string[] }) => result.problems.join("\n");
const ref = (b: WorkspaceBatch, knowledgeId: number, commit: number) => `K${knowledgeId}@v${b.store.versionOrdinal(knowledgeId, commit)}`;
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), "tm-144-verify-")); dirs.push(dir); return dir; };

describe("authority (5.3)", () => {
  test("a block must name curate's latest result of that item; a later Noter version and an item curate never touched are refused", () => {
    const b = batch();
    const item = b.item("Rule one");
    const curated = updateKnowledge(b.store, b.path, item.knowledgeId, item.commit, "Rule one, curated", item.supports);
    const noter = updateKnowledge(b.store, b.path, item.knowledgeId, curated.commit, "Rule one, by the Noter", item.supports);
    const untouched = b.item("Rule two");
    const bound = authority([[item.knowledgeId, curated.commit]], [[item.knowledgeId, item.commit]]);
    const fields = { reason: "r", evidence: `trace://F${item.supports[0]}` };
    expect(check(b, block(`update ${ref(b, item.knowledgeId, curated.commit)}`, fields, "Rule one, corrected"), bound).problems).toEqual([]);
    expect(joined(check(b, block(`update ${ref(b, item.knowledgeId, noter.commit)}`, fields, "Rule one, corrected"), bound)))
      .toContain(`is not curate's latest result for K${item.knowledgeId}, which is ${ref(b, item.knowledgeId, curated.commit)}`);
    expect(joined(check(b, block(`archive ${untouched.ref}`, { kind: "invalid", ...fields }, "The facts contradict it."), bound))).toContain("was not changed by curate");
    expect(joined(check(b, block("unmerge K1@v1", fields), bound))).toContain("is not allowed in a verify file");
  });

  test("a revert may restore only the base of the item's latest curate operation, never an older version (R4-1)", () => {
    const b = batch();
    const v1 = b.item("Rule one");
    const v2 = updateKnowledge(b.store, b.path, v1.knowledgeId, v1.commit, "Rule one, curated first", v1.supports);
    const v3 = updateKnowledge(b.store, b.path, v1.knowledgeId, v2.commit, "Rule one, written by hand", v1.supports);
    const v4 = updateKnowledge(b.store, b.path, v1.knowledgeId, v3.commit, "Rule one, curated again", v1.supports);
    const bound = authority([[v1.knowledgeId, v4.commit]], [[v1.knowledgeId, v3.commit]]);
    const fields = { reason: "r", evidence: `trace://F${v1.supports[0]}` };
    const revert = (to: number) => block(`revert ${ref(b, v1.knowledgeId, v4.commit)} -> ${ref(b, v1.knowledgeId, to)}`, fields);
    expect(joined(check(b, revert(v1.commit), bound))).toContain(`a revert may restore only the version curate wrote K${v1.knowledgeId} from, ${ref(b, v1.knowledgeId, v3.commit)}`);
    expect(check(b, revert(v3.commit), bound).problems).toEqual([]); // the manual text is kept
    // Older state is reached by an update with compliant content and evidence.
    expect(check(b, block(`update ${ref(b, v1.knowledgeId, v4.commit)}`, fields, "Rule one"), bound).problems).toEqual([]);
    // A create has no base to revert to.
    const created = b.item("Created by curate");
    const changed = updateKnowledge(b.store, b.path, created.knowledgeId, created.commit, "Created by curate, then touched", created.supports);
    expect(joined(check(b, block(`revert ${ref(b, created.knowledgeId, changed.commit)} -> ${created.ref}`, fields), authority([[created.knowledgeId, changed.commit]])))).toContain("nothing to revert to");
  });
});

describe("a revert restores supports (5.6)", () => {
  test("it carries the target's supports exactly, empty included, while a plain update still inherits", () => {
    const b = batch();
    const item = b.item("Rule one");
    const other = b.existingFact("Another fact");
    const v2 = updateKnowledge(b.store, b.path, item.knowledgeId, item.commit, "Rule one, changed", [other.id]);
    const evidence = `trace://F${item.supports[0]}`;
    const applyOf = (text: string) => {
      const planned = check(b, text);
      expect(planned.problems).toEqual([]);
      const out = b.store.commitWorkspaceRun({ run: { kind: "manual", sessionId: b.session.id, branch: "main", createdAt: "now" }, path: b.path, operations: planned.knowledge.map(entry => entry.make().operation!) });
      return out.results[0]!;
    };
    expect(b.store.getKnowledgeRevision(item.knowledgeId, v2.commit)!.supports).toEqual([other.id]);
    // revert v2 -> v1: [F other] becomes the target's [F item]
    const reverted = applyOf(block(`revert K${item.knowledgeId}@v2 -> K${item.knowledgeId}@v1`, { reason: "restore", evidence }));
    expect(reverted.ok && b.store.getKnowledgeRevision(item.knowledgeId, reverted.committed[0]!.commit)!.supports).toEqual(item.supports);
    // A target with no supports (a row written before supports were required): the revert is empty, not the base's.
    b.store.db.prepare("UPDATE knowledge_revisions SET supports = '[]' WHERE id = ?").run(item.commit);
    const v4 = updateKnowledge(b.store, b.path, item.knowledgeId, reverted.ok ? reverted.committed[0]!.commit : 0, "Rule one, changed again", [other.id]);
    const emptied = applyOf(block(`revert K${item.knowledgeId}@v4 -> K${item.knowledgeId}@v1`, { reason: "restore", evidence }));
    expect(v4.knowledgeId).toBe(item.knowledgeId);
    expect(emptied.ok && b.store.getKnowledgeRevision(item.knowledgeId, emptied.committed[0]!.commit)!.supports).toEqual([]);
    // A plain update without supports: still the base's.
    const kept = applyOf(block(`update K${item.knowledgeId}@v5`, { reason: "tidy", evidence }, "Rule one, tidied"));
    expect(kept.ok && b.store.getKnowledgeRevision(item.knowledgeId, kept.committed[0]!.commit)!.supports).toEqual([]);
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
    const bound = authority([[item.knowledgeId, item.commit]], [], [root]);
    const evidence = (value: string) => joined(check(b, block(`update ${item.ref}`, { reason: "r", evidence: value }, "Rule one."), bound));
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
