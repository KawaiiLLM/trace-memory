// The Noter's native file tools on Pi (ticket 144): Pi's own write and edit, with operations that touch exactly the run's
// two workspace files. The model names a path; anything but one of the two absolute paths `check` told it is refused before
// the filesystem is reached, as is a path that is a symbolic link or sits outside the run's directory.
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NotingAgentInput } from "../../core/api/index.ts";

type Workspace = NotingAgentInput["workspace"];

export function workspaceFileTools(cwd: string, workspace: Workspace) {
  const own = async (path: string): Promise<string> => {
    if (path !== workspace.facts && path !== workspace.knowledge) throw new Error("Trace Memory: this task may use only its two workspace files");
    if (await realpath(dirname(path)) !== await realpath(workspace.dir)) throw new Error("Trace Memory: a workspace file must sit directly in the run's workspace");
    if (await lstat(path).then(info => info.isSymbolicLink(), () => false)) throw new Error("Trace Memory: a workspace file may not be a symbolic link");
    return path;
  };
  const operations = {
    readFile: async (path: string) => readFile(await own(path)),
    writeFile: async (path: string, content: string) => writeFile(await own(path), content),
    access: async (path: string) => access(await own(path)),
    // Pi's write tool makes the file's directory first; the run's directory exists, so that is the only one allowed.
    mkdir: async (dir: string) => { if (dir !== workspace.dir) throw new Error("Trace Memory: this task may not create directories"); await mkdir(dir, { recursive: true }); },
  };
  return { definitions: [createWriteToolDefinition(cwd, { operations }), createEditToolDefinition(cwd, { operations })], paths: [workspace.facts, workspace.knowledge] };
}
