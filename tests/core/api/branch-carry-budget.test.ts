import { expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { charge, renderEntry, tokens } from "../../../src/core/render/index.ts";

function fixture(texts: string[]) {
  const memory = TraceMemory(":memory:", async () => { throw new Error("No provider expected"); });
  const project = memory.store.createProject({ name: "carry", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: texts[0] ?? "", assistantText: "reply", startedAt: "now" });
  const entries = texts.map((text, index) => memory.appendEntry({ sessionId: session.id, turnId: turn.id,
    nativeLineage: "test", nativeId: `entry-${index}`, role: index === 0 ? "user" : "assistant", text,
    raw: JSON.stringify({ text }), calls: [] }));
  memory.selectEntries(session.id, "main", entries.map(entry => entry.id));
  const carry = () => memory.branchSummary(session.id, "main", turn.id);
  const raw = () => carry().split("Pending raw:\n")[1]!.replace(/\n?<\/branch_carry>$/, "");
  return { memory, session, turn, entries, carry, raw };
}
const receipt = (n: number) => `[... ${n} earlier pending entries omitted from the carry budget; read them with trace]`;

test("an impossible optional carry envelope fails instead of retaining one oversized entry", () => {
  const f = fixture(["hello world"]);
  try {
    f.memory.config.render.episodicBlockTokens = 1;
    expect(f.carry).toThrow(/capacity/);
    expect(f.memory.pendingEntries(f.session.id, "main", f.turn.id).map(e => e.id)).toEqual(f.entries.map(e => e.id));
  } finally { f.memory.close(); }
});

test("a single oversized carry entry is omitted whole with a charged receipt, not a second Raw view", () => {
  const f = fixture(["large raw ".repeat(500)]);
  try {
    const cap = charge(["Pending raw:", receipt(1)]);
    f.memory.config.render.episodicBlockTokens = cap;
    expect(f.raw()).toBe(receipt(1));
    expect(tokens(`Pending raw:\n${f.raw()}`)).toBeLessThanOrEqual(cap);
    f.memory.config.render.episodicBlockTokens = cap - 1;
    expect(f.carry).toThrow(/capacity/);
    // Carry is optional; custom compaction still protects every pending entry and its coverage.
    const compact = f.memory.compact(f.session.id, "main", f.turn.id);
    expect("native" in compact).toBe(false);
    if ("native" in compact) throw new Error(compact.reason);
    expect(compact.supplied.entries.map(e => e.id)).toEqual(f.entries.map(e => e.id));
    expect(compact.text).toContain(renderEntry(f.entries[0]!, f.memory.config.render).content);
  } finally { f.memory.close(); }
});

test("carry keeps the newest whole suffix in source order and charges framing and omissions", () => {
  const f = fixture(["old ".repeat(500), "middle", "newest"]);
  try {
    const views = f.entries.map(e => renderEntry(e, f.memory.config.render).content);
    const cap = charge(["Pending raw:", ...views.slice(1), receipt(1)]);
    f.memory.config.render.episodicBlockTokens = cap;
    expect(f.raw()).toBe([...views.slice(1), receipt(1)].join("\n"));
    expect(tokens(`Pending raw:\n${f.raw()}`)).toBeLessThanOrEqual(cap);
    f.memory.config.render.episodicBlockTokens = cap - 1;
    expect(f.raw()).toBe([views[2], receipt(2)].join("\n"));
    expect(f.memory.progress(f.session.id, "main", f.turn.id).entries).toBe(3);
  } finally { f.memory.close(); }
});

test("empty carry and a complete small Raw view need no omission receipt", () => {
  for (const texts of [[], ["hello world"]]) {
    const f = fixture(texts);
    try {
      const views = f.entries.map(e => renderEntry(e, f.memory.config.render).content);
      f.memory.config.render.episodicBlockTokens = charge(["Pending raw:", ...views]);
      expect(f.raw()).toBe(views.join("\n"));
      expect(f.carry()).not.toContain("omitted from the carry budget");
      f.memory.config.render.episodicBlockTokens = 1;
      expect(f.carry).toThrow(/capacity/);
    } finally { f.memory.close(); }
  }
});
