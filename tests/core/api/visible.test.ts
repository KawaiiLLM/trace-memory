import { expect, test } from "vitest";
import { visibleView, type Carrier, type ContextEntry, type SuppliedMaterial, type VisibleBinding } from "../../../src/core/api/index.ts";

// Ticket 29a "One derived view", the pure half: what a selected context holds is decided by the
// entries and the carriers' own metadata, never by the database and never by the rendered prose.
// The host half (which entries these are, and who writes the carriers) is in
// tests/hosts/pi/visible.test.ts.

const binding: VisibleBinding = { db: "/tmp/a/trace.db", session: 7, pi: "pi-1" };
const supplied = (over: Partial<SuppliedMaterial> = {}): SuppliedMaterial =>
  ({ entries: [], factIds: [], knowledgeCommitIds: [], ...over });
/** Our injected message: a `custom_message` entry with the carrier on its `details`. */
const injected = (id: string, over: Partial<Carrier> = {}): ContextEntry =>
  ({ id, type: "custom_message", details: { traceMemory: { ...binding, supplied: supplied(), ...over } } });
/** A custom compaction: the same carrier, on the compaction entry Pi appended for it. */
const compacted = (id: string, over: Partial<Carrier> = {}): ContextEntry =>
  ({ id, type: "compaction", details: { traceMemory: { ...binding, supplied: supplied(), ...over } } });
const message = (id: string): ContextEntry => ({ id, type: "message" });

test("29a case 3 (injection identity): an injection carries exactly its supplied commits, is not a Raw source, and an id in its text alone covers nothing", () => {
  const view = visibleView([
    message("e1"),
    // The rendered block names K4@11 and K9@12; only K4@11 was actually kept within the budget, so
    // only K4@11 is stated. Nothing here parses the content, which is not even read.
    { ...injected("e2", { supplied: supplied({ knowledgeCommitIds: [11] }) }), type: "custom_message" },
  ], binding);
  expect([...view.knowledgeCommitIds]).toEqual([11]);
  expect(view.factIds.size).toBe(0);
  expect(view.raw.get("e2")).toBeUndefined(); // the injection is not itself a source entry
  expect([...view.raw.keys()]).toEqual(["e1"]);
});

test("29a case 4 (allocation identity): a pre-allocation injection is recognised after allocation, and another database's equal ids never are", () => {
  const before = injected("e2", { session: null, supplied: supplied({ knowledgeCommitIds: [11] }) });
  // Written on the first prompt, when no memory session id existed yet: bound to the Pi session id.
  expect([...visibleView([before], { ...binding, session: null }).knowledgeCommitIds]).toEqual([11]);
  // The first reply allocates S7; the same entry still counts, through that same Pi session id.
  expect([...visibleView([before], binding).knowledgeCommitIds]).toEqual([11]);
  // A different Pi session cannot claim it, and neither can another database's identical integers.
  expect(visibleView([before], { ...binding, pi: "pi-2" }).knowledgeCommitIds.size).toBe(0);
  const foreign = injected("e3", { db: "/tmp/b/trace.db", supplied: supplied({ factIds: [1, 2], knowledgeCommitIds: [11] }) });
  const other = injected("e4", { session: 8, supplied: supplied({ factIds: [3] }) });
  const view = visibleView([foreign, other], binding);
  expect(view.factIds.size).toBe(0);
  expect(view.knowledgeCommitIds.size).toBe(0);
});

test("29a case 7 (opaque fallback): a native summary proves nothing, a tier-2 view proves nothing, and entries retained past either still count", () => {
  // Pi's own compaction entry: `details` is populated — `{readFiles, modifiedFiles}` is Pi's, and the
  // 26c proof pins that it is never an empty slot — so the reader tests for `details.traceMemory`.
  const native: ContextEntry = { id: "c1", type: "compaction", details: { readFiles: ["a.ts"], modifiedFiles: [] } };
  const tier2 = compacted("c2", { supplied: supplied({ entries: [{ id: 5, nativeId: "e9", tier: 2 }], factIds: [4] }) });
  const view = visibleView([native, message("e1"), tier2, message("e7")], binding);
  expect(view.raw.get("e9")).toBeUndefined(); // a compact-only view is not a representation to extract from
  expect([...view.factIds]).toEqual([4]); // …but the complete fact bodies that block did carry are
  expect([...view.raw.keys()].sort()).toEqual(["e1", "e7"]); // retained entries either side still count
});

test("29a: a tier-1 view covers an entry the conversation dropped, and a retained original outranks it", () => {
  const carrier = compacted("c1", { supplied: supplied({ entries: [{ id: 5, nativeId: "e9", tier: 1 }, { id: 6, nativeId: "e10", tier: 1 }] }) });
  // Pi's order: the compaction, then what it kept, then what came after.
  const view = visibleView([carrier, message("e10"), message("e11")], binding);
  expect(view.raw.get("e9")).toBe("tier1"); // gone from the conversation, supplied as a primary view
  expect(view.raw.get("e10")).toBe("source"); // retained as well: the stronger representation wins
  expect(view.raw.get("e11")).toBe("source");
});

test("29a case 9 (visibility versus database changes): the view is a function of the selected entries alone", () => {
  const entries = [compacted("c1", { supplied: supplied({ factIds: [1], knowledgeCommitIds: [11] }) }), message("e1")];
  const first = visibleView(entries, binding);
  // A new fact, a new commit and an explicit tool read change the database, not these entries; the
  // same context computes the same view, and nothing here can observe a read that was never recorded.
  const again = visibleView(entries, binding);
  expect([...again.factIds]).toEqual([...first.factIds]);
  expect([...again.knowledgeCommitIds]).toEqual([...first.knowledgeCommitIds]);
  expect([...again.raw]).toEqual([...first.raw]);
  // A shorter selection is its own view, not a subset of a remembered one.
  expect(visibleView([entries[1]!], binding).factIds.size).toBe(0);
});

test("29a: a malformed or legacy carrier fails closed rather than being reverse-engineered", () => {
  const legacy: ContextEntry = { id: "e2", type: "custom_message", details: { traceMemory: { v: 1, facts: [7, 9] } } };
  const empty: ContextEntry = { id: "e3", type: "custom_message" };
  const view = visibleView([legacy, empty], binding);
  expect(view.factIds.size).toBe(0);
  expect(view.knowledgeCommitIds.size).toBe(0);
  expect(view.raw.size).toBe(0);
});
