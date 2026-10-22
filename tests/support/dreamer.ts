import { readFileSync, writeFileSync } from "node:fs";
import type { RunAgentResult } from "../../src/core/api/index.ts";
import type { DreamingAgentInput } from "../../src/core/dreaming/index.ts";
import type { RunAgent, TraceMemory } from "../source-fixture.ts";
import { REQUEST } from "./noter.ts";
import { block, workspaceBatch } from "./workspace.ts";
import { applyWorkspace, describeBlock, plan } from "../../src/core/workspace/index.ts";
import { CURATE_ROTATION, type CurateOperation } from "../../src/core/store/executions.ts";
import type { Proposal } from "../../src/core/dreaming/changes.ts";
import type { KnowledgePath, Store } from "../../src/core/store/index.ts";
import { knowledge as seedKnowledge } from "./seed.ts";
import { placementOwner } from "../../src/core/store/processing.ts";

/** A scripted Dreamer (ticket 144, stages 4 and 5): the stand-in for the model behind `runAgent` in tests that run the real Dreaming
 * tasks. Like a host, it calls `check`, writes the file `check` names, meets the stop hook after every pass and follows the next
 * batch it is handed. The test states only WHAT each file holds: file text, or a list of texts when the first attempt is expected
 * to fail the check and the repair should say something else. A curate category with no entry writes `## none`; a verify file with
 * no entry confirms every numbered change (stage 5 §9.8), and a script a test supplies is used exactly as given; a classify pass with no
 * entry scores every item 50. */
type Text = string | readonly string[] | ((message: string) => string);
export interface DreamerScript {
  /** The curate batch files by category: a category's text goes to its first listed batch, and `"batch<b>"` names batch b of the group. A batch with no entry writes `## none`. A conversation writes every batch file in order, then meets the
   * stop hook; the repair message names the failing batches, and their files are written again with the next text of a list. */
  curate?: Partial<Record<string, Text>>;
  /** Verify's file. */
  verify?: Text;
  /** Classify's file for each pass (1-based); `ids` are the pass's items. */
  classify?: (pass: number, ids: number[], message: string) => Text | undefined;
  /** Result of the curate conversation (a failure, a cancellation); absent: success. */
  curateResult?: Partial<RunAgentResult>;
  /** Run instead of the scripted conversation for one task (a runner that hangs, ignores abort, or records its input). */
  instead?: Partial<Record<"curate" | "verify" | "classify", (input: DreamingAgentInput) => Promise<RunAgentResult> | RunAgentResult>>;
}

const FILE: Record<string, RegExp> = { curate: /File: (\S+?\.md)/, verify: /Your file: (\S+?\.md)/, classify: /File: (\S+?\.md)/ };
/** The batches a curate `check` result (or a repair) lists: `batch b of n, category X. Items: …. File: path`. */
export const listedBatches = (report: string) => [...report.matchAll(/^batch (\d+) of (\d+), category (\w+)\. Items: .*?\. File: (\S+?\.md)/gm)]
  .map(match => ({ no: Number(match[1]), of: Number(match[2]), category: match[3]!, file: match[4]! }));

/** The default verify file: `## confirm <n>` for every change numbered in the change file the report names. */
export const confirmEvery = (report: string): string => {
  const changes = /Change file: (\S+?\.md)/.exec(report)?.[1];
  const numbers = changes ? [...readFileSync(changes, "utf8").matchAll(/^## (\d+) · /gm)].map(match => match[1]!) : [];
  return numbers.length ? numbers.map(n => `## confirm ${n}\n`).join("\n") : "## none\n";
};

export function scriptedDreamer(script: DreamerScript = {}) {
  script.curate ??= {}; // a test may fill in a batch after the run is built
  const inputs: DreamingAgentInput[] = [], messages: string[] = [], reports: string[] = [], attempts = new Map<string, number>();
  const pick = (key: string, planned: Text | undefined, report: string): string => {
    const attempt = attempts.get(key) ?? 0;
    attempts.set(key, attempt + 1);
    if (typeof planned === "function") return planned(report);
    if (typeof planned === "string") return planned;
    const list = planned ?? ["## none\n"];
    return list[Math.min(attempt, list.length - 1)]!;
  };
  const agent = async (raw: unknown): Promise<RunAgentResult> => {
    const input = raw as DreamingAgentInput;
    inputs.push(input);
    if (script.instead?.[input.task]) return script.instead[input.task]!(input);
    input.reportRequest(REQUEST);
    let report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    reports.push(report);
    if (input.task === "curate") {
      const nth = new Map<string, number>(), all = listedBatches(report).map(batch => ({ ...batch, nth: nth.set(batch.category, (nth.get(batch.category) ?? 0) + 1).get(batch.category)! }));
      let listed = all;
      for (let round = 0; round < 10; round++) {
        for (const batch of listed) {
          const planned = script.curate?.[`batch${batch.no}`] ?? (batch.nth === 1 ? script.curate?.[batch.category] : undefined);
          const attempt = typeof planned === "function" ? planned(report) : typeof planned === "string" ? planned : (planned ?? ["## none\n"])[Math.min(round, (planned ?? [""]).length - 1)]!;
          writeFileSync(batch.file, attempt);
        }
        const message = input.passEnd();
        if (message === undefined) break;
        messages.push(message);
        report = message;
        const failing = new Set(listedBatches(message).map(batch => batch.file));
        listed = all.filter(batch => failing.has(batch.file));
      }
    } else for (let turn = 0; turn < 50; turn++) {
      const file = FILE[input.task]!.exec(report)![1]!;
      const text = input.task === "verify" ? pick(`verify:${/group (\d+)/.exec(report)?.[1] ?? 1}`, script.verify ?? confirmEvery(report), report)
        : (() => {
            const ids = [...(/Items: (.*)/.exec(report)?.[1] ?? "").matchAll(/K(\d+)/g)].map(match => Number(match[1]));
            const pass = Number(/pass (\d+)/.exec(report)?.[1] ?? 1);
            return pick(`classify:${pass}`, script.classify?.(pass, ids, report) ?? ids.map(id => `K${id} 50`).join("\n") + "\n", report);
          })();
      writeFileSync(file, text);
      const message = input.passEnd();
      if (message === undefined) break;
      messages.push(message);
      report = message;
    }
    return { outcome: "success", output: "Done.", request: REQUEST, usage: { tokens: 12 }, ...(input.task === "curate" ? script.curateResult : {}) } as RunAgentResult;
  };
  return { agent, inputs, messages, reports, script };
}

/** A session whose Dreamer is `scriptedDreamer`, due at the first check. `memories` collects what the test must close. A test swaps in
 * its own runner (one that waits, or ignores a stop) for the calls that follow with `next`. */
export function dreamerFixture(memories: TraceMemory[], script: DreamerScript = {}, dbPath?: string) {
  const dreamer = scriptedDreamer(script);
  const runners: RunAgent[] = [];
  const b = workspaceBatch({ agent: raw => (runners.shift() ?? dreamer.agent)(raw), dbPath });
  memories.push(b.memory);
  b.memory.config.dreaming.triggerOperations = 1;
  const target = { sessionId: b.session.id, branch: "main", headTurnId: b.path.headTurnId!, model: "scripted" };
  const dream = () => b.memory.dream(target);
  /** Reach a later operation by real cycles (stage 5 §9.8): Noter-written items that reach the trigger, then one empty `dream()`, until
   * the project's next operation is `operation`. Never seeds run records or edits the rotation. */
  const cycleTo = async (operation: CurateOperation) => {
    for (let guard = 0; b.store.nextCurateOperation(b.project.id) !== operation; guard++) {
      if (guard > CURATE_ROTATION.length) throw new Error(`cycleTo(${operation}) did not converge`);
      noterWrittenItem(b.memory, b.path as never, b.existingFact(`Cycle fact ${guard}`).id);
      const result = await dream();
      if (result.outcome !== "success") throw new Error(`cycleTo: a cycle ended ${result.outcome}`);
    }
  };
  return { ...b, dreamer, target, dream, cycleTo, next: (agent: RunAgent) => { runners.push(agent); } };
}
export type DreamerFixture = ReturnType<typeof dreamerFixture>;

/** The curate model of a test that does something the scripted one does not: it calls `check`, writes the batch files `check` lists with
 * `texts` (in batch order; a batch with no text is left unwritten), and meets the stop hook once. Returns the hook's answer (the repair message,
 * or undefined when the task is over). */
export async function writeCurateFiles(input: DreamingAgentInput, ...texts: string[]): Promise<string | undefined> {
  const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
  listedBatches(report).forEach((batch, i) => { if (texts[i] !== undefined) writeFileSync(batch.file, texts[i]!); });
  return input.passEnd();
}

/** Part 4b: the vehicle for tests whose subject is what a merge, split, archive or update leaves in the Store, not the Dreamer's run.
 * It applies a curate file to a path through the same check and `commitWorkspaceRun` a Dreamer's pass uses, and throws on a file that
 * fails its check. A curate file holds one operation (stage 5 §3.5): `operation` names it, or a text that mixes operations is split into
 * consecutive single-operation files, applied in order. Each operation still commits or is refused on its own: read `blocks` for a stale base. */
export function curateNow(memory: { store: Store }, path: KnowledgePath, text: string, operation?: CurateOperation) {
  const groups: { operation: CurateOperation; text: string }[] = [];
  if (operation) groups.push({ operation, text });
  else for (const segment of text.split(/^(?=## )/m).filter(part => part.trim())) {
    const op = /^## (\w+)/.exec(segment)?.[1] as CurateOperation;
    if (groups.at(-1)?.operation === op) groups.at(-1)!.text += segment; else groups.push({ operation: op, text: segment });
  }
  const done = groups.map(group => {
    const result = applyWorkspace(memory.store, { kind: "curate", operation: group.operation, sessionId: path.sessionId, path, file: { name: `curate-${group.operation}.md`, text: group.text } });
    if (!result.ok) throw new Error(result.problems.join("\n"));
    return result;
  });
  return { ok: true as const, runId: done.at(-1)!.runId, factIds: {}, blocks: done.flatMap(result => result.blocks) };
}
/** `K<id>@v<n>` of a committed version. */
export const versionRef = (store: Store, knowledgeId: number, commit: number) => `K${knowledgeId}@v${store.versionOrdinal(knowledgeId, commit)}`;

type Operation = import("../../src/core/store/index.ts").KnowledgeOperationInput;
/** The store-level operations a Dreamer's pass would commit, written as curate files and applied with `curateNow`. For tests that seed
 * lineage (updates, merges, splits) and need the versions back: every block must apply. Returns the committed versions in operation order
 * (a split: the primary part, then its children). Dreaming has no create (stage 5): a `create` goes straight to the Store write path
 * (`commitDreamerOps`), as the Noter's would. A mixed list becomes consecutive single-operation files. An `archive` of kind `budget` is
 * written as `invalid`. */
export function curateWrite(memory: { store: Store }, path: KnowledgePath, operations: readonly Operation[]): { knowledgeId: number; commit: number }[] {
  const { store } = memory;
  const ref = (knowledgeId: number, commit: number) => versionRef(store, knowledgeId, commit);
  const F = (ids: readonly number[]) => ids.map(id => `F${id}`).join(", ");
  const shared = (op: { category: string; scope: string; topics: readonly string[]; supports: readonly number[]; reason: string }) =>
    ({ category: op.category, scope: op.scope, topics: op.topics.join(", "), ...(op.supports.length ? { supports: F(op.supports) } : {}), reason: op.reason });
  const blockOf = (op: Operation): string => {
    if (op.op === "update") return block(`update ${ref(op.knowledgeId, op.baseCommit)}`, { ...(op.title ? { title: op.title } : {}), ...shared(op) }, op.text);
    if (op.op === "merge") return block(`merge ${ref(op.intoKnowledgeId, op.intoBaseCommit)}`, { absorb: op.absorb.map(parent => ref(parent.knowledgeId, parent.baseCommit)).join(", "), ...(op.title ? { title: op.title } : {}), ...shared(op) }, op.text);
    if (op.op === "split") return block(`split ${ref(op.knowledgeId, op.baseCommit)}`, shared(op), op.text) + op.children.map(child =>
      `\n### child\ntitle: ${child.title}\ncategory: ${child.category}\nscope: ${op.scope}\ntopics: ${child.topics.join(", ")}\nsupports: ${F(op.supports.length ? op.supports : store.knowledgeRevision(op.baseCommit)!.supports)}\nreason: ${op.reason}\n\n${child.text}\n`).join("");
    if (op.op === "archive") return block(`archive ${ref(op.knowledgeId, op.baseCommit)}`, { kind: op.kind === "inadmissible" ? "inadmissible" : "invalid", reason: op.reason },
      op.text ?? "The user withdrew this and nothing replaces it; the grounds are in the cited evidence.");
    throw new Error(`curateWrite: unsupported operation ${(op as { op: string }).op}`);
  };
  const out: { knowledgeId: number; commit: number }[] = [];
  for (let at = 0; at < operations.length;) {
    const op = operations[at]!;
    if (op.op === "create") { out.push(...commitDreamerOps(memory, path, [op])); at++; continue; }
    let end = at;
    while (end < operations.length && operations[end]!.op === op.op) end++;
    const result = curateNow(memory, path, operations.slice(at, end).map(blockOf).join("\n"), op.op);
    const refused = result.blocks.filter(entry => entry.status !== "applied");
    if (refused.length) throw new Error(refused.map(entry => `${entry.block}: ${entry.reason}`).join("\n"));
    out.push(...result.blocks.flatMap(entry => entry.versions).map(version => {
      const [, id, ordinal] = /^K(\d+)@v(\d+)$/.exec(version)!;
      return { knowledgeId: Number(id), commit: store.resolveVersionOrdinal(Number(id), Number(ordinal)) };
    }));
    at = end;
  }
  return out;
}

/** The same, for a test whose operation needs a field the file format does not carry (an archive with its own supports on one branch):
 * the store operations go straight through `commitWorkspaceRun`, the commit a pass uses. Throws when one is refused. */
export function commitDreamerOps(memory: { store: Store }, path: KnowledgePath, operations: readonly Operation[]): { knowledgeId: number; commit: number }[] {
  const done = memory.store.commitWorkspaceRun({ run: { kind: "dreaming", sessionId: path.sessionId, branch: path.branch ?? null, createdAt: new Date().toISOString() }, path, operations });
  const refused = done.results.flatMap(result => result.ok ? [] : [result.reason]);
  if (refused.length) throw new Error(refused.join("\n"));
  return done.results.flatMap(result => result.ok ? result.committed.map(item => ({ knowledgeId: item.knowledgeId, commit: item.commit })) : []);
}

/** A small Noter-written item over `factId`: only Noter changes make a Dreamer due (stage 4, 2026-10-22). A host test pairs it with
 * `dreaming.triggerOperations: 1`. Replaces the retired budget-crossing fixture `createDreamerTrigger`. */
export function noterWrittenItem(memory: TraceMemory, path: { sessionId: number; branch: string; headTurnId: number }, factId: number,
  scope: "global" | "project" | "session" = "project", category: "constraint" | "reference" = "constraint") {
  return seedKnowledge(memory.store, path, scope, category, [factId], `Fixture trigger item ${factId}`, { operation: { title: `Trigger item ${factId}` } });
}

/** Coverage as a passed curate leaves it (stage 4 §2.1): each of these versions is processed in its own pool, under one Dreamer run.
 * It replaces the retired range-freeze-and-complete sequence that tests used to mark knowledge processed. */
export function coverKnowledge(store: Store, path: KnowledgePath, revisionIds: readonly number[]): number {
  const run = store.recordRun({ kind: "dreaming", sessionId: path.sessionId, branch: path.branch ?? null, createdAt: new Date().toISOString(), outcome: "success" });
  for (const id of revisionIds) store.db.prepare("INSERT OR IGNORE INTO knowledge_processed(pool,revision_id,run_id) VALUES (?,?,?)")
    .run(placementOwner(store, { revision: store.knowledgeRevision(id)! }), id, run.id);
  return run.id;
}

/** The operation a curate file of one operation names, from its first block's heading (for a test helper that takes the file's text only). */
export const operationOfText = (text: string): CurateOperation => /^## (update|merge|split|archive)\b/m.exec(text)?.[1] as CurateOperation ?? "update";

/** The proposals a curate run kept (stage 5 §4.2), compiled from curate blocks the way the batch check does: one entry per block, in change order. */
export function proposalsOf(memory: { store: Store }, path: KnowledgePath, ...entries: [CurateOperation, string][]): Proposal[] {
  return entries.flatMap(([operation, text]) => {
    const planned = plan(memory.store, { kind: "curate", operation, sessionId: path.sessionId, path, file: { name: "curate.md", text } });
    if (planned.problems.length) throw new Error(planned.problems.join("\n"));
    return planned.knowledge.map(entry => ({ run: 0, category: "constraint", block: describeBlock(entry.block), operation: entry.make().operation as Proposal["operation"] }));
  }).map((proposal, i) => ({ ...proposal, n: i + 1 }));
}
/** A curate batch run as `commitTaskPass` records it, for tests of the change file: the proposals, and nothing applied. */
export function keptBatch(memory: { store: Store }, path: KnowledgePath, category: string, ...entries: [CurateOperation, string][]): number {
  const proposed = proposalsOf(memory, path, ...entries).map(({ block, operation }) => ({ block, operation }));
  return memory.store.recordRun({ kind: "dreaming", sessionId: path.sessionId, branch: path.branch ?? null, createdAt: new Date().toISOString(), outcome: "success",
    response: JSON.stringify({ task: "curate", category, proposed }) }).id;
}
