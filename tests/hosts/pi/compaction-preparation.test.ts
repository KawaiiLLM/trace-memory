import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type CompactionEntry, type CustomEntry, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { fixture, say as sayNative } from "./native-fixture.ts";

// Ticket 26c, design revision 3 — the *preparation entry* carrier, verified against Pi 0.85.1 with a
// real `AgentSession` and a real `SessionManager`; only the wire is stubbed, so every compaction
// below is one Pi really performed and every entry one Pi really appended.
//
// The candidate: inside `session_before_compact` the host appends one custom entry of its own through
// `pi.appendEntry(customType, data)` carrying the frozen sets. Pi appends the compaction entry with
// `parentId: this.leafId` at the moment of `appendCompaction`, so the compaction becomes that entry's
// child and its baseline is found with `getEntry(parentId)` — no table, no parent-leaf key, no event id.
//
// The Pi lines these cases pin (0.85.1 `dist/`, the installed package):
//   agent-session.js:2029-2035   `ExtensionAPI.appendEntry` → `sessionManager.appendCustomEntry`, returns void
//   session-manager.js:835-849   `appendCustomEntry`: `parentId: this.leafId`, then becomes the leaf
//   session-manager.js:818-834   `appendCompaction`: `parentId: this.leafId` *at append time*
//   agent-session.js:1496-1539   manual `compact()`: hook :1497 → model call :1529 → abort check :1536 → append :1539
//   agent-session.js:1757-1826   `_runAutoCompaction()`: hook :1758 → model call :1803 → abort check :1810 → append :1826
//   agent-session.js:1545/1832   `session_compact`'s entry: `newEntries.find(e => e.type === "compaction" && e.summary === summary)`
//   session-manager.js:166-189   `sessionEntryToContextMessages`: a `custom` entry yields no message
const PREP = "trace-memory-prep";

const compactions = (manager: SessionManager) => manager.getEntries().filter(e => e.type === "compaction") as CompactionEntry[];
const custom = (manager: SessionManager, id: string) => manager.getEntry(id) as CustomEntry;

/** 26c revision 3's reading rule, as the evidence supports it: walk from the compaction's parent up
 * through consecutive `custom` entries to the nearest preparation entry of ours, and fail closed —
 * `undefined`, meaning no baseline, `omitted = ∅`, duplicates rather than loss — when any other kind
 * of entry intervenes or none is found. `custom_message` is deliberately not `custom`: it carries a
 * model-visible message (session-manager.js:177-181), so it ends the walk. */
function preparationOf(manager: SessionManager, compaction: CompactionEntry): CustomEntry | undefined {
  let at: string | null | undefined = compaction.parentId;
  while (at) {
    const entry: SessionEntry | undefined = manager.getEntry(at);
    if (!entry || entry.type !== "custom") return undefined;
    if (entry.customType === PREP) return entry as CustomEntry;
    at = entry.parentId;
  }
  return undefined;
}

/** What each case observes: the preparation entries the hook appended, the reason Pi gave for each
 * attempt, and the `session_compact` events Pi emitted afterwards. */
type Record_ = { preps: string[]; reasons: string[]; events: { id: string; summary: string }[] };
const observed = (): Record_ => ({ preps: [], reasons: [], events: [] });

/** What one attempt of the candidate does, scripted per case. */
type Plan = {
  data: unknown;
  /** Tier 3: return nothing, so Pi generates its own summary through a model call. */
  decline?: boolean;
  /** The summary text tiers 1-2 return; identical text across two compactions is obligation 6. */
  summary?: string;
  /** Run between appending the preparation entry and returning — where a case cancels the attempt. */
  after?: (prep: string) => void | Promise<void>;
};

/** The candidate carrier as a real extension. `pi.appendEntry` returns void, so the preparation
 * entry's own id is read back from the leaf it just advanced. */
function preparer(plan: () => Plan, record: Record_) {
  return (pi: ExtensionAPI) => {
    pi.on("session_before_compact", async (event: any, context: ExtensionContext) => {
      const current = plan();
      pi.appendEntry(PREP, current.data);
      const prep = context.sessionManager.getLeafId()!;
      record.preps.push(prep); record.reasons.push(event.reason);
      await current.after?.(prep);
      if (current.decline) return undefined;
      return { compaction: { summary: current.summary ?? "custom summary", firstKeptEntryId: "",
        tokensBefore: event.preparation.tokensBefore, details: { traceMemory: { v: 1, prep } } } };
    });
    pi.on("session_compact", (event: any) => { record.events.push({ id: event.compactionEntry.id, summary: event.compactionEntry.summary }); });
  };
}

/** A real Pi parent session that really runs extensions: `DefaultResourceLoader` accepts inline
 * `extensionFactories`, so `compact()` and `_runAutoCompaction()` find real handlers and a real
 * `pi.appendEntry`. Nothing here touches ~/.pi or ~/.trace-memory. */
async function piSession(options: { extensions: ((pi: ExtensionAPI) => void)[];
  compaction?: { enabled?: boolean; keepRecentTokens?: number; reserveTokens?: number }; contextWindow?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-prep-"));
  const agentDir = join(dir, "agent"); mkdirSync(agentDir, { recursive: true });
  const origin = "https://fake-prep.invalid";
  // `keepRecentTokens: 1` is what lets a tiny scripted session compact at all; `retry.enabled: false`
  // keeps a scripted failure one failure.
  const compaction = { enabled: false, keepRecentTokens: 1, reserveTokens: 1, ...options.compaction };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction }));
  const contextWindow = options.contextWindow ?? 200_000;
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { name: "Fake", baseUrl: `${origin}/v1`, apiKey: "fake-key",
    api: "openai-completions", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const sent: Record<string, any>[] = [];
  let respond: (body: Record<string, any>) => Response | Promise<Response> = () => say("Done.");
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); sent.push(body); return respond(body);
  }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const model = modelRuntime.getModel("fake", "test")!;
  const settingsManager = SettingsManager.create(dir, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: options.extensions as never });
  await resourceLoader.reload();
  const manager = SessionManager.create(dir, join(agentDir, "sessions", "parent"));
  const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir, model, modelRuntime, settingsManager,
    resourceLoader, sessionManager: manager, noTools: "all", tools: [] });
  expect(extensionsResult.errors).toEqual([]); // an inline factory that failed to load would silently drop the hooks
  return { dir, agentDir, session, manager, sent, model,
    script: (fn: (body: Record<string, any>) => Response | Promise<Response>) => { respond = fn; },
    dispose() {
      session.dispose(); vi.unstubAllGlobals();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(dir, { recursive: true, force: true });
    } };
}

const usage = (input = 10, output = 2) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: 0 } });
const say = (text: string, tokens = usage()) => new Response(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "test",
  choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }], usage: tokens })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } });
/** Pi's own summary pass, told apart from an ordinary turn by the system prompt it carries
 * (`SUMMARIZATION_SYSTEM_PROMPT`, dist/core/compaction/utils.js:139-141). */
const summaryCalls = (sent: Record<string, any>[]) => sent.filter(b => JSON.stringify(b).includes("context summarization assistant"));
const failed = () => new Response(JSON.stringify({ error: { message: "summary call exploded" } }), { status: 500, headers: { "content-type": "application/json" } });

test("26c revision 3 (a) manual /compact: the preparation entry appended inside session_before_compact is the compaction's parent, for a custom result and for a declined one", async () => {
  const record = observed();
  let plan: Plan = { data: { considered: [1] } };
  const f = await piSession({ extensions: [preparer(() => plan, record)] });
  try {
    f.script(() => say("好的。"));
    await f.session.prompt("first"); await f.session.prompt("second");
    const before = f.manager.getLeafId()!;

    // Tier 1/2: the host supplies the whole replacement, so no model is called for the summary.
    const requests = f.sent.length;
    await f.session.compact();
    const c1 = compactions(f.manager)[0]!;
    const prep1 = record.preps[0]!;
    expect(f.sent).toHaveLength(requests); // a custom result pays for nothing
    expect(record.reasons).toEqual(["manual"]);
    expect(custom(f.manager, prep1).customType).toBe(PREP);
    expect(custom(f.manager, prep1).parentId).toBe(before); // the preparation entry hangs from the pre-compaction leaf…
    expect(c1.parentId).toBe(prep1); // …and Pi's compaction entry hangs from the preparation entry
    expect(c1.fromHook).toBe(true);
    expect((c1.details as { traceMemory: { prep: string } }).traceMemory.prep).toBe(prep1); // tiers 1-2: exact by construction
    expect(preparationOf(f.manager, c1)?.data).toEqual({ considered: [1] });

    // Tier 3: the host declines, Pi calls the model for its own summary, and the entry Pi appends is
    // still the child of the preparation entry — which is the whole point of carrier C.
    plan = { data: { considered: [1, 2] }, decline: true };
    await f.session.prompt("third");
    f.script(() => say("native summary"));
    const before2 = f.sent.length;
    await f.session.compact();
    expect(summaryCalls(f.sent.slice(before2)).length).toBeGreaterThan(0); // Pi really paid for its own summary
    const c2 = compactions(f.manager).at(-1)!;
    const prep2 = record.preps[1]!;
    expect(c2.id).not.toBe(c1.id);
    expect(c2.parentId).toBe(prep2);
    expect(c2.fromHook).toBe(false);
    // A native compaction's own `details` are Pi's (`{readFiles, modifiedFiles}` from its summary
    // pass), not a free slot: tier 3 has nowhere on the compaction entry to write, which is why the
    // frozen set lives on the preparation entry above it.
    expect(Object.keys(c2.details as object).sort()).toEqual(["modifiedFiles", "readFiles"]);
    expect(preparationOf(f.manager, c2)?.data).toEqual({ considered: [1, 2] });
  } finally { f.dispose(); }
}, 30000);

test("26c revision 3 (a) automatic threshold: a model call sits between the hook and appendCompaction, and the compaction is still the preparation entry's child", async () => {
  const record = observed();
  let plan: Plan = { data: { considered: [7] } };
  // A 1,000-token window with 500 reserved, and a reply that reports 900: Pi's own threshold rule
  // (`shouldCompact`, compaction.js:160-164) fires at `agent_end` with no nudge from the test.
  const f = await piSession({ extensions: [preparer(() => plan, record)],
    contextWindow: 1_000, compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1 } });
  try {
    f.script(() => say("好的。", usage(900, 2)));
    await f.session.prompt("first");
    const auto = compactions(f.manager);
    expect(auto).toHaveLength(1); // Pi's own automatic path ran; this test never called `compact()`
    expect(record.reasons).toEqual(["threshold"]); // `_runAutoCompaction("threshold", …)`, not the manual entry point
    expect(auto[0]!.fromHook).toBe(true);
    expect(auto[0]!.parentId).toBe(record.preps[0]!);
    expect(preparationOf(f.manager, auto[0]!)?.data).toEqual({ considered: [7] });

    // Pi skips a compaction check whose assistant message is not newer than the last compaction entry
    // (agent-session.js:1650-1654), and both timestamps are millisecond-resolution; a scripted turn is
    // faster than that, so the next turn waits for the clock rather than for anything of ours.
    await new Promise(resolve => setTimeout(resolve, 15));

    // The declined (tier 3) automatic case: `_runDefaultCompaction` (agent-session.js:1803) really
    // calls the model between the hook and the append at :1826, and the association survives that window.
    plan = { data: { considered: [7, 8] }, decline: true };
    const before = f.sent.length;
    await f.session.prompt("second");
    expect(summaryCalls(f.sent.slice(before))).toHaveLength(1); // the model call really happened in that window
    expect(record.reasons).toEqual(["threshold", "threshold"]);
    const native = compactions(f.manager).at(-1)!;
    expect(compactions(f.manager)).toHaveLength(2);
    expect(native.fromHook).toBe(false);
    expect(native.parentId).toBe(record.preps[1]!);
    expect(preparationOf(f.manager, native)?.data).toEqual({ considered: [7, 8] });
  } finally { f.dispose(); }
}, 30000);

test("26c revision 3 (c): two successful compactions prepared at the same point keep their own baselines", async () => {
  const record = observed();
  let plan: Plan = { data: { considered: [1] }, summary: "first summary" };
  const f = await piSession({ extensions: [preparer(() => plan, record)] });
  try {
    f.script(() => say("好的。"));
    await f.session.prompt("first"); await f.session.prompt("second");
    const point = f.manager.getLeafId()!; // P: the leaf both compactions are prepared at

    await f.session.compact();
    const c1 = compactions(f.manager)[0]!;

    // Rewind to P and compact again from the same point — the case that killed the parent-leaf key,
    // because both compactions would have shared P as their identity.
    f.manager.branch(point);
    expect(f.manager.getLeafId()).toBe(point);
    plan = { data: { considered: [1, 2] }, summary: "second summary" };
    await f.session.compact();
    const c2 = compactions(f.manager).find(e => e.id !== c1.id)!;

    expect(c1.parentId).toBe(record.preps[0]!);
    expect(c2.parentId).toBe(record.preps[1]!);
    expect(c1.parentId).not.toBe(c2.parentId);
    expect(custom(f.manager, c1.parentId!).parentId).toBe(point);
    expect(custom(f.manager, c2.parentId!).parentId).toBe(point); // siblings under P, each with its own id
    // Each compaction reads its own frozen set, and neither was recomputed or overwritten.
    expect(preparationOf(f.manager, c1)?.data).toEqual({ considered: [1] });
    expect(preparationOf(f.manager, c2)?.data).toEqual({ considered: [1, 2] });
    // And each is reachable from its own compaction as the selected leaf.
    f.manager.branch(c1.id);
    expect(preparationOf(f.manager, c1)?.data).toEqual({ considered: [1] });
  } finally { f.dispose(); }
}, 30000);

test("26c revision 3 (b): a cancelled and a failed attempt append no compaction, leave their preparation entry as the leaf, and touch no earlier baseline", async () => {
  const record = observed();
  let plan: Plan = { data: { considered: [1] }, summary: "first summary" };
  const f = await piSession({ extensions: [preparer(() => plan, record)] });
  try {
    f.script(() => say("好的。"));
    await f.session.prompt("first"); await f.session.prompt("second");
    // 27d repair 6 (review 2026-09-10): P, the ORIGINAL point both retries are made at — the leaf the
    // first compaction was prepared from, as the sibling case (c) saves it. Rewinding to the first
    // attempt's preparation entry instead would have retried from a different point, which is not the
    // proof the ruling asks for: a retry at the same original point.
    const point = f.manager.getLeafId()!;
    await f.session.compact();
    const c1 = compactions(f.manager)[0]!;
    expect(custom(f.manager, c1.parentId!).parentId).toBe(point); // its preparation entry hangs from P

    // A cancelled attempt: the hook prepares, then the compaction is aborted through
    // `session.abortCompaction()`. Pi's abort check (agent-session.js:1536-1538) throws before
    // `appendCompaction`, so nothing is appended.
    f.manager.branch(point);
    plan = { data: { considered: [1, 2] }, summary: "cancelled summary", after: () => { f.session.abortCompaction(); } };
    await expect(f.session.compact()).rejects.toThrow(/cancel/i);
    const cancelled = record.preps[1]!;
    expect(compactions(f.manager)).toHaveLength(1);
    expect(f.manager.getLeafId()).toBe(cancelled); // the orphaned preparation entry is the leaf
    expect(custom(f.manager, cancelled).data).toEqual({ considered: [1, 2] });

    // A failed attempt, at that same original point: declined to Pi, whose own summary call fails.
    // Same outcome — a preparation entry with no compaction under it, and no entry of Pi's at all.
    f.manager.branch(point);
    plan = { data: { considered: [1, 2, 3] }, decline: true };
    f.script(() => failed());
    await expect(f.session.compact()).rejects.toThrow(/exploded|failed/i);
    const orphan = record.preps[2]!;
    expect(compactions(f.manager)).toHaveLength(1);
    expect(f.manager.getLeafId()).toBe(orphan);
    expect(custom(f.manager, orphan).parentId).toBe(point); // a third sibling under P, not a chain

    // The first compaction's baseline is exactly what it was: nothing was overwritten or recomputed.
    expect(compactions(f.manager)[0]!.id).toBe(c1.id);
    expect(preparationOf(f.manager, c1)?.data).toEqual({ considered: [1] });

    // An abandoned preparation entry does not wedge the session: the next real turn runs and its user
    // message simply hangs from it.
    f.script(() => say("好的。"));
    await f.session.prompt("after");
    expect(f.manager.getBranch().find(e => e.parentId === orphan)!.type).toBe("message");

    // The next successful attempt appends its own preparation entry and its own compaction.
    plan = { data: { considered: [1, 2, 3, 4] }, summary: "third summary" };
    const resumedLeaf = f.manager.getLeafId()!;
    await f.session.compact();
    const c2 = compactions(f.manager).find(e => e.id !== c1.id)!;
    const prep = record.preps[3]!;
    expect(c2.parentId).toBe(prep);
    expect(prep).not.toBe(cancelled); expect(prep).not.toBe(orphan);
    expect(custom(f.manager, prep).parentId).toBe(resumedLeaf);
    expect(preparationOf(f.manager, c2)?.data).toEqual({ considered: [1, 2, 3, 4] });
    // The two abandoned entries are still in the file, below the messages of the turn above, and are
    // reached by nobody: each compaction resolves through its own parent, never by scanning for a
    // preparation entry.
    expect(preparationOf(f.manager, c1)?.data).toEqual({ considered: [1] });
    expect(f.manager.getEntry(cancelled)).toBeTruthy(); expect(f.manager.getEntry(orphan)).toBeTruthy();
  } finally { f.dispose(); }
}, 30000);

test("26c revision 3 (a)/(c): a leaf change between preparation and append — the walk resolves through another extension's custom entry and fails closed on a message", async () => {
  const record = observed();
  let plan: Plan = { data: { considered: [1] }, summary: "first summary" };
  let intruder: "custom" | "message" = "custom";
  let manager!: SessionManager;
  // A second extension registered after ours: its `session_before_compact` handler runs in the same
  // window, after ours and before Pi's `appendCompaction`.
  const other = (pi: ExtensionAPI) => {
    pi.on("session_before_compact", () => {
      if (intruder === "custom") { pi.appendEntry("other-extension", { note: "not ours" }); return undefined; }
      manager.appendMessage({ role: "user", content: [{ type: "text", text: "a steering message" }], timestamp: Date.now() } as never);
      return undefined;
    });
  };
  const f = await piSession({ extensions: [preparer(() => plan, record), other] });
  manager = f.manager;
  try {
    f.script(() => say("好的。"));
    await f.session.prompt("first"); await f.session.prompt("second");
    const point = f.manager.getLeafId()!;

    // A custom entry of someone else's intervenes: the compaction's parent is *not* our preparation
    // entry, and the parent-leaf key would already be wrong here too.
    await f.session.compact();
    const c1 = compactions(f.manager)[0]!;
    const prep1 = record.preps[0]!;
    expect(c1.parentId).not.toBe(prep1);
    expect(custom(f.manager, c1.parentId!).customType).toBe("other-extension");
    // The rule resolves it: consecutive `custom` entries are walked through to the nearest one of ours.
    expect(preparationOf(f.manager, c1)?.id).toBe(prep1);
    expect(preparationOf(f.manager, c1)?.data).toEqual({ considered: [1] });

    // A message intervenes: the walk must fail closed rather than reach past it, because a message
    // means the session moved on and the preparation entry below is not this compaction's.
    f.manager.branch(point);
    intruder = "message";
    plan = { data: { considered: [1, 2] }, summary: "second summary" };
    await f.session.compact();
    const c2 = compactions(f.manager).find(e => e.id !== c1.id)!;
    expect(f.manager.getEntry(c2.parentId!)!.type).toBe("message");
    expect(preparationOf(f.manager, c2)).toBeUndefined(); // no baseline: `omitted = ∅`, duplicates rather than loss
    // Tiers 1-2 are unaffected either way: their `details` name the preparation entry outright.
    expect(custom(f.manager, (c2.details as { traceMemory: { prep: string } }).traceMemory.prep).data).toEqual({ considered: [1, 2] });
  } finally { f.dispose(); }
}, 30000);

test("26c revision 3: the session_compact event names the first compaction with that summary text, so the candidate never keys on it", async () => {
  const record = observed();
  const plan: Plan = { data: { considered: [1] }, summary: "identical summary" };
  const f = await piSession({ extensions: [preparer(() => plan, record)] });
  try {
    f.script(() => say("好的。"));
    await f.session.prompt("first"); await f.session.prompt("second");
    const point = f.manager.getLeafId()!;
    await f.session.compact();
    const c1 = compactions(f.manager)[0]!;
    f.manager.branch(point);
    await f.session.compact(); // the same summary text, a different entry
    const c2 = compactions(f.manager).find(e => e.id !== c1.id)!;

    expect(c1.summary).toBe(c2.summary);
    expect(record.events).toHaveLength(2);
    // `newEntries.find((e) => e.type === "compaction" && e.summary === summary)`
    // (dist/core/agent-session.js:1545, automatic path :1832) is a first match over the whole file,
    // so the second compaction's own event hands back the FIRST entry with that text — the older one.
    expect(record.events[0]!.id).toBe(c1.id);
    expect(record.events[1]!.id).toBe(c1.id);
    expect(record.events[1]!.id).not.toBe(c2.id);
    // The preparation entry the event's id would lead to is the wrong attempt's; `parentId` is right.
    expect(preparationOf(f.manager, f.manager.getEntry(record.events[1]!.id) as CompactionEntry)?.id).toBe(record.preps[0]);
    expect(preparationOf(f.manager, c2)?.id).toBe(record.preps[1]);
  } finally { f.dispose(); }
}, 30000);

test("26c revision 3 (b): the preparation entry is invisible to the model and transparent to the host's reconcile walk", async () => {
  const f = await fixture({ "noting.triggerTokens": 1_000_000_000 });
  try {
    f.script(() => sayNative("好的。"));
    await f.turn("first");
    const manager = f.manager();
    const entries = f.h.memory.store.listSourceEntries(1).length;
    const turns = f.h.memory.store.listTurns(1).length;

    // `pi.appendEntry` is `sessionManager.appendCustomEntry` (dist/core/agent-session.js:2029-2035);
    // this is the write the hook makes, on the real manager the host reads.
    const prep = manager.appendCustomEntry(PREP, { traceMemory: { v: 1, considered: [1, 2], commits: [] } });
    expect(manager.getLeafId()).toBe(prep);

    // In Pi's compaction-aware view (so a later `coverage()` can find it), but not in the messages Pi
    // builds for the provider: `sessionEntryToContextMessages` returns [] for `type: "custom"`.
    expect(manager.buildContextEntries().map(e => e.id)).toContain(prep);
    const messages = manager.buildSessionContext().messages;
    expect(JSON.stringify(messages)).not.toContain(PREP);
    expect(messages.filter(m => (m as { role: string }).role === "custom")).toEqual([]);

    // The real request body of the next real turn carries no trace of it either.
    const captured = await f.turn("second");
    expect(JSON.stringify(captured)).not.toContain(PREP);
    expect(JSON.stringify(captured)).not.toContain("considered");

    // The host's `reconcile` walk (src/hosts/pi/index.ts:561-651) skips it: it is not `type: "message"`
    // and its `customType` is not the host's own state tag, so it records no source entry, opens no
    // Turn, and — because the walk adds every ancestry entry to `seen` before the type checks — the
    // entry below it does not report a missing parent.
    expect(f.h.memory.store.listSourceEntries(1)).toHaveLength(entries + 2); // the second turn's user and assistant entries only
    expect(f.h.memory.store.listTurns(1)).toHaveLength(turns + 1);
    expect(f.h.notices.filter(n => n.includes("missing native history"))).toEqual([]);
    expect(f.h.memory.store.listSourceEntries(1).map(e => e.nativeId)).not.toContain(prep);
  } finally { await f.dispose(); }
}, 30000);
