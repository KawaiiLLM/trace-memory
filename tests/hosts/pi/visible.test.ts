import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { CompactionEntry, CustomMessageEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { host, reply } from "./test-host.ts";
import { visibility } from "../../../src/hosts/pi/index.ts";
import { tag } from "../../../src/hosts/pi/settings.ts";
import { visibleView, type Carrier, type ContextEntry, type VisibleBinding } from "../../../src/core/api/index.ts";

// Ticket 29a — the host half: the production host writes the two carriers, and the view is read back
// off Pi's own compaction-aware context view. The pure rules are in tests/core/api/visible.test.ts;
// what a real Pi session does with a rewind, a cancelled attempt and repeated summary text is in
// compaction-baseline.test.ts.

const quiet = { "noting.triggerTokens": 1_000_000_000 };
/** Global knowledge so the first prompt has a block to inject at all. */
const seedKnowledge = (h: ReturnType<typeof host>, text = "全局规则") => {
  const store = h.memory.store, project = store.createProject({ name: "project-name", declaredBy: "mark" });
  const seed = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: seed.id, kind: "turn", startedAt: "now", userPrompt: "规则" });
  const noted = store.commitNotingRun({ run: { kind: "noting", sessionId: seed.id, createdAt: "now" },
    facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "规则", source: [`T${turn.id}#user`], createdAt: "now" }] });
  if (!noted.ok) throw new Error("seed");
  const commit = store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: seed.id, createdAt: "now" },
    operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "fixture",
      text, supports: [noted.facts[0]!.id], createdAt: "now", category: "constraint", scope: "global" }] });
  if (!commit.ok) throw new Error("seed");
  return commit.committed[0]!.commit;
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

test("29a case 3 (injection identity): the injected message carries exactly the commit ids it supplied, and is visible as knowledge but never as Raw", async () => {
  const h = host(quiet);
  try {
    const commit = seedKnowledge(h);
    const result = await h.prompt("first");
    expect(result.message.content).toContain("<knowledge>");
    expect(carrierOf(result.message).supplied.knowledgeCommitIds).toEqual([commit]);
    const entry = customMessages(h)[0]!;
    expect(carrierOf(entry).db).toBe(h.dbPath);
    expect(carrierOf(entry).supplied).toEqual({ entries: [], factIds: [], knowledgeCommitIds: [commit] });
    const visible = view(h);
    expect([...visible.knowledgeCommitIds]).toEqual([commit]);
    expect(visible.raw.get(entry.id)).toBeUndefined(); // our own injection is not a source entry
    // The commit id appears in the rendered block as well; the coverage above came from the metadata,
    // and a knowledge id that was never supplied is not conjured out of the text.
    expect(visible.knowledgeCommitIds.has(commit + 1)).toBe(false);
    // The injection happens once: the next prompt returns no message and therefore no second carrier.
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    expect(await h.prompt("second")).toBeUndefined();
    expect(customMessages(h)).toHaveLength(1);
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
    expect([...view(h).knowledgeCommitIds]).toEqual([commit]);
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    const binding = bound(h);
    expect(binding.session).toBeGreaterThan(0); // the reply allocated it
    expect([...view(h, binding).knowledgeCommitIds]).toEqual([commit]); // still recognised, through `pi`
    // Another database's equal integers, and another memory session's carrier, satisfy nothing.
    expect(view(h, { ...binding, db: `${h.dbPath}.other` }).knowledgeCommitIds.size).toBe(0);
    expect(view(h, { ...binding, session: binding.session! + 1, pi: "other-pi" }).knowledgeCommitIds.size).toBe(0);
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
    // The replacement re-establishes the knowledge too: the injection entry it summarised away is gone
    // from the context, and the baseline is rebuilt from the accepted replacement alone.
    expect([...visible.knowledgeCommitIds]).toEqual([commit]);
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
    expect(view(h).knowledgeCommitIds.size).toBe(1); // visible while the injection is in the context

    // Pi's own compaction entry: no `traceMemory`, so no coverage claim of any kind is read off its
    // free text — not the knowledge it summarised, and not the entries it replaced.
    const native = h.compaction("native summary") as CompactionEntry;
    expect(native.details).toBeUndefined();
    const context = (h.ctx.sessionManager.buildContextEntries() as SessionEntry[]).map(e => e.id);
    expect(context).not.toContain(injection);
    const visible = view(h);
    expect(visible.knowledgeCommitIds.size).toBe(0);
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
    const visible = visibility({ getLeafId: () => manager.getLeafId(), getEntries: () => manager.getEntries(),
      buildContextEntries: () => { built++; return manager.buildContextEntries(); } });
    const binding = bound(h);
    expect([...visible(binding).knowledgeCommitIds]).toEqual([commit]);
    // A streaming token moves nothing: the leaf, the entry count and the binding are unchanged, so the
    // cached view is returned without walking the context again.
    for (let i = 0; i < 50; i++) visible(binding);
    expect(built).toBe(1);
    // A new commit changes applicability, not this context: the view is unchanged and — because the
    // database is deliberately not in the key — it is not recomputed either.
    seedKnowledge(h, "另一条全局规则");
    expect([...visible(binding).knowledgeCommitIds]).toEqual([commit]);
    expect(built).toBe(1);
    // A new entry invalidates it; so does the memory session id becoming known.
    await h.prompt("second");
    visible(binding);
    expect(built).toBe(2);
    visible({ ...binding, session: null });
    expect(built).toBe(3);
  } finally { await h.dispose(); }
});
