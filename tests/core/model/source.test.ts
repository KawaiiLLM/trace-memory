import { expect, test } from "vitest";
import { sourceBlocks, preciseSources, exactSource, resultHasText } from "../../../src/core/model/source.ts";
import { traceTargets } from "../../../src/core/model/address.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";
import { renderEntryWhole } from "../../../src/core/render/index.ts";
import type { SourceEntry } from "../../../src/core/store/index.ts";
const entry: SourceEntry = { id: 1, entryOrdinal: 2, sessionId: 1, turnId: 1, nativeLineage: "pi", nativeId: "native", role: "assistant", text: "", raw: '{"role":"assistant","content":[]}', calls: [{ ordinal: 1, name: "tool", callId: "ghost", input: "{}", status: "attempted" }] };
test("33 audit: arbitrary quotes in a legacy project name never start ID scanning", () => {
  expect(traceTargets('alpha"beta')).toEqual(['alpha"beta']);
  expect(traceTargets('alpha"beta,T1#E2@"comma,id",F1')).toEqual(['alpha"beta', 'T1#E2@"comma,id"', "F1"]);
});
test("33 audit: normalized empty native content cannot synthesize a projected ghost fragment", () => {
  const source = { ...entry, blocks: piSourceBlocks(entry) };
  expect(sourceBlocks(source)).toEqual([]);
  expect(preciseSources(source)).not.toContain("T1#E2@ghost");
  expect(exactSource(source, "T1#E2@ghost")).toBe(false);
  expect(renderEntryWhole(source).content).not.toContain("ghost");
  expect(exactSource(entry, "T1#E2@ghost")).toBe(false); // legacy projection is not native block proof
});
test("33 audit: core never guesses a generic host's result envelope", () => {
  const source = { ...entry, role: "toolResult" as const, calls: [{ ...entry.calls[0]!, result: '{"content":[]}' }] };
  expect(resultHasText(source)).toBe(true);
  expect(renderEntryWhole(source).content).toContain('{"content":[]}');
});
test("33: redacted and opaque thinking cannot become text evidence", () => {
  for (const block of [{ type: "thinking", thinkingSignature: "opaque" }, { type: "thinking", thinking: "unavailable", redacted: true }]) {
    const source = { ...entry, calls: [], raw: JSON.stringify({ role: "assistant", content: [block] }) };
    const normalized = { ...source, blocks: piSourceBlocks(source) };
    expect(exactSource(normalized, "T1#E2@thinking")).toBe(false);
    expect(renderEntryWhole(normalized).content).not.toContain("opaque");
  }
});
