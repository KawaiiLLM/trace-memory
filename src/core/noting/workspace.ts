// The Noter's run workspace (ticket 144, Stage 3): a directory with the two files its two tasks hand over, the one
// check both tasks and the stop hook run on them, and the messages that check produces. The directory is scratch;
// the database holds what must survive (the first task's run body and the hand-off row).

import { join } from "node:path";
import { checkWorkspace, type CheckResult, type Length, type NotingScope, type WorkspaceFile } from "../workspace/index.ts";
import { TaskWorkspace, defaultWorkspaceRoot, sweepStaleWorkspaces, type StopCheck } from "../workspace/run.ts";
import type { Store } from "../store/index.ts";

export type NotingTask = "write" | "verify";
export interface NotingFiles { facts: string; knowledge: string }
export { defaultWorkspaceRoot, sweepStaleWorkspaces, type StopCheck };

const TASK_LINE: Record<NotingTask, string> = {
  write: "write (task 1 of 2: record the batch's facts, then its knowledge)",
  verify: "verify (task 2 of 2: correct task 1's files, facts first)",
};
const CONSEQUENCE: Record<NotingTask, string> = {
  write: "this task fails and nothing from this batch is kept",
  verify: "this task fails and task 1's files are kept for a later retry",
};

/** One line per block: `facts.md block 1 \`## fact f1\`: title 9/20, body 204/200 (over)`. */
export function lengthLines(file: string, lengths: readonly Length[]): string[] {
  const lines: string[] = [], seen = new Map<string, number>();
  for (const { block, field, count, limit } of lengths) {
    const part = `${field} ${count}/${limit}${count > limit ? " (over)" : ""}`;
    const at = seen.get(block);
    if (at === undefined) { seen.set(block, lines.length); lines.push(`${file} ${block}: ${part}`); }
    else lines[at] += `, ${part}`;
  }
  return lines;
}

export class NotingWorkspace extends TaskWorkspace {
  readonly paths: NotingFiles;
  private readonly store: Store;
  private readonly scope: NotingScope;

  constructor(store: Store, scope: NotingScope, root: string, sessionId: number, executionId: string) {
    super(root, "noting-", sessionId, executionId);
    this.store = store; this.scope = scope;
    this.paths = { facts: this.path("facts.md"), knowledge: this.path("knowledge.md") };
  }

  /** The files as they are; a file the task never wrote reads as empty. */
  read(): NotingFiles & { files: { facts: WorkspaceFile; knowledge: WorkspaceFile } } {
    const facts = this.text("facts.md"), knowledge = this.text("knowledge.md");
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
    let result: ReturnType<NotingWorkspace["check"]>;
    return this.stop(() => (result = this.check()),
      () => `Your files do not pass the check. Correct every problem below, then stop. If they still fail, ${CONSEQUENCE[task]}.\n\n${this.report(task, result)}`);
  }
}
