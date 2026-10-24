import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPrompt } from "../prompts/load.ts";
import { canonicalToolNames, validateToolNames, type ToolNames } from "../prompts/tool-names.ts";
import { withRetrievalPolicy } from "../render/retrieval-policy.ts";
import { knowledgeBlock } from "../render/material.ts";
import { tokens } from "../render/index.ts";
import { readingGuide } from "../render/reading-guide.ts";
import { readFacade } from "../api/read.ts";
import { dreamingWorkspaceToolDefinitions, pricedToolDefinitions, type ToolContext, type ToolDefinition } from "../api/tools.ts";
import { agentException, recordAttempt, requestMissing } from "../api/audit.ts";
import type { AgentControl, CallFence, RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index.ts";
import type { NotingInput } from "../noting/index.ts";
import type { HandoffDetail, DreamerBoundary } from "../store/executions.ts";
import type { KnowledgePath, RunInput, Store, TaskClaim, CurateItem, WorkspaceOperationResult } from "../store/index.ts";
import { TaskWorkspace, defaultWorkspaceRoot } from "../workspace/run.ts";
import { checkCurate, decisionsTemplate, formGroups, groupText, type Curated } from "./curate.ts";
import { classifyAnchors, scoreTargets, scoringText, checkScores, type ScoreTarget } from "./classify.ts";
import { boundaryOf, incrementalCandidates, projectItems, repositoryHead, seedText, trackedAt } from "./candidates.ts";
import { checkGroups, clusteringInput, groupsTemplate, type Cluster } from "./clustering.ts";
import { allowedRoots } from "./roots.ts";
import type { KnowledgeRevision } from "../model/index.ts";

export type DreamingTask = "notes" | "clustering" | "curate" | "scoring";
export const DREAMING_TASKS: readonly DreamingTask[] = ["notes", "clustering", "curate", "scoring"];
export const TASK_GAP_MS = 15_000;
export const CLAIM_LEASE_MARGIN_MS = 60_000;
export interface DreamingTaskConfig { model: string; thinking?: string; capacity?: { inputTokens: number } }
export interface DreamingInput extends Omit<NotingInput, "boundary"> { fullCheck?: boolean }
export type DreamingResult = { automaticOff?: string } & (
  | { outcome: "empty" }
  | { outcome: "dropped"; reason?: string }
  | { outcome: "success" | "failure" | "cancelled"; runId: number; problems: string[];
      failure?: { task: DreamingTask; class: string; groups: { group: number; task: DreamingTask; class: string }[] } });
export interface DreamingAgentInput extends AgentControl {
  kind: "dreaming"; task: DreamingTask; sessionId: number; branch: string; model: string; thinking?: string; mode: "subagent";
  prompt: string; promptHash: string; text: string;
  tools: ToolDefinition[];
  workspace: { dir: string; read: string[]; write: string[]; roots: string[] };
  passEnd(): string | undefined;
  reportResponse?(id: string, inputTokens?: number): void;
  acknowledgeRequest(): void;
  reportRequest(request: unknown): void;
  deadline: number;
}
export interface FrozenGroup { no: number; items: CurateItem[]; clusters?: Cluster[]; run?: number }
export interface DreamingFrozen {
  sessionId: number; branch: string; path: KnowledgePath; claim: TaskClaim; names: ToolNames;
  prompt: string; promptHash: string; model: DreamingTaskConfig; knowledge: string;
  groups: FrozenGroup[]; boundary: DreamerBoundary; seeds: string; notes?: string;
  fullCheck: boolean; clusteringItems: CurateItem[]; groupsFile?: string; clusteringModel: string;
}
/** Groups run in bounded waves; admission reserves enough lease for every wave and notes. */
export const executionLimitMs = (remaining: number, timeoutMs: number) => remaining * timeoutMs + (remaining + 1) * TASK_GAP_MS;
export function prepareDreaming(store: Store, input: DreamingInput, config: TraceMemoryConfig, claim: TaskClaim,
  path: KnowledgePath & { branch: string; headTurnId: number }): DreamingFrozen {
  if (store.getSession(path.sessionId)!.host.startsWith("cc:") && !input.toolNames) throw new Error("CC Dreamer launch requires exposed tool names");
  const names = validateToolNames(input.toolNames ?? canonicalToolNames), saved = store.handoff(path.sessionId, "dreaming")?.detail;
  const kept = saved?.boundary && (!input.fullCheck || saved.fullCheck) ? saved : undefined;
  const fullCheck = kept?.fullCheck ?? input.fullCheck ?? false;
  const live = new Map(projectItems(store, path).map(item => [item.value.knowledge.id, item]));
  const selected = kept ? undefined : fullCheck ? { candidates: [...live.values()], boundary: boundaryOf(store, [...live.values()]), seeds: [] }
    : incrementalCandidates(store, path, config.dreaming.candidatesPerSeed);
  const clusteringItems = kept?.clusteringItems ? kept.clusteringItems.flatMap(id => live.get(id) ?? []) : selected?.candidates ?? [];
  const groups = kept?.groups ? kept.groups.map((group, i) => ({ no: i + 1, items: group.items.flatMap(id => live.get(id) ?? []), clusters: group.clusters, run: group.run }))
    : fullCheck ? [] : formGroups(selected!.candidates, config.dreaming.groupItems).map((items, i) => ({ no: i + 1, items }));
  const compact = kept?.knowledge === undefined ? readFacade(store, config).compact(path.sessionId, path.branch, path.headTurnId, [], false, { readingGuide: false }) : undefined;
  const knowledge = kept?.knowledge ?? (compact && "material" in compact && compact.material ? knowledgeBlock(compact.material) : "");
  const prompt = withRetrievalPolicy(loadPrompt("dreaming.md", names, config.writing), names);
  const model = { model: input.model ?? "session", thinking: input.subagentThinkingLevel ?? input.thinkingLevel, capacity: input.capacity };
  if (model.capacity) {
    const fixed = tokens(prompt) + tokens(knowledge) + tokens(JSON.stringify(pricedToolDefinitions(dreamingWorkspaceToolDefinitions, names)))
      + (input.nativeReadToolTokens ?? 0) + (input.nativeWriteToolTokens ?? 0);
    if (!Number.isSafeInteger(model.capacity.inputTokens) || model.capacity.inputTokens < fixed) throw new Error("Dreaming capacity: knowledge prefix and tools exceed model input allowance");
  }
  return { sessionId: path.sessionId, branch: path.branch, path, claim, names, prompt, promptHash: createHash("sha256").update(prompt).digest("hex"), model, knowledge, groups,
    fullCheck, clusteringItems, groupsFile: kept?.groupsFile, clusteringModel: store.getSession(path.sessionId)!.host.startsWith("cc:") ? "haiku" : model.model,
    boundary: kept?.boundary ?? selected!.boundary, seeds: kept?.seeds ?? seedText(selected!.seeds), ...(kept?.notes === undefined ? {} : { notes: kept.notes }) };
}
export interface DreamingRunOptions { workspaceRoot?: string; executionId: string; registerFence(workspace: { close(): void }): void }
interface DreamingBinding {
  call: CallFence; tools: ToolDefinition[]; sequence: unknown[]; fetched: unknown;
  close(): void; acknowledgeRequest(): void; reportRequest(request: unknown): void;
}
type Bind = (context: ToolContext, run: RunInput, writer?: { check(): string }) => DreamingBinding;
interface Outcome { ok: boolean; runId: number; run?: RunInput; task: DreamingTask; outcome: "success" | "failure" | "cancelled"; problems: string[]; class: string }
const PROVIDER_ERROR = /abort|lease|timeout|timed out|econn|socket|network|rate.?limit|429|503|overloaded|sqlite_busy|database is locked/i;
export function classifyFailure(output: unknown, failureClass?: string): { class: string } {
  const message = String(output ?? "");
  if (failureClass === "timeout") return { class: "timeout" };
  if (/sqlite_busy|database is locked/i.test(message)) return { class: "store error" };
  if (/model.*not found|unknown model/i.test(message)) return { class: "model not found" };
  return { class: PROVIDER_ERROR.test(message) ? "provider error" : "error" };
}
export async function runDreaming(store: Store, frozen: DreamingFrozen, runAgent: RunAgent, config: TraceMemoryConfig, bind: Bind,
  options: DreamingRunOptions): Promise<DreamingResult> {
  const { sessionId, branch, path, groups } = frozen, roots = allowedRoots(store, sessionId), limits = config.dreaming;
  const root = options.workspaceRoot ?? defaultWorkspaceRoot();
  let lastRunId = 0;
  const context = { kind: "dreaming" as const, sessionId, branch, headTurnId: path.headTurnId, range: { from: `S${sessionId}`, to: `S${sessionId}` } };
  const detail = (): HandoffDetail => ({ ...(frozen.fullCheck ? { fullCheck: true, clusteringItems: frozen.clusteringItems.map(item => item.value.knowledge.id), groupsFile: frozen.groupsFile } : {}),
    groups: groups.map(group => ({ items: group.items.map(item => item.value.knowledge.id), clusters: group.clusters, ...(group.run ? { run: group.run } : {}) })),
    knowledge: frozen.knowledge, seeds: frozen.seeds, boundary: frozen.boundary, ...(frozen.notes === undefined ? {} : { notes: frozen.notes }) });
  const metadata: RunInput = { kind: "dreaming", sessionId, branch, createdAt: new Date().toISOString() };
  bind(context, metadata, { check: () => "admission" }).close();
  const template = (task: DreamingTask): RunInput => ({ ...metadata, model: frozen.model.model, mode: "subagent", promptHash: frozen.promptHash,
    createdAt: new Date().toISOString(), rangeFrom: `S${sessionId}/${task}`, rangeTo: `S${sessionId}/${task}` });
  // Persist membership before the first model call, including when notes or the first group fails.
  const admitted = store.commitTaskPass({ run: { ...template("notes"), response: JSON.stringify({ task: "admission" }) }, path,
    handoff: () => ({ nextTask: frozen.notes === undefined ? "notes" : frozen.fullCheck && !frozen.groupsFile ? "clustering" : "curate", detail: detail() }) });
  lastRunId = admitted.runId;

  const conversation = async (workspace: TaskWorkspace, initial: "notes" | "clustering" | "curate", text: string,
    report: () => { problems: string[]; text: string }, advance: () => string | undefined,
    current: () => DreamingTask, responses: Map<string, number | undefined>, instructions?: (task: DreamingTask) => string): Promise<Outcome> => {
    options.registerFence(workspace);
    const started = Date.now(), run = { ...template(initial), model: initial === "clustering" ? frozen.clusteringModel : frozen.model.model };
    const delivered = new Set<DreamingTask>();
    const deliver = (text: string) => {
      const stage = current();
      if (!instructions || delivered.has(stage)) return text;
      delivered.add(stage);
      return `${text}\n\n${instructions(stage)}`;
    };
    const binding = bind(context, run, { check: () => deliver(report().text) });
    binding.call.fence(workspace);
    let repaired = false, ended = false, failed = false;
    const checks: { task: DreamingTask; problems: string[] }[] = [];
    const passEnd = (): string | undefined => {
      if (workspace.closed || ended) return undefined;
      const checked = report(); checks.push({ task: current(), problems: checked.problems });
      if (checked.problems.length) {
        if (!repaired) { repaired = true; return `Correct the following problems, call check, then stop.\n\n${deliver(checked.text)}`; }
        failed = true; ended = true; return undefined;
      }
      repaired = false;
      const next = advance();
      if (next === undefined) ended = true;
      return next === undefined ? undefined : deliver(next);
    };
    const input: DreamingAgentInput = { kind: "dreaming", task: initial, sessionId, branch, model: run.model!, thinking: frozen.model.thinking, mode: "subagent",
      prompt: frozen.prompt, promptHash: frozen.promptHash, text, tools: binding.tools,
      workspace: { dir: workspace.dir, read: ["items.md", "groups.md", "group.md", "seeds.md", "notes.md", "decisions.md", "changes.md", "scoring.md", "scores.md"].map(name => workspace.path(name)),
        write: (initial === "notes" ? ["notes.md"] : initial === "clustering" ? ["groups.md"] : ["decisions.md", "changes.md", "scores.md"]).map(name => workspace.path(name)), roots },
      passEnd, reportResponse: (id, input) => responses.set(id, input), acknowledgeRequest: binding.acknowledgeRequest, reportRequest: binding.reportRequest,
      deadline: started + (initial === "curate" ? 2 : 1) * limits.timeoutMs, call: binding.call };
    let result: RunAgentResult;
    try { result = await runAgent(input); } catch (error) { result = agentException(error); }
    binding.close();
    if (store.closed) return { ok: false, task: current(), runId: 0, outcome: "cancelled", problems: ["store closed"], class: "cancelled" };
    const outcome = result.outcome === "cancelled" || result.outcome === "success" && workspace.closed ? "cancelled" : result.outcome !== "success" || failed || !ended || requestMissing(result) ? "failure" : "success";
    const problems = outcome === "success" ? [] : failed ? report().problems : [String(result.output ?? (requestMissing(result) ? "runAgent must return the exact provider request" : "conversation did not finish"))];
    recordAttempt(run, result, { task: initial, stopChecks: checks, toolCalls: binding.sequence, fetched: binding.fetched, problems, durationMs: Date.now() - started });
    const runId = outcome === "success" ? 0 : store.recordRun({ ...run, outcome }).id;
    if (runId) lastRunId = runId;
    return { ok: outcome === "success", task: current(), runId, run, outcome, problems, class: failed ? "check failed twice" : classifyFailure(result.output, result.failureClass).class };
  };
  const usage = (responses: Map<string, number | undefined>, steps: number, growth?: number) => {
    const inputs = [...responses.values()], first = inputs[0], last = inputs.at(-1);
    return `Budget: steps ${inputs.length} of ${steps}; context +${!inputs.length ? 0 : first === undefined || last === undefined ? "unknown" : last - first}${growth === undefined ? "" : ` of +${growth}`}. In principle stay within ${growth === undefined ? "the step budget" : "both"}; one step is one model response, even with several tool calls.`;
  };
  const failure = (out: Outcome, group?: number): DreamingResult => ({ outcome: out.outcome === "cancelled" ? "cancelled" : "failure", runId: out.runId, problems: out.problems,
    failure: { task: out.task, class: out.class, groups: group ? [{ group, task: out.task, class: out.class }] : [] } });
  if (frozen.notes === undefined) {
    const workspace = new TaskWorkspace(root, "dreaming-", sessionId, options.executionId, "notes").open({ "seeds.md": frozen.seeds, "notes.md": "" });
    const responses = new Map<string, number | undefined>();
    const report = () => {
      const count = tokens(workspace.text("notes.md")), problems = count > limits.notesTokens ? [`notes.md: ${count} tokens exceeds ${limits.notesTokens}`] : [];
      if (!workspace.text("notes.md").trim()) problems.push("notes.md: write repository notes, or None when no repository applies");
      return { problems, text: [`Task: notes. File: ${workspace.path("notes.md")}. Input: ${workspace.path("seeds.md")}`,
        `Repositories you may read: ${roots.join(", ") || "none"}`, usage(responses, limits.notesSteps),
        `Notes: ${count}/${limits.notesTokens} tokens. Explore the repositories once and write notes for all groups; do not change repository files.`, ...problems].join("\n") };
    };
    const out = await conversation(workspace, "notes", `${frozen.knowledge}\n\n${readingGuide(sessionId, frozen.names)}\n\nCall ${frozen.names.check} first.`, report, () => undefined, () => "notes", responses);
    if (!out.ok) return failure(out);
    frozen.notes = workspace.text("notes.md");
    const saved = store.commitTaskPass({ run: { ...out.run!, response: JSON.stringify({ ...JSON.parse(out.run!.response ?? "{}"), task: "notes", notes: frozen.notes }) }, path,
      handoff: () => ({ nextTask: frozen.fullCheck && !frozen.groupsFile ? "clustering" : "curate", detail: detail() }) });
    lastRunId = saved.runId;
    workspace.remove();
  }
  const prefix = `${frozen.knowledge}\n\n<repository_notes>\n${frozen.notes}\n</repository_notes>`;
  if (frozen.fullCheck && frozen.groupsFile === undefined) {
    const workspace = new TaskWorkspace(root, "dreaming-", sessionId, options.executionId, "clustering").open({
      "items.md": clusteringInput(store, frozen.clusteringItems), "groups.md": groupsTemplate(frozen.clusteringItems.length, limits.groupItems) });
    const responses = new Map<string, number | undefined>();
    const report = () => {
      const checked = checkGroups(workspace.text("groups.md"), frozen.clusteringItems, limits.groupItems);
      return { problems: checked.problems, text: [`Task: clustering. Input: ${workspace.path("items.md")}. Output: ${workspace.path("groups.md")}.`,
        `Group size: at most ${limits.groupItems}.`, usage(responses, limits.clusteringSteps, limits.clusteringContextTokens),
        checked.problems.length ? `Problems:\n${checked.problems.join("\n")}` : "Problems: none"].join("\n") };
    };
    const out = await conversation(workspace, "clustering", `${prefix}\n\n${readingGuide(sessionId, frozen.names)}\n\nCall ${frozen.names.check} first.`,
      report, () => undefined, () => "clustering", responses, () => loadPrompt("tasks/clustering.md", frozen.names, config.writing));
    if (!out.ok) return failure(out);
    frozen.groupsFile = workspace.text("groups.md");
    const items = new Map(frozen.clusteringItems.map(item => [item.value.knowledge.id, item]));
    groups.push(...checkGroups(frozen.groupsFile, frozen.clusteringItems, limits.groupItems).groups.map((group, i) => ({
      no: i + 1, items: group.items.map(id => items.get(id)!), clusters: group.clusters })));
    lastRunId = store.commitTaskPass({ run: { ...out.run!, response: JSON.stringify({ ...JSON.parse(out.run!.response ?? "{}"), task: "clustering", ...detail() }) }, path,
      handoff: () => ({ nextTask: "curate", detail: detail() }) }).runId;
    workspace.remove();
  }
  const runGroup = async (group: FrozenGroup): Promise<Outcome> => {
    let task: DreamingTask = "curate";
    const reviewed = new Map(group.items.map(item => [item.value.knowledge.id, store.knowledgeStaleReasons(item.value.revision.id)]));
    const workspace = new TaskWorkspace(root, "dreaming-", sessionId, options.executionId, `group-${group.no}`).open({ "group.md": groupText(store, group.items, group.clusters),
      "seeds.md": frozen.seeds, "decisions.md": decisionsTemplate(group.items), "changes.md": "", "scores.md": "" });
    const responses = new Map<string, number | undefined>();
    const heads = new Map<string, string>();
    // Freeze repository HEAD before curate, never at commit or from model-authored data.
    for (const directory of roots) { const repo = repositoryHead(join(directory, "__head_snapshot__")); if (repo) heads.set(repo.root, repo.commit); }
    for (const item of group.items) for (const file of item.value.revision.files ?? []) { const repo = repositoryHead(file); if (repo) heads.set(repo.root, repo.commit); }
    let curated: Curated | undefined, targets: ScoreTarget[] = [], sealed = "", scoringReview = false;
    const readCurate = () => checkCurate(store, path, group.items, { name: "decisions.md", text: workspace.text("decisions.md") }, { name: "changes.md", text: workspace.text("changes.md") });
    const report = () => {
      const checked = task === "curate" ? readCurate() : undefined;
      const problems = checked ? [...checked.problems] : checkScores(workspace.text("scores.md"), targets).problems;
      if (task === "scoring" && sealed !== workspace.text("decisions.md") + "\0" + workspace.text("changes.md")) problems.push("Curate files changed after passing; restore them before scoring");
      if (checked) for (const op of checked.operations) for (const file of [...op.files ?? [], ...(op.op === "split" ? op.children.flatMap(child => child.files ?? []) : [])]) {
        const repo = repositoryHead(file);
        if (repo && !heads.has(repo.root)) problems.push(`files: no start-of-curate HEAD recorded for repository ${repo.root}`);
      }
      return { problems, text: [`Task: ${task} (group ${group.no} of ${groups.length}).`,
        `Input: ${workspace.path("group.md")}. Seeds: ${workspace.path("seeds.md")}.`,
        `Decisions: ${workspace.path("decisions.md")}. Changes: ${workspace.path("changes.md")}. Scores: ${workspace.path("scores.md")}.`,
        ...(task === "scoring" ? [`Scoring input: ${workspace.path("scoring.md")}. Items: ${targets.map(target => target.label).join(", ")}`] : []),
        `Repositories you may read: ${roots.join(", ") || "none"}`, usage(responses, task === "curate" ? limits.curateSteps : limits.scoringSteps, task === "curate" ? limits.curateContextTokens : limits.scoringContextTokens),
        ...checked?.lengths ?? [], problems.length ? `Problems:\n${problems.join("\n")}` : "Problems: none"].join("\n") };
    };
    const advance = () => {
      if (task === "scoring") {
        if (scoringReview || !targets.length) return undefined;
        scoringReview = true;
        return `Scoring draft passes. Self-check every score in this same conversation: if most items sit in one band, separate them again; correct any score that breaks the Scale floors. Edit scores.md if needed, call check, then stop; if nothing needs correcting, stop. Nothing is published yet.\n\n${report().text}`;
      }
      curated = readCurate();
      targets = scoreTargets(group.items, curated.operations, frozen.fullCheck);
      sealed = workspace.text("decisions.md") + "\0" + workspace.text("changes.md");
      writeFileSync(workspace.path("scoring.md"), scoringText(frozen.fullCheck ? [] : classifyAnchors(projectItems(store, path), new Set(targets.map(target => Number(/^K(\d+)/.exec(target.label)![1])))), targets));
      task = "scoring"; responses.clear();
      return `Curate passes. Continue this same conversation with scoring.\n\n${report().text}`;
    };
    const out = await conversation(workspace, "curate", `${prefix}\n\n${readingGuide(sessionId, frozen.names)}\n\nGroup ${group.no}. Call ${frozen.names.check} first.`, report, advance, () => task, responses,
      stage => loadPrompt(stage === "curate" ? "tasks/curate.md" : "classifying.md", frozen.names, config.writing));
    if (!out.ok) return out;
    const scores = checkScores(workspace.text("scores.md"), targets).scores;
    const run: RunInput = { ...out.run!,
      response: JSON.stringify({ ...JSON.parse(out.run!.response ?? "{}"), task: "group", group: group.no, decisions: workspace.text("decisions.md"), changes: workspace.text("changes.md"), scores: workspace.text("scores.md") }) };
    const previousBoundary = { ...frozen.boundary.versions };
    const completed = new Set<number>();
    try {
      const last = groups.every(other => other === group || other.run !== undefined);
      const done = store.commitTaskPass({ run, path, operations: curated!.operations,
        response: results => JSON.stringify({ ...JSON.parse(run.response ?? "{}"), results, ...(frozen.fullCheck ? { ...detail(), groups: groups.map(other => ({
          items: other.items.map(item => item.value.knowledge.id), clusters: other.clusters, run: other === group ? undefined : other.run })) } : {}) }),
        after: ({ runId, results }) => {
          const refused = new Set(results.flatMap((result, i) => {
            if (result.ok) return [];
            const op = curated!.operations[i]!;
            return op.op === "create" ? [] : op.op === "merge" ? [op.intoKnowledgeId, ...op.absorb.map(base => base.knowledgeId)] : [op.knowledgeId];
          }));
          const current = new Map(projectItems(store, path).map(item => [item.value.knowledge.id, item.value.revision]));
          const processed: KnowledgeRevision[] = [];
          const lateFlags = new Map(group.items.map(item => [item.value.knowledge.id, store.knowledgeStaleReasons(item.value.revision.id)
            .filter(flag => !reviewed.get(item.value.knowledge.id)!.some(old => old.reason === flag.reason && old.detail === flag.detail))]));
          for (const decision of curated!.decisions) {
            const r = current.get(decision.item.value.knowledge.id);
            const operation = curated!.operations.find(op => op.op !== "create" && (op.op === "merge"
              ? op.intoKnowledgeId === decision.item.value.knowledge.id || op.absorb.some(base => base.knowledgeId === decision.item.value.knowledge.id)
              : op.knowledgeId === decision.item.value.knowledge.id));
            if (refused.has(decision.item.value.knowledge.id) || !operation && r?.id !== decision.item.value.revision.id) continue;
            if (r) processed.push(r);
            completed.add(decision.item.value.knowledge.id);
            for (const flag of reviewed.get(decision.item.value.knowledge.id) ?? []) store.clearKnowledgeStale(decision.item.value.revision.id, flag);
          }
          for (const result of results) if (result.ok) for (const committed of result.committed) {
            const r = store.getKnowledgeRevision(committed.knowledgeId, committed.commit)!;
            frozen.boundary.versions[r.knowledgeId] = r.id;
            if (!processed.some(item => item.id === r.id)) processed.push(r);
          }
          for (const r of processed) {
            const source = results.findIndex(result => result.ok && result.committed.some(item => item.commit === r.id));
            const op = curated!.operations[source];
            const parent = op && op.op !== "create" ? op.op === "merge" ? op.intoKnowledgeId : op.knowledgeId : r.knowledgeId;
            const decision = curated!.decisions.find(value => value.item.value.knowledge.id === parent);
            for (const flag of reviewed.get(parent) ?? []) store.clearKnowledgeStale(r.id, flag);
            for (const file of r.files ?? []) {
              const repo = repositoryHead(file), commit = repo && heads.get(repo.root);
              // ponytail: an untracked, ignored or non-git file gets no baseline (its edits cannot be detected, as 「无 git 的文件先不做哈希」) and no
              // new flag: a flag the Dreamer can never clear would bring the item back as a candidate on every run.
              if (commit && trackedAt(repo.root, commit, file)) store.setKnowledgeFileVerification(r.id, { file, verifiedCommit: commit, verifiedAt: new Date().toISOString() });
            }
            // A flag that arrived after the group's input was frozen was not reviewed: the result carries it, from every merge parent.
            const parents = op?.op === "merge" ? [op.intoKnowledgeId, ...op.absorb.map(base => base.knowledgeId)] : [parent];
            for (const flag of parents.flatMap(id => lateFlags.get(id) ?? [])) store.setKnowledgeStale(r.id, flag);
            if (decision?.missingGrounds) store.setKnowledgeStale(r.id, { reason: "missing_grounds", detail: decision.reason });
            frozen.boundary.versions[r.knowledgeId] = r.id;
          }
          const set = store.db.prepare("UPDATE knowledge SET score=?,scored_commit=?,scored_run=? WHERE id=?");
          for (const target of targets) {
            const result: WorkspaceOperationResult | undefined = target.operation === undefined ? undefined : results[target.operation];
            const committed = result?.ok ? result.committed[target.part ?? 0] : undefined;
            const id = committed?.knowledgeId ?? target.knowledgeId, commit = committed?.commit ?? target.commit;
            if (id !== undefined && current.get(id)?.id === commit) set.run(scores.get(target.label)!, commit!, runId, id);
          }
        },
        cover: ({ results }) => [...group.items.filter(item => completed.has(item.value.knowledge.id)).map(item => ({ id: item.value.revision.id, pool: item.pool })), ...results.flatMap(result => result.ok ? result.committed.map(item => ({ id: item.commit })) : [])],
        handoff: ({ runId }) => { group.run = runId; return last ? null : { nextTask: "curate", detail: detail() }; },
        ...(last ? { finish: { boundary: frozen.boundary } } : {}) });
      lastRunId = done.runId;
      workspace.remove();
      return { ...out, runId: done.runId };
    } catch (error) {
      group.run = undefined; frozen.boundary.versions = previousBoundary;
      const runId = store.recordRun({ ...run, outcome: "failure", response: JSON.stringify({ ...JSON.parse(run.response ?? "{}"), error: String(error) }) }).id;
      lastRunId = runId;
      return { ok: false, task, outcome: "failure", runId, problems: [String(error)], class: classifyFailure(error).class };
    }
  };
  const pending = groups.filter(group => group.run === undefined), failures: { group: number; out: Outcome }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limits.parallelGroups, pending.length) }, async () => {
    while (next < pending.length) {
      const group = pending[next++]!;
      try { const out = await runGroup(group); if (!out.ok) failures.push({ group: group.no, out }); }
      catch (error) { failures.push({ group: group.no, out: { ok: false, task: "curate", runId: lastRunId, outcome: "failure", problems: [String(error)], class: classifyFailure(error).class } }); }
    }
  }));
  if (store.closed) return { outcome: "dropped" };
  if (failures.length) {
    failures.sort((a, b) => a.group - b.group);
    const first = failures[0]!;
    return { outcome: failures.some(failed => failed.out.outcome === "cancelled") ? "cancelled" : "failure", runId: first.out.runId,
      problems: failures.flatMap(failed => failed.out.problems), failure: { task: first.out.task, class: first.out.class,
        groups: failures.map(failed => ({ group: failed.group, task: failed.out.task, class: failed.out.class })) } };
  }
  if (!groups.length) lastRunId = store.commitTaskPass({ run: template("curate"), path, handoff: () => null, finish: { boundary: frozen.boundary } }).runId;
  return { outcome: "success", runId: lastRunId, problems: [] };
}
