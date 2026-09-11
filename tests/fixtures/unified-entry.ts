import type { SourceEntry } from "../../src/core/store/index.ts";
import type { Fact } from "../../src/core/model/index.ts";

/** Fixed bilingual engineering transcript: review request, native call/result, then findings.
 * Repetition models a long implementation session; no real user data or provider is involved. */
export function unifiedFixture() {
  const entries: SourceEntry[] = [], facts: Fact[] = [];
  const request = "请检查导出流程中的取消处理。Keep the existing transaction boundary and preserve committed records. "
    + "The user can cancel while the worker is waiting for a result, after a successful write, or during the next read. "
    + "A cancelled attempt must not publish a replacement summary. Add a regression for each boundary and report which checks were actually run. ";
  const finding = "The current implementation retains the original result and records cancellation separately. "
    + "The transaction commits before the completion callback, so cancellation after the write cannot undo the accepted facts. "
    + "The remaining risk is a stale cursor referring to a changed branch. Tests should freeze membership and assert the exact retained source entries. ";
  for (let turnId = 1; turnId <= 60; turnId++) {
    const callId = `call_review_${String(turnId).padStart(4, "0")}`;
    const call = { ordinal: 1, name: "bash", callId, status: "attempted", input: JSON.stringify({
      command: `git diff -- src/core/api/read.ts && npm test -- tests/core/api/cancellation.test.ts`, timeout: 30 }) };
    const result = { ...call, status: "success", input: undefined, result:
      `Review pass ${turnId}:\n` + Array.from({ length: 30 }, (_, i) => `  PASS case ${i + 1}: persisted source identity and cancellation fence remain unchanged`).join("\n")
      + "\nTest Files 1 passed; Tests 30 passed; no provider calls." };
    const base = { sessionId: 1, turnId, nativeLineage: "fixed-offline-fixture", raw: "" };
    const add = (data: Pick<SourceEntry, "role" | "text" | "calls" | "blocks">, entryOrdinal: number) => entries.push({
      ...base, ...data, id: entries.length + 1, nativeId: `native-${entries.length + 1}`, entryOrdinal });
    const user = `${request}Iteration ${turnId}. ${request}`;
    add({ role: "user", text: user, calls: [], blocks: [{ kind: "text", text: user }] }, 1);
    add({ role: "assistant", text: "I will check the cancellation boundary before changing the renderer.", calls: [call], blocks: [
      { kind: "text", text: "I will check the cancellation boundary before changing the renderer." }, { kind: "call", call }] }, 2);
    add({ role: "toolResult", text: "", calls: [result], blocks: [{ kind: "result", call: result, texts: [result.result] }] }, 3);
    add({ role: "assistant", text: finding, calls: [], blocks: [{ kind: "text", text: finding }] }, 4);
    facts.push({ id: turnId, turnId, category: "observation", actor: "agent", text: finding,
      source: [`T${turnId}#E3@${callId}`], quote: null, status: null,
      createdAt: `2026-09-01T${String(Math.floor((turnId - 1) / 60)).padStart(2, "0")}:${String((turnId - 1) % 60).padStart(2, "0")}:00Z` });
  }
  return { entries, facts };
}
