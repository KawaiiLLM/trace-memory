import type { TraceMemory } from "../source-fixture.ts";
import { commitNoterKnowledge } from "../noting-knowledge-fixture.ts";
import type { Store, KnowledgePath, SourceEntry, SourceEntryMeta, FactCommitInput, RunInput, CommittedKnowledgeOp } from "../../src/core/store/index.ts";
import { DEFAULT_WRITING_LIMITS, type Fact, type FactCategory, type KnowledgeCategory } from "../../src/core/model/index.ts";
import { parseKnowledgeAddress } from "../../src/core/model/address.ts";
import type { MemoryReceipt } from "../../src/core/knowledge-write/bind.ts";
import { assignVersionTag } from "../../src/core/store/version-tags.ts";
import { knowledgeTitle } from "../../src/core/render/index.ts";

/** Resolve the shared tool receipt: authored update/merge/split tags, other history addresses. */
export function receiptCommit(store: Store, item: Pick<MemoryReceipt["committed"][number], "knowledgeId" | "version">): number {
  const version = parseKnowledgeAddress(item.version);
  if (!version || version.id !== item.knowledgeId || version.history || version.to !== undefined)
    throw new Error(`invalid committed receipt version: ${item.version}`);
  if (version.tag) return store.resolveVersionTag(version.id, version.tag);
  if (version.ordinal && version.from !== undefined) return store.resolveVersionOrdinal(version.id, version.from);
  throw new Error(`receipt has no exact version: ${item.version}`);
}

const at = "2026-09-21T00:00:00.000Z";

export function session(store: Store, projectId: number, host: string) {
  return store.createSession({ enrollmentChoice: true, projectId, host, startedAt: at, firstReplyAt: at });
}

/** A completed entry; callers own the Turn and select the source path explicitly. */
export function entry(store: Store, sessionId: number, turnId: number, nativeId: string,
  role: "user" | "assistant", text = nativeId, raw = JSON.stringify({ role, content: text })): SourceEntry {
  return store.appendSourceEntry({ sessionId, turnId, nativeLineage: `lineage-${sessionId}`,
    nativeId, role, text, raw, calls: [] });
}

/** Authored public note shape; parsing and authority remain the production tool's responsibility. */
export const factSources = (segments: readonly { address: string; text: string }[]): string =>
  segments.map(({ address, text }) => `[${address}] ${text}`).join("\n");

type NewSeed = { title: string; sources: readonly { entry: SourceEntry; text: string }[];
  negate?: readonly (readonly [number, "strong" | "weak"])[] };

/** One real manual note call per supplied fact; Core owns ordering, roles and owning Turn. A seeded fact
 * stands for one already in the database, and production holds facts written before the caps (ticket 144)
 * that are far over them, so the caps are lifted while seeding; the caps' own contract tests call `note`. */
export function facts(memory: TraceMemory, path: KnowledgePath, items: readonly NewSeed[]): Fact[] {
  if (path.headTurnId === null || !path.branch) throw new Error("facts require an explicit headed branch");
  const tool = memory.tools({ kind: "manual", sessionId: path.sessionId, branch: path.branch,
    currentTurnId: path.headTurnId }).find(tool => tool.name === "note")!;
  const limits = { ...memory.config.writing };
  Object.assign(memory.config.writing, { titleTokens: Infinity, bodyTokens: Infinity });
  try { return seedFacts(memory, tool, items); } finally { Object.assign(memory.config.writing, limits); }
}

function seedFacts(memory: TraceMemory, tool: { execute(input: unknown): string }, items: readonly NewSeed[]): Fact[] {
  const ids = items.map(item => {
    const receipt = tool.execute({ title: item.title, sources: factSources(item.sources.map(source => ({
      address: `T${source.entry.turnId}#E${source.entry.entryOrdinal}`, text: source.text,
    }))), ...(item.negate?.length ? { negate: item.negate.map(([id, strength]) => [`F${id}`, strength]) } : {}) });
    if (receipt.startsWith("rejected:")) throw new Error(`fact seed failed: ${receipt}`);
    const result = JSON.parse(receipt) as { factIds?: number[]; results?: string[] };
    if (result.factIds?.length !== 1 || result.results?.[0] !== `ok: F${result.factIds[0]}`)
      throw new Error(`fact seed failed: ${JSON.stringify(result)}`);
    return result.factIds[0]!;
  });
  return ids.map(id => {
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

/** The title a legacy item would have shown: its body's leading characters. Fixtures that need a title and do not care which use it. */
export const fixtureTitle = (text: string): string => knowledgeTitle({ title: null, text }, DEFAULT_WRITING_LIMITS.titleTokens);

type KnowledgeSeed = { scope: "global" | "project" | "session"; category: KnowledgeCategory; supports: number[];
  title?: string; text: string; topics?: string[]; createdAt?: string; author?: string; reason?: string };
type KnowledgeRun = { kind: "manual" | "noting"; createdAt: string };

/** One real create-only manual/N knowledge run; caller owns path, run time and each item's metadata. */
export function knowledgeBatch(store: Store, path: KnowledgePath, items: readonly KnowledgeSeed[],
  run: KnowledgeRun = { kind: "noting", createdAt: at }) {
  const operations = items.map((item, index) => ({ op: "create" as const, handle: `$${index + 1}`,
    author: item.author ?? "test", title: item.title ?? fixtureTitle(item.text), text: item.text, category: item.category, scope: item.scope,
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
  options: { run?: KnowledgeRun; operation?: { createdAt?: string; topics?: string[]; title?: string } } = {}) {
  return knowledgeBatch(store, path, [{ scope, category, supports, text, title: options.operation?.title, topics: options.operation?.topics,
    createdAt: options.operation?.createdAt }], options.run).committed[0]!;
}

/** An imported legacy revision attached to its real supporting fact's run, without inventing worker progress. */
export function legacyKnowledge(store: Store, path: KnowledgePath, item: KnowledgeSeed): Pick<CommittedKnowledgeOp, "knowledgeId" | "commit"> {
  const factRun = store.db.prepare("SELECT run_id FROM facts WHERE id=?").get(item.supports[0]!);
  if (!factRun || typeof factRun.run_id !== "number") throw new Error("legacy knowledge requires an existing supporting fact run");
  const runId = factRun.run_id;
  const knowledgeId = Number(store.db.prepare("INSERT INTO knowledge (project_id,origin_session_id,author) VALUES (?,?,?)")
    .run(store.getSession(path.sessionId)!.projectId, path.sessionId, item.author ?? "legacy").lastInsertRowid);
  const commit = Number(store.db.prepare(`INSERT INTO knowledge_revisions
    (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
    VALUES (?,NULL,?,?,?,?,'change','create',?,?,?,?,'manual')`).run(knowledgeId, item.text, item.category, item.scope,
      JSON.stringify(item.supports), item.reason ?? "legacy", JSON.stringify(item.topics ?? []), runId, item.createdAt ?? at).lastInsertRowid);
  assignVersionTag(store.db, knowledgeId, commit);
  return { knowledgeId, commit };
}

/** A legacy revision that cites nothing: the write protocol refuses to create one, so the row is made by clearing the column. */
export function clearSupports(store: Store, commit: number): void {
  store.db.prepare("UPDATE knowledge_revisions SET supports = '[]' WHERE id = ?").run(commit);
}

/** One manual update of an exact base: the new body, with the supports it cites. */
export function updateKnowledge(store: Store, path: KnowledgePath, knowledgeId: number, baseCommit: number, text: string,
  supports: number[], category: KnowledgeCategory = "constraint", scope: "global" | "project" | "session" = "project"): CommittedKnowledgeOp {
  const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: path.sessionId, branch: path.branch, createdAt: at },
    operations: [{ op: "update", knowledgeId, baseCommit, text, category, scope, supports, topics: [], reason: "fixture update", createdAt: at }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!;
}

/** One manual archive of an exact base: its body states why (`invalid`, or `inadmissible`). The `budget` kind is retired (2026-10-22); `legacyArchive`
 * writes the shape old rows have. */
export function archive(store: Store, path: KnowledgePath, knowledgeId: number, baseCommit: number, supports: number[],
  kind: "invalid" | "inadmissible" = "invalid", text = "Withdrawn: the user retired this and nothing replaces it, per the cited fact."): number {
  const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: path.sessionId, branch: path.branch, createdAt: at },
    operations: [{ op: "archive", kind, knowledgeId, baseCommit, supports, reason: "fixture archive", createdAt: at, text }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!.commit;
}

/** An archive written before 99, as production keeps it (91): an empty body and no kind. */
export function legacyArchive(store: Store, path: KnowledgePath, knowledgeId: number, baseCommit: number, supports: number[]): number {
  const commit = archive(store, path, knowledgeId, baseCommit, supports);
  store.db.prepare("UPDATE knowledge_revisions SET text = '', archive_kind = NULL WHERE id = ?").run(commit);
  return commit;
}

/** An archive written before 2026-10-22 for the budget: the parent's body kept, kind `budget` (the kind is retired, so only SQL can write it now). */
export function budgetArchive(store: Store, path: KnowledgePath, knowledgeId: number, baseCommit: number, supports: number[]): number {
  const commit = archive(store, path, knowledgeId, baseCommit, supports);
  store.db.prepare("UPDATE knowledge_revisions SET text = (SELECT text FROM knowledge_revisions WHERE id = ?), archive_kind = 'budget' WHERE id = ?").run(baseCommit, commit);
  return commit;
}

/** Scores every knowledge item that has none (default 50): injection spends the Knowledge base on scored items only,
 * so a test of the base window scores its items first. A test of unscored knowledge leaves them alone. */
export function scoreAll(store: Store, score = 50): void {
  store.db.prepare("UPDATE knowledge SET score = ? WHERE score IS NULL").run(score);
}
