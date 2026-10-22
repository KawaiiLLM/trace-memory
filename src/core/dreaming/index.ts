// Dreaming as curate, verify and classify (ticket 144, stage 4). One run is one admission, one claim and one execution; it
// runs from the hand-off's next task to the end, each task through `runAgent`. This module owns the run shape (§1), the
// hand-off and resume (§3), the curate task (§4), verify (§5) and classify (§6).

import { createHash } from "node:crypto";
import { KNOWLEDGE_CATEGORIES } from "../model/index.ts";
import { loadPrompt } from "../prompts/load.ts";
import { canonicalToolNames, renderToolNames, validateToolNames, type ToolNames } from "../prompts/tool-names.ts";
import { readingGuide } from "../render/reading-guide.ts";
import { withRetrievalPolicy } from "../render/retrieval-policy.ts";
import { tokens } from "../render/index.ts";
import { dreamingWorkspaceToolDefinitions, pricedToolDefinitions, type bindTools } from "../api/tools.ts";
import { agentException, recordAttempt, requestMissing } from "../api/audit.ts";
import type { AgentControl, RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index.ts";
import type { NotingInput } from "../noting/index.ts";
import { lengthLines } from "../noting/workspace.ts";
import type { Length } from "../workspace/index.ts";
import type { Handoff } from "../store/executions.ts";
import type { KnowledgePath, RunInput, Store, TaskClaim } from "../store/index.ts";
import { checkWorkspace, describeBlock, parseScores } from "../workspace/index.ts";
import { TaskWorkspace, defaultWorkspaceRoot } from "../workspace/run.ts";
import { batchFileName, checkBatch, curatePrefix, type Category, type CurateItem } from "./curate.ts";
import { buildChanges, checkVerify } from "./changes.ts";
import { classifyAnchors, classifyMessage, classifySet } from "./classify.ts";
import { allowedRoots, repositoryEvidenceProblem } from "./roots.ts";

export type DreamingTask = "curate" | "verify" | "classify";
/** One version a passing task covers; `pool` is the pool it had when the run's input was frozen, absent for a version the run wrote. */
type Cover = { id: number; pool?: string };
export const DREAMING_TASKS: readonly DreamingTask[] = ["curate", "verify", "classify"];

/** The allowance for core's own work between two model calls (§1.3): the execution backstop is set this far past the last task deadline. */
export const TASK_GAP_MS = 15_000;
/** 104 F1: the claim lease outlives the execution backstop by this margin, so the terminal settlement still finds the claim. */
export const CLAIM_LEASE_MARGIN_MS = 60_000;
/** The one line that ends the first message of every task (§1.4): task, batch and files reach the model only through `check`. */
const CHECK_FIRST = "Call {{tool.check}} first: it names your task and your files.";

/** A Dreamer task's frozen model settings (§1.2); `thinking` is opaque to core. */
export interface DreamingTaskConfig { model: string; thinking?: string; capacity?: { inputTokens: number } }
export interface DreamingInput extends Omit<NotingInput, "boundary"> {
  /** The classify task's own model, thinking level and capacity; absent, it follows the main triple. */
  classify?: { model?: string; thinkingLevel?: string; capacity?: { inputTokens: number } };
}
export type DreamingResult = { automaticOff?: string } & (
  | { outcome: "empty" }
  | { outcome: "dropped"; reason?: string }
  | { outcome: "success" | "failure" | "cancelled"; runId: number; problems: string[];
      /** A failure's task, its class (§3.3) and whether Magic Context's rule retries it. */
      failure?: { task: DreamingTask; class: string; transient: boolean } });

/** What core builds for one Dreaming task call. */
export interface DreamingAgentInput extends AgentControl {
  kind: "dreaming"; task: DreamingTask; sessionId: number; branch: string; model: string; thinking?: string; mode: "subagent";
  prompt: string; promptHash: string; text: string;
  tools: import("../api/tools.ts").ToolDefinition[];
  /** The task's directory and the files its host-side tools may read and write; `roots` are repositories verify may read (part 3). */
  workspace: { dir: string; read: string[]; write: string[]; roots: string[] };
  /** The stop hook, called after every normally completed pass: a string authorizes one more pass, `undefined` ends the task. */
  passEnd(): string | undefined;
  acknowledgeRequest(): void;
  reportRequest(request: unknown): void;
  /** Absolute epoch ms; read by core's runner wrapper (§1.3). */
  deadline: number;
}

export interface DreamingFrozen {
  sessionId: number; branch: string; path: KnowledgePath; claim: TaskClaim; names: ToolNames;
  prompt: string; promptHash: string; text: string;
  models: { main: DreamingTaskConfig; classify: DreamingTaskConfig };
  items: CurateItem[]; byCategory: Map<Category, CurateItem[]>;
  /** The hand-off row read at admission: where this run resumes, and which curate batches are applied. */
  handoff: Handoff | null;
}

export const remainingTasks = (next: string | undefined): number => DREAMING_TASKS.length - Math.max(0, DREAMING_TASKS.indexOf(next as DreamingTask));
/** §1.3: every task may take `timeoutMs`; the backstop is the tasks left plus one gap per task and one more. */
export const executionLimitMs = (remaining: number, timeoutMs: number) => remaining * timeoutMs + (remaining + 1) * TASK_GAP_MS;

/** Material for the run, read inside the admission transaction. */
export function prepareDreaming(store: Store, input: DreamingInput, config: TraceMemoryConfig, claim: TaskClaim,
  path: KnowledgePath & { branch: string; headTurnId: number }): DreamingFrozen {
  if (store.getSession(path.sessionId)!.host.startsWith("cc:") && !input.toolNames) throw new Error("CC Dreamer launch requires exposed tool names");
  if (input.nativeReadToolTokens !== undefined && (!Number.isSafeInteger(input.nativeReadToolTokens) || input.nativeReadToolTokens < 0))
    throw new Error("Invalid native Read token estimate: expected a nonnegative safe integer");
  const names = validateToolNames(input.toolNames ?? canonicalToolNames);
  const { text: knowledge, byCategory } = curatePrefix(store, path);
  const text = [readingGuide(path.sessionId, names), knowledge, renderToolNames(CHECK_FIRST, names)].join("\n\n");
  // curate and verify share this prompt (and the first message) so verify's first request reads the cache curate wrote (§1.4).
  const prompt = withRetrievalPolicy(loadPrompt("dreaming.md", names, config.writing), names);
  const main: DreamingTaskConfig = { model: input.model ?? "session", thinking: input.subagentThinkingLevel ?? input.thinkingLevel, capacity: input.capacity };
  const classify: DreamingTaskConfig = { model: input.classify?.model ?? main.model, thinking: input.classify?.thinkingLevel ?? main.thinking,
    capacity: input.classify?.capacity ?? main.capacity };
  if (main.capacity) {
    const tools = tokens(JSON.stringify(pricedToolDefinitions(dreamingWorkspaceToolDefinitions, names))) + (input.nativeReadToolTokens ?? 0) + (input.nativeWriteToolTokens ?? 0);
    if (!Number.isSafeInteger(main.capacity.inputTokens) || main.capacity.inputTokens < 0 || tokens(prompt) + tools + tokens(text) > main.capacity.inputTokens)
      throw new Error("Dreaming capacity: the knowledge prefix and tools exceed the model input allowance; left pending");
  }
  return { sessionId: path.sessionId, branch: path.branch, path, claim, names, prompt, promptHash: createHash("sha256").update(prompt).digest("hex"),
    text, models: { main, classify }, items: [...byCategory.values()].flat(), byCategory, handoff: store.handoff(path.sessionId, "dreaming") };
}

export interface DreamingRunOptions {
  workspaceRoot?: string; executionId: string;
  /** Registers a workspace with the cancellation fence (§1.5): closing the task closes it. */
  registerFence(workspace: { close(): void }): void;
}
type Bind = (context: Parameters<typeof bindTools>[2], run: RunInput, writer?: Parameters<typeof bindTools>[5]) => ReturnType<typeof bindTools>;
type TaskOutcome = { ok: true; runId: number } | { ok: false; outcome: "failure" | "cancelled"; runId: number; problems: string[]; class: string; transient: boolean };

/** Magic Context's `classifyFailure`: a provider, network, store or deadline error is transient; anything else is not. */
const TRANSIENT = /abort|lease|timeout|timed out|econn|socket|network|rate.?limit|429|503|overloaded|sqlite_busy|database is locked/i;
export function classifyFailure(output: unknown, failureClass?: string): { class: string; transient: boolean } {
  if (failureClass === "timeout") return { class: "timeout", transient: true };
  const message = String(output ?? "");
  if (/sqlite_busy|database is locked/i.test(message)) return { class: "store error", transient: true };
  if (/model.*not found|unknown model/i.test(message)) return { class: "model not found", transient: false };
  if (TRANSIENT.test(message)) return { class: "provider error", transient: true };
  return { class: "error", transient: false };
}

const CLAIM_LOST = /task claim is no longer current and unexpired/;

export async function runDreaming(store: Store, frozen: DreamingFrozen, runAgent: RunAgent, config: TraceMemoryConfig, bind: Bind,
  options: DreamingRunOptions): Promise<DreamingResult> {
  const { sessionId, branch, path } = frozen;
  const first = Math.max(0, DREAMING_TASKS.indexOf((frozen.handoff?.nextTask ?? "curate") as DreamingTask));
  const detail = { curateRuns: [...(frozen.handoff?.detail?.curateRuns ?? [])], doneCategories: [...(frozen.handoff?.detail?.doneCategories ?? [])] };
  const root = options.workspaceRoot ?? defaultWorkspaceRoot();
  const template = (task: DreamingTask, model: string, promptHash = frozen.promptHash): RunInput => ({ kind: "dreaming", sessionId, branch, model, mode: "subagent",
    promptHash, createdAt: new Date().toISOString(), rangeFrom: `S${sessionId}/${task}`, rangeTo: `S${sessionId}/${task}` });
  const context = { kind: "dreaming" as const, sessionId, branch, headTurnId: path.headTurnId, range: { from: `S${sessionId}`, to: `S${sessionId}` } };
  let lastRunId = 0;

  /** A task that does no model call: its run is recorded and the hand-off moves (§3.2 no-work run). */
  const noWork = (task: DreamingTask, next: DreamingTask | null, cover?: () => Cover[]): TaskOutcome => {
    const run = template(task, frozen.models.main.model);
    const bound = bind(context, run, { check: () => "no work" });
    bound.close(); // the run record only; it has no tools to run
    const done = store.commitTaskPass({ run: { ...run, response: JSON.stringify({ task, passes: 0 }) }, path, cover,
      handoff: () => next ? { nextTask: next, detail: { ...detail } } : null });
    return { ok: true, runId: lastRunId = done.runId };
  };

  const runCurate = async (): Promise<TaskOutcome> => {
    const batches = KNOWLEDGE_CATEGORIES.filter(category => frozen.byCategory.get(category)!.length && !detail.doneCategories.includes(category));
    const written = (runIds: number[]): Cover[] => runIds.flatMap(id => store.listCommitsByRun(id).map(revision => ({ id: revision.id })));
    const coveredBy = (runIds: number[]) => runIds.flatMap(id => (JSON.parse(store.getRun(id)?.response ?? "{}").covers ?? []) as Cover[]);
    if (!batches.length) return noWork("curate", "verify", () => [...coveredBy(detail.curateRuns), ...written(detail.curateRuns)]);

    const workspace = new TaskWorkspace(root, "dreaming-", sessionId, options.executionId, "curate").open();
    options.registerFence(workspace);
    const files = batches.map((category, i) => workspace.path(batchFileName(i, category)));
    const started = Date.now(), deadline = started + config.dreaming.timeoutMs;
    const run = template("curate", frozen.models.main.model);
    let at = 0, repaired = false, problem: string | undefined, lost = false, lastBatchRun = 0;
    const read = (): { name: string; text: string } => ({ name: batchFileName(at, batches[at]!), text: workspace.text(batchFileName(at, batches[at]!)) });
    const report = (result = checkBatch(store, path, batches[at]!, read())) => [
      `Task: curate (batch ${at + 1} of ${batches.length}, category ${batches[at]}). File: ${files[at]}`,
      result.problems.length ? `Problems: ${result.problems.length}\n${result.problems.join("\n")}` : "Problems: none",
      ...(result.lengths.length ? ["Lengths:", ...lengthLines(batchFileName(at, batches[at]!), result.lengths)] : [])].join("\n");
    const binding = bind(context, run, { check: () => report() });
    const stopChecks: { ok: boolean; problems: string[] }[] = [];

    /** The stop hook: apply the batch when it passes and return the next one; one repair for a batch that fails (§4.5). */
    const passEnd = (): string | undefined => {
      if (workspace.closed || at >= batches.length) return undefined;
      const category = batches[at]!, checked = checkBatch(store, path, category, read());
      stopChecks.push({ ok: checked.ok, problems: checked.problems });
      if (!checked.ok) {
        if (!repaired) { repaired = true;
          return `Your file does not pass the check. Correct every problem below, then stop. If it still fails, curate fails and this batch is not applied.\n\n${report(checked)}`; }
        problem = `check failed twice: batch ${at + 1}/${batches.length} (${category})`;
        return undefined;
      }
      // The pool each shown version had when the input was frozen: a version moved meanwhile stays uncovered in its new pool (§2.1).
      const covers: Cover[] = frozen.byCategory.get(category)!.filter(item => !item.covered).map(item => ({ id: item.value.revision.id, pool: item.pool }));
      const lastBatch = at === batches.length - 1;
      let results: Parameters<NonNullable<Parameters<Store["commitTaskPass"]>[0]["response"]>>[0] = [];
      try {
        const done = store.commitTaskPass({ run: { ...run }, path, operations: checked.planned.map(entry => entry.make().operation!),
          response: out => { results = out; return JSON.stringify({ task: "curate", category, file: files[at], covers,
            blocks: checked.planned.map((entry, i) => ({ block: describeBlock(entry.block), line: entry.block.line, result: out[i] })) }); },
          cover: lastBatch ? ({ runId, results: out }) => [...coveredBy(detail.curateRuns), ...covers, ...written(detail.curateRuns),
            ...out.flatMap(result => result.ok ? result.committed.map(item => ({ id: item.commit })) : [])] : undefined,
          handoff: ({ runId }) => ({ nextTask: lastBatch ? "verify" : "curate",
            detail: { curateRuns: [...detail.curateRuns, runId], doneCategories: [...detail.doneCategories, category] } }) });
        detail.curateRuns.push(done.runId); detail.doneCategories.push(category);
        lastBatchRun = lastRunId = done.runId;
      } catch (error) {
        if (CLAIM_LOST.test(String(error))) lost = true;
        problem = `batch ${at + 1}/${batches.length} could not be applied: ${error instanceof Error ? error.message : String(error)}`;
        workspace.close();
        return undefined;
      }
      const versions = results.flatMap(result => result.ok ? result.committed.map(item => `K${item.knowledgeId}@v${store.versionOrdinal(item.knowledgeId, item.commit)}`) : []);
      const stale = results.flatMap(result => !result.ok ? [result.reason] : []);
      const receipt = `Applied batch ${at + 1} of ${batches.length} (${category}). Versions written: ${versions.join(", ") || "none"}.`
        + (stale.length ? ` Refused, left for the next run: ${stale.join("; ")}.` : "");
      at++; repaired = false;
      return at < batches.length ? `${receipt}\n\nNext: batch ${at + 1} of ${batches.length}, category ${batches[at]}. File: ${files[at]}. ${renderToolNames("Call {{tool.check}} to see its problems.", frozen.names)}` : undefined;
    };

    const input: DreamingAgentInput = { kind: "dreaming", task: "curate", sessionId, branch, model: frozen.models.main.model, thinking: frozen.models.main.thinking,
      mode: "subagent", prompt: frozen.prompt, promptHash: frozen.promptHash, text: frozen.text, tools: binding.tools,
      workspace: { dir: workspace.dir, read: files, write: files, roots: [] }, passEnd, deadline,
      acknowledgeRequest: binding.acknowledgeRequest, reportRequest: binding.reportRequest };
    let result: RunAgentResult;
    try { result = await runAgent(input); } catch (error) { result = agentException(error); }
    binding.close();
    if (store.closed) return { ok: false, outcome: "cancelled", runId: 0, problems: ["store closed"], class: "cancelled", transient: false };
    // A fence closed by a stop, memory off or executor exit while the model ignored it: its late pass applied nothing.
    if (result.outcome === "success" && workspace.closed && !problem)
      result = { ...result, outcome: "cancelled", output: "Dreamer cancelled before its pass ended" };
    const success = result.outcome === "success" && !requestMissing(result) && !problem && at === batches.length;
    const problems = problem ? [problem] : result.outcome !== "success" ? [String(result.output ?? result.outcome)]
      : requestMissing(result) ? ["runAgent must return the exact provider request"]
      : at < batches.length ? [`ended before batch ${at + 1}/${batches.length}`] : [];
    recordAttempt(run, result, { task: "curate", stopChecks, toolCalls: binding.sequence, fetched: binding.fetched, problems, durationMs: Date.now() - started });
    if (success) {
      // The conversation's request and usage ride on the last batch's run, which holds the same task's last pass.
      const previous = JSON.parse(store.getRun(lastBatchRun)?.response ?? "{}");
      store.updateRun(lastBatchRun, { ...run, response: JSON.stringify({ ...previous, ...JSON.parse(run.response!) }), outcome: "success" });
      return { ok: true, runId: lastBatchRun };
    }
    const outcome = result.outcome === "cancelled" ? "cancelled" : "failure";
    const classified = lost ? { class: "claim lost", transient: true } : problem?.startsWith("check failed twice") ? { class: "check failed twice", transient: false }
      : result.outcome !== "success" ? classifyFailure(result.output, (result as { failureClass?: string }).failureClass)
      : { class: `ended before batch ${at + 1}/${batches.length}`, transient: false };
    return { ok: false, outcome, problems, ...classified, runId: store.recordRun({ ...run, outcome }).id };
  };

  /** One conversation that writes one file and stops (§1.1): verify's, and each pass of classify. The stop hook checks the file, allows
   * one repair, then applies it through `apply` (one `commitTaskPass`, which returns the pass's run id) or fails the task. */
  interface FilePass {
    task: "verify" | "classify"; label: string; workspace: TaskWorkspace; read: string[]; write: string[]; roots: string[];
    model: DreamingTaskConfig; prompt: string; promptHash: string; text: string; deadline: number;
    check(): { problems: string[]; report: string };
    apply(run: RunInput): number;
  }
  const filePass = async (spec: FilePass): Promise<TaskOutcome> => {
    const started = Date.now(), run = template(spec.task, spec.model.model, spec.promptHash);
    let repaired = false, problem: string | undefined, lost = false, appliedRun = 0;
    const stopChecks: { ok: boolean; problems: string[] }[] = [];
    const binding = bind(context, run, { check: () => spec.check().report });
    const passEnd = (): string | undefined => {
      if (spec.workspace.closed || appliedRun) return undefined;
      const checked = spec.check();
      stopChecks.push({ ok: !checked.problems.length, problems: checked.problems });
      if (checked.problems.length) {
        if (!repaired) { repaired = true;
          return `Your file does not pass the check. Correct every problem below, then stop. If it still fails, ${spec.label} fails and nothing from it is applied.\n\n${checked.report}`; }
        problem = `check failed twice: ${spec.label}`;
        return undefined;
      }
      try { appliedRun = lastRunId = spec.apply(run); } catch (error) {
        if (CLAIM_LOST.test(String(error))) lost = true;
        problem = `${spec.label} could not be applied: ${error instanceof Error ? error.message : String(error)}`;
        spec.workspace.close();
      }
      return undefined;
    };
    const input: DreamingAgentInput = { kind: "dreaming", task: spec.task, sessionId, branch, model: spec.model.model, thinking: spec.model.thinking,
      mode: "subagent", prompt: spec.prompt, promptHash: spec.promptHash, text: spec.text,
      tools: spec.task === "classify" ? binding.tools.filter(tool => tool.name === "check") : binding.tools, // §6.4: the scorer has check, read, write and edit
      workspace: { dir: spec.workspace.dir, read: spec.read, write: spec.write, roots: spec.roots }, passEnd, deadline: spec.deadline,
      acknowledgeRequest: binding.acknowledgeRequest, reportRequest: binding.reportRequest };
    let result: RunAgentResult;
    try { result = await runAgent(input); } catch (error) { result = agentException(error); }
    binding.close();
    if (store.closed) return { ok: false, outcome: "cancelled", runId: 0, problems: ["store closed"], class: "cancelled", transient: false };
    if (result.outcome === "success" && spec.workspace.closed && !problem)
      result = { ...result, outcome: "cancelled", output: "Dreamer cancelled before its pass ended" };
    const success = result.outcome === "success" && !requestMissing(result) && !problem && appliedRun !== 0;
    const problems = problem ? [problem] : result.outcome !== "success" ? [String(result.output ?? result.outcome)]
      : requestMissing(result) ? ["runAgent must return the exact provider request"] : appliedRun === 0 ? [`ended before ${spec.label} was applied`] : [];
    recordAttempt(run, result, { task: spec.task, stopChecks, toolCalls: binding.sequence, fetched: binding.fetched, problems, durationMs: Date.now() - started });
    if (success) {
      const previous = JSON.parse(store.getRun(appliedRun)?.response ?? "{}");
      store.updateRun(appliedRun, { ...run, response: JSON.stringify({ ...previous, ...JSON.parse(run.response!) }), outcome: "success" });
      return { ok: true, runId: appliedRun };
    }
    const outcome = result.outcome === "cancelled" ? "cancelled" : "failure";
    const classified = lost ? { class: "claim lost", transient: true } : problem?.startsWith("check failed twice") ? { class: "check failed twice", transient: false }
      : result.outcome !== "success" ? classifyFailure(result.output, (result as { failureClass?: string }).failureClass)
      : { class: `ended before ${spec.label} was applied`, transient: false };
    return { ok: false, outcome, problems, ...classified, runId: store.recordRun({ ...run, outcome }).id };
  };
  const written = (results: { ok: boolean; committed?: { commit: number }[] }[]): Cover[] => results.flatMap(result => result.ok ? result.committed!.map(item => ({ id: item.commit })) : []);

  /** §5: verify checks curate's changes against the facts, Raw and the repositories, under the authority curate's results give it. */
  const runVerify = async (): Promise<TaskOutcome> => {
    const changes = buildChanges(store, detail.curateRuns);
    if (!changes.blocks) return noWork("verify", "classify"); // nothing was changed: no model call
    const roots = allowedRoots(store, sessionId);
    const authority = { results: changes.results, bases: changes.bases, resolveRepository: (reference: string) => repositoryEvidenceProblem(reference, roots) };
    const workspace = new TaskWorkspace(root, "dreaming-", sessionId, options.executionId, "verify").open({ "changes.md": changes.text });
    options.registerFence(workspace);
    const changesFile = workspace.path("changes.md"), file = workspace.path("verify.md");
    const checked = () => checkVerify(store, path, { name: "verify.md", text: workspace.text("verify.md") }, authority);
    const report = (result = checked()) => [
      `Task: verify. Change file: ${changesFile} (${changes.blocks} blocks, ${changes.lines} lines; read it in pages). Your file: ${file}`,
      `Repositories you may read: ${roots.join(", ") || "none"}`,
      result.problems.length ? `Problems: ${result.problems.length}\n${result.problems.join("\n")}` : "Problems: none",
      ...(result.lengths.length ? ["Lengths:", ...lengthLines("verify.md", result.lengths as Length[])] : [])].join("\n");
    return filePass({ task: "verify", label: "verify", workspace, read: [changesFile, file], write: [file], roots, model: frozen.models.main,
      prompt: frozen.prompt, promptHash: frozen.promptHash, text: frozen.text, deadline: Date.now() + config.dreaming.timeoutMs,
      check: () => { const result = checked(); return { problems: result.problems, report: report(result) }; },
      apply: run => {
        const result = checked();
        return store.commitTaskPass({ run: { ...run }, path, operations: result.planned.map(entry => entry.make().operation!),
          response: out => JSON.stringify({ task: "verify", file, blocks: result.planned.map((entry, i) => ({ block: describeBlock(entry.block), line: entry.block.line, result: out[i] })) }),
          cover: ({ results }) => written(results), handoff: () => ({ nextTask: "classify", detail: { ...detail } }) }).runId;
      } });
  };

  /** §6: score the items frozen when the task starts, 100 to a conversation; every pass has a clean context of its own. */
  const runClassify = async (): Promise<TaskOutcome> => {
    const items = store.curateItems(path), passes = classifySet(items);
    if (!passes.length) return noWork("classify", null); // nothing to score: no model call
    const anchors = classifyAnchors(items), model = frozen.models.classify;
    const prompt = loadPrompt("classifying.md", frozen.names, config.writing), promptHash = createHash("sha256").update(prompt).digest("hex");
    // One deadline for the whole task: a later pass gets only the time left (§1.3).
    const deadline = Date.now() + config.dreaming.timeoutMs;
    let outcome: TaskOutcome = { ok: true, runId: lastRunId };
    for (const [at, pass] of passes.entries()) {
      const text = classifyMessage(anchors, pass, store.writing, frozen.names, CHECK_FIRST);
      if (model.capacity && tokens(prompt) + tokens(JSON.stringify(pricedToolDefinitions(dreamingWorkspaceToolDefinitions, frozen.names))) + tokens(text) > model.capacity.inputTokens)
        throw new Error("Dreaming capacity: a classify pass exceeds the model input allowance");
      const workspace = new TaskWorkspace(root, "dreaming-", sessionId, options.executionId, `classify-${at + 1}`).open();
      options.registerFence(workspace);
      const name = `classify-${at + 1}.md`, file = workspace.path(name), label = `classify pass ${at + 1}/${passes.length}`;
      const ids = pass.map(item => item.value.revision.knowledgeId);
      const checked = () => checkWorkspace(store, { kind: "classify", items: ids, file: { name, text: workspace.text(name) } });
      const report = (result = checked()) => [`Task: ${label}. File: ${file}`, `Items: ${ids.map(id => `K${id}`).join(", ")}`,
        result.problems.length ? `Problems: ${result.problems.length}\n${result.problems.join("\n")}` : "Problems: none"].join("\n");
      outcome = await filePass({ task: "classify", label, workspace, read: [file], write: [file], roots: [], model, prompt, promptHash, text, deadline,
        check: () => { const result = checked(); return { problems: result.problems, report: report(result) }; },
        apply: run => {
          const scores = parseScores({ name, text: workspace.text(name) }).scores;
          const shown = new Map(pass.map(item => [item.value.revision.knowledgeId, item.value.revision.id]));
          return store.commitTaskPass({ run: { ...run }, path, scores: scores.map(line => ({ knowledgeId: line.knowledgeId, commit: shown.get(line.knowledgeId)!, score: line.score })),
            response: () => JSON.stringify({ task: "classify", pass: at + 1, passes: passes.length, file, scores: scores.map(line => [line.knowledgeId, line.score]) }),
            handoff: () => at === passes.length - 1 ? null : { nextTask: "classify", detail: { ...detail } } }).runId;
        } });
      if (!outcome.ok) return outcome;
    }
    return outcome;
  };

  const tasks: Record<DreamingTask, () => Promise<TaskOutcome> | TaskOutcome> = { curate: runCurate, verify: runVerify, classify: runClassify };

  for (const task of DREAMING_TASKS.slice(first)) {
    let outcome: TaskOutcome;
    try { outcome = await tasks[task](); } catch (error) {
      if (store.closed) return { outcome: "dropped" };
      const lost = CLAIM_LOST.test(String(error));
      const message = error instanceof Error ? error.message : String(error);
      const classified = lost ? { class: "claim lost", transient: true } : classifyFailure(message);
      return { outcome: "failure", runId: store.recordRun({ ...template(task, frozen.models.main.model), outcome: "failure", response: JSON.stringify({ task, problems: [message] }) }).id,
        problems: [message], failure: { task, class: classified.class, transient: classified.transient } };
    }
    if (!outcome.ok) return { outcome: outcome.outcome, runId: outcome.runId, problems: outcome.problems,
      failure: { task, class: outcome.class, transient: outcome.transient } };
  }
  return { outcome: "success", runId: lastRunId, problems: [] };
}
