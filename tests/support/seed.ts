import type { TraceMemory } from "../source-fixture.ts";
import { commitNoterKnowledge } from "../noting-knowledge-fixture.ts";
import type { Store, KnowledgePath, SourceEntry } from "../../src/core/store/index.ts";
import type { Fact } from "../../src/core/model/index.ts";

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

/** Current public write shape: Core, not the fixture, decides ordering, roles and owning Turn. */
export function fact(memory: TraceMemory, path: KnowledgePath, title: string,
  sources: readonly { entry: SourceEntry; text: string }[]): Fact {
  if (path.headTurnId === null || !path.branch) throw new Error("fact requires an explicit headed branch");
  const tool = memory.tools({ kind: "manual", sessionId: path.sessionId, branch: path.branch,
    currentTurnId: path.headTurnId }).find(tool => tool.name === "note")!;
  const receipt = tool.execute({ facts: [{ title, sources: sources.map(source => ({
    address: `T${source.entry.turnId}#E${source.entry.entryOrdinal}`, text: source.text,
  })) }] });
  if (receipt.startsWith("rejected:")) throw new Error(`fact seed failed: ${receipt}`);
  const result = JSON.parse(receipt) as { factIds?: number[]; results?: string[] };
  if (result.factIds?.length !== 1 || result.results?.[0] !== `ok: F${result.factIds[0]}`)
    throw new Error(`fact seed failed: ${JSON.stringify(result)}`);
  const committed = memory.store.getFact(result.factIds[0]!);
  if (!committed) throw new Error("fact seed committed without a readable fact");
  return committed;
}

/** Historical Store row; preserve each authored source spelling and bind its actual native entry. */
export function legacyFact(store: Store, path: KnowledgePath, sources: readonly { entry: SourceEntry; address: string }[], text: string): Fact {
  if (!sources.length) throw new Error("legacy fact requires bound entries");
  const result = store.commitNotingRun({ run: { kind: "manual", sessionId: path.sessionId, branch: path.branch, createdAt: at },
    facts: [{ turnId: sources[0]!.entry.turnId, category: "observation", actor: "user", text, source: sources.map(source => source.address),
      entryIds: sources.map(source => source.entry.id), createdAt: at }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.facts[0]!;
}

/** Real N publication path; caller supplies scope, evidence and selected path. */
export function knowledge(store: Store, path: KnowledgePath, scope: "global" | "project" | "session",
  supports: number[], text: string) {
  const result = commitNoterKnowledge(store, { path, run: { sessionId: path.sessionId, branch: path.branch, createdAt: at },
    operations: [{ op: "create", handle: "$1", author: "test", text, category: "understanding", scope,
      supports, topics: [], reason: "fixture", createdAt: at }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  if (result.committed.length !== 1) throw new Error("knowledge seed did not commit one revision");
  return result.committed[0]!;
}
