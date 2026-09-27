import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type CompactionEntry, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SuppliedMaterial } from "../../../src/core/api/index.ts";
import { visibleView, type ContextEntry, type VisibleBinding } from "../../../src/hosts/pi/visible.ts";
import { piSession } from "./native-fixture.ts";

// Ticket 29a, migrated from 26c's compaction-preparation cases: the baseline of a compaction is the
// compaction entry's own `details.traceMemory` (29 "Receipt and content are one carrier"), so the
// three Pi facts that still bind are re-expressed against that entry. The preparation-entry mechanism
// those cases were written for is retired (29 "Native fallback is opaque"): this host appends nothing
// of its own around a compaction, and the cases below assert that too.
//
// The Pi lines these cases pin (0.85.1 `dist/`, the installed package):
//   agent-session.js:1496-1539   manual `compact()`: hook :1497 → model call :1529 → abort check :1536 → append :1539
//   agent-session.js:1545/:1832  `session_compact`'s entry: `newEntries.find(e => e.type === "compaction" && e.summary === summary)`
//   session-manager.js:418-453   `buildContextEntries`: the selected ancestry, or
//                                `[latestCompaction, ...from firstKeptEntryId, ...after]`

const binding: VisibleBinding = { db: "/tmp/29a/trace.db", session: 1, pi: "pi-a" };
const supplied = (over: Partial<SuppliedMaterial> = {}): SuppliedMaterial => ({ entries: [], factIds: [], knowledgeCommitIds: [], ...over });
/** The view at whatever leaf is selected right now, exactly as the host computes it. */
const viewAt = (manager: SessionManager) => visibleView(manager.buildContextEntries() as ContextEntry[], binding);
const facts = (manager: SessionManager) => [...viewAt(manager).factIds].sort((a, b) => a - b);
const compactions = (manager: SessionManager) => manager.getEntries().filter(e => e.type === "compaction") as CompactionEntry[];

/** What one attempt does, scripted per case. */
type Plan = {
  /** The identities this replacement supplies; they are the baseline the compaction carries. */
  supplied: SuppliedMaterial;
  /** Tier 3: return nothing, so Pi generates its own summary through a model call. */
  decline?: boolean;
  /** The summary text tiers 1-2 return; identical text across two compactions is the first case here. */
  summary?: string;
  /** Run before returning — where a case cancels the attempt. */
  after?: () => void | Promise<void>;
};
type Record_ = { reasons: string[]; events: { id: string; summary: string }[] };
const observed = (): Record_ => ({ reasons: [], events: [] });

/** The host's carrier as a real extension: one hook result, one appended entry, no entry of its own. */
function summarizer(plan: () => Plan, record: Record_) {
  return (pi: ExtensionAPI) => {
    pi.on("session_before_compact", async (event: any) => {
      const current = plan();
      record.reasons.push(event.reason);
      await current.after?.();
      if (current.decline) return undefined;
      return { compaction: { summary: current.summary ?? "custom summary", firstKeptEntryId: "",
        tokensBefore: event.preparation.tokensBefore, details: { traceMemory: { ...binding, supplied: current.supplied } } } };
    });
    pi.on("session_compact", (event: any) => { record.events.push({ id: event.compactionEntry.id, summary: event.compactionEntry.summary }); });
  };
}

const usage = (input = 10, output = 2) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: 0 } });
const say = (text: string, tokens = usage()) => new Response(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "test",
  choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }], usage: tokens })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } });
const failed = () => new Response(JSON.stringify({ error: { message: "summary call exploded" } }), { status: 500, headers: { "content-type": "application/json" } });

test("29a case 8: two compactions with the same summary text — the session_compact event names the older one, and the view is read off the selected entry", async () => {
  const record = observed();
  let plan: Plan = { supplied: supplied({ factIds: [1] }), summary: "identical summary" };
  const f = await piSession({ extensions: [summarizer(() => plan, record)] });
  try {
    f.script(() => say("好的。"));
    await f.session.prompt("first"); await f.session.prompt("second");
    const point = f.manager.getLeafId()!;
    await f.session.compact();
    const c1 = compactions(f.manager)[0]!;
    expect(facts(f.manager)).toEqual([1]);

    // The same summary text, a different entry, a different baseline.
    f.manager.branch(point);
    plan = { supplied: supplied({ factIds: [1, 2] }), summary: "identical summary" };
    await f.session.compact();
    const c2 = compactions(f.manager).find(e => e.id !== c1.id)!;
    expect(c1.summary).toBe(c2.summary);

    // `newEntries.find(e => e.type === "compaction" && e.summary === summary)` is a first match on
    // summary text alone, so the second compaction's own event hands back the FIRST entry with that
    // text. Nothing here keys on it: the view comes from the selected context, which holds C2.
    expect(record.events.map(e => e.id)).toEqual([c1.id, c1.id]);
    expect(record.events[1]!.id).not.toBe(c2.id);
    expect((f.manager.getEntry(record.events[1]!.id) as CompactionEntry).details).toEqual(c1.details); // the wrong attempt's baseline
    expect(facts(f.manager)).toEqual([1, 2]);
    // And each compaction still carries its own, whichever one is selected.
    f.manager.branch(c1.id);
    expect(facts(f.manager)).toEqual([1]);
  } finally { f.dispose(); }
}, 30000);

test("29a case 5: a cancelled and a failed attempt append nothing and leave the earlier baseline exactly as it was", async () => {
  const record = observed();
  let plan: Plan = { supplied: supplied({ factIds: [1], knowledgeCommitIds: [11] }), summary: "first summary" };
  const f = await piSession({ extensions: [summarizer(() => plan, record)] });
  try {
    f.script(() => say("好的。"));
    await f.session.prompt("first"); await f.session.prompt("second");
    const point = f.manager.getLeafId()!;
    await f.session.compact();
    const c1 = compactions(f.manager)[0]!;
    const baseline = c1.details;
    expect(facts(f.manager)).toEqual([1]);

    // Cancelled: Pi's post-summary abort check (agent-session.js:1536-1538) throws before
    // `appendCompaction`, so the attempt's identities never reach the file.
    f.manager.branch(point);
    plan = { supplied: supplied({ factIds: [1, 2] }), summary: "cancelled summary", after: () => { f.session.abortCompaction(); } };
    await expect(f.session.compact()).rejects.toThrow(/cancel/i);
    expect(compactions(f.manager)).toHaveLength(1);
    expect(f.manager.getLeafId()).toBe(point); // nothing of ours was appended: the leaf never moved

    // Failed: declined to Pi, whose own summary call fails. Same outcome, and again no entry of ours.
    f.manager.branch(point);
    plan = { supplied: supplied({ factIds: [1, 2, 3] }), decline: true };
    f.script(() => failed());
    await expect(f.session.compact()).rejects.toThrow(/exploded|failed/i);
    expect(compactions(f.manager)).toHaveLength(1);
    expect(f.manager.getLeafId()).toBe(point);
    expect(record.reasons).toEqual(["manual", "manual", "manual"]); // all three attempts really ran the hook
    expect(f.manager.getEntries().filter(e => e.type === "custom")).toEqual([]); // 29: no preparation entries accumulate

    // The first compaction's baseline is byte-for-byte what it was, and its view is unchanged.
    expect(compactions(f.manager)[0]!.details).toEqual(baseline);
    f.manager.branch(c1.id);
    expect(facts(f.manager)).toEqual([1]);
  } finally { f.dispose(); }
}, 30000);

test("29a case 8: rewinding within a segment, across a compaction, forward again and onto a sibling each computes its own view", async () => {
  const record = observed();
  const plan: Plan = { supplied: supplied({ factIds: [4, 5], knowledgeCommitIds: [11] }), summary: "custom summary" };
  const f = await piSession({ extensions: [summarizer(() => plan, record)] });
  try {
    f.script(() => say("好的。"));
    await f.session.prompt("first");
    const early = f.manager.getLeafId()!;
    await f.session.prompt("second");
    const point = f.manager.getLeafId()!;
    await f.session.compact();
    const compaction = compactions(f.manager)[0]!;
    await f.session.prompt("third");
    const tip = f.manager.getLeafId()!;
    const after = viewAt(f.manager);
    expect([...after.factIds]).toEqual([4, 5]);
    // Post-compaction messages are ordinary retained entries; the compaction itself is not one.
    expect(after.raw.get(compaction.id)).toBeUndefined();
    expect([...after.raw.values()].every(v => v === "source")).toBe(true);
    const post = after.raw.size;

    // Rewound within the pre-compaction segment: no compaction is selected, so no baseline applies —
    // the view is the retained conversation alone, and it is not the accumulated set from the tip.
    f.manager.branch(early);
    expect(facts(f.manager)).toEqual([]);
    expect(viewAt(f.manager).raw.size).toBeGreaterThan(0);
    f.manager.branch(point);
    expect(facts(f.manager)).toEqual([]);

    // Onto the compaction entry itself: Pi returns that entry and nothing after it, and its own
    // `details` reconstruct exactly the same baseline.
    f.manager.branch(compaction.id);
    expect((f.manager.buildContextEntries()).map(e => e.id)).toEqual([compaction.id]);
    expect(facts(f.manager)).toEqual([4, 5]);
    expect(viewAt(f.manager).raw.size).toBe(0); // nothing retained here, and nothing invented

    // Forward again to the tip: the same view as before the walk.
    f.manager.branch(tip);
    expect(facts(f.manager)).toEqual([4, 5]);
    expect(viewAt(f.manager).raw.size).toBe(post);

    // A sibling of the compaction, branched from the same pre-compaction point: that path never had a
    // compaction, so it claims none of its identities.
    f.manager.branch(point);
    await f.session.prompt("sibling");
    expect(facts(f.manager)).toEqual([]);
    expect(compactions(f.manager)).toHaveLength(1); // still on the abandoned path, and still intact
  } finally { f.dispose(); }
}, 30000);
