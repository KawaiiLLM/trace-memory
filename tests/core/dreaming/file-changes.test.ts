import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as ChildProcess from "node:child_process";
import { workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";
import { knowledgeBatch, session } from "../../support/seed.ts";
import { scanChangedFiles } from "../../../src/core/dreaming/candidates.ts";
import { dreamerFixture, writeDecisions } from "../../support/dreamer.ts";
import { REQUEST } from "../../support/noter.ts";

const git = vi.hoisted(() => ({ root: "", before: "", after: "", diff: "", head: "head" }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof ChildProcess>(),
  execFileSync: (command: string, args: string[]) => {
    if (command !== "git") throw new Error(`Unexpected command ${command}`);
    if (args.includes("--show-toplevel")) return git.root;
    if (args.includes("rev-parse")) return git.head;
    if (args.includes("show")) return args.at(-1)!.startsWith("verified:") ? git.before : git.after;
    if (args.includes("diff")) return git.diff;
    if (args.includes("cat-file")) return "";
    throw new Error(`Unexpected git arguments ${args}`);
  },
}));
const opened: WorkspaceBatch[] = [], directories: string[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.memory.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test.each([
  { name: "outside the linked function", before: "export function target() { return 1; }\nconst other = 1;", after: "export function target() { return 1; }\nconst other = 2;", changed: false },
  { name: "inside the linked function", before: "export function target() { return 1; }", after: "export function target() { return 2; }", changed: true },
  { name: "missing at the verified commit", before: "const other = 1;", after: "export function target() { return 1; }", changed: true },
  { name: "missing at HEAD", before: "export function target() { return 1; }", after: "const other = 1;", changed: true, missing: true },
  { name: "missing at both commits", before: "const other = 1;", after: "const other = 2;", changed: true, missing: true },
])("committed edit $name sets only the appropriate symbol stale flag", ({ before, after, changed, missing }) => {
  const f = workspaceBatch(); opened.push(f);
  const dir = mkdtempSync("/private/tmp/code-links-"); directories.push(dir);
  const file = join(dir, "rule.ts"), address = `${file}#target`;
  writeFileSync(file, after);
  Object.assign(git, { root: dir, before, after, diff: "Whole file changed", head: "head" });
  session(f.store, f.project.id, "pi:code-links", { directory: dir });
  const support = f.existingFact();
  const item = knowledgeBatch(f.store, f.path, [{ scope: "project", category: "constraint", title: "Linked rule", text: "Preserve this rule", supports: [support.id], files: [address] }]).committed[0]!;
  f.store.setKnowledgeFileVerification(item.commit, { file: address, verifiedCommit: "verified", verifiedAt: "2026-10-24T00:00:00Z" });
  const background = scanChangedFiles(f.store, f.path);
  const flags = f.store.knowledgeStaleReasons(item.commit).filter(flag => flag.reason === "file_changed");
  expect(flags).toEqual(changed ? [{ reason: "file_changed", detail: `${address} since verified${missing ? ": symbol missing" : ""}` }] : []);
  expect(background).toEqual(changed ? [expect.stringContaining(address)] : []);
});

test("a symbol added during curate retains the captured file baseline and is flagged on the next scan", async () => {
  const memories: WorkspaceBatch["memory"][] = [], f = dreamerFixture(memories);
  const dir = mkdtempSync("/private/tmp/code-links-baseline-"); directories.push(dir);
  const file = join(dir, "rule.ts"), address = `${file}#target`;
  writeFileSync(file, "export function target() { return 1; }");
  Object.assign(git, { root: dir, head: "verified", before: "const other = 1;", after: "export function target() { return 1; }", diff: "" });
  session(f.store, f.project.id, "pi:code-links-baseline", { directory: dir });
  const item = f.item("A newly grounded rule");
  f.dreamer.script.instead = { curate: async input => {
    git.head = "head"; // A repository commit arrives after the start-of-curate snapshot.
    input.reportRequest(REQUEST);
    await input.tools.find(tool => tool.name === "check")!.execute({});
    writeDecisions(input.workspace.dir);
    const decisions = join(input.workspace.dir, "decisions.md");
    writeFileSync(decisions, readFileSync(decisions, "utf8").replace("files: None", `files: ${address}`));
    writeFileSync(join(input.workspace.dir, "changes.md"), "## none\n");
    expect(input.passEnd()).toContain("Curate passes.");
    writeFileSync(join(input.workspace.dir, "scores.md"), `K${item.knowledgeId} 60\n`);
    expect(input.passEnd()).toBeDefined();
    expect(input.passEnd()).toBeUndefined();
    return { outcome: "success", output: "Done", request: REQUEST };
  } };
  try {
    expect(await f.dream()).toMatchObject({ outcome: "success" });
    const current = f.store.currentCommit(item.knowledgeId, f.path)[0]!;
    expect(f.store.knowledgeFileVerifications(current.id)).toEqual([{ file: address, verifiedCommit: "verified", verifiedAt: expect.any(String) }]);
    scanChangedFiles(f.store, f.path);
    expect(f.store.knowledgeStaleReasons(current.id)).toEqual([{ reason: "file_changed", detail: `${address} since verified` }]);
  } finally { for (const memory of memories) memory.close(); }
});
