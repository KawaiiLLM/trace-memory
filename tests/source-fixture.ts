import { TraceMemory as createMemory, type CompactResult, type SourceEntry } from "../src/core/api/index.ts";
export type TraceMemory = ReturnType<typeof createMemory>;
export * from "../src/core/api/index.ts";

/** A completed-message fixture producer; native identities are assigned by this fake host. */
export const TraceMemory: typeof createMemory = (...args) => {
  const memory = createMemory(...args);
  const store = memory.store;
  const append = store.appendTurn.bind(store), tool = store.appendToolCall.bind(store), update = store.updateTurn.bind(store);
  const source = (turnId: number, role: SourceEntry["role"], text: string, calls: SourceEntry["calls"] = []) => {
    if (!text && !calls.length) return;
    const sessionId = store.getTurn(turnId)!.sessionId;
    memory.appendEntry({ sessionId, nativeLineage: "fixture", nativeId: `message-${store.listSourceEntries(sessionId).length + 1}`,
      turnId, role, text, raw: JSON.stringify({ role, text, calls }), calls });
  };
  store.appendTurn = input => {
    const turn = append(input);
    if (turn.kind === "turn") { source(turn.id, "user", turn.userPrompt ?? ""); source(turn.id, "assistant", turn.assistantText ?? ""); }
    return turn;
  };
  store.appendToolCall = input => {
    const call = tool(input), base = { ordinal: call.ordinal, name: call.name, callId: `call-${call.id}` };
    source(call.turnId, "assistant", "", [{ ...base, input: call.input ?? "", status: "attempted" }]);
    if (call.result !== null) source(call.turnId, "toolResult", "", [{ ...base, result: call.result, status: call.status }]);
    return call;
  };
  store.updateTurn = (id, patch) => {
    if (patch.assistantText && store.getTurn(id)!.assistantText !== null) throw new Error("fixture update must supply one first completed assistant message; use appendEntry for later occurrences");
    const turn = update(id, patch);
    if (patch.assistantText && turn.kind === "turn") source(id, "assistant", patch.assistantText);
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
