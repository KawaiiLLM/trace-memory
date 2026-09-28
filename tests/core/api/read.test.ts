import { afterEach, beforeEach, expect, test } from "vitest";
import { wholeTrace } from "../../trace-pages.ts";
import { fact as seedFact, legacyFacts } from "../../support/seed.ts";
import { readFileSync } from "node:fs";
import { MEMORY_FILES_NOTICE } from "../../../src/core/render/index.ts";
import { sourceSeededMemory, compacted, renderEntry, tokens, ENTRY_VIEW_VERSION , hydrate } from "../../source-fixture.ts";
import { setKnowledgeCapacity, setKnowledgeInjection, setSharedAllowance } from "../../knowledge-budget-fixture.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/noting/facts.json", import.meta.url), "utf8"));
const rawFixture = JSON.parse(readFileSync(new URL("../../fixtures/noting/turns.json", import.meta.url), "utf8"));
const time = "2026-09-06T00:00:00Z";
let memory: ReturnType<typeof sourceSeededMemory>, calls: number, admittedScenarios: AdmittedDreamerScenarios;
// 26a: a Noting run completes its batch by submitting; with nothing to record it sends `{facts: []}`.
beforeEach(() => { calls = 0;
  const fallback = async (raw: unknown) => { calls++;
    const input = raw as { kind: string; tools: { name: string; execute(input: unknown): string }[] };
    if (input.kind === "noting") {
      input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
      input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    }
    return { outcome: "success" as const, output: [], request: {} };
  };
  admittedScenarios = new AdmittedDreamerScenarios(fallback);
  memory = sourceSeededMemory(":memory:", admittedScenarios.agent);
});
afterEach(() => memory.close());
function session(projectId?: number, declaration: "marker" | "undeclared" = "marker") {
  const project = projectId ?? memory.store.createProject({ name: "mapC", declaredBy: "marker" }).id;
  return memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project, projectDeclaration: declaration });
}
function turn(sessionId: number, text = fixture.base, parentTurnId?: number) {
  return memory.store.appendTurn({ sessionId, userPrompt: text, assistantText: null, parentTurnId, kind: "turn", startedAt: time });
}
function noting(sessionId: number, turnId: number, text = fixture.base, branch = "main") {
  const selected = memory.store.sourcePath(sessionId, branch, turnId);
  const users = hydrate(memory.store.listSourceEntries(sessionId, turnId), memory.store).filter(entry => entry.role === "user");
  expect(users).toHaveLength(1);
  const user = users[0]!;
  expect(selected.map(entry => entry.id)).toContain(user.id);
  return legacyFacts(memory.store, { sessionId, branch, kind: "noting", createdAt: time },
    [{ text, category: "decision", actor: "user", sources: [{ entry: user, address: `T${turnId}#E${user.entryOrdinal}` }], createdAt: time }],
    selected.map(entry => entry.id));
}
function knowledge(sessionId: number, factId: number, category: "constraint" | "open" | "goal" | "understanding" | "reference" = "constraint",
  scope: "session" | "project" | "global" = "project", text = fixture.knowledge, createdAt = time, topics: string[] = [], historicalManual = false) {
  const result = memory.store.commitConsolidationRun({ run: { sessionId, branch: "main", kind: "manual", createdAt: time },
    operations: [{ op: "create", topics, reason: "Initial admission of this conclusion.", handle: "$e1", author: "fake", text, category, scope, supports: [factId], createdAt }],
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.committed[0]!.knowledgeId;
}
function populated() {
  const s = session(), t = turn(s.id), n = noting(s.id, t.id), f = n.facts[0]!;
  const e = knowledge(s.id, f.id);
  return { s, t, f, e };
}
const golden = (name: string) => readFileSync(new URL(`../../fixtures/read/${name}.txt`, import.meta.url), "utf8").trimEnd();
/** 28a: what one custom replacement charged, window by window. A `native` delegation has none. */
const charged = (result: ReturnType<typeof memory.compact>) => {
  if ("native" in result) throw new Error(`expected a custom replacement, got: ${result.reason}`);
  return result.charged!;
};
/** Tests set independent bases; a zero allowance isolates each base boundary. */
const setWindows = (knowledge: number, facts: number, raw: number, allowance = 0) => {
  setKnowledgeCapacity(memory, Math.max(3, knowledge));
  Object.assign(memory.config.compaction, { factsTokens: facts, rawTokens: raw, sharedAllowanceTokens: allowance });
};
const defaultWindows = () => {
  memory.setKnowledgeBudget("global", 4_000);
  memory.setKnowledgeBudget("project", 15_000);
  memory.setKnowledgeBudget("session", 1_000);
  memory.config.compaction.sharedAllowanceTokens = 10_000;
  memory.config.compaction.factsTokens = 10_000;
  memory.config.compaction.rawTokens = 10_000;
};

test("injection and compaction match Chinese fixture goldens without a model call", () => {
  const { s, t } = populated();
  const next = turn(s.id, rawFixture[1].userPrompt, t.id);
  const knowledge = `<knowledge>\nItems are ordered oldest to newest. For claims about the same object, the later item takes precedence until maintenance merges them.\nSession S${s.id}: a subagent inherits this session's knowledge by reading /tm/S${s.id}/knowledge.\n${MEMORY_FILES_NOTICE}\n[K1#${memory.store.versionTag(1, 1)}] [constraint/project] 地形层和高度层一起读。\n  change supports: F1\n</knowledge>`;
  expect(memory.inject(s.id)).toBe(knowledge);
  // The exact bound source is already supplied as Raw, so the Fact is not duplicated.
  const compact = memory.compact(s.id, "main");
  if ("native" in compact) throw new Error(compact.reason);
  expect(compact.supplied.factIds).toEqual([]);
  expect(compact.supplied.entries.map(entry => entry.id)).toEqual(
    memory.store.sourcePath(s.id, "main", next.id).map(entry => entry.id));
  expect(compacted(compact)).toContain("地形层和高度层需要一起读。");
  expect(calls).toBe(0);
});

test("injection stays byte-identical across a zero-fact noting and has no XML attributes", async () => {
  const { s, t } = populated();
  const before = memory.inject(s.id), next = turn(s.id, fixture.observation, t.id);
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: next.id })).outcome).toBe("success");
  expect(memory.inject(s.id)).toBe(before);
  for (const tag of before.match(/<[^>]+>/g)!) expect(tag).toMatch(/^<\/?[a-z_]+>$/);
});

test("visibility includes global, own project and own session only, excluding inactive knowledge", () => {
  const { s, f } = populated(), peer = session(s.projectId), foreign = session();
  const own = knowledge(s.id, f.id, "open", "session"), other = knowledge(peer.id, noting(peer.id, turn(peer.id).id).facts[0]!.id, "open", "session");
  const outside = knowledge(foreign.id, noting(foreign.id, turn(foreign.id).id).facts[0]!.id), global = knowledge(foreign.id, f.id, "goal", "global");
  const archived = knowledge(s.id, f.id, "reference");
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, kind: "manual", createdAt: time },
    operations: [{ op: "archive", kind: "budget", reason: "Retired: the cited evidence withdraws this conclusion.", knowledgeId: archived, baseCommit: archived, supports: [f.id], createdAt: time }] });
  for (const block of [memory.inject(s.id), compacted(memory.compact(s.id))]) {
    expect(block).toContain(`[K${own}#${memory.store.versionTag(own, own)}]`); expect(block).toContain(`[K${global}#${memory.store.versionTag(global, global)}]`);
    for (const id of [other, outside, archived]) expect(block).not.toContain(`[K${id}#`);
  }
});

test("64c category display and commit recency retain whole newer items; lines are never escaped", () => {
  const { s, f } = populated();
  const categories = ["reference", "understanding", "goal", "open"] as const;
  const ids = categories.map(category => knowledge(s.id, f.id, category));
  // The renderer must also handle a large single body manually stored before any worker runs.
  const earlier = knowledge(s.id, f.id, "constraint", "project", "<&> " + "word ".repeat(6_000), "2020", [], true);
  const all = memory.inject(s.id);
  expect(all.indexOf(`[K${earlier}#`)).toBeGreaterThan(all.indexOf("[K1#")); // older timestamp, newer commit
  // Injected lines are trace lines byte for byte (ruling 15:14); tags only delimit blocks.
  expect(all).toContain("<&>");
  expect(all).not.toContain("&lt;");
  expect([...all.matchAll(/\[K(\d+)#[a-z]+\]/g)].map(match => Number(match[1]))).toEqual([1, ...ids, earlier]);
  for (const category of ["constraint", ...categories]) {
    expect(all).toContain(`[${category}/project]`);
    expect(all).not.toContain(`<${category}>`); // one chronological list, not category blocks
  }
  // 34c: the foreground cap is hard, and a zero remainder emits neither a clipped item nor an
  // omission-only block. Receipt accounting for compaction and worker material remains separate.
  setKnowledgeCapacity(memory, 5_000);
  expect(memory.inject(s.id)).toBe("");
  // A binding cap drops the oldest commits regardless of category; receipts grant no body visibility.
  setKnowledgeCapacity(memory, tokens(all) - 50);
  const partial = memory.inject(s.id);
  const visibleIds = [...partial.matchAll(/\[K(\d+)#/g)].map(match => Number(match[1]));
  expect(visibleIds.length).toBeGreaterThan(0);
  expect(new Set(visibleIds)).toEqual(new Set([1, ...ids, earlier].sort((a, b) => b - a).slice(0, visibleIds.length)));
  expect(partial).toContain("Receipts:"); // omitted bodies remain eligible and unacknowledged
  for (const id of ids.slice(0, 4)) expect(memory.trace(`K${id}`)).toContain(`[K${id}@${id}]`);
});

test("64c compaction is identical across scheduling records and large changed Knowledge is optional", () => {
  const s = session(), t = turn(s.id), f = noting(s.id, t.id).facts[0]!;
  const id = knowledge(s.id, f.id, "constraint", "project", "large knowledge ".repeat(2_000), time, [], true);
  setWindows(5_000, 10_000, 10_000);
  const before = memory.compact(s.id, "main", t.id);
  expect("native" in before).toBe(false);
  const revision = memory.store.getKnowledgeRevision(id, id)!;
  memory.store.db.prepare("INSERT INTO knowledge_processed(pool,revision_id,run_id) VALUES (?,?,?)")
    .run(`project:${s.projectId}`, revision.id, revision.runId);
  expect(memory.compact(s.id, "main", t.id)).toEqual(before);
});

test("compaction retains oversized raw with standard tool cuts, in its bounded views", () => {
  const { s, t } = populated(), raw = fixture.observation.repeat(1000);
  const next = turn(s.id, raw, t.id);
  memory.store.appendToolCall({ turnId: next.id, name: "Bash", input: "pwd", result: JSON.stringify({ stdout: "x".repeat(10000) }), status: "success" });
  // 20c/30: a custom replacement applies only while the bounded views fit the shared cap. This case is
  // about those views' own cuts — `E` on the user text, `R` on the result — not about delegation, so
  // it gives the enclosing envelope the room; delegation has its own tests.
  memory.config.noting.batchTokens = 100_000; memory.config.render.episodicBlockTokens = 200_000;
  const compaction = memory.compact(s.id, "main", next.id);
  expect("native" in compaction).toBe(false);
  const result = compacted(compaction);
  // 17a supersedes unbounded user Raw: both excerpts retain head, omission count and tail.
  expect(result).not.toContain(raw); expect(result).toMatch(/\[\.\.\. \d+ characters truncated\]/);
  expect(result).toContain(raw.slice(0, 40)); expect(result).toContain(raw.slice(-40));
  expect(calls).toBe(0);
});

test("compaction uses supplied ancestry and newest facts fit before older facts", () => {
  const { s, t } = populated();
  const abandoned = turn(s.id, "abandoned raw", t.id), selected = turn(s.id, "selected raw", t.id);
  const precise = compacted(memory.compact(s.id, "main", selected.id));
  expect(precise).toContain("selected raw"); expect(precise).not.toContain("abandoned raw");
  // 17a: an omitted head resolves one path, never a union of sibling queues.
  expect(compacted(memory.compact(s.id))).not.toContain("abandoned raw");
  const n = noting(s.id, selected.id, fixture.interpretation);
  // Both exact sources are covered while Raw is supplied; exclude Raw to exercise the independent Fact window.
  Object.assign(memory.config.compaction, { rawTokens: 0, sharedAllowanceTokens: 0 });
  const whole = memory.compact(s.id, "main", selected.id);
  const full = compacted(whole);
  expect(full.indexOf("[F1]")).toBeLessThan(full.indexOf(`[F${n.facts[0]!.id}]`)); // chronological presentation
  // 92: facts are chosen newest-first within their independent base. A tight facts window keeps
  // the newest and receipts the older, regardless of historical C processing.
  const windows = charged(whole);
  Object.assign(memory.config.compaction, { factsTokens: Math.ceil(windows.facts * 0.7), sharedAllowanceTokens: 0 });
  const limited = compacted(memory.compact(s.id, "main", selected.id));
  expect(limited).toContain(`[F${n.facts[0]!.id}]`); expect(limited).not.toContain("[F1]");
  defaultWindows();
  expect(memory.store.getTurn(abandoned.id)).not.toBeNull();
});

// ---- Frozen bounded views: capacity truncates material without starting extraction (73/92). ----

test("20c/92: pending Raw and historical facts fit their independent windows without starting a worker or changing progress", () => {
  const { s, t } = populated();
  const selected = turn(s.id, "selected raw", t.id);
  const second = noting(s.id, t.id, fixture.interpretation).facts[0]!; // a newer fact on an already-processed turn
  const pending = hydrate(memory.pendingEntries(s.id, "main", selected.id), memory.store);
  const runsBefore = memory.store.listRuns(s.id).length;
  const result = memory.compact(s.id, "main", selected.id);
  expect("native" in result).toBe(false);
  const text = compacted(result);
  // Every pending entry is present in its normal shared view, and both historical facts fit beside them.
  for (const entry of pending) expect(text).toContain(renderEntry(entry, memory.config.render).content);
  expect(text).not.toContain(`[F${second.id}]`); expect(text).not.toContain("[F1]"); // Raw fully covers their bound sources
  expect(text).not.toContain("compact-only");
  // Reading a snapshot is not extraction: no model call, no run, no progress, no claim.
  expect(calls).toBe(0);
  expect(memory.store.listRuns(s.id)).toHaveLength(runsBefore);
  expect(hydrate(memory.pendingEntries(s.id, "main", selected.id), memory.store).map(e => e.id)).toEqual(pending.map(e => e.id));
  // Exclude Raw for this independent Fact-window measurement: source coverage is then absent.
  Object.assign(memory.config.compaction, { rawTokens: 0, sharedAllowanceTokens: 0 });
  const factWhole = memory.compact(s.id, "main", selected.id);
  if ("native" in factWhole) throw new Error(factWhole.reason);
  expect(factWhole.supplied.factIds).toEqual([second.id, 1]); // selection newest-first; rendering remains chronological
  const windows = charged(factWhole);
  expect(windows.facts).toBeGreaterThan(0);
  Object.assign(memory.config.compaction, { factsTokens: Math.ceil(windows.facts * 0.8) });
  const limited = compacted(memory.compact(s.id, "main", selected.id));
  expect(limited).toContain(`[F${second.id}]`); expect(limited).not.toContain("[F1]");
  expect(limited).toContain("omitted 1 older facts; expand: F1");
  expect(limited.indexOf("Receipts:")).toBeGreaterThan(limited.indexOf("</episodic>"));
  defaultWindows();
});

test("20c/23 scenario 10, rescaled by 73: one bounded view of every entry under the ordinary Raw title, and an envelope it cannot meet truncates instead of delegating", () => {
  const { s, t } = populated();
  const body = "word ".repeat(12_000);
  // Three long prompts: each entry view is worth at most `render.entryTokens` (2,000 since 30), so
  // the two ahead of the inspected turn are ordinary pending entries and every one of them is cut.
  let parent = t.id;
  for (const i of [1, 2]) parent = turn(s.id, `FILLER_${i} ${body}`, parent).id;
  const next = turn(s.id, `USER_HEAD ${body} USER_TAIL`, parent);
  memory.store.appendToolCall({ turnId: next.id, name: "Bash", input: JSON.stringify({ command: "SECRET_ARGUMENT" }),
    result: JSON.stringify({ stdout: "SECRET_RESULT " + "x".repeat(4_000) }), status: "success" });
  const pending = hydrate(memory.pendingEntries(s.id, "main", next.id), memory.store);
  const result = memory.compact(s.id, "main", next.id);
  expect("native" in result).toBe(false);
  const text = compacted(result);
  // One view, one title: the tier-2 block title 23 introduced is gone with the tier itself (30).
  expect(text).toContain("\nRaw:\n");
  expect(text).not.toContain("tier-2 entry views");
  // Every selected entry is represented, in order, by the addresses its labels carry; native identity
  // stays in storage and in the run audit, never in the model-facing text.
  for (const entry of pending) {
    const view = renderEntry(entry, memory.config.render, memory.resultText).content;
    expect(text).toContain(view);
    expect(tokens(view)).toBeLessThanOrEqual(memory.config.render.entryTokens);
  }
  expect(text).not.toContain(`[entry ${JSON.stringify([pending[0]!.nativeLineage, pending[0]!.nativeId])}]`);
  const own = pending.filter(entry => entry.turnId === next.id);
  const call = own.find(entry => entry.role === "assistant" && entry.calls.length)!;
  const resultEntry = own.find(entry => entry.role === "toolResult")!;
  expect(text.indexOf(`[T${next.id}#E1@user] user:`)).toBeLessThan(text.indexOf(`[T${next.id}#E${call.entryOrdinal}@`));
  // Tool identity and status remain, and so does what `C` and `R` can hold of the payload.
  expect(text).toContain(`[T${next.id}#E${call.entryOrdinal}@assistant] Bash(command="SECRET_ARGUMENT")`);
  expect(text).toContain(`[T${next.id}#E${resultEntry.entryOrdinal}@observation] Bash success: `);
  expect(text).toContain("SECRET_RESULT"); expect(text).not.toContain("x".repeat(4_000));
  // User text is excerpted, and the omission is marked in the one wording every view uses.
  expect(text).toContain("USER_HEAD"); expect(text).not.toContain(body);
  expect(text).toMatch(/\[\.\.\. \d+ characters truncated\]/);
  // Deterministic local work: the same snapshot renders the same bytes, and no model was called.
  expect(compacted(memory.compact(s.id, "main", next.id))).toBe(text);
  expect(calls).toBe(0);
  // 73: there is no fallback any more (30's delegation is gone). An envelope these views cannot meet
  // is truncated instead — the newest contiguous span kept, the rest omitted and receipted, with
  // nothing hidden to force a success and nothing processed or erased in the store.
  setWindows(100, 200, 200);
  const delegated = memory.compact(s.id, "main", next.id);
  expect("native" in delegated).toBe(false);
  if ("native" in delegated) throw new Error("unreachable");
  expect(delegated.truncated?.raw).toBeTruthy();
  expect(compacted(delegated)).toContain("earlier entries omitted from the Raw window");
  expect(hydrate(memory.pendingEntries(s.id, "main", next.id), memory.store).map(e => e.id)).toEqual(pending.map(e => e.id));
  defaultWindows();
  // The stored evidence is untouched by any of it: `full` still renders it uncut, and the assembled
  // read without `full` (23b) is the same bounded view of the same entry, cut where the budgets bite.
  expect(wholeTrace(memory, `T${next.id}#E1`, { full: true })).toContain(body);
  expect(memory.trace(`T${next.id}#E1`)).toContain("USER_HEAD");
  const full = wholeTrace(memory, `T${next.id}`, { full: true });
  expect(full).toContain("SECRET_ARGUMENT");
  expect(full).toContain("SECRET_RESULT");
});

/** 25c amended this acceptance on its own terms — its thresholds moved from `noting.batchTokens` to
 * the shared envelope, because compaction no longer applies the Noter's batch ceiling to a foreground
 * backlog (parent amendment 3) — 30 amended it again (there is no second rendering to escalate to, so
 * a backlog the one bounded view cannot fit delegates to native compaction, and the tighter `E` of
 * 2,000 keeps long replies inside the envelope), and 28a makes that envelope the sum of the three
 * windows: Raw over its own 10,000-token baseline borrows the knowledge and facts allowance nothing
 * else is using, which is exactly the lending this acceptance now exercises. */
test("23 conversation-dense acceptance, rescaled by 73: a dozen long replies fit, four dozen truncate to the newest span, eight three times as long still fit under E", () => {
  const dense = (count: number, words: number) => {
    const s = session();
    let parent: number | undefined;
    for (let i = 0; i < count; i++) {
      const t = turn(s.id, `Question ${i}: ` + "word ".repeat(30), parent);
      memory.store.updateTurn(t.id, { assistantText: `Answer ${i}: ` + "word ".repeat(words) });
      parent = t.id;
    }
    return { s, parent: parent! };
  };
  const view = (entry: Parameters<typeof renderEntry>[0]) => renderEntry(entry, memory.config.render, memory.resultText).content;
  const total = (views: string[]) => tokens(views.join("\n\n"));
  const capacity = memory.knowledgeBudgets().injection + memory.config.compaction.factsTokens + memory.config.compaction.rawTokens
    + memory.config.compaction.sharedAllowanceTokens;
  // Long replies with few tool calls: the shape the retired compact-only view handled.
  const dozen = dense(12, 1_000);
  memory.store.appendToolCall({ turnId: dozen.parent, name: "bash", input: JSON.stringify({ command: "npm test" }), result: "ok", status: "success" });
  const pending = hydrate(memory.pendingEntries(dozen.s.id, "main", dozen.parent), memory.store);
  const fits = total(pending.map(view));
  // Above the Noter's batch ceiling and below the shared envelope: before 25c the inner cap escalated
  // this; the one view keeps every entry, and the ordinary Raw title is the only one there is.
  expect(fits).toBeGreaterThan(memory.config.noting.batchTokens);
  expect(fits).toBeLessThan(capacity);
  const kept = memory.compact(dozen.s.id, "main", dozen.parent);
  expect("native" in kept).toBe(false);
  for (const entry of pending) expect(compacted(kept)).toContain(view(entry));
  expect(compacted(kept)).toContain("\nRaw:\n");
  // Four times the backlog is over the envelope even in the one view (73: no fallback any more) —
  // compact keeps the newest contiguous Raw span that fits base plus allowance, omits the rest with a
  // receipt, and starts no recovery worker (the recovery machinery itself is gone).
  const many = dense(48, 1_000);
  memory.store.appendToolCall({ turnId: many.parent, name: "bash", input: JSON.stringify({ command: "npm test" }), result: "ok", status: "success" });
  const overflowing = hydrate(memory.pendingEntries(many.s.id, "main", many.parent), memory.store);
  expect(total(overflowing.map(view))).toBeGreaterThan(capacity);
  const result = memory.compact(many.s.id, "main", many.parent);
  expect("native" in result).toBe(false);
  if ("native" in result) throw new Error("unreachable");
  expect(result.truncated?.raw).toBeTruthy();
  expect(compacted(result)).toContain("earlier entries omitted from the Raw window");
  expect(compacted(result)).toContain(view(overflowing.at(-1)!)); // the newest entry survives the cut
  expect(hydrate(memory.pendingEntries(many.s.id, "main", many.parent), memory.store).map(e => e.id)).toEqual(overflowing.map(e => e.id));
  expect(calls).toBe(0);
  // Eight replies three times as long: each is over `E` on its own, so each is cut to it, and the
  // backlog that needed the tier-2 profile before 30 now fits the one view.
  const longer = dense(8, 3_000);
  const longEntries = hydrate(memory.pendingEntries(longer.s.id, "main", longer.parent), memory.store);
  expect(longEntries.some(e => tokens(view(e)) === memory.config.render.entryTokens)).toBe(true);
  expect(total(longEntries.map(view))).toBeLessThan(capacity);
  const fewer = memory.compact(longer.s.id, "main", longer.parent);
  expect("native" in fewer).toBe(false);
  for (const entry of longEntries) expect(compacted(fewer)).toContain(view(entry));
});

test("73: when the bounded views miss the Raw window compact truncates to the newest span and changes nothing in the store", () => {
  const { s, t } = populated();
  let parent = t.id;
  for (let i = 0; i < 40; i++) parent = turn(s.id, `entry ${i}`, parent).id;
  const pending = hydrate(memory.pendingEntries(s.id, "main", parent), memory.store).map(e => e.id);
  expect(pending.length).toBeGreaterThanOrEqual(40);
  // Many tiny entries: their identities and labels alone exceed the whole Raw window.
  setWindows(100, 50, 50);
  const outer = memory.compact(s.id, "main", parent);
  expect("native" in outer).toBe(false);
  if ("native" in outer) throw new Error("unreachable");
  expect(outer.truncated?.raw).toBeTruthy();
  expect(compacted(outer)).toContain("earlier entries omitted from the Raw window");
  // 25c: there is no second cap to miss any more. The Noter's batch ceiling is not compact's knob —
  // shrinking it to fifty tokens neither truncates this snapshot nor appears in any receipt — so the
  // three windows and the shared allowance are the only budgets that can bite.
  defaultWindows(); memory.config.noting.batchTokens = 50;
  const inner = memory.compact(s.id, "main", parent);
  expect("native" in inner).toBe(false);
  if ("native" in inner) throw new Error("unreachable");
  expect(compacted(inner)).not.toContain("raw ceiling");
  expect(inner.truncated).toBeUndefined();
  for (const id of pending) expect(compacted(inner)).toContain(`T${hydrate(memory.store.listSourceEntries(s.id), memory.store).find(e => e.id === id)!.turnId}#`);
  setWindows(100, 50, 50);
  const named = memory.compact(s.id, "main", parent);
  expect("native" in named).toBe(false);
  if ("native" in named) throw new Error("unreachable");
  expect(compacted(named)).not.toContain("raw ceiling");
  // Truncation is a receipt, not a summary: nothing was read differently, processed or erased.
  expect(hydrate(memory.pendingEntries(s.id, "main", parent), memory.store).map(e => e.id)).toEqual(pending);
  expect(memory.trace(`T${parent}#E1@user`)).toContain("entry 39");
  expect(calls).toBe(0);
});

// ---- Independent fact/Raw bases plus Knowledge-first shared allowance (92). ----

test("64c/92: the independent facts window bounds history while Knowledge and Raw retain their own budgets", () => {
  setKnowledgeCapacity(memory, 3);
  const { s, t } = populated();
  // Large fact bodies make the independent facts window's whole-item cutoff observable.
  // These facts have no C processing marks; C state no longer controls fact selection.
  for (let i = 0; i < 15; i++) noting(s.id, t.id, `history ${i} ` + "word ".repeat(800));
  const facts = memory.store.listSessionFacts(s.id);
  // Historical C processing is irrelevant to the now-independent facts window.
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store)).toHaveLength(0);
  // No pending Raw: facts fill their own window; the three windows stay inside the envelope.
  Object.assign(memory.config.compaction, { rawTokens: 0, sharedAllowanceTokens: 0 });
  const roomy = memory.compact(s.id, "main", t.id);
  const spare = compacted(roomy);
  if ("native" in roomy) throw new Error(roomy.reason);
  expect(roomy.supplied.factIds.length).toBeGreaterThan(0);
  expect(roomy.supplied.factIds.length).toBeLessThan(facts.length);
  expect(spare).toContain("older facts; expand:");
  expect(charged(roomy).facts).toBeLessThanOrEqual(10_000);
  const windows = charged(roomy);
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
  // Add ten large pending Raw views, then give Raw its measured size and explicitly shrink the
  // facts window. Raw does not take capacity from facts.
  memory.config.compaction.rawTokens = 10_000;
  for (let i = 0; i < 10; i++) memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: `big${i}`, turnId: t.id,
    role: "assistant", text: "word ".repeat(1_940), raw: "", calls: [] });
  const pending = hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store);
  expect(pending).toHaveLength(10);
  setSharedAllowance(memory, 20_000); // measure the actual pending Raw cost before isolating its window
  const measured = charged(memory.compact(s.id, "main", t.id));
  // Size Raw to its complete views, facts to its receipt alone and Knowledge to its measured body.
  // Raw and Knowledge remain, while facts are omitted because their own window cannot hold a body.
  setKnowledgeInjection(memory, Math.max(3, measured.knowledge));
  Object.assign(memory.config.compaction, { rawTokens: measured.raw, factsTokens: 80, sharedAllowanceTokens: 0 });
  const crowded = memory.compact(s.id, "main", t.id);
  expect("native" in crowded).toBe(false); // fact truncation does not delegate compaction
  const text = compacted(crowded);
  for (const entry of pending) expect(text).toContain(renderEntry(entry, memory.config.render).content);
  for (const fact of facts) expect(text).not.toContain(`[F${fact.id}]`);
  expect(text).toContain(`omitted ${facts.length} older facts; expand: F1`);
  expect(text.indexOf("Receipts:")).toBeGreaterThan(text.indexOf("</episodic>"));
  // Knowledge keeps its own baseline under that pressure: the block is still there.
  expect(text).toContain("<knowledge>");
  expect(text.indexOf("<knowledge>")).toBeLessThan(text.indexOf("<episodic>"));
  expect(memory.inject(s.id).startsWith("<knowledge>")).toBe(true);
  expect(calls).toBe(0);
  defaultWindows();
});

test("25c 2026-09-09, rescaled by 73: pending membership is processing progress inside a Turn, and truncation leaves injection alone", () => {
  const { s, t } = populated();
  const noted = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "done", turnId: t.id, role: "assistant", text: "PARTIAL_NOTED", raw: "", calls: [] });
  const open = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "open", turnId: t.id, role: "assistant", text: "PARTIAL_PENDING " + "word ".repeat(1_500), raw: "", calls: [] });
  // One Turn, two entries, one of them processed: progress is per entry, never a Turn watermark.
  const run = legacyFacts(memory.store, { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    [{ text: "PARTIAL_FACT", category: "observation", actor: "agent", sources: [
      { entry: noted, address: `T${t.id}#E${noted.entryOrdinal}` }], createdAt: time }], [noted.id]);
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).map(e => e.id)).toEqual([open.id]);
  const bounded = compacted(memory.compact(s.id, "main", t.id));
  expect(bounded).toContain("PARTIAL_PENDING");
  expect(bounded).not.toContain("PARTIAL_FACT"); // fully covered by the selected Raw source
  Object.assign(memory.config.compaction, { rawTokens: 0, sharedAllowanceTokens: 0 });
  const factOnly = memory.compact(s.id, "main", t.id);
  expect(compacted(factOnly)).toContain("PARTIAL_FACT");
  expect(charged(factOnly).facts).toBeGreaterThan(0);
  defaultWindows();
  // 28a refill (b): the already-extracted entry is not pending, and it is not excluded on that
  // account either — the spare allowance supplies recent applicable already-extracted Raw beside the
  // pending views. Membership is what `pendingEntries` says, never presence in the block.
  expect(bounded).toContain("PARTIAL_NOTED");
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).map(e => e.id)).toEqual([open.id]);
  // The identities the block carries, in the one bounded view (30), in source order.
  const membership = (text: string) => hydrate(memory.store.listSourceEntries(s.id), memory.store)
    .filter(e => text.includes(renderEntry(e, memory.config.render, memory.resultText).content)).map(e => e.id);
  expect(membership(bounded)).toEqual(hydrate(memory.store.sourcePath(s.id, "main", t.id), memory.store).map(e => e.id));
  expect(membership(bounded)).toContain(noted.id); expect(membership(bounded)).toContain(open.id);
  // 73: truncation, not delegation. The pending set does not shrink to fit in the store, and the
  // injection (Knowledge only) does not move — Raw and facts are compact's own concern.
  const injection = memory.inject(s.id);
  setWindows(200, 0, 0);
  const delegated = memory.compact(s.id, "main", t.id);
  expect("native" in delegated).toBe(false);
  if ("native" in delegated) throw new Error("unreachable");
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store).map(e => e.id)).toEqual([open.id]);
  defaultWindows();
  expect(memory.inject(s.id)).toBe(injection);
  expect(calls).toBe(0);
});

// 29d (ticket 29, "Retire automatic foreground receipt delivery") supersedes the ruling this file
// pinned as "pending delivery is exact to its run and branch, consumed once, including after later
// commits": commits create no delivery intents at all now, so exactness and single consumption have
// no subject. What survives of it is the part that was never about delivery — a run owns its facts —
// and that is asserted by the test below and by "commits leave no delivery intent behind".
test("29d: a noting commit records its facts and leaves no delivery intent behind", () => {
  const s = session(), t = turn(s.id);
  const first = noting(s.id, t.id, "first fact", "main");
  noting(s.id, t.id, "second fact", "other");
  expect(memory.inject(s.id)).not.toContain("noted");
  expect(memory.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending_deliveries'").all()).toEqual([]);
  expect(JSON.parse(memory.store.getRun(first.runId)!.response!).factIds).toEqual([first.facts[0]!.id]);
});

test("branch facts use run ownership independently of audit JSON", () => {
  const s = session(), t = turn(s.id);
  const first = noting(s.id, t.id, "noted", "main");
  const user = hydrate(memory.store.listSourceEntries(s.id, t.id), memory.store).find(entry => entry.role === "user")!;
  seedFact(memory, { sessionId: s.id, branch: "other", headTurnId: t.id }, "Manual branch fact", [{ entry: user, text: "manual" }]);
  const manual = memory.store.listRuns(s.id).at(-1)!;
  memory.store.db.exec("UPDATE run_bodies SET response = 'not JSON'"); // 79: response lives in run_bodies
  expect(memory.store.listBranchFacts(s.id, "main").map(f => f.text)).toEqual(["noted", "manual"]); // facts belong to their turn, whichever branch wrote them
  expect(memory.store.listBranchFacts(s.id, "other").map(f => f.text)).toEqual(["noted", "manual"]); // same turn, same path
  for (const run of [memory.store.getRun(first.runId)!, manual]) {
    memory.store.updateRun(run.id, { ...run, response: "{}" });
    const ids = (memory.store.db.prepare("SELECT id FROM facts WHERE run_id = ? ORDER BY id").all(run.id) as { id: number }[]).map(f => f.id);
    expect(JSON.parse(memory.store.getRun(run.id)!.response!).factIds).toEqual(ids);
  }
  const empty = memory.store.recordRun({ sessionId: s.id, kind: "manual", createdAt: time, outcome: "success", response: "{}" });
  memory.store.updateRun(empty.id, empty);
  expect(JSON.parse(memory.store.getRun(empty.id)!.response!)).toEqual({});
});

test("literal search finds facts, historical knowledge and raw across projects", () => {
  const s = session(), t = turn(s.id, "needle raw"), n = noting(s.id, t.id, "needle fact");
  const e = knowledge(s.id, n.facts[0]!.id, "goal", "project", "needle knowledge");
  expect(memory.search("needle", "facts")).toContain("[F1]"); expect(memory.search("needle", "facts")).not.toContain("[K");
  expect(memory.search("needle", "knowledge")).toContain(`[K${e}@${e}]`); expect(memory.search("needle", "knowledge")).not.toContain("[F1]");
  const all = memory.search("needle", "all", { versions: "all" }); expect(all).toContain("[F1]"); expect(all).toContain(`[K${e}@${e}]`); expect(all).toContain(`[S${s.id}/T${t.id}]`);
  expect(all.split("\n").filter((l) => l.startsWith("["))).toHaveLength(3);
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, kind: "consolidation", createdAt: time }, operations: [{
    op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId: e, baseCommit: 1, text: "replacement knowledge", category: "goal", scope: "project", supports: [1], createdAt: time }] });
  expect(memory.search("needle", "knowledge", { versions: "all" })).toContain(`[K${e}@${e}]`);
  expect(memory.search("needle", "knowledge", { versions: "all" })).not.toContain(`[K${e}@2]`);
  const other = session(), foreign = turn(other.id, "needle foreign");
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: "toolonly", result: "literal%_", status: "success" });
  const raw = memory.search("toolonly", "raw");
  expect(raw).toContain(`[S${s.id}/T${t.id}]`); expect(raw).toContain("literal substring search");
  expect(memory.search("needle foreign", "raw")).toContain(`T${foreign.id}`); // another project's raw is readable (ruling 2026-09-07)
  expect(memory.search("%_", "raw")).toContain(`[S${s.id}/T${t.id}]`);
  expect(memory.search("nohits", "all")).toContain("No hit does not mean absent.");
});

// Ticket 81: raw_fts is now a real, used index (Raw search's candidate step), not dead scaffolding --
// this pins its shadow-table shape and that nothing else under this glob, and no trigger, ever appears
// (the writers maintain the index themselves; see Store.indexRawField/reindexRawField).
test("schema has exactly raw_fts and its shadow tables under *_fts*, and no triggers", () => {
  const names = (memory.store.db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB '*_fts*'").all() as { name: string }[]).map(r => r.name).sort();
  expect(names).toEqual(["raw_fts", "raw_fts_config", "raw_fts_data", "raw_fts_docsize", "raw_fts_idx"]);
  expect(memory.store.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all()).toEqual([]);
});

test.each([
  ["美琴", "御坂美琴的电击"],
  ["pnpm", "使用pnpm而不是npm"],
  ["不要", "用 pnpm，不要 npm"],
  ["琴", "御坂美琴的电击"],
  ["用pnpm", "使用pnpm而不是npm"],
  ["core/api/read.ts", "查看core/api/read.ts文件"],
  ["%", "进度100%完成"],
  ["_", "使用snake_case命名"],
  ["\\", "路径core\\api\\read.ts"],
])("literal substring search for %s across all layers and projects keeps cursor order", (query, text) => {
  const s = session(), foreign = session();
  const expected = { facts: [] as string[], knowledge: [] as string[], raw: [] as string[] };
  for (const owner of [s, foreign]) {
    for (const content of [text, "无关内容 core/api/read.ts snakeXcase 100X coreapi", text]) {
      const t = turn(owner.id, "raw prompt");
      memory.store.appendToolCall({ turnId: t.id, name: "Bash", result: content, status: "success" });
      const f = noting(owner.id, t.id, content).facts[0]!;
      const k = knowledge(owner.id, f.id, "reference", "project", content);
      if (content.includes(query)) { // both projects: reads are unrestricted (ruling 2026-09-07)
        expected.facts.push(`[F${f.id}]`);
        expected.knowledge.push(`[K${k}@${k}]`);
        expected.raw.push(`[S${owner.id}/T${t.id}]`);
      }
    }
  }
  const search = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: 1 }).find(t => t.name === "search")!;
  for (const layer of ["facts", "knowledge", "raw", "all"] as const) {
    const wanted = layer === "all" ? [...expected.facts, ...expected.knowledge, ...expected.raw] : expected[layer];
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = memory.search(query, layer, { versions: "all", cap: 1, ...(cursor ? { cursor } : {}) });
      const addresses = [...page.matchAll(/^\[[^\]]+\]/gm)].map(m => m[0]);
      expect(addresses).toHaveLength(1);
      expect(page).toContain("literal substring search");
      found.push(...addresses);
      cursor = /cursor=(\S+)/.exec(page)?.[1];
      expect(found.length).toBeLessThanOrEqual(wanted.length);
    } while (cursor);
    expect(found).toEqual(wanted);
  }
  expect(search.description).toContain("literal substring search");
});

test("opaque cursors continue search snapshots and trace session, comma, revision and negation listings", () => {
  const { s, t, f, e } = populated();
  turn(s.id, "second turn", t.id);
  noting(s.id, t.id, fixture.base);
  const first = memory.search(fixture.base, "facts", { cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  expect(cursor).not.toContain("{"); expect(first).toContain("[F1]");
  const last = memory.search("ignored", "all", { cursor });
  expect(last).toContain("[F2]"); expect(last).not.toContain("cursor="); expect(last).toContain("No hit does not mean absent");
  expect(() => memory.trace(`cursor=${cursor}`)).toThrow("unknown or expired cursor");
    expect(() => memory.trace(`F${f.id}..`)).toThrow(/invalid public trace address/);
  for (const address of [`S${s.id}`, "mapC", `F${f.id},K${e}`, `K${e}`, `F${f.id},F2`]) {
    const full = memory.trace(address), chunks: string[] = [];
    let part = memory.trace(address, { cap: 1 });
    for (;;) {
      chunks.push(part.split("\n\nReceipts:")[0]!);
      const next = /cursor=(\S+)/.exec(part)?.[1];
      if (!next) break;
      part = memory.trace(`cursor=${next}`);
    }
    expect(chunks.join("\n")).toBe(full.split("\n\nReceipts:")[0]);
  }
  expect(() => memory.trace(`S${s.id}`, { cap: 0 })).toThrow("positive integer");
});

test("status reports attribution, counts, every watermark and last runs, and no delivery queue (29d)", () => {
  const { s, t } = populated(); noting(s.id, t.id, fixture.observation, "side");
  // A historical audit row is readable without invoking the retired stage.
  const historical = memory.store.recordRun({ kind: "consolidation", sessionId: s.id, branch: "main", createdAt: time, outcome: "success" });
  const status = memory.status(s.id);
  expect(status).not.toContain("Watermark");
  expect(status).not.toContain("Pending deliveries"); // 29d: the queue-only status field went with the queue
  for (const text of ["Project: mapC (marker)", "Facts: 2 session; 2 project", "Knowledge: 1 visible active", "Last noting: run 3 success", `Last consolidation: run ${historical.id} success`, "Last dreaming: none"]) expect(status).toContain(text);
});

test("project mark merges an undeclared own project, relabels facts and knowledge, and beats later marker reports", () => {
  const s = session(undefined, "undeclared"), t = turn(s.id), n = noting(s.id, t.id), f = n.facts[0]!;
  const e = knowledge(s.id, f.id), own = knowledge(s.id, f.id, "open", "session");
  const selected = { sessionId: s.id, branch: "main", headTurnId: t.id };
  expect(memory.declareProject(s.id, "declared", "mark", selected)).toContain("declared (mark)");
  const project = memory.store.findProjectByName("declared")!;
  expect(memory.store.getProject(s.projectId)!.mergedInto).toBe(project.id);
  expect(memory.store.listProjectFacts(project.id).map((f) => f.id)).toEqual([f.id]);
  expect(memory.store.getKnowledge(e)!.projectId).toBe(project.id);
  const peer = session(project.id);
  expect(memory.inject(peer.id)).toContain(`[K${e}#${memory.store.versionTag(e, e)}]`); expect(memory.inject(peer.id)).not.toContain(`[K${own}#`);
  memory.declareProject(s.id, "ignored marker", "marker");
  expect(memory.store.getSession(s.id)!.projectId).toBe(project.id);
  expect(memory.store.findProjectByName("ignored marker")).toBeNull();
  memory.declareProject(s.id, "next", "mark", selected);
  expect(memory.store.getSession(peer.id)!.projectId).toBe(project.id);
  expect(memory.store.getProject(project.id)!.mergedInto).toBeNull();
  expect(memory.inject(s.id)).toContain(`[K${own}#${memory.store.versionTag(own, own)}]`);
});

test("listing line caps still apply with an explicit large search token budget", () => {
  const s = session(), t = turn(s.id);
  const user = hydrate(memory.store.listSourceEntries(s.id, t.id), memory.store).find(entry => entry.role === "user")!;
  const result = legacyFacts(memory.store, { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    Array.from({ length: 101 }, (_, i) => ({ text: `needle ${i}`, category: "observation" as const,
      actor: "user" as const, sources: [{ entry: user, address: `T${t.id}#E${user.entryOrdinal}` }], createdAt: time })));
  expect(result.facts).toHaveLength(101);
  const first = memory.search("needle", "all", { maxTokens: 8000 });
  expect(first.split("\n").filter((l) => l.startsWith("[F"))).toHaveLength(100);
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  noting(s.id, t.id, "needle added later");
  const last = memory.search("", "all", { cursor });
  expect(last).toContain("[F101]"); expect(last).not.toContain("[F102]");
  expect(last).not.toContain("cursor=");
});

test("first-prompt injection by project needs no session: global and project knowledge", () => {
  const { s, f } = populated();
  const p = memory.store.getSession(s.id)!.projectId;
  knowledge(s.id, f.id, "constraint", "session", "session-only");
  const byProject = memory.inject({ projectId: p });
  const bySession = memory.inject(s.id);
  expect(byProject).toContain("[K1#");
  expect(byProject).not.toContain("session-only");
  expect(bySession).toContain("session-only");
  expect(() => memory.inject({ projectId: 999 })).toThrow("does not exist");
});

test("search marks historical, merged and archived knowledge hits so they do not read like current rules", async () => {
  const s = session(), t = turn(s.id, "rule raw"), n = noting(s.id, t.id, "pnpm rule fact");
  const a = knowledge(s.id, n.facts[0]!.id, "constraint", "project", "Use pnpm for installs");
  const b = knowledge(s.id, n.facts[0]!.id, "constraint", "project", "pnpm is the package manager");
  const c = knowledge(s.id, n.facts[0]!.id, "constraint", "project", "pnpm lockfile is committed");
  const selectedEntries = hydrate(memory.store.listSourceEntries(s.id, t.id), memory.store);
  memory.selectEntries(s.id, "main", selectedEntries.map(entry => entry.id));
  const path = { sessionId: s.id, branch: "main", headTurnId: t.id, triggerEntryId: selectedEntries.at(-1)!.id };
  const trigger1 = createDreamerTrigger(memory, path, n.facts[0]!.id, 1);
  let updated!: { knowledgeId: number; commit: number }, merged!: { knowledgeId: number; commit: number };
  const maintained = await admittedScenarios.run(memory, path, input => {
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    const tag = (id: number, commit: number) => `K${id}#${memory.store.versionTag(id, commit)}`;
    for (const address of [tag(a, 1), tag(b, b), tag(c, c), tag(trigger1.knowledgeId, trigger1.commit)]) trace.execute({ address, itemBudget: null });
    const receipt = JSON.parse(write.execute({ operations: [
      { op: "update", id: tag(a, 1), topics: [], reason: "Substantive correction of the recorded conclusion.", text: "Use npm for installs", category: "constraint", scope: "project", supports: ["F1"] },
      { op: "merge", id: tag(b, b), absorb: [tag(c, c)], topics: [], reason: "Merged duplicate knowledge into the survivor.", text: "pnpm is the package manager and its lockfile is committed", category: "constraint", scope: "project", supports: ["F1"] },
      { op: "archive", kind: "budget", id: tag(trigger1.knowledgeId, trigger1.commit), supports: ["F1"], reason: "Retire the explicit fixture trigger." },
    ], skipped: [] }));
    expect(receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === a)!.version).toBe(`K${a}@v2`);
    expect(receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === b)!.version).toBe(`K${b}@v2`);
    updated = { knowledgeId: a, commit: memory.store.resolveVersionOrdinal(a, 2) };
    merged = { knowledgeId: b, commit: memory.store.resolveVersionOrdinal(b, 2) };
    return { outcome: "success", output: "maintenance complete", request: { fixture: "history statuses", trigger: trigger1 } };
  });
  expect(maintained.outcome, JSON.stringify(maintained)).toBe("success");
  const trigger2 = createDreamerTrigger(memory, path, n.facts[0]!.id, 2);
  const retired = await admittedScenarios.run(memory, path, input => {
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    const tag = (id: number, commit: number) => `K${id}#${memory.store.versionTag(id, commit)}`;
    trace.execute({ address: tag(b, merged.commit), itemBudget: null });
    trace.execute({ address: tag(trigger2.knowledgeId, trigger2.commit), itemBudget: null });
    write.execute({ operations: [
      { op: "archive", kind: "budget", id: tag(b, merged.commit), supports: ["F1"], reason: "Retired: the cited evidence withdraws this conclusion." },
      { op: "archive", kind: "budget", id: tag(trigger2.knowledgeId, trigger2.commit), supports: ["F1"], reason: "Retire the explicit fixture trigger." },
    ], skipped: [] });
    return { outcome: "success", output: "maintenance complete", request: { fixture: "archive merged result", trigger: trigger2 } };
  });
  expect(retired.outcome, JSON.stringify(retired)).toBe("success");
  const hits = memory.search("pnpm", "knowledge", { versions: "all", fields: ["text", "status"] });
  expect(hits).toContain(`[K${a}@1]`); expect(hits).toContain(`status: superseded by K${a}@${updated.commit}`);
  expect(hits.split("\n").find(l => l.startsWith(`[K${c}@3]`))).toContain("status: archived");
  expect(hits).toContain("status: archived");
  const current = memory.search("for installs", "knowledge", { versions: "all", fields: ["text", "status"] }).split("\n").find((l) => l.startsWith(`[K${a}@${updated.commit}]`))!;
  expect(current).toContain("status: tip"); // unbound reads label tips without claiming current
});

test("reads resolve any existing address: another session's history, current revision, and a missing revision is rejected as missing", async () => {
  const s = session(), t = turn(s.id, "scope raw"), n = noting(s.id, t.id, "scoped fact");
  const k = knowledge(s.id, n.facts[0]!.id, "goal", "project", "shared-then-private goal");
  const selectedEntries = hydrate(memory.store.listSourceEntries(s.id, t.id), memory.store);
  memory.selectEntries(s.id, "main", selectedEntries.map(entry => entry.id));
  const path = { sessionId: s.id, branch: "main", headTurnId: t.id, triggerEntryId: selectedEntries.at(-1)!.id };
  const trigger = createDreamerTrigger(memory, path, n.facts[0]!.id, 1);
  let privateRevision!: { knowledgeId: number; commit: number };
  const scoped = await admittedScenarios.run(memory, path, input => {
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    const tag = (id: number, commit: number) => `K${id}#${memory.store.versionTag(id, commit)}`;
    trace.execute({ address: tag(k, 1), itemBudget: null });
    trace.execute({ address: tag(trigger.knowledgeId, trigger.commit), itemBudget: null });
    const receipt = JSON.parse(write.execute({ operations: [
      { op: "update", id: tag(k, 1), topics: [], reason: "Substantive correction of the recorded conclusion.", text: "private goal now",
        category: "goal", scope: "session", supports: ["F1"] },
      { op: "archive", kind: "budget", id: tag(trigger.knowledgeId, trigger.commit), supports: ["F1"], reason: "Retire the explicit fixture trigger." },
    ], skipped: [] }));
    expect(receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === k)!.version).toBe(`K${k}@v2`);
    privateRevision = { knowledgeId: k, commit: memory.store.resolveVersionOrdinal(k, 2) };
    return { outcome: "success", output: "maintenance complete", request: { fixture: "cross-session history", trigger } };
  });
  expect(scoped.outcome, JSON.stringify(scoped)).toBe("success");
  const peer = session(memory.store.getSession(s.id)!.projectId), pt = turn(peer.id, "peer raw");
  memory.store.updateTurn(pt.id, { assistantText: "ok" });
  const trace = memory.tools({ kind: "manual", sessionId: peer.id, branch: "main", currentTurnId: pt.id }).find((d) => d.name === "trace")!;
  expect(memory.search("shared-then-private", "knowledge", { sessionId: peer.id })).not.toContain(`[K${k}@`);
  expect(trace.execute({ address: `K${k}@v1` })).toContain("shared-then-private goal");
  expect(trace.execute({ address: `K${k}` })).not.toContain("shared-then-private goal");
  expect(trace.execute({ address: `K${k}@v2` })).toContain("private goal now");
  expect(trace.execute({ address: `K${k}@v999` })).toContain(`unknown knowledge history K${k}@v999`);
});

// ---- 21b 2026-09-08: topic grouping and literal label retrieval ----

test("21b 2026-09-08: one topic spans categories, one commit joins two groups, and a label absent from the text finds that commit once", () => {
  const { s, f, e } = populated();
  const a = knowledge(s.id, f.id, "constraint", "project", "The extractor keeps every raw entry", time, ["extraction", "database"]);
  const b = knowledge(s.id, f.id, "understanding", "project", "One row per entry, written in the same transaction", time, ["database"]);
  const c = knowledge(s.id, f.id, "understanding", "project", "An entry is one native message", time);
  const groups = memory.topicGroups(s.id);
  // One subject holds knowledge of two categories; the groups reference the exact commits.
  expect(groups.topics).toEqual([
    { topic: "database", commits: [{ knowledgeId: a, commit: a }, { knowledgeId: b, commit: b }] },
    { topic: "extraction", commits: [{ knowledgeId: a, commit: a }] }]);
  expect(groups.unclassified).toEqual([{ knowledgeId: e, commit: e }, { knowledgeId: c, commit: c }]);
  // Sharing a label merges no identity and clones no record: both groups name the same K@commit.
  expect(memory.store.getKnowledge(a)!.id).not.toBe(memory.store.getKnowledge(b)!.id);
  expect(memory.store.listKnowledgeRevisions(a)).toHaveLength(1);
  // The label is absent from every conclusion, and the hit is one line per exact commit.
  for (const id of [a, b]) expect(memory.store.getKnowledgeRevision(id, id)!.text).not.toContain("database");
  const hits = memory.search("database", "knowledge").split("\n").filter(l => l.startsWith("[K"));
  expect(hits).toHaveLength(2);
  // Several labels, or text and labels together, still return one result per commit.
  const d = knowledge(s.id, f.id, "reference", "project", "The database schema lives in core/store", time, ["database", "database design"]);
  const again = memory.search("database", "knowledge").split("\n").filter(l => l.startsWith("[K"));
  expect(again).toHaveLength(3);
  expect(again.filter(l => l.startsWith(`[K${d}@${d}]`))).toHaveLength(1);
});

test("21b 2026-09-08: labels match literally, never as JSON syntax, and empty topics hide nothing", () => {
  const { s, f } = populated();
  const labelled = knowledge(s.id, f.id, "goal", "project", "带标签的结论", time,
    ["禁书目录", "read path", "100%_done", 'say "hi"', "core\\store"]);
  const plain = knowledge(s.id, f.id, "open", "project", "unlabelled but searchable", time);
  for (const query of ["禁书目录", "read path", "100%_done", '"hi"', "core\\store"]) {
    expect(memory.search(query, "knowledge")).toContain(`[K${labelled}@${labelled}]`);
  }
  // The serialized JSON around the labels is not searchable content: neither its punctuation nor its escapes.
  for (const query of ['", "', '["', '\\"hi\\"', '","']) expect(memory.search(query, "knowledge")).not.toContain("[K");
  // A percent or underscore is a literal character here, exactly as in text search.
  expect(memory.search("100%", "knowledge")).toContain(`[K${labelled}@`);
  expect(memory.search("100X_done", "knowledge")).not.toContain("[K");
  expect(memory.search("unlabelled but searchable", "knowledge")).toContain(`[K${plain}@${plain}]`);
});

// ---- Shared allowance, independent facts and processed-Raw refill (92). ----

/** Facts of one Turn, without advancing Raw progress or creating C processing marks. */
function pendingFacts(sessionId: number, turnId: number, texts: string[], branch = "main") {
  const user = hydrate(memory.store.listSourceEntries(sessionId, turnId), memory.store).find(entry => entry.role === "user")!;
  return legacyFacts(memory.store, { sessionId, branch, kind: "noting", createdAt: time },
    texts.map(text => ({ text, category: "observation" as const, actor: "user" as const,
      sources: [{ entry: user, address: `T${turnId}#E${user.entryOrdinal}` }], createdAt: time })), []).facts;
}
const entry = (sessionId: number, turnId: number, nativeId: string, text: string) =>
  memory.appendEntry({ sessionId, nativeLineage: "x", nativeId, turnId, role: "assistant", text, raw: "", calls: [] });

test("92: knowledge and Raw share the allowance, but facts are independently capped at 10k", () => {
  const s = session(), t = turn(s.id, "head");
  const seed = pendingFacts(s.id, t.id, ["seed"])[0]!;
  for (let i = 0; i < 9; i++) for (let part = 0; part < 2; part++)
    knowledge(s.id, seed.id, "constraint", "project", `K${i} part ${part} ` + "word ".repeat(970), `202${i}`);
  const facts = pendingFacts(s.id, t.id, [...Array(14)].map((_, i) => `FACT_${i} ` + "word ".repeat(990)));
  for (let i = 0; i < 3; i++) entry(s.id, t.id, `raw${i}`, `RAW_${i} ` + "word ".repeat(1_940));
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result).toBe(false); // 38k of demand inside the 50k envelope
  const windows = charged(result), text = compacted(result);
  // The historical 14k fact corpus is no longer permitted to borrow shared allowance.
  expect(windows.facts).toBeLessThanOrEqual(10_000);
  expect(text).toContain("older facts; expand:");
  expect(windows.knowledge).toBeGreaterThan(17_000);
  expect(windows.raw).toBeGreaterThan(5_000);
  expect(windows.envelope).toBe(50_000);
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
  expect(facts.some(fact => text.includes(`[F${fact.id}]`))).toBe(true);
  expect(facts.some(fact => !text.includes(`[F${fact.id}]`))).toBe(true);
  for (let i = 0; i < 3; i++) expect(text).toContain(`RAW_${i}`);
  for (let i = 0; i < 9; i++) expect(text).toContain(`K${i} `);
  expect(calls).toBe(0);
});

test("73: knowledge borrows the shared allowance first, even when it leaves pending Raw to truncate", () => {
  setSharedAllowance(memory, 15_000);
  const s = session(), t = turn(s.id, "head");
  const seed = pendingFacts(s.id, t.id, ["seed"])[0]!;
  // A knowledge corpus far past its own window (borrows and still overflows), 7k of pending facts
  // (fits its own base) and enough pending Raw that its base alone cannot hold it.
  for (let i = 0; i < 20; i++) for (let part = 0; part < 2; part++)
    knowledge(s.id, seed.id, "constraint", "project", `K${i} part ${part} ` + "word ".repeat(970), `20${10 + i}`);
  const facts = pendingFacts(s.id, t.id, [...Array(7)].map((_, i) => `FACT_${i} ` + "word ".repeat(990)));
  for (let i = 0; i < 6; i++) entry(s.id, t.id, `raw${i}`, `RAW_${i} ` + "word ".repeat(1_940));
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result).toBe(false);
  if ("native" in result) throw new Error("unreachable");
  const windows = charged(result), text = compacted(result);
  const base = memory.knowledgeBudgets().injection, allowance = memory.config.compaction.sharedAllowanceTokens;
  // Knowledge takes the whole allowance before Raw or facts see any of it, and still truncates the
  // oldest items past base plus allowance.
  expect(windows.knowledge).toBeGreaterThan(base);
  expect(windows.knowledge).toBeLessThanOrEqual(base + allowance);
  expect(text).toContain("knowledge; expand: K");
  // Facts fit inside their own base with nothing left to borrow.
  for (const fact of facts) expect(text).toContain(`[F${fact.id}]`);
  // Raw cannot borrow what knowledge already took, so it truncates to its own base — the newest
  // pending entries survive, the oldest are omitted and receipted, and the omission is reported.
  expect(windows.raw).toBeLessThanOrEqual(memory.config.compaction.rawTokens);
  expect(text).toContain("earlier entries omitted from the Raw window");
  expect(result.truncated?.raw).toBeTruthy();
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
  expect(hydrate(memory.pendingEntries(s.id, "main", t.id), memory.store)).toHaveLength(7); // nothing was processed or erased
  expect(calls).toBe(0);
});

test("28a/30/92: facts and Raw refill stay whole, recent, path-applicable and deduplicated within independent windows", () => {
  const s = session(), t = turn(s.id, "head");
  const sibling = turn(s.id, "sibling", t.id), selected = turn(s.id, "selected", t.id);
  // Padding gives the refill candidates a size the tight-window case below can reliably exclude,
  // while the substrings the assertions look for stay intact.
  const pad = "word ".repeat(500);
  // Facts on the selected path and a sibling; none is marked as processed by C.
  const history = pendingFacts(s.id, t.id, [`HISTORY_OLD ${pad}`, `HISTORY_NEW ${pad}`]);
  const elsewhere = pendingFacts(s.id, sibling.id, [`SIBLING_HISTORY ${pad}`], "sibling");
  const pending = pendingFacts(s.id, selected.id, ["PENDING_FACT"])[0]!;
  // Raw refill candidates: already-extracted path entries, including Turn prompts.
  entry(s.id, t.id, "old", `EXTRACTED_OLD ${pad}`);
  const newer = entry(s.id, t.id, "new", `EXTRACTED_NEW ${pad}`);
  const run = memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    facts: [], entryIds: hydrate(memory.store.sourcePath(s.id, "main", selected.id), memory.store).map(e => e.id) });
  expect(run.ok).toBe(true);
  const open = entry(s.id, selected.id, "open", "STILL_PENDING");
  expect(hydrate(memory.pendingEntries(s.id, "main", selected.id), memory.store).map(e => e.id)).toEqual([open.id]);

  const result = memory.compact(s.id, "main", selected.id);
  const text = compacted(result), windows = charged(result);
  // The newest fact and pending entry fit their respective windows.
  expect(text).toContain("PENDING_FACT"); expect(text).toContain("STILL_PENDING");
  // Each selected fact appears once; the sibling fact remains outside the selected path.
  expect(text).toContain("HISTORY_OLD"); expect(text).toContain("HISTORY_NEW");
  expect(text).not.toContain("SIBLING_HISTORY");
  expect(text.match(/PENDING_FACT/g)).toHaveLength(1); // whole items, once each
  // Already-extracted Raw entries are included whole and remain in source order.
  expect(text).toContain("EXTRACTED_OLD"); expect(text).toContain("EXTRACTED_NEW");
  expect(text.indexOf("EXTRACTED_OLD")).toBeLessThan(text.indexOf("EXTRACTED_NEW"));
  expect(text.indexOf("EXTRACTED_NEW")).toBeLessThan(text.indexOf("STILL_PENDING"));
  // The carrier lists exactly what was included, pending and refilled alike, each in the one view.
  const supplied = "native" in result ? { entries: [], factIds: [] } : result.supplied;
  expect([...supplied.factIds].sort((a, b) => a - b)).toEqual([...history.map(f => f.id), pending.id].sort((a, b) => a - b));
  expect(supplied.entries.map(e => e.id)).toEqual(hydrate(memory.store.sourcePath(s.id, "main", selected.id), memory.store).map(e => e.id));
  expect(new Set(supplied.entries.map(e => e.view))).toEqual(new Set(["bounded"]));
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);

  // 30 case 10: an entry the post-compaction context retains is not supplied a second time — and an
  // entry whose only earlier visibility was the summary being discarded is NOT excluded on that
  // account, since only the pending set and the retained set exclude anything.
  const retained = memory.compact(s.id, "main", selected.id, [newer.nativeId, open.nativeId]);
  const kept = compacted(retained);
  expect(kept).not.toContain("EXTRACTED_NEW");
  expect(kept).toContain("EXTRACTED_OLD"); // an older view of it rode a discarded summary; still refilled
  expect(kept).toContain("STILL_PENDING"); // retained-original refill exclusion does not consume pending Raw
  expect("native" in retained ? [] : retained.supplied.entries.map(e => e.nativeId)).not.toContain(newer.nativeId);

  // Tight independent windows retain the newest fact and pending Raw, dropping older facts and
  // processed Raw without a worker, delegation or processing reset.
  const runsBefore = memory.store.listRuns(s.id).length;
  Object.assign(memory.config.compaction, { factsTokens: 150, rawTokens: 150, sharedAllowanceTokens: 0 });
  const tight = memory.compact(s.id, "main", selected.id);
  expect("native" in tight).toBe(false);
  const bare = compacted(tight);
  expect(bare).toContain("PENDING_FACT"); expect(bare).toContain("STILL_PENDING");
  for (const absent of ["HISTORY_OLD", "HISTORY_NEW", "EXTRACTED_OLD", "EXTRACTED_NEW"]) expect(bare).not.toContain(absent);
  expect("native" in tight ? [] : tight.supplied.factIds).toEqual([pending.id]);
  expect("native" in tight ? [] : tight.supplied.entries.map(e => e.id)).toEqual([open.id]);
  const tightWindows = charged(tight);
  expect(tightWindows.knowledge + tightWindows.facts + tightWindows.raw).toBeLessThanOrEqual(tightWindows.envelope);
  expect(memory.store.listRuns(s.id)).toHaveLength(runsBefore);
  expect(hydrate(memory.pendingEntries(s.id, "main", selected.id), memory.store).map(e => e.id)).toEqual([open.id]);
  expect(calls).toBe(0);
  defaultWindows();
});

test("28a/92: the independent facts window keeps newest whole facts and receipts older omissions", () => {
  const s = session(), t = turn(s.id, "head");
  const older = pendingFacts(s.id, t.id, ["OLDEST " + "word ".repeat(400)])[0]!;
  const newer = pendingFacts(s.id, t.id, ["NEWEST " + "word ".repeat(400)])[0]!;
  expect(newer.id).toBeGreaterThan(older.id);
  const measured = charged(memory.compact(s.id, "main", t.id));
  // Neither fact has a C processing mark. Facts never borrow; a base between one item and two
  // keeps only the newer whole body and receipts the older omission.
  Object.assign(memory.config.compaction, { factsTokens: Math.ceil(measured.facts * 0.65), sharedAllowanceTokens: 0 });
  const text = compacted(memory.compact(s.id, "main", t.id));
  expect(text).toContain("NEWEST"); expect(text).not.toContain("OLDEST");
  expect(text).toContain(`omitted 1 older facts; expand: F${older.id}`);
  defaultWindows();
});
