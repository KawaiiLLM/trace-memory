import { TraceMemory as createMemory, type ConsolidationAgentInput, type NotingAgentInput, type SourceEntry } from "../core/api/index.ts";
export type TraceMemory = ReturnType<typeof createMemory>;
export * from "../core/api/index.ts";

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

/** Test-side flattening of core's structured task material (19b): the fresh-context parts, in the
 * order a full run would show them. Assertions ask what a run's material carries; how a host lays it
 * out is the adapter's business and is pinned in hosts/pi/compose.test.ts. */
export function materialText(input: NotingAgentInput | ConsolidationAgentInput): string {
  const parts = input.kind === "noting"
    ? [...input.material.knowledge, ...input.material.facts, ...input.material.entries.map(e => e.view), ...input.material.receipts]
    : [...input.material.knowledge, ...input.material.consolidated, ...input.material.rangeFacts, ...input.material.reminders, ...input.material.receipts];
  return parts.join("\n\n");
}
