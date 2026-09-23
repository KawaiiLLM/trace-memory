// Ticket 75: the host-neutral formatter extracted from Pi's `showSpend` (24a/51). Pi's own byte-identity
// across idle/each phase/off/unknown is proven by the untouched `tests/hosts/pi/footer.test.ts` and
// `index.test.ts` suites continuing to pass against Pi's refactored call site; this file exercises the
// formatter directly for the combinations the ticket calls out that Pi's integration tests do not: all
// three phases running at once, and the cross of unknown counts with a known cost and vice versa.
import { expect, test } from "vitest";
import { memoryStatusLine } from "../../src/hosts/status-line.ts";

const counts = { entries: 24, facts: 102, unconsolidated: 9, changedKnowledge: 252, knowledge: 306 };

test("idle enabled: dim ○, full text", () => {
  expect(memoryStatusLine({ enabled: true, running: {}, counts, cost: 0.12 })).toEqual([
    { role: "dim", text: "○" },
    { role: "dim", text: "notes: 24->102 memory: 9->252/306 cost: $0.12" },
  ]);
});

test("each running phase paints its own role", () => {
  expect(memoryStatusLine({ enabled: true, running: { noting: true }, counts, cost: 0 })[0]).toEqual({ role: "accent", text: "●" });
  expect(memoryStatusLine({ enabled: true, running: { consolidation: true }, counts, cost: 0 })[0]).toEqual({ role: "success", text: "●" });
  expect(memoryStatusLine({ enabled: true, running: { dreaming: true }, counts, cost: 0 })[0]).toEqual({ role: "customMessageLabel", text: "●" });
});

test("N, C and D running at once: precedence stays N, then C, then D", () => {
  expect(memoryStatusLine({ enabled: true, running: { noting: true, consolidation: true, dreaming: true }, counts, cost: 0 })[0])
    .toEqual({ role: "accent", text: "●" });
  expect(memoryStatusLine({ enabled: true, running: { consolidation: true, dreaming: true }, counts, cost: 0 })[0])
    .toEqual({ role: "success", text: "●" });
  expect(memoryStatusLine({ enabled: true, running: { dreaming: true }, counts, cost: 0 })[0])
    .toEqual({ role: "customMessageLabel", text: "●" });
});

test("off collapses to one dim segment, never two joined by a space", () => {
  expect(memoryStatusLine({ enabled: false, running: { noting: true }, counts, cost: 5 })).toEqual([{ role: "dim", text: "○ off" }]);
});

test("unknown counts render ?, never 0, with a known cost", () => {
  expect(memoryStatusLine({ enabled: true, running: {}, cost: 0 })[1]).toEqual({ role: "dim", text: "notes: ?->? memory: ?->?/? cost: $0.00" });
});

test("known counts with an unknown cost render $?", () => {
  expect(memoryStatusLine({ enabled: true, running: {}, counts })[1]).toEqual({ role: "dim", text: "notes: 24->102 memory: 9->252/306 cost: $?" });
});

test("both unknown at once", () => {
  expect(memoryStatusLine({ enabled: true, running: {} })[1]).toEqual({ role: "dim", text: "notes: ?->? memory: ?->?/? cost: $?" });
});
