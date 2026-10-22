// The repositories curate and verify may read (ticket 144 stage 4 §5.4, stage 5 §3.7): one function names the allowed roots, one deny list applies to
// Read, Grep, Glob and to the files `evidence:` cites. Both hosts and the file check call these and nothing else.

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { Store } from "../store/index.ts";

/** The roots are the working directories of the project's sessions (user rulings, 2026-10-22 and 2026-10-23): a session's
 * `directory` (the repository root ticket 62 resolved) when it has one, otherwise the directory it started in
 * (`start_directory`, so a session started in the home directory reads the whole home directory). A directory that is gone
 * cannot be read and is left out. */
export function allowedRoots(store: Store, sessionId: number): string[] {
  const projectId = store.getSession(sessionId)!.projectId;
  const roots = new Set<string>();
  for (const row of store.db.prepare("SELECT DISTINCT COALESCE(directory, start_directory) AS root FROM sessions WHERE project_id = ? AND COALESCE(directory, start_directory) IS NOT NULL").all(projectId)) {
    try { roots.add(realpathSync(String(row.root))); } catch { /* a directory that is gone cannot be read */ }
  }
  return [...roots].sort();
}

const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const SECRET_FILES = [".env", ".env.*", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".netrc", ".npmrc", "credentials", "credentials.json", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore"];
const SECRET_DIRS = [".ssh", ".aws", ".gnupg"];
/** The production memory directory and the Pi agent directory, relative to home (`deniedPath` holds them to the exact home). A Grep rooted
 * at home would otherwise search them, so the exclusion names them too (any directory of the same name is skipped as well). */
const DENIED_TREES = [".trace-memory", ".pi/agent"];
const SECRET = new RegExp(`^(?:${SECRET_FILES.map(name => name.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")).join("|")})$`, "i");
/** The same list as a ripgrep exclusion, for a Grep call (a hook can only allow or rewrite a call, never filter its output). */
export const SECRET_GLOB = `!**/{${[...SECRET_FILES, ...SECRET_DIRS.map(name => `${name}/**`), ...DENIED_TREES.map(tree => `${tree}/**`)].join(",")}}`;

/** The one deny list: the production memory directory, the Pi agent directory and secret files. A symlink out of the roots is
 * refused by `resolveRepositoryPath`, which tests the resolved path. */
export function deniedPath(path: string): string | null {
  const home = real(homedir());
  for (const forbidden of DENIED_TREES.map(tree => join(home, ...tree.split("/"))))
    if (path === forbidden || path.startsWith(forbidden + sep)) return "that directory holds the memory database or agent configuration and is never read";
  if (SECRET.test(basename(path)) || path.split(sep).some(part => SECRET_DIRS.includes(part))) return "that looks like a secret file and is never read";
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
  const match = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(reference);
  if (!match) return "expected <path>[:<line>[-<line>]]";
  const resolved = resolveRepositoryPath(match[1]!, roots);
  if ("reason" in resolved) return resolved.reason;
  return statSync(resolved.path).isFile() ? null : `${match[1]} is not a file`;
}

/** One Grep or Glob call confined to the roots (curate and verify): the directory it searches, resolved, and for a Grep the exclusion of secret
 * files. Throws the reason a call is refused. */
export function confineSearch(input: { path?: unknown; glob?: unknown; pattern?: unknown }, roots: readonly string[], tool: "grep" | "glob"): { path: string; glob?: string } {
  if (!roots.length) throw new Error("Grep and Glob read repositories during curate and verify only, and this session has none");
  if (typeof input.path !== "string" || !isAbsolute(input.path)) throw new Error(`name an absolute directory in path; allowed: ${roots.join(", ")}`);
  const resolved = resolveRepositoryPath(input.path, roots);
  if ("reason" in resolved) throw new Error(resolved.reason);
  if (tool === "glob") {
    if (typeof input.pattern !== "string" || isAbsolute(input.pattern) || input.pattern.split("/").includes("..")) throw new Error("a Glob pattern must be relative and stay inside path");
    return { path: resolved.path };
  }
  if (input.glob !== undefined) throw new Error("a Grep glob is not available here: narrow the search with path");
  return { path: resolved.path, glob: SECRET_GLOB };
}
