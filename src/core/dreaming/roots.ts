// The repositories the Dreamer may read: one function names the allowed roots; one deny list applies to
// Read, Grep, Glob and to the files `evidence:` cites. Both hosts and the file check call these and nothing else.

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Store } from "../store/index.ts";

/** The roots are the working directories of the project's sessions (user rulings, 2026-10-22 and 2026-10-23): a session's
 * `directory` (the repository root ticket 62 resolved) when it has one, otherwise the directory it started in
 * (`start_directory`, so a session started in the home directory reads the whole home directory). Missing or unreadable
 * directories are left out. */
export function allowedRoots(store: Store, sessionId: number): string[] {
  const projectId = store.getSession(sessionId)!.projectId;
  const roots = new Set<string>();
  for (const row of store.db.prepare("SELECT DISTINCT COALESCE(directory, start_directory) AS root FROM sessions WHERE project_id = ? AND COALESCE(directory, start_directory) IS NOT NULL").all(projectId)) {
    try {
      const root = realpathSync(String(row.root));
      if (!statSync(root).isDirectory()) continue;
      accessSync(root, constants.R_OK | constants.X_OK);
      roots.add(root);
    } catch { /* missing or unreadable directory */ }
  }
  return [...roots].sort();
}

const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
export const SECRET_FILES = [".env", ".env.*", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", ".npmrc", "credentials", "credentials.json", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore"];
export const SECRET_DIRS = [".ssh", ".aws", ".gnupg"];
/** The production memory directory and the Pi agent directory, relative to home (`deniedPath` holds them to the exact home). A Grep rooted
 * at home would otherwise search them, so the exclusion names them too (any directory of the same name is skipped as well). */
const DENIED_TREES = [".trace-memory", ".pi/agent"];
const SECRET = new RegExp(`^(?:${SECRET_FILES.map(name => name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")).join("|")})$`, "i");
/** ripgrep's `--glob` is case-sensitive, so each letter becomes a class (`.env` -> `.[eE][nN][vV]`) to match `SECRET`'s case-insensitivity. */
const anyCase = (name: string) => name.replace(/[a-z]/gi, letter => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
/** The protected directories as named under the home directory and as they really are (a protected directory may be a symbolic link). */
function protectedTrees(): string[] {
  const trees = new Set<string>();
  for (const home of new Set([homedir(), real(homedir())]))
    for (const tree of DENIED_TREES) { const named = join(home, ...tree.split("/")); trees.add(named); trees.add(real(named)); }
  return [...trees];
}
/** A path as a glob that matches itself: the characters a glob reads specially become one-character classes, and a backslash, which
 * escapes in a glob, is escaped. */
const literalGlob = (path: string) => path.replace(/[*?[\]{},\\]/g, character =>
  character === "]" ? "[]]" : character === "\\" ? "\\\\" : `[${character}]`);
/** The same list as a ripgrep exclusion, for a Grep call (a hook can only allow or rewrite a call, never filter its output). `below` adds
 * directories to skip, as paths below the searched one. ripgrep matches a glob against the path relative to its own working directory
 * when that holds the searched path, else the absolute path, and a host's working directory is not known here; a leading `**` plus slash matches in both,
 * so a directory with the same relative path elsewhere under the search is skipped too (as the `.trace-memory` entry skips any such name). */
const secretGlob = (below: readonly string[] = []) => `!{${[...SECRET_FILES, ...SECRET_DIRS.map(name => `${name}/**`), ...DENIED_TREES.map(tree => `${tree}/**`)]
  .map(name => `**/${anyCase(name)}`).concat(below.map(path => `**/${literalGlob(path)}/**`)).join(",")}}`;
export const SECRET_GLOB = secretGlob();

/** The one deny list: the production memory directory, the Pi agent directory and secret files, by name in any letter case. A protected
 * directory is denied both where it is named and where it really is (it may be a symbolic link into a root). A symlink out of the roots
 * is refused by `resolveRepositoryPath`, which tests the resolved path. */
export function deniedPath(path: string): string | null {
  const lower = path.toLowerCase();
  for (const tree of protectedTrees().map(tree => tree.toLowerCase()))
    if (lower === tree || lower.startsWith(tree + sep)) return "that directory holds the memory database or agent configuration and is never read";
  if (SECRET.test(basename(path)) || path.split(sep).some(part => SECRET_DIRS.includes(part.toLowerCase()))) return "that looks like a secret file and is never read";
  return null;
}

/** A path as a verify tool call names it, resolved: absolute, or relative to the first root that holds it. Symbolic links are followed
 * and the result must sit inside a root and pass the deny list; the message says why not. */
export function resolveRepositoryPath(reference: string, given: readonly string[]): { path: string } | { reason: string } {
  const roots = given.map(real);
  if (!roots.length) return { reason: "this session has no repository to read" };
  const candidates = isAbsolute(reference) ? [reference] : roots.map(root => join(root, reference));
  for (const candidate of candidates) {
    let path: string;
    try { path = realpathSync(candidate); } catch { continue; }
    if (!roots.some(root => path === root || path.startsWith(root + sep))) return { reason: `${reference} is outside the repositories you may read` };
    const denied = deniedPath(path);
    return denied ? { reason: `${reference}: ${denied}` } : { path };
  }
  return { reason: `${reference} does not exist under ${roots.join(", ")}` };
}

/** The `evidence:` form `<path>[:<line>[-<line>]]` (§5.4): the problem, or null when it names an existing file under a root. */
export function repositoryEvidenceProblem(reference: string, roots: readonly string[]): string | null {
  const pinned = /^(.*)@([0-9a-f]{7,40})$/.exec(reference);
  const match = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(pinned?.[1] ?? reference);
  if (!match) return "expected <path>[:<line>[-<line>]][@commit]";
  const resolved = resolveRepositoryPath(match[1]!, roots);
  if ("reason" in resolved) return resolved.reason;
  if (!statSync(resolved.path).isFile()) return `${match[1]} is not a file`;
  if (pinned) {
    try {
      const root = execFileSync("git", ["-C", dirname(resolved.path), "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      execFileSync("git", ["-C", root, "cat-file", "-e", `${pinned[2]}:${relative(root, resolved.path)}`], { stdio: "ignore" });
    } catch { return `${reference} is not a file at that repository commit`; }
  }
  return null;
}

/** One Grep or Glob call confined to the Dreamer's roots: the directory it searches, resolved, and for a Grep the exclusion of secret
 * files. Throws the reason a call is refused. */
export function confineSearch(input: { path?: unknown; glob?: unknown; pattern?: unknown }, roots: readonly string[], tool: "grep" | "glob"): { path: string; glob?: string } {
  if (!roots.length) throw new Error("Grep and Glob need an allowed Dreamer repository root; this session has none");
  if (typeof input.path !== "string" || !isAbsolute(input.path)) throw new Error(`name an absolute directory in path; allowed: ${roots.join(", ")}`);
  const resolved = resolveRepositoryPath(input.path, roots);
  if ("reason" in resolved) throw new Error(resolved.reason);
  if (tool === "glob") {
    if (typeof input.pattern !== "string" || isAbsolute(input.pattern) || input.pattern.split("/").includes("..")) throw new Error("a Glob pattern must be relative and stay inside path");
    return { path: resolved.path };
  }
  if (input.glob !== undefined) throw new Error("a Grep glob is not available here: narrow the search with path");
  // A protected directory that is a symbolic link into the searched tree is searched through its target, whose name the glob does not know.
  return { path: resolved.path, glob: secretGlob(protectedTrees().filter(tree => tree.startsWith(resolved.path + sep)).map(tree => relative(resolved.path, tree))) };
}
