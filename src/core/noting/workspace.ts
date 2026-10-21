// The Noter's run workspace (ticket 144, Stage 3): a directory with the two files its two tasks hand over, the one
// check both tasks and the stop hook run on them, and the messages that check produces. The directory is scratch;
// the database holds what must survive (the first task's run body and the hand-off row).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkspace, type CheckResult, type Length, type NotingScope, type WorkspaceFile } from "../workspace/index.ts";
import type { Store } from "../store/index.ts";

export type NotingTask = "write" | "verify";
export interface NotingFiles { facts: string; knowledge: string }

/** Where a host that names no root has its workspaces. */
export const defaultWorkspaceRoot = (): string => join(tmpdir(), "trace-memory-workspaces");

const PREFIX = "noting-";
/** The directory is far older than any claim lease (30 minutes) by then, so nothing live is removed. */
const STALE_MS = 24 * 60 * 60 * 1000;
/** Remove workspaces a crashed executor left behind. A workspace being swept is never one a live run uses. */
export function sweepStaleWorkspaces(root: string, now = Date.now()): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(root, name);
    try { if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true }); } catch { /* another sweeper took it */ }
  }
}

const TASK_LINE: Record<NotingTask, string> = {
  write: "write (task 1 of 2: record the batch's facts, then its knowledge)",
  verify: "verify (task 2 of 2: correct task 1's files, facts first)",
};
const CONSEQUENCE: Record<NotingTask, string> = {
  write: "this task fails and nothing from this batch is kept",
  verify: "this task fails and task 1's files are kept for a later retry",
};

/** One line per block: `facts.md block 1 \`## fact f1\`: title 9/20, body 204/200 (over)`. */
function lengthLines(file: string, lengths: readonly Length[]): string[] {
  const lines: string[] = [], seen = new Map<string, number>();
  for (const { block, field, count, limit } of lengths) {
    const part = `${field} ${count}/${limit}${count > limit ? " (over)" : ""}`;
    const at = seen.get(block);
    if (at === undefined) { seen.set(block, lines.length); lines.push(`${file} ${block}: ${part}`); }
    else lines[at] += `, ${part}`;
  }
  return lines;
}

export interface StopCheck { ok: boolean; problems: string[] }

export class NotingWorkspace {
  readonly dir: string;
  readonly paths: NotingFiles;
  private readonly store: Store;
  private readonly scope: NotingScope;
  readonly stopChecks: StopCheck[] = [];

  constructor(store: Store, scope: NotingScope, root: string, sessionId: number, executionId: string) {
    this.store = store; this.scope = scope;
    this.dir = join(root, `${PREFIX}S${sessionId}-${executionId.slice(0, 8)}`);
    this.paths = { facts: join(this.dir, "facts.md"), knowledge: join(this.dir, "knowledge.md") };
  }

  /** Create the directory, with the files a resumed run starts from. A fresh write task starts with none. */
  open(seed?: NotingFiles): this {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (seed) { writeFileSync(this.paths.facts, seed.facts); writeFileSync(this.paths.knowledge, seed.knowledge); }
    return this;
  }

  remove(): void { rmSync(this.dir, { recursive: true, force: true }); }

  /** The files as they are; a file the task never wrote reads as empty. */
  read(): NotingFiles & { files: { facts: WorkspaceFile; knowledge: WorkspaceFile } } {
    const text = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : "";
    const facts = text(this.paths.facts), knowledge = text(this.paths.knowledge);
    return { facts, knowledge, files: { facts: { name: "facts.md", text: facts }, knowledge: { name: "knowledge.md", text: knowledge } } };
  }

  /** The check both tasks, the `check` tool and the stop hook share: the facts file, then the knowledge file read with it. */
  check(): { ok: boolean; problems: string[]; facts: CheckResult; knowledge: CheckResult } {
    const { files } = this.read();
    const facts = checkWorkspace(this.store, { kind: "noting-facts", scope: this.scope, file: files.facts });
    const knowledge = checkWorkspace(this.store, { kind: "noting-knowledge", scope: this.scope, file: files.knowledge, facts: files.facts });
    return { ok: facts.ok && knowledge.ok, problems: [...facts.problems, ...knowledge.problems], facts, knowledge };
  }

  /** What `check` returns: the task and its files, the problems with file and line, and every title and body length. */
  report(task: NotingTask, result = this.check()): string {
    return [`Task: ${TASK_LINE[task]}. Files: ${this.paths.facts}, ${this.paths.knowledge}`,
      result.problems.length ? `Problems: ${result.problems.length}\n${result.problems.join("\n")}` : "Problems: none",
      ...(result.facts.lengths.length + result.knowledge.lengths.length
        ? ["Lengths:", ...lengthLines("facts.md", result.facts.lengths), ...lengthLines("knowledge.md", result.knowledge.lengths)] : [])].join("\n");
  }

  /** The stop hook: nothing to say when the files pass; otherwise the one follow-up that lists what to correct. */
  passEnd(task: NotingTask): string | undefined {
    const result = this.check();
    this.stopChecks.push({ ok: result.ok, problems: result.problems });
    if (result.ok) return undefined;
    return `Your files do not pass the check. Correct every problem below, then stop. If they still fail, ${CONSEQUENCE[task]}.\n\n${this.report(task, result)}`;
  }
}
