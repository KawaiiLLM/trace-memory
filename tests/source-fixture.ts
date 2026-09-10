import { TraceMemory as createMemory, type CompactResult, type SourceEntry, type VisibleView } from "../src/core/api/index.ts";
export type TraceMemory = ReturnType<typeof createMemory>;
export * from "../src/core/api/index.ts";

/** 29b: the initial visible view of a child that already holds every pending entry of this target as
 * a retained conversation entry — the fork case the one material builder subtracts against. Nothing
 * else is claimed: no fact and no knowledge commit, so the optional material is still supplied. */
export function visibleTarget(memory: TraceMemory, sessionId: number, branch: string, headTurnId: number): VisibleView {
  return { raw: new Map(memory.pendingEntries(sessionId, branch, headTurnId).map(e => [e.nativeId, "source" as const])),
    factIds: new Set<number>(), knowledgeCommitIds: new Set<number>(), injection: false };
}

/** Seed one completed source entry — the record a host writes when a native message is finished, and
 * the only thing pending-entry discovery, Noting batches and compaction ever see. Text and calls are
 * the completed message's own; the native identity is this fake host's. An entry with neither text
 * nor calls is not a completed message and is not written. */
export function seedSourceEntry(memory: TraceMemory, turnId: number, role: SourceEntry["role"], text: string, calls: SourceEntry["calls"] = []) {
  if (!text && !calls.length) return;
  const store = memory.store, sessionId = store.getTurn(turnId)!.sessionId;
  memory.appendEntry({ sessionId, nativeLineage: "fixture", nativeId: `message-${store.listSourceEntries(sessionId).length + 1}`,
    turnId, role, text, raw: JSON.stringify({ role, text, calls }), calls });
}

/** The production façade with three store writers wrapped, for the core cases written before source
 * entries were their own record: `appendTurn`, `appendToolCall` and `updateTurn` also seed the
 * completed entries a host's ingestion would have written, so appending a Turn is enough to give
 * those cases something to note.
 *
 * Production does none of this. Appending a Turn there creates no source entry, and what a real host
 * imports is covered by the Pi host tests and by direct store cases — never through this wrapper.
 * The substitution is here, named, rather than hidden behind a factory that looks like the real one. */
export const sourceSeededMemory: typeof createMemory = (...args) => {
  const memory = createMemory(...args);
  const store = memory.store;
  const append = store.appendTurn.bind(store), tool = store.appendToolCall.bind(store), update = store.updateTurn.bind(store);
  const seed = (turnId: number, role: SourceEntry["role"], text: string, calls: SourceEntry["calls"] = []) =>
    seedSourceEntry(memory, turnId, role, text, calls);
  store.appendTurn = input => {
    const turn = append(input);
    if (turn.kind === "turn") { seed(turn.id, "user", turn.userPrompt ?? ""); seed(turn.id, "assistant", turn.assistantText ?? ""); }
    return turn;
  };
  store.appendToolCall = input => {
    const call = tool(input), base = { ordinal: call.ordinal, name: call.name, callId: `call-${call.id}` };
    seed(call.turnId, "assistant", "", [{ ...base, input: call.input ?? "", status: "attempted" }]);
    if (call.result !== null) seed(call.turnId, "toolResult", "", [{ ...base, result: call.result, status: call.status }]);
    return call;
  };
  store.updateTurn = (id, patch) => {
    if (patch.assistantText && store.getTurn(id)!.assistantText !== null) throw new Error("fixture update must supply one first completed assistant message; use appendEntry for later occurrences");
    const turn = update(id, patch);
    if (patch.assistantText && turn.kind === "turn") seed(id, "assistant", patch.assistantText);
    return turn;
  };
  return memory;
};

/** Seed completed entry coverage explicitly; never translate a production watermark. */
export function recorded(memory: ReturnType<typeof createMemory>, sessionId: number, branch: string, head: number) {
  const entries = memory.store.sourcePath(sessionId, branch, head);
  const result = memory.store.commitNotingRun({ run: { kind: "noting", sessionId, branch,
    rangeFrom: `S${sessionId}/T${entries[0]?.turnId ?? head}`, rangeTo: `S${sessionId}/T${head}`, createdAt: "fixture" }, facts: [], entryIds: entries.map(e => e.id) });
  if (!result.ok) throw new Error(result.problems.join("; "));
}

/** 20c: `compact` returns a tier, not a string. A case that asserts the custom replacement's bytes
 * reads it through this, so reaching native delegation instead fails loudly with its reason rather
 * than silently comparing against `undefined`. */
export function compacted(result: CompactResult): string {
  if (result.tier === "native") throw new Error(`compact delegated to native compaction: ${result.reason}`);
  return result.text;
}
