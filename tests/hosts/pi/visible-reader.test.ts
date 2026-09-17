import { expect, test } from "vitest";
import { visibleView, type Carrier, type ContextEntry, type VisibleBinding } from "../../../src/hosts/pi/visible.ts";
import type { SuppliedMaterial } from "../../../src/core/api/index.ts";

// Ticket 29a/53: Pi reads its own persisted entry and envelope formats. Coverage is decided by
// structural metadata, never by the database or rendered prose.

const binding: VisibleBinding = { db: "/tmp/a/trace.db", session: 7, pi: "pi-1" };
const supplied = (over: Partial<SuppliedMaterial> = {}): SuppliedMaterial =>
  ({ entries: [], factIds: [], knowledgeCommitIds: [], ...over });
/** Our injected message: a `custom_message` entry with the carrier on its `details`. */
const injected = (id: string, over: Partial<Carrier> = {}): ContextEntry =>
  ({ id, type: "custom_message", customType: "trace-memory", details: { traceMemory: { ...binding, supplied: supplied(), ...over } } });
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

test("29a case 7 (opaque fallback): a native summary proves nothing, and entries retained past it still count", () => {
  // Pi's own compaction entry: `details` is populated — `{readFiles, modifiedFiles}` is Pi's, and the
  // 26c proof pins that it is never an empty slot — so the reader tests for `details.traceMemory`.
  const native: ContextEntry = { id: "c1", type: "compaction", details: { readFiles: ["a.ts"], modifiedFiles: [] } };
  const unmarked = compacted("c2", { supplied: supplied({ entries: [{ id: 5, nativeId: "e9" } as never], factIds: [4] }) });
  const view = visibleView([native, message("e1"), unmarked, message("e7")], binding);
  expect(view.raw.get("e9")).toBeUndefined(); // no representation stated: nothing to extract from
  expect([...view.factIds]).toEqual([]); // malformed entries invalidate the entire carrier atomically
  expect([...view.raw.keys()].sort()).toEqual(["e1", "e7"]); // retained entries either side still count
});

test("30: a supplied bounded view covers an entry the conversation dropped, a legacy tier counts as one, and a retained original outranks both", () => {
  const carrier = compacted("c1", { supplied: supplied({ entries: [{ id: 5, nativeId: "e9", view: "bounded" },
    { id: 6, nativeId: "e10", view: "bounded" }, { id: 7, nativeId: "e12", tier: 1 }, { id: 8, nativeId: "e13", tier: 2 }] }) });
  // Pi's order: the compaction, then what it kept, then what came after.
  const view = visibleView([carrier, message("e10"), message("e11")], binding);
  expect(view.raw.get("e9")).toBe("view"); // gone from the conversation, supplied as a bounded view
  // 30 "Visibility and fork": both legacy tiers are marked compressed views, so both count as Raw.
  expect(view.raw.get("e12")).toBe("view");
  expect(view.raw.get("e13")).toBe("view");
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


test.each([
  null, [], "carrier", {},
  { ...binding, supplied: null },
  { ...binding, supplied: { entries: {}, factIds: [1], knowledgeCommitIds: [2] } },
  { ...binding, supplied: { entries: [], factIds: "12", knowledgeCommitIds: [2] } },
  { ...binding, supplied: { entries: [], factIds: [1], knowledgeCommitIds: null } },
  ...[null, 1, {}, { nativeId: "target", view: "bounded" },
    { id: 1, nativeId: "", view: "bounded" }, { id: 1, nativeId: 7, view: "bounded" },
    { id: 1, nativeId: "target", view: "other" }, { id: 1, nativeId: "target", tier: 3 },
    { id: 1, nativeId: "target", view: "bounded", tier: 1 },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(id => ({ id, nativeId: "target", view: "bounded" }))]
    .map(item => ({ ...binding, generation: 9, supplied: supplied({ entries: [item as never], factIds: [1], knowledgeCommitIds: [2] }) })),
  ...[NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "9", null].map(generation =>
    ({ ...binding, generation, supplied: supplied({ factIds: [1], knowledgeCommitIds: [2] }) })),
  ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null].flatMap(id => [
    { ...binding, supplied: supplied({ factIds: [id as never], knowledgeCommitIds: [2] }) },
    { ...binding, supplied: supplied({ factIds: [1], knowledgeCommitIds: [id as never] }) },
    { ...binding, session: id, supplied: supplied({ factIds: [1] }) },
  ]).filter(value => value.session !== null),
  ...[null, "", 1].flatMap(value => [
    { ...binding, pi: value, supplied: supplied({ factIds: [1] }) },
    { ...binding, db: value, supplied: supplied({ factIds: [1] }) },
  ]),
])("malformed persisted carrier %#: reject atomically without throwing", payload => {
  const view = visibleView([{ ...injected("bad"), details: { traceMemory: payload } }], binding);
  expect(view).toEqual({ raw: new Map(), factIds: new Set(), knowledgeCommitIds: new Set(), injection: false, suppliedGeneration: 0 });
});

test.each(["custom", "branch_summary", "model_change", "message", "custom_message"])("foreign container %s donates no plugin coverage", type => {
  const view = visibleView([{ ...injected("raw", { generation: 8, supplied: supplied({ factIds: [1], knowledgeCommitIds: [2] }) }),
    type, customType: "other-extension" }], binding);
  expect([...view.factIds]).toEqual([]);
  expect([...view.knowledgeCommitIds]).toEqual([]);
  expect(view.suppliedGeneration).toBe(0);
  expect(view.injection).toBe(false);
  expect([...view.raw]).toEqual(type === "message" ? [["raw", "source"]] : []);
});

test("valid empty injection completes its generation, but a compaction cannot serve a command", () => {
  expect(visibleView([injected("empty", { generation: 0 })], binding).injection).toBe(true);
  expect(visibleView([injected("empty", { generation: 7 })], binding).suppliedGeneration).toBe(7);
  expect(visibleView([compacted("invalid", { generation: 7, supplied: supplied({ factIds: [1] }) })], binding).factIds.size).toBe(0);
});


test("carrier validation inspects every item before donating any identity", () => {
  const invalid = injected("mixed", { generation: 9, supplied: supplied({
    entries: [{ id: 1, nativeId: "valid", view: "bounded" }, null as never], factIds: [1], knowledgeCommitIds: [2] }) });
  const sparse = injected("sparse", { supplied: supplied({ factIds: new Array(2) }) });
  expect(visibleView([null as never, invalid, sparse], binding)).toEqual(visibleView([], binding));
});

test("a cloned Pi session inherits legitimate material, not the originating session's command completion", () => {
  const cloned = injected("cloned", { generation: 8, supplied: supplied({ knowledgeCommitIds: [1] }) });
  const view = visibleView([cloned], { ...binding, pi: "new-pi-session" });
  expect([...view.knowledgeCommitIds]).toEqual([1]);
  expect(view.injection).toBe(true);
  expect(view.suppliedGeneration).toBe(0);
});
