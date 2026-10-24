import { readFileSync, writeFileSync } from "node:fs";
import type { RunAgentResult } from "../../src/core/api/index.ts";
import type { DreamingAgentInput, DreamingTask, DreamingResult } from "../../src/core/dreaming/index.ts";
import type { RunAgent, TraceMemory } from "../source-fixture.ts";
import { REQUEST } from "./noter.ts";
import { block, workspaceBatch, type WorkspaceBatch } from "./workspace.ts";
import { applyWorkspace, parseBlocks } from "../../src/core/workspace/index.ts";
import type { KnowledgePath, Store, KnowledgeOperationInput } from "../../src/core/store/index.ts";
import { knowledge as seedKnowledge } from "./seed.ts";
import { placementOwner } from "../../src/core/store/processing.ts";

type Text = string | readonly string[] | ((message: string) => string);
export interface DreamerScript {
  notes?: Text;
  clustering?: Text;
  curate?: Partial<Record<string, Text>>;
  scoring?: (batch: number, labels: string[], message: string) => Text | undefined;
  curateResult?: Partial<RunAgentResult>;
  instead?: Partial<Record<DreamingTask, (input: DreamingAgentInput) => Promise<RunAgentResult> | RunAgentResult>>;
}
export function decisionText(templateText: string, changes = "## none\n"): string {
  const template = parseBlocks({ name: "decisions.md", text: templateText });
  const operations = parseBlocks({ name: "changes.md", text: changes }).blocks;
  return template.blocks.map(item => {
    const operation = operations.find(op => op.target === item.target);
    const merged = operations.find(op => op.op === "merge" && op.fields.get("absorb")?.value.split(",").map(value => value.trim()).includes(item.target));
    const decision = merged ? `merged into ${merged.target.split("@")[0]}` : operation?.op ?? "keep";
    return `## item ${item.target}\ntitle: ${operation?.fields.get("title")?.value ?? item.fields.get("title")?.value ?? ""}\naccuracy: ok\ngrounds: Recorded facts\nnorms: Reviewed\nevidence: None\n${item.fields.has("files") ? "files: None\n" : ""}decision: ${decision}\nreason: Preserve the supported understanding\n`;
  }).join("\n");
}
export function writeDecisions(dir: string, changes = "## none\n"): void {
  const file = `${dir}/decisions.md`;
  writeFileSync(file, decisionText(readFileSync(file, "utf8"), changes));
}
export function clusteredItems(addresses: readonly string[], size = 50): string {
  const groups: string[] = [];
  for (let at = 0; at < addresses.length; at += size) {
    const items = addresses.slice(at, at + size), clusters: string[] = [];
    for (let c = 0; c < items.length; c += 10) clusters.push(`## Cluster Topic ${at / size + 1}.${c / 10 + 1}\n${items.slice(c, c + 10).map(address => `- ${address.split("@")[0]}`).join("\n")}\n`);
    groups.push(`# Group ${at / size + 1}\n\n${clusters.join("\n")}`);
  }
  return groups.join("\n");
}
export interface ScriptedDreamer {
  agent: RunAgent; inputs: DreamingAgentInput[]; messages: string[]; reports: string[]; script: DreamerScript;
}
export function scriptedDreamer(script: DreamerScript = {}): ScriptedDreamer {
  script.curate ??= {};
  const inputs: DreamingAgentInput[] = [], messages: string[] = [], reports: string[] = [];
  const attempts = new Map<string, number>();
  const pick = (key: string, text: Text | undefined, report: string, fallback: string) => {
    const at = attempts.get(key) ?? 0; attempts.set(key, at + 1);
    return typeof text === "function" ? text(report) : typeof text === "string" ? text : text?.[Math.min(at, text.length - 1)] ?? fallback;
  };
  const agent = async (raw: unknown): Promise<RunAgentResult> => {
    const input = raw as DreamingAgentInput;
    inputs.push(input);
    if (script.instead?.[input.task]) return script.instead[input.task]!(input);
    input.reportRequest(REQUEST);
    let report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    reports.push(report);
    if (input.task === "notes") {
      writeFileSync(`${input.workspace.dir}/notes.md`, pick("notes", script.notes, report, "No repository-specific notes."));
      let next = input.passEnd();
      if (next) { messages.push(next); writeFileSync(`${input.workspace.dir}/notes.md`, pick("notes", script.notes, next, "No repository-specific notes.")); input.passEnd(); }
    } else if (input.task === "clustering") {
      const items = readFileSync(`${input.workspace.dir}/items.md`, "utf8").trim().split("\n").map(line => line.split(" ")[0]!);
      const size = Number(/Group size: at most (\d+)/.exec(report)?.[1] ?? 50);
      const fallback = clusteredItems(items, size);
      writeFileSync(`${input.workspace.dir}/groups.md`, pick("clustering", script.clustering, report, fallback));
      const next = input.passEnd();
      if (next) { messages.push(next); writeFileSync(`${input.workspace.dir}/groups.md`, pick("clustering", script.clustering, next, fallback)); input.passEnd(); }
    } else {
      const group = Number(/(?:group|batch) (\d+)/.exec(report)?.[1] ?? 1);
      const scoring = input.task === "scoring";
      for (let round = 0; round < 6; round++) {
        input.reportResponse?.(`${group}-${round}`, 1000 + round * 100);
        if (!scoring) {
          const configured = script.curate?.[`group${group}`] ?? Object.entries(script.curate ?? {}).find(([key]) => !key.startsWith("group"))?.[1];
          const changes = pick(`curate:${group}`, configured, report, "## none\n");
          writeDecisions(input.workspace.dir, changes);
          writeFileSync(`${input.workspace.dir}/changes.md`, changes);
        } else {
          const labels = [...(report.match(/Items: ([^\n]*)/)?.[1] ?? "").matchAll(/K\d+/g)].map(match => match[0]);
          writeFileSync(`${input.workspace.dir}/scores.md`, pick(`scoring:${group}`, script.scoring?.(group, labels, report), report, labels.map(label => `${label} 4 4 4`).join("\n")));
        }
        const next = input.passEnd();
        if (!next) break;
        messages.push(next); report = next;
      }
    }
    return { outcome: "success", output: "Done.", request: REQUEST, usage: { tokens: 12 }, ...(input.task === "curate" ? script.curateResult : {}) } as RunAgentResult;
  };
  return { agent, inputs, messages, reports, script };
}
export interface DreamerFixture extends WorkspaceBatch {
  dreamer: ScriptedDreamer;
  target: { sessionId: number; branch: string; headTurnId: number; model: string };
  dream(): Promise<DreamingResult>;
  next(agent: RunAgent): void;
}
export function dreamerFixture(memories: TraceMemory[], script: DreamerScript = {}, dbPath?: string): DreamerFixture {
  const dreamer = scriptedDreamer(script), runners: RunAgent[] = [];
  const b = workspaceBatch({ agent: raw => (runners.shift() ?? dreamer.agent)(raw), dbPath });
  memories.push(b.memory); b.memory.config.dreaming.triggerOperations = 1;
  const target = { sessionId: b.session.id, branch: "main", headTurnId: b.path.headTurnId!, model: "scripted" };
  return { ...b, dreamer, target, dream: () => b.memory.dream(target), next: (agent: RunAgent) => { runners.push(agent); } };
}
export async function writeCurateFiles(input: DreamingAgentInput, ...texts: string[]): Promise<string | undefined> {
  await input.tools.find(tool => tool.name === "check")!.execute({});
  if (input.task === "notes") writeFileSync(`${input.workspace.dir}/notes.md`, texts[0] ?? "No repository notes.");
  else {
    writeDecisions(input.workspace.dir, texts[0]);
    writeFileSync(`${input.workspace.dir}/changes.md`, texts[0] ?? "## none\n");
  }
  return input.passEnd();
}
export function curateNow(memory: { store: Store }, path: KnowledgePath, text: string, _operation?: string) {
  const result = applyWorkspace(memory.store, { kind: "curate", sessionId: path.sessionId, path, file: { name: "changes.md", text } });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result;
}
/** `K<id>@v<n>` of a committed version. */
export const versionRef = (store: Store, knowledgeId: number, commit: number) => `K${knowledgeId}@v${store.versionOrdinal(knowledgeId, commit)}`;

type Operation = KnowledgeOperationInput;
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

