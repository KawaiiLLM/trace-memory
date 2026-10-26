import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { CompactionEntry, CustomMessageEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { host, reply } from "./test-host.ts";
import { entry, knowledge, legacyFacts, scoreAll } from "../../support/seed.ts";
import { visibility } from "../../../src/hosts/pi/index.ts";
import { tokens } from "../../../src/core/render/tokens.ts";
import { tag } from "../../../src/hosts/pi/settings.ts";
import { visibleView, type Carrier, type ContextEntry, type VisibleBinding } from "../../../src/hosts/pi/visible.ts";

// Ticket 29a — the host half: the production host writes the two carriers, and the view is read back
// off Pi's own compaction-aware context view. The pure rules are in tests/hosts/pi/visible-reader.test.ts;
// what a real Pi session does with a rewind, a cancelled attempt and repeated summary text is in
// compaction-baseline.test.ts.

const quiet = { "noting.triggerTokens": 1_000_000_000 };
/** Global knowledge so the first prompt has a block to inject at all. */
const seedKnowledge = (h: ReturnType<typeof host>, text = "全局规则") => {
  const store = h.memory.store, project = store.createProject({ name: "project-name", declaredBy: "mark" });
  const seed = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: seed.id, kind: "turn", startedAt: "now", userPrompt: "规则" });
  const source = entry(store, seed.id, turn.id, `rule-${seed.id}`, "user", "规则");
  const evidence = legacyFacts(store, { kind: "noting", sessionId: seed.id, createdAt: "now" },
    [{ sources: [{ entry: source, address: `T${turn.id}#E${source.entryOrdinal}` }], text: "规则",
      category: "decision", actor: "user", createdAt: "now" }]).facts[0]!;
  const commit = knowledge(store, store.knowledgePath(seed.id, "main", turn.id), "global", "constraint",
    [evidence.id], text, { run: { kind: "manual", createdAt: "now" } }).commit;
  scoreAll(store); // the Knowledge base carries scored items
  return commit;
};
/** The identity this host binds its carriers to, read the way `restore` reads it: the resolved
 * database path, the memory session id the host recorded in its own state entry (absent before the
 * first reply allocates one), and the Pi session id. */
const bound = (h: ReturnType<typeof host>): VisibleBinding => {
  const saved = h.entries.filter(e => e.type === "custom" && e.customType === tag).map(e => e.data as { sessionId?: number }).at(-1);
  return { db: h.dbPath, session: saved?.sessionId ?? null, pi: h.ctx.sessionManager.getSessionId() };
};
const view = (h: ReturnType<typeof host>, binding = bound(h)) =>
  visibleView(h.ctx.sessionManager.buildContextEntries() as ContextEntry[], binding);
const carrierOf = (entry: { details?: unknown }) => (entry.details as { traceMemory: Carrier }).traceMemory;
const customMessages = (h: ReturnType<typeof host>) => h.entries.filter(e => e.type === "custom_message") as CustomMessageEntry[];

test("29a case 3 (injection identity): the injected message carries exactly the commit ids it supplied, and is never Raw", async () => {
  const h = host(quiet);
  try {
    const commit = seedKnowledge(h);
    const result = await h.prompt("first");
    expect(result.message.content).toContain("<knowledge>");
    expect(carrierOf(result.message).supplied.knowledgeCommitIds).toEqual([commit]);
    const entry = customMessages(h)[0]!;
    expect(carrierOf(entry).db).toBe(h.dbPath);
    expect(carrierOf(entry).supplied).toEqual({ entries: [], factIds: [], knowledgeCommitIds: [commit],
      guideVersions: carrierOf(result.message).supplied.guideVersions, knowledgeTokens: tokens(result.message.content.split("\n\n").slice(1).join("\n\n")) });
    expect(view(h).raw.get(entry.id)).toBeUndefined(); // our own injection is not a source entry
    // Allocation changes guide text, but guides wait for the next material-bearing injection.
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    expect(await h.prompt("second")).toBeUndefined();
    expect(customMessages(h)).toHaveLength(1);
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    expect(await h.prompt("third")).toBeUndefined();
  } finally { await h.dispose(); }
});

test("29a case 4 (allocation identity): the first prompt's injection is bound to the Pi session id and is still recognised once the memory session is allocated", async () => {
  const h = host(quiet);
  try {
    const commit = seedKnowledge(h);
    await h.prompt("first");
    const entry = customMessages(h)[0]!;
    // Written before the first reply, so there is no memory session id yet to bind to.
    expect(carrierOf(entry).session).toBeNull();
    expect(carrierOf(entry).pi).toBe(h.ctx.sessionManager.getSessionId());
    // 97: the delivery is recorded for this context before its memory session exists.
    const store = h.memory.store, owner = `pi:${h.ctx.sessionManager.getSessionId()}`;
    expect([...store.deliveredKnowledge({ owner, sessionId: null, headTurnId: null, pending: [{ key: carrierOf(entry).prompt! }] })
      .knowledgeCommitIds]).toEqual([commit]);
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    const binding = bound(h);
    expect(binding.session).toBeGreaterThan(0); // the reply allocated it
    const head = store.listTurns(binding.session!).at(-1)!.id;
    expect([...store.deliveredKnowledge({ owner, sessionId: binding.session!, branch: "main", headTurnId: head })
      .knowledgeCommitIds]).toEqual([commit]); // the prompt's Turn owns it once allocated
    // Another context's records satisfy nothing.
    expect(store.deliveredKnowledge({ owner: "pi:other-pi", sessionId: null, headTurnId: null }).knowledgeCommitIds.size).toBe(0);
  } finally { await h.dispose(); }
});

test("29a case 5/6 (compaction baseline, retained entries): the custom summary and its kept identities are one entry, and what Pi retained past it still counts", async () => {
  const h = host(quiet);
  try {
    const commit = seedKnowledge(h);
    await h.prompt("first");
    // `message_end` alone, so the tip stays a message entry and Pi's `firstKeptEntryId` really retains
    // one of the entries this compaction also supplies.
    await h.emit("message_end", { message: reply("one") });
    // The tip is the reply; the first conversation entry is the prompt, which this compaction replaces.
    const kept = h.entries.at(-1)!.id, dropped = h.entries.find(e => e.type === "message")!.id;
    const appended = h.entries.length;
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100 } });
    expect(h.entries).toHaveLength(appended); // the handler appends no entry of its own (29: no preparation carrier)
    // The handler reconciles first, so this is the frozen set it just rendered. S1 is the seed above;
    // the reply allocated S2 for this host.
    const entries = h.memory.store.listSourceEntries(2);
    expect(entries.length).toBeGreaterThan(1);
    const supplied = carrierOf(result.compaction).supplied;
    // Every selected pending entry is represented, in the one bounded view (30), with both identities.
    expect(supplied.entries.map(e => e.nativeId).sort()).toEqual(entries.map(e => e.nativeId).sort());
    expect(new Set(supplied.entries.map(e => e.view))).toEqual(new Set(["bounded"]));
    expect(supplied.entries.map(e => e.id).sort()).toEqual(entries.map(e => e.id).sort());
    expect(supplied.knowledgeCommitIds).toEqual([commit]);
    // Receipt and content are one entry: the summary Pi appends carries the identities with it.
    const compaction = h.compaction(result.compaction.summary) as CompactionEntry;
    expect(carrierOf(compaction).supplied).toEqual(supplied);

    const context = (h.ctx.sessionManager.buildContextEntries() as SessionEntry[]).map(e => e.id);
    expect(context).toContain(kept); expect(context).not.toContain(dropped);
    // Read as the allocated memory session this compaction was written under.
    const visible = view(h, { db: h.dbPath, session: 2, pi: h.ctx.sessionManager.getSessionId() });
    expect(carrierOf(compaction).session).toBe(2);
    expect(visible.raw.get(kept)).toBe("source"); // a pre-compaction source Pi retained still counts
    expect(visible.raw.get(dropped)).toBe("view"); // …and one it summarised away is covered by the carrier
    for (const entry of supplied.entries) expect(visible.raw.has(entry.nativeId)).toBe(true);
  } finally { await h.dispose(); }
});

test("28a carrier: the persisted compaction lists the refilled already-extracted entries too, each in the one bounded view", async () => {
  const h = host(quiet);
  try {
    await h.prompt("first");
    await h.emit("message_end", { message: reply("one") });
    await h.emit("agent_settled"); await h.drain();
    // Everything recorded so far is extracted, so it is refill (b) material rather than pending Raw.
    const store = h.memory.store, sid = bound(h).session!;
    const head = () => store.listTurns(sid).at(-1)!.id;
    const extracted = store.sourcePath(sid, "main", head()).map(e => e.id);
    expect(extracted.length).toBeGreaterThan(0);
    expect(store.commitNotingRun({ run: { kind: "noting", sessionId: sid, branch: "main", createdAt: "now" }, facts: [], entryIds: extracted }).ok).toBe(true);
    await h.prompt("second");
    await h.emit("message_end", { message: reply("two") });
    await h.emit("agent_settled"); await h.drain();
    const pending = h.memory.pendingEntries(sid, "main", head()).map(e => e.id);
    expect(pending.length).toBeGreaterThan(0);
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100 } });
    const supplied = carrierOf(result.compaction).supplied;
    // Exactly the included identities, pending and refilled alike, in source order and one view.
    expect(supplied.entries.map(e => e.id)).toEqual(store.sourcePath(sid, "main", head()).map(e => e.id));
    expect(supplied.entries.map(e => e.id)).toEqual(expect.arrayContaining([...extracted, ...pending]));
    expect(new Set(supplied.entries.map(e => e.view))).toEqual(new Set(["bounded"]));
    // Receipt and content are one entry, and every listed identity counts as visible Raw afterwards.
    const compaction = h.compaction(result.compaction.summary) as CompactionEntry;
    expect(carrierOf(compaction).supplied).toEqual(supplied);
    const visible = view(h);
    for (const entry of supplied.entries) expect(visible.raw.has(entry.nativeId)).toBe(true);
  } finally { await h.dispose(); }
});

test("29a case 7 (opaque fallback): a native summary proves nothing, and the entries Pi retained past it still count", async () => {
  const h = host(quiet);
  try {
    seedKnowledge(h);
    await h.prompt("first");
    await h.emit("message_end", { message: reply("one") });
    const kept = h.entries.at(-1)!.id, injection = customMessages(h)[0]!.id;

    // Pi's own compaction entry: no `traceMemory`, so no coverage claim of any kind is read off its
    // free text — not the knowledge it summarised, and not the entries it replaced.
    const native = h.compaction("native summary") as CompactionEntry;
    expect(native.details).toBeUndefined();
    const context = (h.ctx.sessionManager.buildContextEntries() as SessionEntry[]).map(e => e.id);
    expect(context).not.toContain(injection);
    const visible = view(h);
    expect(visible.factIds.size).toBe(0);
    expect(visible.raw.get(kept)).toBe("source"); // a retained entry still counts on its own
    expect([...visible.raw.values()].every(v => v === "source")).toBe(true); // nothing is tier-1 covered
  } finally { await h.dispose(); }
});

test("29a case 7 (no compensating mechanism): src/ holds no preparation entry, considered set or coverage table", () => {
  const read = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap(item => item.isDirectory() ? read(join(dir, item.name)) : item.name.endsWith(".ts") ? [readFileSync(join(dir, item.name), "utf8")] : []);
  const sources = read("src").join("\n");
  // The 26c preparation-entry mechanism is retired (parent 29, "Native fallback is opaque"): no custom
  // entry is appended for a compaction, no `considered` set is frozen and no omitted history is
  // reconstructed later. The behavioural half of this — the handler appending nothing — is above.
  for (const retired of ["trace-memory-prep", "considered:", "preparationOf", "nativeCompaction"]) expect(sources).not.toContain(retired);
});

test("29a case 9 / the memoized view: one computation per context position, and a database change is never in the key", async () => {
  const h = host(quiet);
  try {
    const commit = seedKnowledge(h);
    await h.prompt("first"); await h.answer("one"); await h.emit("agent_settled"); await h.drain();
    let built = 0;
    const manager = h.ctx.sessionManager;
    const visible = visibility({ getLeafId: () => manager.getLeafId(), getEntry: id => manager.getEntry(id),
      buildContextEntries: () => { built++; return manager.buildContextEntries(); } });
    const binding = bound(h);
    const retained = [...visible(binding).raw];
    expect(retained.length).toBeGreaterThan(0);
    // A streaming token moves nothing: the leaf, the entry count and the binding are unchanged, so the
    // cached view is returned without walking the context again.
    for (let i = 0; i < 50; i++) visible(binding);
    expect(built).toBe(1);
    // A new commit changes applicability, not this context: the view is unchanged and — because the
    // database is deliberately not in the key — it is not recomputed either.
    seedKnowledge(h, "另一条全局规则");
    expect([...visible(binding).raw]).toEqual(retained);
    expect(built).toBe(1);
    // A real append extends the selected view, without rebuilding historical context.
    await h.prompt("second");
    visible(binding);
    expect(built).toBe(1);
    visible({ ...binding, session: null });
    expect(built).toBe(2);
  } finally { await h.dispose(); }
});

// 144 stage 4 §7.4: a title-only delivery goes through Pi's carrier and the delivery records; a later body upgrades it.
test("144 title-only injection: carried, recorded once, not re-sent, and a later body upgrades it", async () => {
  const h = host(quiet);
  try {
    const commit = seedKnowledge(h, "big rule " + "word ".repeat(1_500));
    h.memory.setKnowledgeBase(0); // the base holds nothing: a title
    const first = await h.prompt("first");
    expect(first.message.content).not.toMatch(/\[K\d+#/); // Titles carry no exact body version.
    const supplied = carrierOf(first.message).supplied;
    expect(supplied.knowledgeCommitIds).toEqual([]);
    expect(supplied.knowledgeTitleCommitIds).toEqual([commit]);
    expect(supplied.pointerTokens).toBeGreaterThan(0);
    const owner = `pi:${h.ctx.sessionManager.getSessionId()}`;
    const delivered = h.memory.store.deliveredKnowledge({ owner, sessionId: null, headTurnId: null, pending: [{ key: carrierOf(customMessages(h)[0]!).prompt! }] });
    expect([...delivered.knowledgeTitleCommitIds]).toEqual([commit]);
    expect(delivered.pointerTokens).toBe(supplied.pointerTokens);
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    expect(await h.prompt("second")).toBeUndefined(); // a title is never re-sent for the same version
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    h.memory.setKnowledgeBase(20_000); // base room appears
    const third = await h.prompt("third");
    expect(carrierOf(third.message).supplied.knowledgeCommitIds).toEqual([commit]);
    expect(carrierOf(third.message).supplied.guideVersions).toHaveLength(1); // The changed reading guide rides the body upgrade.
  } finally { await h.dispose(); }
});

test("144 a Pi carrier names its title-only versions and temporary charge validly or is ignored", () => {
  const binding: VisibleBinding = { db: "d", session: 1, pi: "p" };
  const entryWith = (supplied: object): ContextEntry => ({ id: "c", type: "compaction", details: { traceMemory: { db: "d", session: 1, pi: "p",
    supplied: { entries: [], factIds: [9], knowledgeCommitIds: [], ...supplied } } } });
  expect(visibleView([entryWith({ knowledgeTitleCommitIds: [2], temporaryTokens: 5 })], binding).factIds.has(9)).toBe(true);
  expect(visibleView([entryWith({})], binding).factIds.has(9)).toBe(true); // absent means none
  expect(visibleView([entryWith({ knowledgeTitleCommitIds: [0] })], binding).factIds.has(9)).toBe(false);
  expect(visibleView([entryWith({ temporaryTokens: -1 })], binding).factIds.has(9)).toBe(false);
});
