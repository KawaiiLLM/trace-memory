// The Noter's run workspace (ticket 144, Stages 3 and 5): a directory with the two files its two tasks hand over, the step
// machine of each task, the one check its steps and the stop hook run, and the messages that check produces. The directory is scratch;
// the database holds what must survive (the first task's run body and the hand-off row).

import { createHash } from "node:crypto";
import { loadPrompt } from "../prompts/load.ts";
import type { ToolNames } from "../prompts/tool-names.ts";
import type { WritingLimits } from "../model/index.ts";
import { checkWorkspace, type CheckResult, type Length, type NotingScope, type WorkspaceFile } from "../workspace/index.ts";
import { TaskWorkspace, defaultWorkspaceRoot, sweepStaleWorkspaces, type StopCheck } from "../workspace/run.ts";
import type { Store } from "../store/index.ts";

export type NotingTask = "write" | "verify";
export type NotingStep = 1 | 2;
export interface NotingFiles { facts: string; knowledge: string }
export { defaultWorkspaceRoot, sweepStaleWorkspaces, type StopCheck };

/** The instructions of each task's two steps, tool names and limits filled in. They reach the model only through the first
 * `check` result of a step, a repair message or a step-advance message (stage 5 §0). */
export type StepPrompts = Record<NotingTask, readonly [string, string]>;
export const stepPromptFiles = {
  write: ["tasks/noting-write-facts.md", "tasks/noting-write-knowledge.md"],
  verify: ["tasks/noting-verify-facts.md", "tasks/noting-verify-knowledge.md"],
} as const;
export const stepPrompts = (names: ToolNames, limits: WritingLimits): StepPrompts => ({
  write: [loadPrompt(stepPromptFiles.write[0], names, limits), loadPrompt(stepPromptFiles.write[1], names, limits)],
  verify: [loadPrompt(stepPromptFiles.verify[0], names, limits), loadPrompt(stepPromptFiles.verify[1], names, limits)],
});

const TASK_LINE: Record<NotingTask, string> = {
  write: "write (task 1 of 2: record the batch's facts, then its knowledge)",
  verify: "verify (task 2 of 2: correct task 1's files, facts first)",
};
const STEP_NAME = { 1: "facts", 2: "knowledge" } as const;
const CONSEQUENCE: Record<NotingTask, string> = {
  write: "this task fails and nothing from this batch is kept",
  verify: "this task fails and task 1's files are kept for a later retry",
};

/** One line per block: `facts.md block 1 \`## fact f1\`: title 9/20 units (limit 22), body 224/200 units (limit 220, over)`. */
export function lengthLines(file: string, lengths: readonly Length[]): string[] {
  const lines: string[] = [], seen = new Map<string, number>();
  for (const { block, field, count, target, limit } of lengths) {
    const part = `${field} ${count}/${target} units (limit ${limit}${count > limit ? ", over" : ""})`;
    const at = seen.get(block);
    if (at === undefined) { seen.set(block, lines.length); lines.push(`${file} ${block}: ${part}`); }
    else lines[at] += `, ${part}`;
  }
  return lines;
}

/** All step state of one task (stage 5 §1.2). `beginTask` replaces it, so nothing leaks from write into verify. */
interface TaskSteps {
  task: NotingTask; step: NotingStep;
  announced: Set<NotingStep>;
  repaired: Record<NotingStep, boolean>;
  /** The facts file as it was when step 1 passed: step 2 may not change it. */
  factsAtStep1: string | null;
  done: boolean;
  /** Terminal: once set, no later stop re-runs a step or reopens the task. */
  failed: string | null;
  stopChecks: { step: NotingStep; ok: boolean; problems: string[] }[];
}
const NO_PROBLEMS: CheckResult = { ok: true, problems: [], lengths: [] };

export class NotingWorkspace extends TaskWorkspace {
  readonly paths: NotingFiles;
  private readonly store: Store;
  private readonly scope: NotingScope;
  private readonly prompts: StepPrompts;
  private steps: TaskSteps;

  constructor(store: Store, scope: NotingScope, root: string, sessionId: number, executionId: string, prompts: StepPrompts) {
    super(root, "noting-", sessionId, executionId);
    this.store = store; this.scope = scope; this.prompts = prompts;
    this.paths = { facts: this.path("facts.md"), knowledge: this.path("knowledge.md") };
    this.steps = this.fresh("write");
  }

  private fresh(task: NotingTask): TaskSteps {
    return { task, step: 1, announced: new Set(), repaired: { 1: false, 2: false }, factsAtStep1: null, done: false, failed: null, stopChecks: [] };
  }
  /** A task starts at step 1 with nothing announced. The files on disk and the cancellation fence are kept across tasks. */
  beginTask(task: NotingTask): void { this.steps = this.fresh(task); }

  /** The files as they are; a file the task never wrote reads as empty. */
  read(): NotingFiles & { files: { facts: WorkspaceFile; knowledge: WorkspaceFile } } {
    const facts = this.text("facts.md"), knowledge = this.text("knowledge.md");
    return { facts, knowledge, files: { facts: { name: "facts.md", text: facts }, knowledge: { name: "knowledge.md", text: knowledge } } };
  }

  /** The check of the current step, pure: step 1 reads the facts file; step 2 also reads the knowledge file against it and
   * requires the facts file to be what passed step 1 (Q10). `both` reads the knowledge file at any step. */
  private verify(both = false): { ok: boolean; problems: string[]; facts: CheckResult; knowledge: CheckResult; text: string } {
    const { facts: text, files } = this.read(), { step, factsAtStep1 } = this.steps;
    const facts = checkWorkspace(this.store, { kind: "noting-facts", scope: this.scope, file: files.facts });
    const knowledge = both || step === 2 ? checkWorkspace(this.store, { kind: "noting-knowledge", scope: this.scope, file: files.knowledge, facts: files.facts }) : NO_PROBLEMS;
    const frozen = factsAtStep1 !== null && text !== factsAtStep1 ? ["facts.md: changed after step 1 passed; step 2 may not change it, restore it as it was"] : [];
    const problems = [...facts.problems, ...frozen, ...knowledge.problems];
    return { ok: !problems.length, problems, facts, knowledge, text };
  }

  /** The check core runs once more after the host returns: the step check over both files, so a facts file rewritten after the
   * steps passed fails the task. */
  check(): { ok: boolean; problems: string[] } { const { ok, problems } = this.verify(true); return { ok, problems }; }

  /** A step's instructions, once: the text if this step's have not been carried by a message yet, and the call marks them
   * carried. Only code that is composing a message for the model calls it. */
  private deliver(step: NotingStep): string {
    if (this.steps.announced.has(step)) return "";
    this.steps.announced.add(step);
    return this.prompts[this.steps.task][step - 1]!;
  }

  private header(): string {
    const { task, step } = this.steps;
    return `Task: ${TASK_LINE[task]}. Step ${step} of 2 (${STEP_NAME[step]}). File: ${step === 1 ? this.paths.facts : this.paths.knowledge}`
      + (step === 2 ? `. The facts file ${this.paths.facts} is fixed` : "");
  }

  /** What `check` returns: the task, step and file, the problems with file and line, every title and body length, and the
   * step's instructions the first time. */
  private report(result: { problems: string[]; facts: CheckResult; knowledge: CheckResult }): string {
    const lengths = [...lengthLines("facts.md", result.facts.lengths), ...lengthLines("knowledge.md", result.knowledge.lengths)];
    return [this.header(),
      result.problems.length ? `Problems: ${result.problems.length}\n${result.problems.join("\n")}` : "Problems: none",
      ...(lengths.length ? ["Lengths:", ...lengths] : []), this.deliver(this.steps.step)].filter(Boolean).join("\n");
  }
  checkTool(): string { return this.report(this.verify()); }

  /** The stop hook: nothing to say when the step passes at step 2 or the task is over; otherwise the one repair of the
   * step, or the next step's instructions. A second failure of a step is terminal. */
  passEnd(): string | undefined {
    const s = this.steps;
    if (this.closed || s.failed || s.done) return undefined;
    const result = this.verify();
    s.stopChecks.push({ step: s.step, ok: result.ok, problems: result.problems });
    if (!result.ok) {
      if (s.repaired[s.step]) { s.failed = `check failed twice: step ${s.step}`; return undefined; }
      s.repaired[s.step] = true;
      return `Your files do not pass the check. Correct every problem below, then stop. If it still fails, ${CONSEQUENCE[s.task]}.\n\n${this.report(result)}`;
    }
    if (s.step === 2) { s.done = true; return undefined; }
    s.factsAtStep1 = result.text; s.step = 2;
    return ["Step 1 passed.", this.header(), this.deliver(2)].filter(Boolean).join("\n\n");
  }

  /** Why the task did not finish its two steps, or nothing when it did. */
  unfinished(): string | undefined { return this.steps.failed ?? (this.steps.done ? undefined : `ended at step ${this.steps.step}`); }
  /** The audit of the task: each step's stop checks, and a hash of every step prompt a message carried. */
  record() {
    const { stopChecks, announced, task } = this.steps;
    return { steps: ([1, 2] as const).filter(step => stopChecks.some(c => c.step === step))
        .map(step => ({ step, stopChecks: stopChecks.filter(c => c.step === step).map(({ ok, problems }) => ({ ok, problems })) })),
      taskPrompts: [...announced].sort().map(step => ({ step, hash: createHash("sha256").update(this.prompts[task][step - 1]!).digest("hex") })) };
  }
}
