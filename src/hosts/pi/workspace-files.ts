// The Noter's native file tools on Pi (ticket 144): Pi's own write and edit, with operations that touch exactly the run's
// two workspace files. The model names a path; anything but one of the two absolute paths `check` told it is refused before
// the filesystem is reached, as is a path that is a symbolic link or sits outside the run's directory.
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { confineSearch } from "../../core/dreaming/roots.ts";
import type { DreamingAgentInput, NotingAgentInput } from "../../core/api/index.ts";

type Workspace = NotingAgentInput["workspace"] | DreamingAgentInput["workspace"];

/** The Noter's two files, or a Dreaming task's lists (stage 4): the same confinement either way. */
export function workspaceFileTools(cwd: string, workspace: Workspace, search = false) {
  const files = "facts" in workspace ? { read: [workspace.facts, workspace.knowledge], write: [workspace.facts, workspace.knowledge] } : workspace;
  const own = async (path: string, allowed: readonly string[]): Promise<string> => {
    if (!allowed.includes(path)) throw new Error("Trace Memory: this task may use only its workspace files");
    if (await realpath(dirname(path)) !== await realpath(workspace.dir)) throw new Error("Trace Memory: a workspace file must sit directly in the run's workspace");
    if (await lstat(path).then(info => info.isSymbolicLink(), () => false)) throw new Error("Trace Memory: a workspace file may not be a symbolic link");
    return path;
  };
  const operations = {
    readFile: async (path: string) => readFile(await own(path, files.read)),
    writeFile: async (path: string, content: string) => writeFile(await own(path, files.write), content),
    access: async (path: string) => access(await own(path, files.read)),
    // Pi's write tool makes the file's directory first; the run's directory exists, so that is the only one allowed.
    mkdir: async (dir: string) => { if (dir !== workspace.dir) throw new Error("Trace Memory: this task may not create directories"); await mkdir(dir, { recursive: true }); },
  };
  // Stage 4 §5.4: curate and verify list grep and find so their requests are alike; only verify has roots, and a call outside them is
  // refused (the deny list applies to a search as to a read).
  const roots = "roots" in workspace ? workspace.roots : [];
  const grep = createGrepToolDefinition(cwd), find = createFindToolDefinition(cwd);
  const searches = !search ? [] : [
    { ...grep, execute: (async (id: string, input: Record<string, unknown>, ...rest: unknown[]) => (grep.execute as Function)(id, { ...input, ...confineSearch(input, roots, "grep") }, ...rest)) as typeof grep.execute },
    { ...find, execute: (async (id: string, input: Record<string, unknown>, ...rest: unknown[]) => (find.execute as Function)(id, { ...input, path: confineSearch(input, roots, "glob").path }, ...rest)) as typeof find.execute }];
  return { definitions: [createWriteToolDefinition(cwd, { operations }), createEditToolDefinition(cwd, { operations }), ...searches], paths: [...new Set([...files.read, ...files.write])] };
}
