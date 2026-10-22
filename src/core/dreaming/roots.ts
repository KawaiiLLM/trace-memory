// The repositories verify may read (ticket 144 stage 4 §5.4, §12 Q3): one function names the allowed roots, one deny list applies to
// Read, Grep, Glob and to the files `evidence:` cites. Both hosts and the file check call these and nothing else.

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { Store } from "../store/index.ts";

/** PENDING Q3: the maintainer has not chosen the roots. This is the recommended option A, the directories of the project's sessions
 * (`sessions.directory`); B (the session's own directory) or C (any path) change this function only. */
export function allowedRoots(store: Store, sessionId: number): string[] {
  const projectId = store.getSession(sessionId)!.projectId;
  const roots = new Set<string>();
  for (const row of store.db.prepare("SELECT DISTINCT directory FROM sessions WHERE project_id = ? AND directory IS NOT NULL").all(projectId)) {
    try { roots.add(realpathSync(String(row.directory))); } catch { /* a directory that is gone cannot be read */ }
  }
  return [...roots].sort();
}

const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const SECRET = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.netrc|\.npmrc|credentials(?:\.json)?)$|\.(?:pem|key|p12|pfx|keystore)$/i;
const SECRET_DIRS = [".ssh", ".aws", ".gnupg"];

/** The one deny list: the production memory directory, the Pi agent directory and secret files. A symlink out of the roots is
 * refused by `resolveRepositoryPath`, which tests the resolved path. */
export function deniedPath(path: string): string | null {
  const home = real(homedir());
  for (const forbidden of [join(home, ".trace-memory"), join(home, ".pi", "agent")])
    if (path === forbidden || path.startsWith(forbidden + sep)) return "that directory holds the memory database or agent configuration and is never read";
  if (SECRET.test(basename(path)) || path.split(sep).some(part => SECRET_DIRS.includes(part))) return "that looks like a secret file and is never read";
  return null;
}

/** A path as a verify tool call names it, resolved: absolute, or relative to the first root that holds it. Symbolic links are followed
 * and the result must sit inside a root and pass the deny list; the message says why not. */
export function resolveRepositoryPath(reference: string, roots: readonly string[]): { path: string } | { reason: string } {
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
