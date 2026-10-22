import { writeFileSync } from "node:fs";
import type { DreamingAgentInput, RunAgentResult } from "../../src/core/api/index.ts";
import type { RunAgent, TraceMemory } from "../source-fixture.ts";
import { REQUEST } from "./noter.ts";
import { block, workspaceBatch } from "./workspace.ts";
import { applyWorkspace } from "../../src/core/workspace/index.ts";
import type { KnowledgePath, Store } from "../../src/core/store/index.ts";

/** A scripted Dreamer (ticket 144, stage 4): the stand-in for the model behind `runAgent` in tests that run the real Dreaming
 * tasks. Like a host, it calls `check`, writes the file `check` names, meets the stop hook after every pass and follows the next
 * batch it is handed. The test states only WHAT each file holds: file text, or a list of texts when the first attempt is expected
 * to fail the check and the repair should say something else. A curate category or a verify file with no entry writes `## none`;
 * a classify pass with no entry scores every item 50. */
type Text = string | readonly string[] | ((message: string) => string);
export interface DreamerScript {
  /** The curate batch files by category. */
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
const CATEGORY = /category (\w+)/;

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
    for (let turn = 0; turn < 50; turn++) {
      const file = FILE[input.task]!.exec(report)![1]!;
      const text = input.task === "curate" ? (() => { const category = CATEGORY.exec(report)![1]!; return pick(`curate:${category}`, script.curate?.[category], report); })()
        : input.task === "verify" ? pick("verify", script.verify, report)
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
  b.memory.config.dreaming.triggerTokens = 1;
  const target = { sessionId: b.session.id, branch: "main", headTurnId: b.path.headTurnId!, model: "scripted" };
  const dream = () => b.memory.dream(target);
  return { ...b, dreamer, target, dream, next: (agent: RunAgent) => { runners.push(agent); } };
}
export type DreamerFixture = ReturnType<typeof dreamerFixture>;

/** Part 4b: the vehicle for tests whose subject is what a merge, split, archive or update leaves in the Store, not the Dreamer's run.
 * It applies a curate (or verify) file to a path through the same check and `commitWorkspaceRun` a Dreamer's pass uses, and throws on a
 * file that fails its check. Each operation still commits or is refused on its own: read `blocks` for a stale base. */
export function curateNow(memory: { store: Store }, path: KnowledgePath, text: string, kind: "curate" | "verify" = "curate") {
  const result = applyWorkspace(memory.store, { kind, sessionId: path.sessionId, path, file: { name: `${kind}.md`, text } });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result;
}
/** `K<id>@v<n>` of a committed version. */
export const versionRef = (store: Store, knowledgeId: number, commit: number) => `K${knowledgeId}@v${store.versionOrdinal(knowledgeId, commit)}`;

type Operation = import("../../src/core/store/index.ts").KnowledgeOperationInput;
/** The store-level operations a Dreamer's pass would commit, written as one curate file and applied with `curateNow`. For tests that seed
 * lineage (updates, merges, splits) and need the versions back: every block must apply. Returns the committed versions in block order
 * (a split: the primary part, then its children). An `archive` of kind `budget` is written as `invalid`. */
export function curateWrite(memory: { store: Store }, path: KnowledgePath, operations: readonly Operation[]): { knowledgeId: number; commit: number }[] {
  const { store } = memory;
  const ref = (knowledgeId: number, commit: number) => versionRef(store, knowledgeId, commit);
  const F = (ids: readonly number[]) => ids.map(id => `F${id}`).join(", ");
  const shared = (op: { category: string; scope: string; topics: readonly string[]; supports: readonly number[]; reason: string }) =>
    ({ category: op.category, scope: op.scope, topics: op.topics.join(", "), ...(op.supports.length ? { supports: F(op.supports) } : {}), reason: op.reason });
  const blocks = operations.map(op => {
    if (op.op === "update") return block(`update ${ref(op.knowledgeId, op.baseCommit)}`, { ...(op.title ? { title: op.title } : {}), ...shared(op) }, op.text);
    if (op.op === "merge") return block(`merge ${ref(op.intoKnowledgeId, op.intoBaseCommit)}`, { absorb: op.absorb.map(parent => ref(parent.knowledgeId, parent.baseCommit)).join(", "), ...(op.title ? { title: op.title } : {}), ...shared(op) }, op.text);
    if (op.op === "split") return block(`split ${ref(op.knowledgeId, op.baseCommit)}`, shared(op), op.text) + op.children.map(child =>
      `\n### child\ntitle: ${child.title}\ncategory: ${child.category}\nscope: ${op.scope}\ntopics: ${child.topics.join(", ")}\nsupports: ${F(op.supports)}\nreason: ${op.reason}\n\n${child.text}\n`).join("");
    if (op.op === "archive") return block(`archive ${ref(op.knowledgeId, op.baseCommit)}`, { kind: op.kind === "inadmissible" ? "inadmissible" : "invalid", reason: op.reason },
      op.text ?? "The user withdrew this and nothing replaces it; the grounds are in the cited evidence.");
    if (op.op === "create") return block("create", { title: op.title ?? "Fixture title", ...shared(op) }, op.text);
    throw new Error(`curateWrite: unsupported operation ${op.op}`);
  });
  const result = curateNow(memory, path, blocks.join("\n"));
  const refused = result.blocks.filter(entry => entry.status !== "applied");
  if (refused.length) throw new Error(refused.map(entry => `${entry.block}: ${entry.reason}`).join("\n"));
  return result.blocks.flatMap(entry => entry.versions).map(version => {
    const [, id, ordinal] = /^K(\d+)@v(\d+)$/.exec(version)!;
    return { knowledgeId: Number(id), commit: store.resolveVersionOrdinal(Number(id), Number(ordinal)) };
  });
}
