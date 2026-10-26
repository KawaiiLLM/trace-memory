// Four independent conversations hand off files; each checked lane publishes atomically.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadPrompt } from "../prompts/load.ts";
import type { ToolNames } from "../prompts/tool-names.ts";
import type { WritingLimits } from "../model/index.ts";
import type { TraceMemoryConfig } from "../api/index.ts";
import { checkWorkspace, parseBlocks, type CheckResult, type Length, type NotingScope, type WorkspaceFile } from "../workspace/index.ts";
import { TaskWorkspace, defaultWorkspaceRoot, sweepStaleWorkspaces, type StopCheck } from "../workspace/run.ts";
import type { Store } from "../store/index.ts";
import { relatedFacts, relatedKnowledge } from "./retrieval.ts";

export const NOTING_TASKS = ["extract-facts", "check-facts", "write-knowledge", "check-knowledge"] as const;
export type NotingTask = typeof NOTING_TASKS[number];
export interface NotingFiles { facts: string; knowledge: string }
export { defaultWorkspaceRoot, sweepStaleWorkspaces, type StopCheck };
export type StagePrompts = Record<NotingTask, string>;
export const stagePromptFiles = {
  "extract-facts": "tasks/noting-write-facts.md",
  "check-facts": "tasks/noting-verify-facts.md",
  "write-knowledge": "tasks/noting-write-knowledge.md",
  "check-knowledge": "tasks/noting-verify-knowledge.md",
} as const;
export const stagePrompts = (names: ToolNames, limits: WritingLimits): StagePrompts =>
  Object.fromEntries(NOTING_TASKS.map(task => [task, loadPrompt(stagePromptFiles[task], names, limits)])) as StagePrompts;

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
const NO_PROBLEMS: CheckResult = { ok: true, problems: [], lengths: [] };

export class NotingWorkspace extends TaskWorkspace {
  readonly paths: NotingFiles;
  private task: NotingTask = "extract-facts";
  private announced = false;
  private repaired = false;
  private done = false;
  private failed = false;
  private before: NotingFiles = { facts: "", knowledge: "" };
  private checks: StopCheck[] = [];
  private responses = new Map<string, number | undefined>();
  private readonly store: Store;
  private readonly scope: NotingScope;
  private readonly prompts: StagePrompts;
  private readonly config: TraceMemoryConfig["noting"];

  constructor(store: Store, scope: NotingScope, root: string, sessionId: number,
    executionId: string, prompts: StagePrompts, config: TraceMemoryConfig["noting"], lane?: "facts" | "knowledge") {
    super(root, "noting-", sessionId, executionId, lane);
    this.store = store; this.scope = scope; this.prompts = prompts; this.config = config;
    this.paths = { facts: this.path("facts.md"), knowledge: this.path("knowledge.md") };
  }
  beginTask(task: NotingTask): void {
    this.task = task; this.announced = false; this.repaired = false; this.done = false; this.failed = false;
    this.checks = []; this.responses.clear(); this.before = this.read();
    if (task === "check-facts") writeFileSync(this.path("related-facts.md"), relatedFacts(this.store, this.scope, this.read().files.facts, this.config.relatedFacts));
    if (task === "check-knowledge") writeFileSync(this.path("related-knowledge.md"), relatedKnowledge(this.store, this.scope, this.read().files, this.config.relatedKnowledge));
  }
  reportResponse(id: string, inputTokens?: number): void { this.responses.set(id, inputTokens); }
  private budget() {
    const keys = { "extract-facts": "extractFacts", "check-facts": "checkFacts", "write-knowledge": "writeKnowledge", "check-knowledge": "checkKnowledge" } as const;
    const prefix = keys[this.task];
    const inputs = [...this.responses.values()], first = inputs[0], latest = inputs.at(-1);
    return { steps: inputs.length, growth: !inputs.length ? 0 : first === undefined || latest === undefined ? null : latest - first,
      stepBudget: this.config[`${prefix}Steps`], contextBudget: this.config[`${prefix}ContextTokens`] };
  }
  read(): NotingFiles & { files: { facts: WorkspaceFile; knowledge: WorkspaceFile } } {
    const facts = this.text("facts.md"), knowledge = this.text("knowledge.md");
    return { facts, knowledge, files: { facts: { name: "facts.md", text: facts }, knowledge: { name: "knowledge.md", text: knowledge } } };
  }
  noWork(): boolean {
    if (this.task !== "check-facts" && this.task !== "check-knowledge") return false;
    const { files } = this.read();
    const parsed = parseBlocks(this.task === "check-facts" ? files.facts : files.knowledge);
    return parsed.blocks.length === 1 && parsed.blocks[0]!.op === "none" && this.check().ok;
  }
  private verify() {
    const { facts: text, knowledge: knowledgeText, files } = this.read();
    const facts = checkWorkspace(this.store, { kind: "noting-facts", scope: this.scope, file: files.facts, checked: this.task !== "extract-facts" });
    const knowledge = this.task === "write-knowledge" || this.task === "check-knowledge"
      ? checkWorkspace(this.store, { kind: "noting-knowledge", scope: this.scope, file: files.knowledge, facts: files.facts,
        checked: this.task === "check-knowledge", allowFlags: this.task === "check-knowledge" }) : NO_PROBLEMS;
    const frozen = this.task === "write-knowledge" || this.task === "check-knowledge"
      ? text !== this.before.facts ? ["facts.md: changed after check facts passed; restore it as it was"] : []
      : knowledgeText !== this.before.knowledge ? ["knowledge.md: this stage may change only facts.md; restore it as it was"] : [];
    const problems = [...facts.problems, ...knowledge.problems, ...frozen];
    return { ok: !problems.length, problems, facts, knowledge };
  }
  check(): StopCheck { const { ok, problems } = this.verify(); return { ok, problems }; }
  private report(result: { problems: string[]; facts: CheckResult; knowledge: CheckResult }): string {
    const facts = this.task === "extract-facts" || this.task === "check-facts";
    const retrieval = this.task === "check-facts" ? this.path("related-facts.md") : this.task === "check-knowledge" ? this.path("related-knowledge.md") : undefined;
    const budget = this.budget();
    const prompt = this.announced ? "" : this.prompts[this.task]; this.announced = true;
    return [`Task: ${this.task} (stage ${NOTING_TASKS.indexOf(this.task) + 1} of 4). File: ${facts ? this.paths.facts : this.paths.knowledge}`,
      `Inputs: ${this.paths.facts}${retrieval ? `, ${retrieval}` : ""}`,
      `Budget: steps ${budget.steps} of ${budget.stepBudget}, context +${budget.growth ?? "unknown"} of +${budget.contextBudget}. In principle stay within both budgets; a step is one model response, even with several tool calls.`,
      result.problems.length ? `Problems: ${result.problems.length}\n${result.problems.join("\n")}` : "Problems: none",
      ...lengthLines("facts.md", result.facts.lengths), ...lengthLines("knowledge.md", result.knowledge.lengths), prompt].filter(Boolean).join("\n");
  }
  checkTool(): string { return this.report(this.verify()); }
  passEnd(): string | undefined {
    if (this.closed || this.failed || this.done) return undefined;
    const result = this.verify(); this.checks.push({ ok: result.ok, problems: result.problems });
    if (result.ok) { this.done = true; return undefined; }
    if (this.repaired) { this.failed = true; return undefined; }
    this.repaired = true;
    return `Your files do not pass the check. Correct every problem below, then stop. A second failure fails this stage; earlier passed stage files are kept for a later retry.\n\n${this.report(result)}`;
  }
  unfinished(): string | undefined { return this.failed ? `check failed twice: ${this.task}` : this.done ? undefined : `ended before ${this.task} passed`; }
  record() {
    return { steps: [{ step: 1, stopChecks: this.checks }], budget: this.budget(),
      taskPrompts: this.announced ? [{ step: 1, hash: createHash("sha256").update(this.prompts[this.task]).digest("hex") }] : [] };
  }
}
