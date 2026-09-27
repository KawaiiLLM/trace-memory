import type { TraceMemory } from "../source-fixture.ts";
import { commitNoterKnowledge } from "../noting-knowledge-fixture.ts";
import type { Store, KnowledgePath, SourceEntry, SourceEntryMeta, FactCommitInput, RunInput } from "../../src/core/store/index.ts";
import type { Fact, FactCategory, KnowledgeCategory } from "../../src/core/model/index.ts";

const at = "2026-09-21T00:00:00.000Z";

export function session(store: Store, projectId: number, host: string) {
  return store.createSession({ enrollmentChoice: true, projectId, host, startedAt: at, firstReplyAt: at });
}

/** A completed text entry; callers own the Turn and select the source path explicitly. */
export function entry(store: Store, sessionId: number, turnId: number, nativeId: string,
  role: "user" | "assistant", text = nativeId): SourceEntry {
  return store.appendSourceEntry({ sessionId, turnId, nativeLineage: `lineage-${sessionId}`,
    nativeId, role, text, raw: JSON.stringify({ role, content: text }), calls: [] });
}

type NewSeed = { title: string; sources: readonly { entry: SourceEntry; text: string }[];
  negate?: readonly (readonly [number, "strong" | "weak"])[] };

/** One real manual note call for the supplied batch; Core owns ordering, roles and owning Turn. */
export function facts(memory: TraceMemory, path: KnowledgePath, items: readonly NewSeed[]): Fact[] {
  if (path.headTurnId === null || !path.branch) throw new Error("facts require an explicit headed branch");
  const tool = memory.tools({ kind: "manual", sessionId: path.sessionId, branch: path.branch,
    currentTurnId: path.headTurnId }).find(tool => tool.name === "note")!;
  const receipt = tool.execute({ facts: items.map(item => ({ title: item.title, sources: item.sources.map(source => ({
    address: `T${source.entry.turnId}#E${source.entry.entryOrdinal}`, text: source.text,
  })), ...(item.negate?.length ? { negate: item.negate.map(([id, strength]) => [`F${id}`, strength]) } : {}) })) });
  if (receipt.startsWith("rejected:")) throw new Error(`fact seed failed: ${receipt}`);
  const result = JSON.parse(receipt) as { factIds?: number[]; results?: string[] };
  if (result.factIds?.length !== items.length || result.results?.length !== items.length ||
      result.results.some((message, index) => message !== `ok: F${result.factIds![index]}`))
    throw new Error(`fact seed failed: ${JSON.stringify(result)}`);
  return result.factIds.map(id => {
    const committed = memory.store.getFact(id);
    if (!committed) throw new Error(`fact seed committed without readable F${id}`);
    return committed;
  });
}

export function fact(memory: TraceMemory, path: KnowledgePath, title: string,
  sources: readonly { entry: SourceEntry; text: string }[], negate: readonly (readonly [number, "strong" | "weak"])[] = []): Fact {
  return facts(memory, path, [{ title, sources, negate }])[0]!;
}

type BoundSource = { entry: Pick<SourceEntryMeta, "id" | "turnId" | "entryOrdinal">; address: string };
type LegacySeed = Pick<FactCommitInput, "text" | "category" | "actor" | "createdAt" | "support" | "negate" | "quote" | "status"> & {
  sources: readonly BoundSource[];
  turnId?: number;
};
type SeedRun = Pick<RunInput, "kind" | "sessionId" | "branch" | "createdAt">;

function legacyRow(seed: LegacySeed): FactCommitInput {
  if (!seed.sources.length) throw new Error("legacy fact requires bound entries");
  return { turnId: seed.turnId ?? seed.sources[0]!.entry.turnId, text: seed.text, category: seed.category, actor: seed.actor,
    createdAt: seed.createdAt, source: seed.sources.map(source => source.address),
    entryIds: seed.sources.map(source => source.entry.id),
    ...(seed.support !== undefined ? { support: seed.support } : {}),
    ...(seed.negate !== undefined ? { negate: seed.negate } : {}),
    ...(seed.quote !== undefined ? { quote: seed.quote } : {}),
    ...(seed.status !== undefined ? { status: seed.status } : {}) };
}

/** One historical run; leave local $n and permanent F<n> relations to Store's atomic resolver. */
export function legacyFacts(store: Store, run: SeedRun, seeds: readonly LegacySeed[],
  processedEntryIds: readonly number[] = []): { runId: number; facts: Fact[] } {
  const result = store.commitNotingRun({ run, facts: seeds.map(legacyRow), entryIds: [...processedEntryIds] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return { runId: result.runId, facts: result.facts };
}

/** Single historical row; same construction as a batch, with explicit legacy defaults. */
export function legacyFact(store: Store, path: KnowledgePath, sources: readonly BoundSource[],
  text: string, category: FactCategory = "observation"): Fact {
  return legacyFacts(store, { kind: "manual", sessionId: path.sessionId, branch: path.branch, createdAt: at },
    [{ sources, text, category, actor: "user", createdAt: at }]).facts[0]!;
}

type KnowledgeSeed = { scope: "global" | "project" | "session"; category: KnowledgeCategory; supports: number[];
  text: string; topics?: string[]; createdAt?: string; author?: string; reason?: string };
type KnowledgeRun = { kind: "manual" | "noting"; createdAt: string };

/** One real create-only manual/N knowledge run; caller owns path, run time and each item's metadata. */
export function knowledgeBatch(store: Store, path: KnowledgePath, items: readonly KnowledgeSeed[],
  run: KnowledgeRun = { kind: "noting", createdAt: at }) {
  const operations = items.map((item, index) => ({ op: "create" as const, handle: `$${index + 1}`,
    author: item.author ?? "test", text: item.text, category: item.category, scope: item.scope,
    supports: item.supports, topics: item.topics ?? [], reason: item.reason ?? "fixture",
    createdAt: item.createdAt ?? run.createdAt }));
  const recorded = { kind: run.kind, sessionId: path.sessionId, branch: path.branch, createdAt: run.createdAt };
  const result = run.kind === "manual"
    ? store.commitConsolidationRun({ path, run: recorded, operations })
    : commitNoterKnowledge(store, { path, run: { sessionId: path.sessionId, branch: path.branch, createdAt: run.createdAt }, operations });
  if (!result.ok) throw new Error(result.problems.join("; "));
  if (result.committed.length !== items.length) throw new Error("knowledge seed did not commit every revision");
  return result;
}

export function knowledge(store: Store, path: KnowledgePath, scope: "global" | "project" | "session",
  category: KnowledgeCategory, supports: number[], text: string,
  options: { run?: KnowledgeRun; operation?: { createdAt?: string; topics?: string[] } } = {}) {
  return knowledgeBatch(store, path, [{ scope, category, supports, text, topics: options.operation?.topics,
    createdAt: options.operation?.createdAt }], options.run).committed[0]!;
}
