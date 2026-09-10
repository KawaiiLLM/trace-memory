import { expect, test } from "vitest";
import type { BeforeAgentStartEventResult, CompactionEntry, CustomEntry, CustomMessageEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { host } from "./test-host.ts";
import { call, fixture, noteBatch, say, settled, submitted, worker } from "./native-fixture.ts";
import { tag } from "../../../src/hosts/pi/settings.ts";

// Ticket 26c0 — fixture parity with Pi for the three carriers 26c reads coverage off. Nothing in
// `src/` writes these fields yet (slice 3); what is pinned here is that the fixtures persist what Pi
// persists, so a later slice can read a carrier back instead of inventing a place to keep it.
//
// The Pi lines the fixtures copy, quoted where they are copied:
//   agent-session.ts:1286-1293  a `before_agent_start` message becomes a `role: "custom"` message
//   agent-session.ts:674-684    …persisted at `message_end` via `appendCustomMessageEntry`
//   agent-session.ts:2025/:2350 a `session_before_compact` result reaches `appendCompaction(summary,
//                               firstKeptEntryId, tokensBefore, details, fromExtension, usage)`
//   session-manager.ts:418-453  `buildContextEntries`: the selected ancestry, or
//                               `[latestCompaction, ...from firstKeptEntryId, ...after]`

const quiet = { "noting.triggerTokens": 1_000_000_000 };
const ids = (entries: readonly SessionEntry[]) => entries.map(e => e.id);

/** A stand-in extension whose two hook results the case scripts. The production host returns no
 * `details` on either carrier yet, so this is how a case states what a handler returned. */
function scripted() {
  const script: { message?: BeforeAgentStartEventResult["message"]; details?: unknown } = {};
  let api: ExtensionAPI;
  const extension = (pi: ExtensionAPI) => {
    api = pi;
    pi.on("before_agent_start", () => script.message ? { message: script.message } : undefined);
    pi.on("session_before_compact", event =>
      ({ compaction: { summary: "custom summary", firstKeptEntryId: "", tokensBefore: event.preparation.tokensBefore, details: script.details } }));
  };
  return { script, extension, pi: () => api };
}
const customMessages = (h: ReturnType<typeof host>) => h.entries.filter(e => e.type === "custom_message") as CustomMessageEntry[];

test("26c0 carrier A: a before_agent_start message is persisted as a custom_message entry carrying its details, and a prompt that returns none writes none", async () => {
  const { script, extension } = scripted();
  const h = host(quiet, { extension });
  try {
    const receipt ={ traceMemory: { v: 1, session: 1, facts: [7, 9], commits: [], knowledge: true } };
    script.message = { customType: tag, content: "<noted>…</noted>", display: false, details: receipt };
    const returned = await h.prompt("first");
    expect(returned.message.details).toBe(receipt);
    const entry = customMessages(h)[0]!;
    expect(entry.type).toBe("custom_message");
    expect(entry.customType).toBe(tag);
    expect(entry.content).toBe("<noted>…</noted>");
    expect(entry.display).toBe(false);
    expect(entry.details).toEqual(receipt); // the on-disk field, not a copy the fixture kept beside it
    // Pi persists the returned message after the user message of the same turn, as its child, and it
    // is the leaf the next entry hangs from.
    expect(entry.parentId).toBe(h.entries.at(-2)!.id);
    expect(h.ctx.sessionManager.getLeafId()).toBe(entry.id);
    expect(h.ctx.sessionManager.getEntry(entry.id)).toBe(entry);
    expect(ids(h.ctx.sessionManager.buildContextEntries())).toContain(entry.id);
    // A prompt whose handler returns nothing carries no receipt: absence is the "not delivered" state.
    script.message = undefined;
    await h.answer();
    expect(await h.prompt("second")).toBeUndefined();
    expect(customMessages(h)).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("26c0 carrier B: a session_before_compact result's compaction.details land on the appended compaction entry, with fromHook", async () => {
  const { script, extension } = scripted();
  const h = host(quiet, { extension });
  try {
    await h.prompt("first"); await h.answer();
    const baseline = { traceMemory: { v: 1, session: 1, covered: [1], considered: [1, 2], commits: [4] } };
    script.details = baseline;
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100 } });
    expect(result.compaction.details).toBe(baseline);
    const entry = h.compaction("custom summary") as CompactionEntry;
    expect(entry.details).toEqual(baseline);
    expect(entry.fromHook).toBe(true); // Pi's `fromExtension`: this summary is the extension's, not Pi's
    expect((h.ctx.sessionManager.getEntry(entry.id) as CompactionEntry).details).toEqual(baseline);
    // One hook result belongs to one appended entry: a compaction Pi wrote on its own carries neither
    // field, which is exactly the tier-3 native fallback 26c must tell apart.
    const native = h.compaction() as CompactionEntry;
    expect(native.details).toBeUndefined();
    expect(native.fromHook).toBeUndefined();
  } finally { await h.dispose(); }
});

test("26c0: pi.appendEntry writes a custom entry whose parent is the current leaf, and that entry becomes the new leaf", async () => {
  const { extension, pi } = scripted();
  const h = host(quiet, { extension });
  try {
    await h.prompt("first"); await h.answer();
    const leaf = h.ctx.sessionManager.getLeafId();
    pi().appendEntry(tag, { considered: [1, 2] });
    const entry = h.entries.at(-1) as CustomEntry;
    expect(entry.type).toBe("custom");
    expect(entry.customType).toBe(tag);
    expect(entry.data).toEqual({ considered: [1, 2] });
    expect(entry.parentId).toBe(leaf);
    expect(h.ctx.sessionManager.getLeafId()).toBe(entry.id);
    expect(ids(h.ctx.sessionManager.buildContextEntries()).at(-1)).toBe(entry.id);
  } finally { await h.dispose(); }
});

test("26c0: buildContextEntries follows Pi's rule — the selected ancestry, then the compaction with its kept interval and everything after", async () => {
  const { extension } = scripted();
  const h = host(quiet, { extension });
  try {
    await h.prompt("first"); await h.answer("one");
    // Before any compaction the context view is the selected ancestry itself.
    expect(ids(h.ctx.sessionManager.buildContextEntries())).toEqual(h.entries.map(e => e.id));
    const dropped = h.entries[0]!.id, kept = h.entries.at(-1)!.id; // the fixture keeps from the tip
    const compaction = h.compaction("summary");
    await h.prompt("second"); await h.answer("two");
    const view = ids(h.ctx.sessionManager.buildContextEntries());
    expect(view).toEqual([compaction.id, kept, ...h.entries.slice(-2).map(e => e.id)]);
    expect(view).not.toContain(dropped); // summarised entries before `firstKeptEntryId` are gone
    // A compaction on a sibling path is not on this ancestry and changes nothing here.
    h.compaction("sibling summary", { sibling: true });
    expect(ids(h.ctx.sessionManager.buildContextEntries())).toEqual(view);
  } finally { await h.dispose(); }
});

test("26c0 native fixture: the message the hook returned is persisted through the real SessionManager and the real buildContextEntries carries it", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : submitted(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    await settled(f); // the Noter committed a fact
    // 29d: that commit reaches no prompt on its own, so the message this case needs is the one
    // automatic carrier that is left — the initial knowledge block.
    const store = f.h.memory.store, fact = store.listSessionFacts(1)[0]!;
    store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: 1, createdAt: "now" }, operations: [{
      op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "fixture",
      text: "Carried knowledge", category: "constraint", scope: "global", supports: [fact.id], createdAt: "now" }] });
    await f.turn("第二个问题");
    const manager = f.manager();
    const receipt = manager.getEntries().find(e => e.type === "custom_message") as CustomMessageEntry | undefined;
    expect(receipt?.customType).toBe(tag);
    expect(String(receipt!.content)).toContain("Carried knowledge");
    expect(receipt!.display).toBe(false);
    // Real entry, on the real ancestry, inside the real compaction-aware view.
    expect(ids(manager.getBranch())).toContain(receipt!.id);
    expect(ids(manager.buildContextEntries())).toContain(receipt!.id);
    expect(manager.getEntry(receipt!.id)).toEqual(receipt);
  } finally { await f.dispose(); }
});

test("26c0 (26c design revision 3): rewinding to a compaction node yields the compaction alone, so a child entry cannot carry its baseline", async () => {
  const f = await fixture();
  try {
    f.script(() => say("好的。"));
    await f.turn();
    const manager = f.manager();
    const baseline = { traceMemory: { v: 1, considered: [1, 2] } };
    const compaction = manager.appendCompaction("summary", "", 100, baseline, true);
    manager.appendCustomEntry(tag, { nativeCompaction: { entry: compaction, considered: [1, 2] } });
    const child = manager.getLeafId()!;
    // While the child is the leaf it is in the view — which is what made carrier C look workable.
    expect(ids(manager.buildContextEntries())).toEqual([compaction, child]);
    // Rewound to the compaction node itself, Pi returns that entry and nothing after it: a child of
    // the compaction is not reachable, so no baseline may live there.
    manager.branch(compaction);
    expect(ids(manager.buildContextEntries())).toEqual([compaction]);
    // The compaction's own `details` survive the same rewind, which is why carrier B is the entry.
    const entry = manager.getEntry(compaction) as CompactionEntry;
    expect(entry.details).toEqual(baseline);
    expect(entry.fromHook).toBe(true);
  } finally { await f.dispose(); }
});
