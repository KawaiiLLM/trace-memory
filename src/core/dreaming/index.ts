// Dreaming as curate, verify and classify (ticket 144, stages 4 and 5). One run is one admission, one claim and one execution; it
// runs from the hand-off's next task to the end, each task through `runAgent`. One run performs one curate operation (the project's
// rotation, stage 5 §3); curate only proposes, verify gives every proposal a verdict and applies, classify scores. This module owns
// the run shape (§1), the hand-off and resume (§3), the curate task (§4), verify (§5) and classify (§6).

import { createHash } from "node:crypto";
import { loadPrompt, type PromptFile } from "../prompts/load.ts";
import { canonicalToolNames, renderToolNames, validateToolNames, type ToolNames } from "../prompts/tool-names.ts";
import { readingGuide } from "../render/reading-guide.ts";
import { withRetrievalPolicy } from "../render/retrieval-policy.ts";
import { tokens } from "../render/index.ts";
import { dreamingWorkspaceToolDefinitions, pricedToolDefinitions, type bindTools } from "../api/tools.ts";
import { agentException, recordAttempt, requestMissing } from "../api/audit.ts";
import type { AgentControl, CallFence, RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index.ts";
import type { NotingInput } from "../noting/index.ts";
import { lengthLines } from "../noting/workspace.ts";
import type { Length } from "../workspace/index.ts";
import type { Handoff, HandoffDetail } from "../store/executions.ts";
import type { KnowledgePath, RunInput, Store, TaskClaim } from "../store/index.ts";
import { checkWorkspace, describeBlock, overCaps, parseScores } from "../workspace/index.ts";
import { TaskWorkspace, defaultWorkspaceRoot } from "../workspace/run.ts";
import { batchFileName, batchesOf, checkBatch, curatePrefix, formGroups, wholeCost, type Category, type CurateItem, type CurateOperation } from "./curate.ts";
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
/** curate and verify share one first message; the task's own instructions arrive with `check`'s first result (stage 5 §0). */
const CHECK_FIRST_TASK = "Call {{tool.check}} first: it names your task and your files, and its first result carries the task's instructions.";

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
      /** A failure's task, its class label (what failed, shown in the reason and the /trace notice; it decides nothing about the retry), the operation a
       * resumed run repeats, and each failed group (146 §7); `task` and `class` are the earliest failed group's. */
      failure?: { task: DreamingTask; class: string; operation: CurateOperation; groups: { group: number; task: DreamingTask; class: string }[] } });

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

/** One batch of a group (§4.1): at most 20 items of one category, its own file. `no` is its number in the group; `run` is the kept run of its file. */
export interface FrozenBatch { no: number; category: Category; items: CurateItem[]; run?: number }
/** One group (§2): at most 100 items, its prefix and its batches. `verifyRun` is set when the group's verify passed and applied. */
export interface FrozenGroup { no: number; items: CurateItem[]; batches: FrozenBatch[]; text: string; verifyRun?: number }

export interface DreamingFrozen {
  sessionId: number; branch: string; path: KnowledgePath; claim: TaskClaim; names: ToolNames;
  prompt: string; promptHash: string;
  models: { main: DreamingTaskConfig; classify: DreamingTaskConfig };
  /** The groups: the hand-off's when it resumes (members that left the pools dropped), else formed now (§2.2, §2.3). */
  groups: FrozenGroup[];
  /** A refusal found while forming or checking the groups (§2.5): the run raises it as an ordinary failure. */
  refusal?: string;
  /** This run's one curate operation (stage 5 §3.1): the hand-off's when it resumes, else the project's next in the rotation. */
  operation: CurateOperation;
  /** The task prompts curate and verify deliver with their first `check` result. */
  taskPrompts: Record<"curate" | "verify", { text: string; hash: string }>;
  /** The hand-off row read at admission: where this run resumes, and which batches are kept. */
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
  const handoff = store.handoff(path.sessionId, "dreaming");
  const operation = handoff?.detail?.operation ?? store.nextCurateOperation(store.getSession(path.sessionId)!.projectId);
  const taskPrompt = (task: "curate" | "verify") => {
    const body = loadPrompt(`tasks/${task}-${operation}.md` as PromptFile, names, config.writing);
    return { text: body, hash: createHash("sha256").update(body).digest("hex") };
  };
  const taskPrompts = { curate: taskPrompt("curate"), verify: taskPrompt("verify") };
  // curate and verify share this prompt (and a group's first message) so verify's first request reads the cache curate wrote (§1.4).
  const prompt = withRetrievalPolicy(loadPrompt("dreaming.md", names, config.writing), names);
  const main: DreamingTaskConfig = { model: input.model ?? "session", thinking: input.subagentThinkingLevel ?? input.thinkingLevel, capacity: input.capacity };
  const classify: DreamingTaskConfig = { model: input.classify?.model ?? main.model, thinking: input.classify?.thinkingLevel ?? main.thinking,
    capacity: input.classify?.capacity ?? main.capacity };
  const items = store.curateItems(path);
  const guide = readingGuide(path.sessionId, names), check = renderToolNames(CHECK_FIRST_TASK, names);
  const firstMessage = (prefix: string) => [guide, prefix, check].join("\n\n");
  const taskTokens = Math.max(tokens(taskPrompts.curate.text), tokens(taskPrompts.verify.text));
  let room = Infinity, tools = 0;
  if (main.capacity) {
    tools = tokens(JSON.stringify(pricedToolDefinitions(dreamingWorkspaceToolDefinitions, names))) + (input.nativeReadToolTokens ?? 0) + (input.nativeWriteToolTokens ?? 0);
    const fixed = tokens(prompt) + tools + tokens(firstMessage(curatePrefix(store, path, [], items.length).text)) + taskTokens;
    if (!Number.isSafeInteger(main.capacity.inputTokens) || main.capacity.inputTokens < 0 || fixed > main.capacity.inputTokens)
      throw new Error("Dreaming capacity: the knowledge prefix and tools exceed the model input allowance; left pending");
    room = main.capacity.inputTokens - fixed;
  }
  let refusal: string | undefined, groups: FrozenGroup[];
  const kept = handoff?.detail?.groups;
  if (kept) {
    // §2.3: the frozen groups are not re-formed. Members that left the pools drop out; a new item belongs to no group.
    const live = new Map(items.map(item => [item.value.revision.knowledgeId, item]));
    groups = kept.map((group, k) => {
      const batches = group.batches.map((batch, i) => ({ no: i + 1, category: batch.category as Category, items: batch.items.flatMap(id => live.get(id) ?? []),
        ...(batch.run !== undefined ? { run: batch.run } : {}) }));
      return { no: k + 1, items: batches.flatMap(batch => batch.items), batches, text: "", ...(group.verifyRun !== undefined ? { verifyRun: group.verifyRun } : {}) };
    });
  } else {
    const formed = formGroups(items, item => wholeCost(store, item), room);
    if ("refusal" in formed) { refusal = formed.refusal; groups = []; }
    else groups = formed.groups.map((list, k) => ({ no: k + 1, items: list, batches: batchesOf(list).map((batch, i) => ({ no: i + 1, ...batch })), text: "" }));
  }
  for (const group of groups) {
    group.text = firstMessage(curatePrefix(store, path, group.items, items.length).text);
    if (main.capacity && !refusal && tokens(prompt) + tools + tokens(group.text) + taskTokens > main.capacity.inputTokens)
      refusal = `group ${group.no} (${group.items.length} items) exceeds the model input allowance`;
  }
  return { sessionId: path.sessionId, branch: path.branch, path, claim, names, prompt, promptHash: createHash("sha256").update(prompt).digest("hex"),
    models: { main, classify }, groups, ...(refusal ? { refusal } : {}), operation, taskPrompts, handoff };
}

export interface DreamingRunOptions {
  workspaceRoot?: string; executionId: string;
  /** Registers a workspace with the cancellation fence (§1.5): closing the task closes it. */
  registerFence(workspace: { close(): void }): void;
}
type Bind = (context: Parameters<typeof bindTools>[2], run: RunInput, writer?: Parameters<typeof bindTools>[5]) => ReturnType<typeof bindTools> & { call: CallFence };
type TaskOutcome = { ok: true; runId: number } | { ok: false; outcome: "failure" | "cancelled"; runId: number; problems: string[]; class: string };

/** The class label of a failure: a provider, network, store or deadline error, or a plain error. It is only named in the reason and the notice. */
const PROVIDER_ERROR = /abort|lease|timeout|timed out|econn|socket|network|rate.?limit|429|503|overloaded|sqlite_busy|database is locked/i;
export function classifyFailure(output: unknown, failureClass?: string): { class: string } {
  if (failureClass === "timeout") return { class: "timeout" };
  const message = String(output ?? "");
  if (/sqlite_busy|database is locked/i.test(message)) return { class: "store error" };
  if (/model.*not found|unknown model/i.test(message)) return { class: "model not found" };
  if (PROVIDER_ERROR.test(message)) return { class: "provider error" };
  return { class: "error" };
}

const CLAIM_LOST = /task claim is no longer current and unexpired/;
/** §2.5: a refusal found at admission; the run raises it as an ordinary failure. */
class Refusal extends Error {}

export async function runDreaming(store: Store, frozen: DreamingFrozen, runAgent: RunAgent, config: TraceMemoryConfig, bind: Bind,
  options: DreamingRunOptions): Promise<DreamingResult> {
  const { sessionId, branch, path, groups } = frozen;
  const first = Math.max(0, DREAMING_TASKS.indexOf((frozen.handoff?.nextTask ?? "curate") as DreamingTask));
  const { operation } = frozen;
  const root = options.workspaceRoot ?? defaultWorkspaceRoot();
  const template = (task: DreamingTask, model: string, promptHash = frozen.promptHash): RunInput => ({ kind: "dreaming", sessionId, branch, model, mode: "subagent",
    promptHash, createdAt: new Date().toISOString(), rangeFrom: `S${sessionId}/${task}`, rangeTo: `S${sessionId}/${task}` });
  const context = { kind: "dreaming" as const, sessionId, branch, headTurnId: path.headTurnId, range: { from: `S${sessionId}`, to: `S${sessionId}` } };
  let lastRunId = 0;

  /** §3.4: the hand-off's detail, written whole at every commit from the in-memory groups, which change only inside a commit's `handoff` callback. */
  const detailOf = (): HandoffDetail => ({ operation, groups: groups.map(group => ({
    batches: group.batches.map(batch => ({ category: batch.category, items: batch.items.map(item => item.value.revision.knowledgeId), ...(batch.run !== undefined ? { run: batch.run } : {}) })),
    ...(group.verifyRun !== undefined ? { verifyRun: group.verifyRun } : {}) })) });
  const pending = (group: FrozenGroup) => group.batches.filter(batch => batch.items.length && batch.run === undefined);
  /** `next_task` is derived at every write (§3.4). */
  const nextTask = (): DreamingTask => groups.some(group => pending(group).length) ? "curate" : groups.some(group => group.verifyRun === undefined) ? "verify" : "classify";

  /** A task that does no model call: its run is recorded and the hand-off moves (§3.2 no-work run). */
  const noWork = (task: DreamingTask, next: DreamingTask | null, cover?: () => Cover[], group?: FrozenGroup): TaskOutcome => {
    const run = template(task, frozen.models.main.model);
    const bound = bind(context, run, { check: () => "no work" });
    bound.close(); // the run record only; it has no tools to run
    const done = store.commitTaskPass({ run: { ...run, response: JSON.stringify({ task, passes: 0, operation, ...(group ? { group: group.no } : {}) }) }, path, cover,
      handoff: ({ runId }) => { if (group) group.verifyRun = runId; return next ? { nextTask: group ? nextTask() : next, detail: detailOf() } : null; }, ...(next ? {} : { finish: { operation } }) });
    return { ok: true, runId: lastRunId = done.runId };
  };

  /** The run record of a task that failed before or outside its conversation, linked to the execution so settlement can name it. */
  const failedRun = (task: DreamingTask, group: number | undefined, problems: string[], outcome: "failure" | "cancelled" = "failure") => {
    const run = template(task, frozen.models.main.model);
    bind(context, run, { check: () => "no work" }).close();
    return store.recordRun({ ...run, outcome, response: JSON.stringify({ task, problems, ...(group ? { group } : {}) }) }).id;
  };

  /** Stage 5 §0: a task prompt counts as delivered once a message that goes to the model carries it (a `check` result or a repair). The file
   * checks are pure and deliver nothing. */
  const delivery = (task: "curate" | "verify" | "classify") => {
    const prompt = task === "classify" ? undefined : frozen.taskPrompts[task];
    let sent = false;
    return { give: (message: string) => { if (!prompt || sent) return message; sent = true; return `${message}\n\n${prompt.text}`; },
      hashes: () => prompt && sent ? [prompt.hash] : [] };
  };

  /** §4.2: one conversation per group over its batches. The first `check` result lists the batches and their files; the agent writes them
   * in order, checks as it goes and stops once. The stop hook checks every file once and allows one repair. When the conversation ends, every
   * file that passes is kept (failure and deadline included; a cancellation, a lost claim or a close keeps nothing). */
  const runCurate = async (group: FrozenGroup): Promise<TaskOutcome> => {
    const todo = pending(group);
    if (!todo.length) return { ok: true, runId: lastRunId };
    const workspace = new TaskWorkspace(root, "dreaming-", sessionId, options.executionId, `curate-g${group.no}`).open();
    options.registerFence(workspace);
    const name = (batch: FrozenBatch) => batchFileName(batch.no - 1, batch.category);
    const files = new Map(todo.map(batch => [batch, workspace.path(name(batch))]));
    const started = Date.now(), deadline = started + config.dreaming.timeoutMs;
    const run = template("curate", frozen.models.main.model);
    const roots = allowedRoots(store, sessionId), delivered = delivery("curate");
    const read = (batch: FrozenBatch) => ({ name: name(batch), text: workspace.text(name(batch)), written: workspace.written(name(batch)) });
    const checkAll = () => todo.map(batch => ({ batch, checked: checkBatch(store, path, read(batch), operation) }));
    const report = (results = checkAll(), only?: FrozenBatch[]) => [
      `Task: curate ${operation} (group ${group.no} of ${groups.length}, ${todo.length} batch${todo.length === 1 ? "" : "es"} to do)`,
      `Repositories you may read: ${roots.join(", ") || "none"}`,
      ...results.filter(({ batch }) => !only || only.includes(batch)).flatMap(({ batch, checked }) => [
        `batch ${batch.no} of ${group.batches.length}, category ${batch.category}. Items: ${batch.items.map(item => item.address).join(", ")}. File: ${files.get(batch)}`,
        checked.ok ? "  passes" : `  Problems: ${checked.problems.length}\n${checked.problems.join("\n")}`,
        ...(checked.lengths.length ? ["  Lengths:", ...lengthLines(name(batch), checked.lengths)] : [])])].join("\n");
    const binding = bind(context, run, { check: () => delivered.give(report()) });
    binding.call.fence(workspace);
    const stopChecks: { ok: boolean; problems: string[]; files: string[] }[] = [];
    let repaired = false, problem: string | undefined, lost = false;

    /** The stop hook: one final check over every file, one repair, then the task ends. Nothing is committed here (the files are kept after the call). */
    const passEnd = (): string | undefined => {
      if (workspace.closed || problem) return undefined;
      const results = checkAll(), failing = results.filter(({ checked }) => !checked.ok);
      stopChecks.push({ ok: !failing.length, problems: failing.flatMap(({ checked }) => checked.problems), files: todo.map(name) });
      if (!failing.length) return undefined;
      if (!repaired) { repaired = true;
        return delivered.give(`Your files do not pass the check. Correct every problem below, then stop. If they still fail, curate fails; the files that pass are kept.\n\n${report(results, failing.map(({ batch }) => batch))}`); }
      problem = `check failed twice: batch${failing.length === 1 ? "" : "es"} ${failing.map(({ batch }) => `${batch.no}/${group.batches.length} (${batch.category})`).join(", ")}`;
      return undefined;
    };

    const input: DreamingAgentInput = { kind: "dreaming", task: "curate", sessionId, branch, model: frozen.models.main.model, thinking: frozen.models.main.thinking,
      mode: "subagent", prompt: frozen.prompt, promptHash: frozen.promptHash, text: group.text, tools: binding.tools,
      workspace: { dir: workspace.dir, read: [...files.values()], write: [...files.values()], roots }, passEnd, deadline, call: binding.call,
      acknowledgeRequest: binding.acknowledgeRequest, reportRequest: binding.reportRequest };
    let result: RunAgentResult;
    try { result = await runAgent(input); } catch (error) { result = agentException(error); }
    binding.close();
    if (store.closed) return { ok: false, outcome: "cancelled", runId: 0, problems: ["store closed"], class: "cancelled" };
    // A fence closed by a stop, memory off or executor exit while the model ignored it: its late pass kept nothing.
    if (result.outcome === "success" && workspace.closed && !problem)
      result = { ...result, outcome: "cancelled", output: "Dreamer cancelled before its pass ended" };
    // Keeping: after any ending but a cancellation, each file that passes is committed on its own, in batch order.
    let lastKept = 0;
    if (result.outcome !== "cancelled") for (const { batch, checked } of checkAll()) {
      if (!checked.ok) continue;
      // The pool each shown version had when the input was frozen: a version moved meanwhile stays uncovered in its new pool (§2.1).
      const covers: Cover[] = batch.items.filter(item => !item.covered).map(item => ({ id: item.value.revision.id, pool: item.pool }));
      try {
        const done = store.commitTaskPass({ run: { ...run }, path,
          response: () => JSON.stringify({ task: "curate", operation, group: group.no, category: batch.category, batch: batch.no, file: files.get(batch), text: read(batch).text, covers,
            proposed: checked.planned.map(entry => ({ block: describeBlock(entry.block), operation: entry.make().operation })) }),
          handoff: ({ runId }) => { batch.run = runId; return { nextTask: nextTask(), detail: detailOf() }; } });
        lastKept = lastRunId = done.runId;
      } catch (error) {
        batch.run = undefined;
        if (CLAIM_LOST.test(String(error))) lost = true;
        problem ??= `batch ${batch.no}/${group.batches.length} could not be kept: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }
    const left = pending(group);
    const success = result.outcome === "success" && !requestMissing(result) && !problem && !left.length;
    const problems = problem ? [problem] : result.outcome !== "success" ? [String(result.output ?? result.outcome)]
      : requestMissing(result) ? ["runAgent must return the exact provider request"]
      : left.length ? [`ended before batch ${left[0]!.no}/${group.batches.length} was kept`] : [];
    recordAttempt(run, result, { task: "curate", operation, group: group.no, taskPrompts: delivered.hashes(), stopChecks, toolCalls: binding.sequence, fetched: binding.fetched, problems, durationMs: Date.now() - started });
    // The conversation's request and usage ride on the last kept file's run, or on the failed run when no file is kept.
    if (lastKept) {
      const previous = JSON.parse(store.getRun(lastKept)?.response ?? "{}");
      store.updateRun(lastKept, { ...run, response: JSON.stringify({ ...previous, ...JSON.parse(run.response!) }), outcome: "success" });
    }
    if (success) return { ok: true, runId: lastKept };
    const outcome = result.outcome === "cancelled" ? "cancelled" : "failure";
    const classified = lost ? { class: "claim lost" } : problem?.startsWith("check failed twice") ? { class: "check failed twice" }
      : result.outcome !== "success" ? classifyFailure(result.output, (result as { failureClass?: string }).failureClass)
      : { class: `ended before batch ${left[0]?.no ?? "?"}/${group.batches.length} was kept` };
    return { ok: false, outcome, problems, ...classified, runId: lastKept || store.recordRun({ ...run, outcome }).id };
  };

  /** One conversation that writes one file and stops (§1.1): verify's, and each pass of classify. The stop hook checks the file, allows
   * one repair, then applies it through `apply` (one `commitTaskPass`, which returns the pass's run id) or fails the task. */
  interface FilePass {
    task: "verify" | "classify"; label: string; group?: number; workspace: TaskWorkspace; read: string[]; write: string[]; roots: string[];
    model: DreamingTaskConfig; prompt: string; promptHash: string; text: string; deadline: number;
    check(): { problems: string[]; report: string };
    apply(run: RunInput): number;
  }
  const filePass = async (spec: FilePass): Promise<TaskOutcome> => {
    const started = Date.now(), run = template(spec.task, spec.model.model, spec.promptHash);
    let repaired = false, problem: string | undefined, lost = false, appliedRun = 0;
    const stopChecks: { ok: boolean; problems: string[] }[] = [], delivered = delivery(spec.task);
    const binding = bind(context, run, { check: () => delivered.give(spec.check().report) });
    binding.call.fence(spec.workspace);
    const passEnd = (): string | undefined => {
      if (spec.workspace.closed || appliedRun) return undefined;
      const checked = spec.check();
      stopChecks.push({ ok: !checked.problems.length, problems: checked.problems });
      if (checked.problems.length) {
        if (!repaired) { repaired = true;
          return delivered.give(`Your file does not pass the check. Correct every problem below, then stop. If it still fails, ${spec.label} fails and nothing from it is applied.\n\n${checked.report}`); }
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
      workspace: { dir: spec.workspace.dir, read: spec.read, write: spec.write, roots: spec.roots }, passEnd, deadline: spec.deadline, call: binding.call,
      acknowledgeRequest: binding.acknowledgeRequest, reportRequest: binding.reportRequest };
    let result: RunAgentResult;
    try { result = await runAgent(input); } catch (error) { result = agentException(error); }
    binding.close();
    if (store.closed) return { ok: false, outcome: "cancelled", runId: 0, problems: ["store closed"], class: "cancelled" };
    if (result.outcome === "success" && spec.workspace.closed && !problem)
      result = { ...result, outcome: "cancelled", output: "Dreamer cancelled before its pass ended" };
    const success = result.outcome === "success" && !requestMissing(result) && !problem && appliedRun !== 0;
    const problems = problem ? [problem] : result.outcome !== "success" ? [String(result.output ?? result.outcome)]
      : requestMissing(result) ? ["runAgent must return the exact provider request"] : appliedRun === 0 ? [`ended before ${spec.label} was applied`] : [];
    recordAttempt(run, result, { task: spec.task, operation, ...(spec.group ? { group: spec.group } : {}), taskPrompts: delivered.hashes(), stopChecks, toolCalls: binding.sequence, fetched: binding.fetched, problems, durationMs: Date.now() - started });
    if (success) {
      const previous = JSON.parse(store.getRun(appliedRun)?.response ?? "{}");
      store.updateRun(appliedRun, { ...run, response: JSON.stringify({ ...previous, ...JSON.parse(run.response!) }), outcome: "success" });
      return { ok: true, runId: appliedRun };
    }
    const outcome = result.outcome === "cancelled" ? "cancelled" : "failure";
    const classified = lost ? { class: "claim lost" } : problem?.startsWith("check failed twice") ? { class: "check failed twice" }
      : result.outcome !== "success" ? classifyFailure(result.output, (result as { failureClass?: string }).failureClass)
      : { class: `ended before ${spec.label} was applied` };
    return { ok: false, outcome, problems, ...classified, runId: store.recordRun({ ...run, outcome }).id };
  };
  const written = (results: { ok: boolean; committed?: { commit: number; knowledgeId: number }[] }[], others: ReadonlySet<number>): Cover[] =>
    results.flatMap(result => result.ok ? result.committed!.filter(item => !others.has(item.knowledgeId)).map(item => ({ id: item.commit })) : []);

  /** §5 (stage 5 §4, per group §3): verify gives every change the group's curate kept one verdict against the facts, Raw and the repositories;
   * its pass then applies the confirmed and edited operations, the first time anything curate proposed reaches the Store. */
  const runVerify = async (group: FrozenGroup): Promise<TaskOutcome> => {
    const runs = group.batches.flatMap(batch => batch.run ?? []);
    const changes = buildChanges(store, path, runs);
    // Coverage is written at the group's verify pass (§3.2, ruling 「processed means verified」): what its batches showed, and the versions this pass
    // wrote on items that are not another group's (a version written on another group's item is covered by that group's own pass).
    const coveredBy = () => runs.flatMap(id => (JSON.parse(store.getRun(id)?.response ?? "{}").covers ?? []) as Cover[]);
    const others = new Set(groups.filter(other => other !== group).flatMap(other => other.items.map(item => item.value.revision.knowledgeId)));
    if (!changes.blocks) return noWork("verify", "classify", coveredBy, group); // nothing was proposed: no model call
    const roots = allowedRoots(store, sessionId);
    const workspace = new TaskWorkspace(root, "dreaming-", sessionId, options.executionId, `verify-g${group.no}`).open({ "changes.md": changes.text });
    options.registerFence(workspace);
    const changesFile = workspace.path("changes.md"), file = workspace.path("verify.md");
    const resolveRepository = (reference: string) => repositoryEvidenceProblem(reference, roots);
    const checked = () => checkVerify(store, path, { name: "verify.md", text: workspace.text("verify.md") }, changes.proposals, resolveRepository);
    const report = (result = checked()) => [
      `Task: verify ${operation} (group ${group.no} of ${groups.length}). Change file: ${changesFile} (${changes.blocks} blocks, ${changes.lines} lines; read it in pages). Your file: ${file}`,
      `Repositories you may read: ${roots.join(", ") || "none"}`,
      result.problems.length ? `Problems: ${result.problems.length}\n${result.problems.join("\n")}` : "Problems: none",
      ...(result.lengths.length ? ["Lengths:", ...lengthLines("verify.md", result.lengths as Length[])] : [])].join("\n");
    return filePass({ task: "verify", label: "verify", group: group.no, workspace, read: [changesFile, file], write: [file], roots, model: frozen.models.main,
      prompt: frozen.prompt, promptHash: frozen.promptHash, text: group.text, deadline: Date.now() + config.dreaming.timeoutMs,
      check: () => { const result = checked(); return { problems: result.problems, report: report(result) }; },
      apply: run => {
        const result = checked();
        // The caps in force now (§4.5): an operation over them is refused with its counts and left for the next run; the rest apply.
        const over = result.verdicts.map(verdict => verdict.operation ? overCaps(store, verdict.operation) : []);
        const applying = result.verdicts.flatMap((verdict, i) => verdict.operation && !over[i]!.length ? [i] : []);
        try {
          return store.commitTaskPass({ run: { ...run }, path, operations: applying.map(i => result.verdicts[i]!.operation!),
            response: out => JSON.stringify({ task: "verify", operation, group: group.no, file, verdicts: result.verdicts.map((verdict, i) => ({ n: verdict.n, verdict: verdict.verdict,
              ...(verdict.reason ? { reason: verdict.reason } : {}), ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
              ...(verdict.operation ? { result: over[i]!.length ? { ok: false, stale: false, reason: over[i]!.join("; ") } : out[applying.indexOf(i)] } : {}) })) }),
            cover: ({ results }) => [...coveredBy(), ...written(results, others)],
            handoff: ({ runId }) => { group.verifyRun = runId; return { nextTask: nextTask(), detail: detailOf() }; } }).runId;
        } catch (error) { group.verifyRun = undefined; throw error; }
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
            response: () => JSON.stringify({ task: "classify", operation, pass: at + 1, passes: passes.length, file, scores: scores.map(line => [line.knowledgeId, line.score]) }),
            handoff: () => at === passes.length - 1 ? null : { nextTask: "classify", detail: detailOf() },
            ...(at === passes.length - 1 ? { finish: { operation } } : {}) }).runId;
        } });
      if (!outcome.ok) return outcome;
    }
    return outcome;
  };

  /** A task that threw (a claim lost mid-commit, a store error, a capacity refusal): a failed run linked to the execution. */
  const thrown = (task: DreamingTask, group: number | undefined, error: unknown): Extract<TaskOutcome, { ok: false }> => {
    if (store.closed) return { ok: false, outcome: "cancelled", runId: 0, problems: ["store closed"], class: "cancelled" };
    const message = error instanceof Error ? error.message : String(error);
    const classified = error instanceof Refusal ? { class: "capacity" } : CLAIM_LOST.test(message) ? { class: "claim lost" } : classifyFailure(message);
    return { ok: false, outcome: "failure", runId: failedRun(task, group, [message]), problems: [message], ...classified };
  };

  /** §3.1: one group's curate over its unkept batches, then its verify, as soon as its curate passes. */
  const pipeline = async (group: FrozenGroup): Promise<{ group: number; task: DreamingTask; outcome: Extract<TaskOutcome, { ok: false }> } | undefined> => {
    let task: DreamingTask = "curate";
    try {
      const curated = await runCurate(group);
      if (!curated.ok) return { group: group.no, task, outcome: curated };
      task = "verify";
      const verified = await runVerify(group);
      if (!verified.ok) return { group: group.no, task, outcome: verified };
    } catch (error) { return { group: group.no, task, outcome: thrown(task, group.no, error) }; }
    return undefined;
  };

  try { if (frozen.refusal) throw new Refusal(frozen.refusal); } catch (error) {
    const failed = thrown(DREAMING_TASKS[first]!, undefined, error);
    return { outcome: failed.outcome, runId: failed.runId, problems: failed.problems, failure: { task: DREAMING_TASKS[first]!, class: failed.class, operation, groups: [] } };
  }
  if (!groups.length) {
    // Nothing to curate: curate and verify are recorded as no-work runs (§2.1).
    try { if (first < 1) noWork("curate", "verify"); if (first < 2) noWork("verify", "classify"); }
    catch (error) {
      if (store.closed) return { outcome: "dropped" };
      const failed = thrown(first < 1 ? "curate" : "verify", undefined, error);
      return { outcome: failed.outcome, runId: failed.runId, problems: failed.problems, failure: { task: first < 1 ? "curate" : "verify", class: failed.class, operation, groups: [] } };
    }
  } else {
    const outcomes = (await Promise.all(groups.filter(group => group.verifyRun === undefined).map(pipeline))).filter(outcome => outcome !== undefined);
    if (outcomes.length) {
      if (store.closed) return { outcome: "dropped" };
      const earliest = outcomes.some(failed => failed.task === "curate") ? "curate" : "verify", head = outcomes.find(failed => failed.task === earliest)!;
      return { outcome: outcomes.some(failed => failed.outcome.outcome === "cancelled") ? "cancelled" : "failure", runId: head.outcome.runId,
        problems: outcomes.flatMap(failed => failed.outcome.problems),
        failure: { task: earliest, class: head.outcome.class, operation, groups: outcomes.map(failed => ({ group: failed.group, task: failed.task, class: failed.outcome.class })) } };
    }
  }
  let outcome: TaskOutcome;
  try { outcome = await runClassify(); } catch (error) { outcome = thrown("classify", undefined, error); }
  if (!outcome.ok) {
    if (store.closed) return { outcome: "dropped" };
    return { outcome: outcome.outcome, runId: outcome.runId, problems: outcome.problems, failure: { task: "classify", class: outcome.class, operation, groups: [] } };
  }
  return { outcome: "success", runId: lastRunId, problems: [] };
}
