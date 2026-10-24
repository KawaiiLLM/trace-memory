import { afterEach, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    if (args.includes("--show-toplevel")) {
      if (!args[1]!.startsWith(git.root)) throw new Error("Not a git repository");
      return git.root;
    }
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

test("a symbol absent at the first checked nested HEAD stays refused after HEAD gains it", async () => {
  const memories: WorkspaceBatch["memory"][] = [], f = dreamerFixture(memories);
  const root = mkdtempSync("/private/tmp/code-links-baseline-"); directories.push(root);
  const dir = join(root, "repository"); mkdirSync(dir);
  const file = join(dir, "rule.ts"), address = `${file}#target`;
  writeFileSync(file, "export function target() { return 1; }");
  Object.assign(git, { root: dir, head: "verified", before: "const other = 1;", after: "export function target() { return 1; }", diff: "" });
  session(f.store, f.project.id, "pi:code-links-baseline", { directory: root });
  const item = f.item("A newly grounded rule");
  const reports: string[] = [], stops: (string | undefined)[] = [];
  f.dreamer.script.instead = { curate: async input => {
    input.reportRequest(REQUEST);
    const check = () => input.tools.find(tool => tool.name === "check")!.execute({});
    await check();
    writeDecisions(input.workspace.dir);
    const decisions = join(input.workspace.dir, "decisions.md");
    writeFileSync(decisions, readFileSync(decisions, "utf8").replace("files: None", `files: ${address}`));
    writeFileSync(join(input.workspace.dir, "changes.md"), "## none\n");
    reports.push(String(await check()));
    git.head = "head";
    reports.push(String(await check()));
    stops.push(input.passEnd(), input.passEnd());
    return { outcome: "success", output: "Done", request: REQUEST };
  } };
  try {
    expect(await f.dream()).toMatchObject({ outcome: "failure" });
    expect(reports).toEqual([expect.stringContaining("symbol missing"), expect.stringContaining("symbol missing")]);
    expect(stops).toEqual([expect.stringContaining("symbol missing"), undefined]);
    const current = f.store.currentCommit(item.knowledgeId, f.path)[0]!;
    expect(current.id).toBe(item.commit);
    expect(f.store.knowledgeFileVerifications(current.id)).toEqual([]);
  } finally { for (const memory of memories) memory.close(); }
});

test.each(["primary", "split child"])("a newly linked nested repository freezes its first checked HEAD for the %s", async part => {
  const memories: WorkspaceBatch["memory"][] = [], f = dreamerFixture(memories);
  const root = mkdtempSync("/private/tmp/nested-head-"); directories.push(root);
  const nested = join(root, "repository"); mkdirSync(nested);
  const file = join(nested, "rule.ts"), address = `${file}#target`;
  writeFileSync(file, "export function target() { return 1; }");
  Object.assign(git, { root: nested, head: "verified", before: "export function target() { return 1; }", after: "const other = 1;", diff: "" });
  session(f.store, f.project.id, "pi:nested-repository", { directory: root });
  const item = f.item("A newly grounded rule");
  f.dreamer.script.instead = { curate: async input => {
    input.reportRequest(REQUEST);
    const check = () => input.tools.find(tool => tool.name === "check")!.execute({});
    await check();
    const changes = part !== "split child" ? "## none\n" :
      `## split ${item.ref}\nsupports: F${item.supports[0]}\nreason: Separate conditions\n\nPrimary condition\n` +
      `\n### child\ntitle: Linked condition\ncategory: constraint\nscope: project\ntopics:\nsupports: F${item.supports[0]}\nfiles: ${address}\nreason: Independent condition\n\nLinked condition\n`;
    writeDecisions(input.workspace.dir, changes);
    const decisions = join(input.workspace.dir, "decisions.md");
    if (part !== "split child") writeFileSync(decisions, readFileSync(decisions, "utf8").replace("files: None", `files: ${address}`));
    writeFileSync(join(input.workspace.dir, "changes.md"), changes);
    expect(String(await check())).toContain("Problems: none");
    git.head = "head";
    expect(String(await check())).toContain("Problems: none");
    const scoring = input.passEnd();
    expect(scoring).toContain("Curate passes.");
    const labels = /Items: ([^\n]*)/.exec(scoring!)![1]!.split(", ");
    writeFileSync(join(input.workspace.dir, "scores.md"), labels.map(label => `${label} 70`).join("\n"));
    expect(input.passEnd()).toBeDefined();
    expect(input.passEnd()).toBeUndefined();
    return { outcome: "success", output: "Done", request: REQUEST };
  } };
  try {
    expect(await f.dream()).toMatchObject({ outcome: "success" });
    const linked = f.store.curateItems(f.path).find(item => item.value.revision.files?.includes(address))!.value.revision;
    expect(f.store.knowledgeFileVerifications(linked.id)).toEqual([{ file: address, verifiedCommit: "verified", verifiedAt: expect.any(String) }]);
    scanChangedFiles(f.store, f.path);
    expect(f.store.knowledgeStaleReasons(linked.id)).toEqual([{ reason: "file_changed", detail: `${address} since verified: symbol missing` }]);
  } finally { for (const memory of memories) memory.close(); }
});

test("parallel curate groups share the first captured nested repository HEAD", async () => {
  const memories: WorkspaceBatch["memory"][] = [], f = dreamerFixture(memories);
  const root = mkdtempSync("/private/tmp/parallel-head-"); directories.push(root);
  const nested = join(root, "repository"); mkdirSync(nested);
  const file = join(nested, "rule.ts"), address = `${file}#target`;
  writeFileSync(file, "export function target() { return 1; }");
  Object.assign(git, { root: nested, head: "verified", before: "export function target() { return 1; }", after: "export function target() { return 2; }", diff: "" });
  session(f.store, f.project.id, "pi:parallel-head", { directory: root });
  f.memory.config.dreaming.groupItems = 1;
  f.memory.config.dreaming.parallelGroups = 2;
  const items = [f.item("First grounded rule"), f.item("Second grounded rule")];
  const firstChecked = Promise.withResolvers<void>(), secondChecked = Promise.withResolvers<void>();
  f.dreamer.script.instead = { curate: async input => {
    input.reportRequest(REQUEST);
    const first = input.text.includes("Group 1.");
    if (!first) await firstChecked.promise;
    writeDecisions(input.workspace.dir);
    const decisions = join(input.workspace.dir, "decisions.md");
    writeFileSync(decisions, readFileSync(decisions, "utf8").replace("files: None", `files: ${address}`));
    writeFileSync(join(input.workspace.dir, "changes.md"), "## none\n");
    await input.tools.find(tool => tool.name === "check")!.execute({});
    if (first) {
      git.head = "head";
      firstChecked.resolve();
      await secondChecked.promise;
    } else secondChecked.resolve();
    const scoring = input.passEnd()!;
    const labels = /Items: ([^\n]*)/.exec(scoring)![1]!.split(", ");
    writeFileSync(join(input.workspace.dir, "scores.md"), labels.map(label => `${label} 70`).join("\n"));
    input.passEnd(); input.passEnd();
    return { outcome: "success", output: "Done", request: REQUEST };
  } };
  try {
    expect(await f.dream()).toMatchObject({ outcome: "success" });
    for (const item of items) {
      const current = f.store.currentCommit(item.knowledgeId, f.path)[0]!;
      expect(f.store.knowledgeFileVerifications(current.id)).toEqual([{ file: address, verifiedCommit: "verified", verifiedAt: expect.any(String) }]);
    }
  } finally { for (const memory of memories) memory.close(); }
});
