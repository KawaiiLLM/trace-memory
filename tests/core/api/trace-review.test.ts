// Review of b3fa426..80e2cb5 (2026-09-09), three P2s: a stored compaction summary has no source entry
// but must still be readable through trace; a non-object JSON payload (a root array) is cut with the
// same escape-safe units as a nested one; a search continuation renders its deferred Raw hits under
// the profile the query was made with, not the configuration in force when the page is asked for.
import { expect, test } from "vitest";
import { sourceSeededMemory , hydrate } from "../../source-fixture.ts";
import { renderEntry } from "../../../src/core/render/index.ts";

const setup = () => {
  const m = sourceSeededMemory(":memory:", async () => { throw new Error("no model requests"); });
  const projectId = m.store.createProject({ name: "p", declaredBy: "mark" }).id;
  const s = m.store.createSession({ projectId, host: "fake", enrollmentChoice: true, startedAt: "t", firstReplyAt: "t" });
  return { m, s };
};
const profile = { entryTokens: 10_000, toolInputTokens: 300, toolResultTokens: 300 };

test("review 80e: a stored compaction summary is readable through trace, full and budgeted, and by its #assistant address", () => {
  const { m, s } = setup();
  try {
    const t = m.store.appendTurn({ sessionId: s.id, kind: "compaction", assistantText: "PERSISTED COMPACTION SUMMARY", startedAt: "t" });
    expect(hydrate(m.store.listSourceEntries(s.id, t.id), m.store)).toEqual([]); // summaries are deliberately not Raw source entries
    expect(m.trace(`T${t.id}`, { full: true })).toBe(`[T${t.id}] compaction summary (not Raw evidence): PERSISTED COMPACTION SUMMARY`);
    expect(m.trace(`T${t.id}`)).toContain("PERSISTED COMPACTION SUMMARY");
    expect(m.trace(`T${t.id}#assistant`, { full: true })).toBe(`[T${t.id}] compaction summary (not Raw evidence): PERSISTED COMPACTION SUMMARY`);
    expect(() => m.trace(`T${t.id}#E1`)).toThrow(/does not exist/);
    expect(m.trace(`T${t.id}`)).not.toContain(`#assistant]`);
    // Display only: neither an E source nor a citable-looking legacy label is fabricated.
    expect(hydrate(m.store.listSourceEntries(s.id, t.id), m.store)).toEqual([]);
    // An ordinary Turn whose assistant entry exists shows that entry once, never a second stored copy.
    const u = m.store.appendTurn({ sessionId: s.id, parentTurnId: t.id, kind: "turn", userPrompt: "q", startedAt: "t" });
    m.store.updateTurn(u.id, { assistantText: "ANSWER" }); // the store records the assistant entry itself
    expect(hydrate(m.store.listSourceEntries(s.id, u.id), m.store).filter(e => e.role === "assistant")).toHaveLength(1);
    expect(m.trace(`T${u.id}`, { full: true }).split("ANSWER")).toHaveLength(2);
  } finally { m.close(); }
});

test("review 80e: a search continuation renders its deferred Raw hits under the query-time profile", () => {
  const { m, s } = setup();
  try {
    const t1 = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "needle first", startedAt: "t" });
    const t2 = m.store.appendTurn({ sessionId: s.id, parentTurnId: t1.id, kind: "turn", userPrompt: "needle second", startedAt: "t" });
    m.store.appendToolCall({ turnId: t2.id, name: "tool", input: "{}", result: "head " + "value ".repeat(1000) + " tail", status: "success" });
    const expected = m.search("needle", "raw", { cap: 100 }).split("\n\nReceipts:")[0];
    const first = m.search("needle", "raw", { cap: 1 });
    const cursor = /cursor=(\S+)/.exec(first)![1]!;
    // The host refreshes this same configuration object on restore; the page must not follow it.
    m.config.render.toolResultTokens = 1000;
    const last = m.search("", "raw", { cursor });
    expect(first.split("\n\nReceipts:")[0] + "\n" + last.split("\n\nReceipts:")[0]).toBe(expected);
  } finally { m.close(); }
});

test("review 80e: a root-array JSON payload is cut on escape-safe units, never inside an escape sequence", () => {
  const input = JSON.stringify(Array.from({ length: 100 }, () => "xxa\nb\"c\\d "));
  const entry = { id: 1, entryOrdinal: 1, sessionId: 1, turnId: 1, nativeId: "x", nativeLineage: "fake", role: "assistant" as const, text: "", raw: "",
    calls: [{ ordinal: 1, name: "tool", callId: "c", input, status: "attempted" }] };
  for (const C of [300, 100]) {
    const text = renderEntry(entry, { entryTokens: 10_000, toolInputTokens: C, toolResultTokens: C }).content;
    const marker = text.indexOf("[...");
    expect(marker).toBeGreaterThan(0);
    const head = text.slice("[T1#E1] tool(".length, marker);
    expect((/\\+$/.exec(head)?.[0].length ?? 0) % 2).toBe(0); // a head never ends on a lone backslash
    expect(head.startsWith("[\"xxa\\nb")).toBe(true); // the compact JSON text, not the raw payload re-quoted
  }
  const withInput = (value: string) => ({ ...entry, calls: [{ ...entry.calls[0]!, input: value }] });
  // A root string is a quoted value; a root number is its JSON text; text that is not JSON stays raw.
  expect(renderEntry(withInput(JSON.stringify("plain")), profile).content).toBe("[T1#E1] tool(\"plain\")");
  expect(renderEntry(withInput("42"), profile).content).toBe("[T1#E1] tool(42)");
  expect(renderEntry(withInput("not json"), profile).content).toBe("[T1#E1] tool(not json)");
});
