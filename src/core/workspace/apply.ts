// Publishing a checked workspace file (ticket 144, Stage 2). The Noter's two files go through the existing
// Noting commit, so facts, their ids and the knowledge that cites them land in one transaction, and a stale
// update becomes a create there. Dreaming's knowledge file goes through `commitWorkspaceRun`, which refuses an
// operation whose base is no longer current (and what depends on it) and leaves it for the next run.

import { describeBlock, type Block, type WorkspaceFile } from "./parse.ts";
import { plan, type NotingScope, type PlannedBlock } from "./plan.ts";
import type { KnowledgePath, RunInput, Store } from "../store/index.ts";

export type ApplyInput =
  | { kind: "noting"; scope: NotingScope; facts: WorkspaceFile; knowledge: WorkspaceFile; run?: RunInput }
  | { kind: "curate" | "verify"; sessionId: number; path?: KnowledgePath; file: WorkspaceFile; run?: RunInput };

/** What publishing did with one block. `versions` are the versions it wrote, as `K<id>@v<n>`. */
export interface BlockResult {
  block: string;
  line: number;
  status: "applied" | "refused";
  versions: string[];
  /** A Noter's update whose base had moved on, published as a create. */
  converted?: boolean;
  /** Refused because its base is no longer current: left for the next run. */
  stale?: boolean;
  reason?: string;
}

export type ApplyResult =
  | { ok: true; runId: number; blocks: BlockResult[]; /** The ids the facts file's labels were published as. */ factIds: Record<string, number> }
  | { ok: false; problems: string[] };

export function applyWorkspace(store: Store, input: ApplyInput): ApplyResult {
  if (input.kind === "noting") return applyNoting(store, input);
  const planned = plan(store, { kind: input.kind, sessionId: input.sessionId, path: input.path, file: input.file });
  if (planned.problems.length) return { ok: false, problems: planned.problems };
  const path = planned.path!;
  // A merged archive points at its successor's version, so it is applied after everything that may write one.
  const ordered = [...planned.knowledge.filter(entry => entry.successor === undefined), ...planned.knowledge.filter(entry => entry.successor !== undefined)];
  const operations = ordered.map(entry => ({
    operation: entry.make().operation!,
    dependsOn: entry.successor === undefined ? undefined : ordered.flatMap((other, index) => other.successor === undefined && other.items[0] === entry.successor ? [index] : []),
  }));
  const run: RunInput = input.run ?? { kind: "dreaming", sessionId: path.sessionId, branch: path.branch ?? null, createdAt: new Date().toISOString() };
  const done = store.commitWorkspaceRun({ run, path, operations, response: results => JSON.stringify({ workspace: input.kind,
    blocks: ordered.map((entry, i) => ({ block: describeBlock(entry.block), line: entry.block.line, result: results[i] })) }) });
  const blocks = ordered.map((entry, i): BlockResult => {
    const result = done.results[i]!, where = describeBlock(entry.block);
    if (result.ok) return { block: where, line: entry.block.line, status: "applied", versions: result.committed.map(item => version(store, item)) };
    const dependent = result.dependent ? ordered.find(other => other.successor === undefined && other.items[0] === entry.successor) : undefined;
    return { block: where, line: entry.block.line, status: "refused", versions: [], stale: result.stale,
      reason: dependent ? `its successor K${entry.successor} was refused (${describeBlock(dependent.block)}); left for the next run`
        : result.stale ? `${result.reason}; left for the next run` : result.reason };
  }).sort((a, b) => a.line - b.line);
  return { ok: true, runId: done.runId, blocks, factIds: {} };
}

const version = (store: Store, item: { knowledgeId: number; commit: number; op: string }): string => {
  try { return `K${item.knowledgeId}@v${store.versionOrdinal(item.knowledgeId, item.commit)}`; }
  catch { return `K${item.knowledgeId}`; } // a merged archive writes no version of its own
};

function applyNoting(store: Store, input: Extract<ApplyInput, { kind: "noting" }>): ApplyResult {
  const facts = plan(store, { kind: "noting-facts", scope: input.scope, file: input.facts });
  const knowledge = plan(store, { kind: "noting-knowledge", scope: input.scope, file: input.knowledge, facts: input.facts });
  const problems = [...facts.problems, ...knowledge.problems];
  if (problems.length) return { ok: false, problems };
  const { path, sources } = facts as Required<Pick<typeof facts, "path" | "sources">> & typeof facts;
  const run: RunInput = input.run ?? { kind: "noting", sessionId: input.scope.sessionId, branch: input.scope.branch,
    rangeFrom: input.scope.range.from, rangeTo: input.scope.range.to, createdAt: new Date().toISOString() };
  const committed = store.commitNotingRun({ run, facts: facts.facts.map(entry => entry.fact), entryIds: sources.frozenEntries,
    held: { path, slots: facts.facts.map((_, i) => i + 1),
      // The batch is published once: its frozen entries must still be pending on the path.
      validate: () => {
        const pending = new Set(store.pendingEntries(path.sessionId, path.branch!, path.headTurnId!, store.pathSnapshot(path)).map(entry => entry.id));
        if (sources.frozenEntries.some(id => !pending.has(id))) throw new Error("frozen Noter entries are no longer pending on the target path");
      },
      knowledge: mapping => knowledge.knowledge.map((entry: PlannedBlock) => {
        const made = entry.make(mapping);
        if (!made.operation) throw new Error(made.problems.join("; ") || "invalid knowledge operation");
        return made.operation;
      }) } });
  if (!committed.ok) return { ok: false, problems: committed.problems };
  const audit = (JSON.parse(store.getRun(committed.runId)!.response ?? "{}").knowledgeOperations ?? []) as
    { requested: { op: string }; applied: { op: string } | null; committed: { op: string; knowledgeId: number; commit: number }[] }[];
  const blocks = knowledge.knowledge.map((entry, i): BlockResult => ({ block: describeBlock(entry.block), line: entry.block.line, status: "applied",
    versions: (audit[i]?.committed ?? []).map(item => version(store, item)),
    ...(audit[i]?.requested.op === "update" && audit[i]?.applied?.op === "create" ? { converted: true } : {}) }));
  return { ok: true, runId: committed.runId, blocks, factIds: Object.fromEntries(facts.facts.map((entry, i) => [entry.label, committed.facts[i]!.id])) };
}

export type { Block };
