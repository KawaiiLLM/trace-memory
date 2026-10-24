// Dreamer repository reads and searches share project roots and the same deny list.
// A rootless call fails before searching. The real host route is exercised in dreaming.test.ts.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceFileTools } from "../../../src/hosts/pi/workspace-files.ts";
import { memoryReadTool } from "../../../src/hosts/pi/memory-files.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "tm-144-pi-"))); dirs.push(dir); return dir; };
const workspace = (roots: string[]) => ({ dir: tmp(), read: [], write: [], roots });

test("Dreamer searches are confined; non-Dreamer workspaces have no search tool", async () => {
  const root = tmp(), outside = tmp();
  expect(workspaceFileTools(root, workspace([]), true).definitions.map(tool => tool.name)).toEqual(["write", "edit", "grep", "find"]);
  expect(workspaceFileTools(root, workspace([]), false).definitions.map(tool => tool.name)).toEqual(["write", "edit"]);
  const call = (roots: string[], name: string, input: Record<string, unknown>) =>
    (workspaceFileTools(root, workspace(roots), true).definitions.find(tool => tool.name === name)!.execute as Function)("id", input, undefined, undefined, { cwd: root });
  await expect(call([], "grep", { pattern: "x", path: root })).rejects.toThrow();
  await expect(call([root], "grep", { pattern: "x", path: outside })).rejects.toThrow("outside the repositories you may read");
  await expect(call([root], "find", { pattern: "../*", path: root })).rejects.toThrow("stay inside path");
  await expect(call([root], "grep", { pattern: "x", path: root, glob: "*.ts" })).rejects.toThrow("narrow the search with path");
});

test("a memory-only Read opens a repository file only for a task with roots (curate, verify), and never a secret file or a path outside the roots", async () => {
  const root = tmp(), outside = tmp();
  writeFileSync(join(root, "a.ts"), "export const marker = 1;\n"); writeFileSync(join(root, ".env"), "SECRET=1\n"); writeFileSync(join(outside, "b.txt"), "x\n");
  const read = (roots: string[]) => memoryReadTool(root, () => { throw new Error("no trace"); }, { memoryOnly: true, readableRoots: () => roots });
  const run = (roots: string[], path: string) => (read(roots).execute as Function)("id", { path }, undefined, undefined, { cwd: root });
  expect(JSON.stringify(await run([root], join(root, "a.ts")))).toContain("marker");
  await expect(run([], join(root, "a.ts"))).rejects.toThrow("restricted to trace://");
  await expect(run([root], join(root, ".env"))).rejects.toThrow("secret file");
  await expect(run([root], join(outside, "b.txt"))).rejects.toThrow("outside the repositories you may read");
});
