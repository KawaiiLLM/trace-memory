import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import type { Store } from "../store/index.ts";

/** 62: the key a new session records — its repository root (the parent of git's common dir, so every
 * worktree of one repository shares it) or the real path of cwd — or the verdict that it records none. */
export type DirectoryResolution = { directory: string } | { excluded: true };

export interface DirectoryOptions {
  /** Runs `git rev-parse --git-common-dir` in cwd; any throw means "not a repository". */
  git?: (cwd: string) => string;
  /** Real paths never used as keys: the home directory (equality) and temporary roots (prefix). */
  excluded?: { home: string; temporary: string[] };
}

const gitCommonDir = (cwd: string) => execFileSync("git", ["rev-parse", "--git-common-dir"],
  { cwd, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();

const realpathOrNull = (path: string | undefined) => { try { return path ? realpathSync(path) : null; } catch { return null; } };

export function defaultExclusions(): NonNullable<DirectoryOptions["excluded"]> {
  return { home: realpathOrNull(homedir()) ?? homedir(),
    temporary: ["/tmp", "/private/tmp", process.env.TMPDIR].map(realpathOrNull).filter((path): path is string => path !== null) };
}

/** Git runs once per call — at session allocation, never per turn. A missing or failing git, or a
 * cwd outside any repository, keys on the real path of cwd; a cwd that cannot be resolved is excluded. */
export function sessionDirectory(cwd: string, options: DirectoryOptions = {}): DirectoryResolution {
  let directory: string | null;
  try { directory = realpathSync(dirname(resolve(cwd, (options.git ?? gitCommonDir)(cwd)))); }
  catch { directory = realpathOrNull(cwd); }
  if (directory === null) return { excluded: true };
  const excluded = options.excluded ?? defaultExclusions();
  if (directory === excluded.home || excluded.temporary.some(root => directory === root || directory!.startsWith(root + sep))) return { excluded: true };
  return { directory };
}

/** The allocation rule shared by every host: an excluded (or unknown) cwd keeps the session's own
 * project and records no directory; a directory whose recorded sessions belong to exactly one
 * effective project joins it as a `marker` declaration; none or several keep the own project and
 * record the directory for the next session. `own` allocates the host's per-session project. */
export function directoryAllocation(store: Store, cwd: string | undefined, own: () => number, options?: DirectoryOptions):
  { projectId: number; projectDeclaration: "marker" | "undeclared"; directory: string | null } {
  const resolved = cwd === undefined ? { excluded: true as const } : sessionDirectory(cwd, options);
  if ("excluded" in resolved) return { projectId: own(), projectDeclaration: "undeclared", directory: null };
  const projects = store.directoryProjects(resolved.directory);
  return projects.length === 1 ? { projectId: projects[0]!, projectDeclaration: "marker", directory: resolved.directory }
    : { projectId: own(), projectDeclaration: "undeclared", directory: resolved.directory };
}
