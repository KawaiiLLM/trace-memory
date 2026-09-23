// The serial performance runner (ticket 22 "Workloads and acceptance"). Not part of `npm test`:
// `npm run perf` invokes it, one scenario at a time, and prints the runtime version, the fixture
// size and the warm/cold state with every number. No provider traffic: the fake host's wire is not
// even installed, and the run asserts that no request was made.
//
//   npm run perf                 both sizes
//   npm run perf -- baseline     one size
//   npm run perf -- --rebuild    regenerate the cached fixture databases
//   npm run perf -- --repeats=3  fewer samples per scenario (the first is always the cold one)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { loadPrompt } from "../../src/core/prompts/load.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, nativeAncestry, countSourceReads, countGraphResolutions, countRunBodies, runAudit, searchCorpus, type Fixture } from "./fixture.ts";
import { TraceMemory, noVisibility, renderEntry, toolDefinitions, tokens, type EntryProfile, type SourceEntry } from "../../src/core/api/index.ts";
import { freezeNoting } from "../../src/core/noting/index.ts";
import { captureNotingNear, notingNearFeedback } from "../../src/core/noting/review.ts";
import { freezeConsolidation } from "../../src/core/consolidation/index.ts";
import { freezeDreaming } from "../../src/core/dreaming/index.ts";
import { Store } from "../../src/core/store/index.ts";
import { host } from "../hosts/pi/test-host.ts";

const SIZES: Record<string, { entries: number; facts: number }> = {
  baseline: { entries: 2_000, facts: 132 },
  large: { entries: 4_000, facts: 264 },
};

const cache = join(tmpdir(), "trace-memory-perf");

const argv = process.argv.slice(2);
const rebuild = argv.includes("--rebuild");
const REPEATS = Number(argv.find(a => a.startsWith("--repeats="))?.split("=")[1] ?? 5);
const selected = argv.filter(a => !a.startsWith("--"));
const sizes = selected.length ? selected : Object.keys(SIZES);

interface Sample { name: string; cold: number; warm: number; p95: number; reads: number; note: string }

const ms = (value: number) => value.toFixed(1).padStart(9);
const measure = (name: string, run: () => unknown, note = ""): Sample => {
  const counter = countSourceReads();
  const times: number[] = [];
  let reads = 0;
  try {
    for (let i = 0; i < REPEATS; i++) {
      counter.reset();
      const started = performance.now();
      run();
      times.push(performance.now() - started);
      if (i === 1) reads = counter.reads(); // warm read count
    }
  } finally { counter.restore(); }
  const warm = [...times.slice(1)].sort((a, b) => a - b);
  return { name, cold: times[0]!, warm: warm[Math.floor(warm.length / 2)]!, p95: warm.at(-1)!, reads, note };
};

/** The disabled-session host callbacks, on a copy of the fixture with enrollment switched off. */
async function disabledHost(fixture: Fixture, size: string): Promise<Sample[]> {
  const copy = join(cache, `${size}-disabled.db`);
  rmSync(copy, { force: true });
  copyFileSync(fixture.dbPath, copy);
  const store = new Store(copy);
  store.setEnrollment(fixture.sessionId, false);
  store.close();
  const counter = countSourceReads();
  const samples: Sample[] = [];
  const h = host({ dbPath: copy }, { fetch: false });
  try {
    h.entries.push({ id: "e0", parentId: null, timestamp: new Date().toISOString(), type: "custom", customType: "trace-memory",
      data: { dbPath: copy, piId: "pi-test", sessionId: fixture.sessionId, projectId: fixture.projectId, branch: fixture.branch, head: fixture.headTurnId } });
    const time = async (name: string, event: string, payload: unknown = {}) => {
      const times: number[] = [];
      let reads = 0;
      for (let i = 0; i < REPEATS; i++) {
        counter.reset();
        const started = performance.now();
        await h.emit(event, payload);
        times.push(performance.now() - started);
        if (i === 1) reads = counter.reads();
      }
      const warm = [...times.slice(1)].sort((a, b) => a - b);
      samples.push({ name, cold: times[0]!, warm: warm[Math.floor(warm.length / 2)]!, p95: warm.at(-1)!, reads, note: "disabled session" });
    };
    await time("host session_start (disabled)", "session_start");
    await time("host before_agent_start (disabled)", "before_agent_start", { prompt: "hi", systemPrompt: "host" });
    await time("host before_provider_request (disabled)", "before_provider_request", { payload: { messages: [] } });
    if (h.requests.length) throw new Error("the performance suite made a provider request");
    const status = h.statuses.get("trace-memory") ?? "";
    // 24a: the off footer is the compact line, and it counts nothing at all.
    if (!/^🧠 .*○ off/.test(status)) throw new Error(`disabled footer is not the off line: ${status}`);
    samples.push({ name: `  footer text: ${status}`, cold: NaN, warm: NaN, p95: NaN, reads: 0, note: "off session" });
  } finally {
    counter.restore();
    await h.dispose();
    rmSync(copy, { force: true });
  }
  return samples;
}

/** Ticket 22b, hotspot family 2: the Noting trigger with a whole backlog pending. The generated
 * fixture keeps only its tail pending, so the audit's "the trigger check alone, 1,566 pending
 * entries" is reproduced on a copy whose Noting progress is removed — the same entries, none of them
 * taken yet. The copy is read-only for the measurement and deleted afterwards. */
async function triggerBacklog(fixture: Fixture, size: string): Promise<Sample[]> {
  const copy = join(cache, `${size}-backlog.db`);
  rmSync(copy, { force: true });
  copyFileSync(fixture.dbPath, copy);
  const store = new Store(copy);
  store.db.prepare("DELETE FROM noted_entries").run();
  store.close();
  const memory = TraceMemory(copy, async () => { throw new Error("the performance suite must not call a model"); });
  const head = fixture.headTurnId;
  const target = { sessionId: fixture.sessionId, branch: fixture.branch, headTurnId: head };
  try {
    const meta = memory.pendingEntries(fixture.sessionId, fixture.branch, head);
    const pending = meta.length;
    // 79: `viewTokens` renders every entry, so it hydrates the whole chosen set in one batched read;
    // the `measure` below still calls the metadata-only `pendingEntries` itself, unhydrated.
    const entries = memory.store.hydrateSourceEntries(meta.map(e => e.id));
    return [
      measure("pendingEntries (whole backlog pending)", () => memory.pendingEntries(fixture.sessionId, fixture.branch, head), `${pending} pending entries`),
      measure("taskEligibility noting (whole backlog pending)", () => memory.taskEligibility("noting", target), `${pending} pending entries`),
      ...viewTokens(memory, entries, size),
    ];
  } finally { memory.close(); rmSync(copy, { force: true }); }
}

/** Ticket 23 acceptance: what the entry view costs on that same backlog. The pre-change totals below
 * were measured on this generator at `e7cd633` (the 17a view, `B = 1,000` in fixed halves, one native
 * identity header per entry) with Node 24.6.0; the configured total must be at most half of them.
 * Ticket 30 retired the second tier, so there is one profile left to render. */
const VIEW_TOKENS_BEFORE_23: Record<string, number> = { baseline: 553_980, large: 1_086_050 };

function viewTokens(memory: ReturnType<typeof TraceMemory>, entries: SourceEntry[], size: string): Sample[] {
  // A profile whose `E` cannot hold one entry's minima raises the capacity error; that entry is
  // counted, not rendered smaller, and compaction delegates over it exactly as it does in production.
  const total = (profile: EntryProfile) => {
    const started = performance.now();
    let sum = 0, overflowed = 0;
    for (const entry of entries) {
      try { sum += tokens(renderEntry(entry, profile, memory.resultText).content); }
      catch (error) { if (!/capacity/.test(String(error))) throw error; overflowed++; }
    }
    return { sum, overflowed, ms: performance.now() - started };
  };
  const view = total(memory.config.render);
  const before = VIEW_TOKENS_BEFORE_23[size];
  // The ticket's target is half the pre-23 total. 23a fell short of it on this fixture at 42.2%,
  // because about half of the total here is natural text, which the rule keeps at its own size on
  // purpose; 23c's line format reached it (52.4% on the large fixture) and 30's tighter defaults go
  // further. The note still reports the shortfall whenever it returns, and what is enforced is only
  // that the view never costs more than the one it replaced.
  const saving = before ? `${(100 * (1 - view.sum / before)).toFixed(1)}% under the pre-23 view (${before}); target 50%${view.sum * 2 <= before ? "" : ", not reached on this fixture"}`
    : "no recorded pre-23 total for this size";
  if (before && view.sum >= before) throw new Error(`entry view regression: ${view.sum} tokens over ${entries.length} pending entries, not below the pre-23 ${before}`);
  return [
    { name: "entry views (whole backlog)", cold: view.ms, warm: view.ms, p95: view.ms, reads: 0,
      note: `${view.sum} tokens, ${saving}${view.overflowed ? `, ${view.overflowed} entries over the entry budget (compaction delegates)` : ""}` },
  ];
}

/** Ticket 22b, hotspot families 1 and 2: the host's own reconciliation. A fresh fake host is given a
 * long native ancestry and nothing else; `/trace on` is the one-time import, `/trace on` again
 * is the repeat, and the callbacks after it are the ordinary boundaries of a warmed-up session. The
 * imported history is marked noted in batches first (no model, no facts), so the ordinary callbacks
 * below are the ordinary case and not a due trigger; the trigger itself is measured on the store
 * fixture, where a full pending backlog exists. */
async function hostReconciliation(size: string, entries: number): Promise<Sample[]> {
  const ancestry = nativeAncestry({ entries });
  const dbPath = join(cache, `${size}-host.db`);
  rmSync(dbPath, { force: true });
  const samples: Sample[] = [];
  const counter = countSourceReads();
  const h = host({ dbPath, "noting.forkModeDefault": false }, { fetch: false });
  const single = (name: string, ms: number, reads: number, note: string) => samples.push({ name, cold: ms, warm: ms, p95: ms, reads, note });
  try {
    h.setHeaderTimestamp("2000-01-01T00:00:00Z"); // disabled by default, so enabling is the explicit import
    await h.emit("session_start");
    h.entries.push(...ancestry); h.allEntries.push(...ancestry);
    const command = (args: string) => (h.commands.get("trace") as { handler(args: string, ctx: unknown): Promise<void> }).handler(args, h.ctx);

    counter.reset();
    let started = performance.now();
    await command("on");
    single("host /trace on (import)", performance.now() - started, counter.reads(), `${ancestry.length} native entries, single shot`);
    counter.reset();
    started = performance.now();
    await command("on");
    single("host /trace on (repeat)", performance.now() - started, counter.reads(), "already reconciled");

    const store = h.memory.store;
    const state = () => (h.entries.filter(e => e.customType === "trace-memory").at(-1) as { data: { head: number } }).data;
    const head = state().head;
    const imported = store.pendingEntries(1, "main", head).map(e => e.id);
    for (let i = 0; i < imported.length; i += 50) {
      const committed = store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", rangeFrom: "S1/T1", rangeTo: `S1/T${head}`, createdAt: "2026-01-01T01:00:00Z" },
        facts: [], entryIds: imported.slice(i, i + 50) });
      if (!committed.ok) throw new Error(committed.problems.join("; "));
    }
    if (h.requests.length) throw new Error("the performance suite made a provider request");

    const callback = async (name: string, prepare: () => void, event: string, payload: unknown = {}, note = "after warm-up") => {
      const times: number[] = [];
      let reads = 0;
      for (let i = 0; i < REPEATS; i++) {
        prepare();
        counter.reset();
        const at = performance.now();
        await h.emit(event, payload);
        times.push(performance.now() - at);
        if (i === 1) reads = counter.reads();
      }
      const warm = [...times.slice(1)].sort((a, b) => a - b);
      samples.push({ name, cold: times[0]!, warm: warm[Math.floor(warm.length / 2)]!, p95: warm.at(-1)!, reads, note });
    };
    const exchange = () => { h.persist({ role: "user", content: "one short follow-up", timestamp: 1 });
      h.persist({ role: "assistant", content: [{ type: "text", text: "a short answer" }], timestamp: 1 }); };
    await callback("host agent_end (short new exchange)", exchange, "agent_end");
    await callback("host agent_settled (no new entry)", () => {}, "agent_settled");
    await callback("host tool_result", () => {}, "tool_result", { toolName: "read", input: { path: "small" }, content: [{ type: "text", text: "small result" }], isError: false });
    {
      const times: number[] = [];
      let reads = 0;
      for (let i = 0; i < REPEATS; i++) {
        counter.reset();
        const at = performance.now();
        for (let update = 0; update < 50; update++) await h.emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: `delta ${update}` }], timestamp: 1 } });
        times.push(performance.now() - at);
        if (i === 1) reads = counter.reads();
      }
      const warm = [...times.slice(1)].sort((a, b) => a - b);
      samples.push({ name: "host 50 message_update (unchanged leaf)", cold: times[0]!, warm: warm[Math.floor(warm.length / 2)]!, p95: warm.at(-1)!, reads, note: "50 updates in total" });
    }
    if (h.requests.length) throw new Error("the performance suite made a provider request");
    samples.push({ name: `  imported: ${store.listTurns(1).length} turns, ${store.listSourceEntries(1).length} entries, leaf ${h.ctx.sessionManager.getLeafId()}`, cold: NaN, warm: NaN, p95: NaN, reads: 0, note: "" });
  } finally {
    counter.restore();
    await h.dispose();
    rmSync(dbPath, { force: true });
  }
  return samples;
}

/** Ticket 22d, hotspot family 6: the Noting and Consolidation freezes under a model allowance. The
 * copy has its Noting progress removed, so the whole history is pending and a freeze selects a real
 * batch. Three allowances: none (the natural freeze), one below the fixed instruction and tool cost
 * (impossible — no candidate material can ever bring the price under it), and one just under the
 * natural size (feasible, but the optional history has to give way, which is the re-freeze loop).
 * Nothing here runs a task, so no provider request is possible. */
async function capacityScenarios(fixture: Fixture, size: string, main: ReturnType<typeof TraceMemory>): Promise<Sample[]> {
  const copy = join(cache, `${size}-capacity.db`);
  rmSync(copy, { force: true });
  copyFileSync(fixture.dbPath, copy);
  const prepared = new Store(copy);
  prepared.db.prepare("DELETE FROM noted_entries").run();
  prepared.close();
  const memory = TraceMemory(copy, async () => { throw new Error("the performance suite must not call a model"); });
  const store = memory.store, samples: Sample[] = [];
  const instructions = (file: "noting.md" | "consolidation.md" | "dreaming.md") => tokens(loadPrompt(file));
  const toolCost = tokens(JSON.stringify(toolDefinitions));
  const rejected = (name: string, note: string, run: () => unknown) => samples.push(measure(name, () => {
    try { run(); } catch (error) { if (/capacity/.test(String(error))) return; throw error; }
    throw new Error(`${name}: an impossible allowance must be rejected`);
  }, note));
  try {
    const target = { sessionId: fixture.sessionId, branch: fixture.branch, headTurnId: fixture.headTurnId, mode: "subagent" as const };
    const noting = instructions("noting.md");
    const natural = freezeNoting(store, target, memory.config, memory.resultText);
    const naturalTokens = noting + toolCost + tokens(natural.prepared!.text);
    samples.push(measure("noting freeze (no allowance)", () => freezeNoting(store, target, memory.config, memory.resultText),
      `${natural.entries.length} of ${store.pendingEntries(fixture.sessionId, fixture.branch, fixture.headTurnId).length} pending entries selected, ${naturalTokens} tokens priced`));
    rejected("noting freeze (impossible 2,000-token allowance)",
      `instructions ${noting} + tools ${toolCost} = ${noting + toolCost} mandatory tokens, allowance 2,000`,
      () => freezeNoting(store, { ...target, capacity: { inputTokens: 2_000, prefixTokens: 0 } }, memory.config, memory.resultText));
    const tight = { ...target, capacity: { inputTokens: naturalTokens - 500, prefixTokens: 0 } };
    const reduced = freezeNoting(store, tight, memory.config, memory.resultText);
    samples.push(measure("noting freeze (allowance 500 under the natural size)", () => freezeNoting(store, tight, memory.config, memory.resultText),
      `${reduced.entries.length} entries, ${reduced.prepared!.material.facts.length} historical facts kept of ${natural.prepared!.material.facts.length}`));

    // The same rejection on the fixture as it stands — an ordinary session with a short pending tail,
    // which is the workload the 100 ms target is stated against. The backlog copy above is the worst
    // case: its own floor is the pending read, which loads 1,996 whole Raw payloads before the freeze
    // can know it has anything to do at all.
    rejected("noting freeze (impossible allowance, ordinary pending tail)",
      `${fixture.pendingEntryCount} pending entries on the untouched fixture, allowance 2,000`,
      () => freezeNoting(main.store, { ...target, capacity: { inputTokens: 2_000, prefixTokens: 0 } }, main.config, main.resultText));

    const consolidation = instructions("consolidation.md");
    const batch = store.consolidationBatch(fixture.sessionId, fixture.branch, fixture.headTurnId).length;
    samples.push(measure("consolidation freeze (no allowance)", () => freezeConsolidation(store, target, memory.config), `${batch} pending facts`));
    rejected("consolidation freeze (impossible 2,000-token allowance)",
      `instructions ${consolidation} + tools ${toolCost} = ${consolidation + toolCost} mandatory tokens, allowance 2,000`,
      () => freezeConsolidation(store, { ...target, capacity: { inputTokens: 2_000, prefixTokens: 0 } }, memory.config));
  } finally { memory.close(); rmSync(copy, { force: true }); }
  return samples;
}

/** Ticket 22d, hotspot family 7: the session spend over about 200 runs whose audit bodies are large
 * and whose usage records are small. "chars" is the request/response text the read pulls into
 * JavaScript; the totals are compared against what the generator wrote, so a faster aggregation that
 * loses an observation, or invents one for an unknown usage, fails here rather than looking fast. */
async function spendScenarios(fixture: Fixture, size: string): Promise<Sample[]> {
  const copy = join(cache, `${size}-spend.db`);
  rmSync(copy, { force: true });
  copyFileSync(fixture.dbPath, copy);
  const written = runAudit(copy, { sessionId: fixture.sessionId, branch: fixture.branch });
  const memory = TraceMemory(copy, async () => { throw new Error("the performance suite must not call a model"); });
  const bodies = countRunBodies();
  try {
    const totals = memory.spend(fixture.sessionId);
    if (totals.input < written.input || totals.output < written.output || totals.cacheRead < written.cacheRead)
      throw new Error(`spend lost an observation: ${JSON.stringify(totals)} against ${JSON.stringify(written)}`);
    bodies.reset();
    memory.spend(fixture.sessionId);
    const chars = bodies.chars();
    return [measure(`spend (${written.runs} large-audit runs)`, () => memory.spend(fixture.sessionId),
      `${(chars / 1e6).toFixed(1)} M audit characters loaded, ${(written.chars / 1e6).toFixed(1)} M stored over ${written.runs} runs ` +
      `(${written.observed} observed, ${written.unknown} unknown usage, ${written.malformed} non-JSON), $${totals.cost.toFixed(4)}`)];
  } finally { bodies.restore(); memory.close(); rmSync(copy, { force: true }); }
}

/** Ticket 22c, hotspot family 5: knowledge search over 100, 500 and 1,000 matching revisions, with a
 * first-page cap of one. The corpus is written on a copy of the long-history fixture, so applicability
 * is decided against its real facts and Turns; it is cached like the fixture itself (`--rebuild`
 * regenerates it) because writing 1,000 valid commits is slower than reading them. Both the first
 * page and the complete continuation are measured, with the whole-graph resolutions each performs. */
async function searchScenarios(fixture: Fixture, size: string): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (const revisions of [100, 500, 1_000]) {
    const copy = join(cache, `${size}-search-${revisions}.db`);
    let built = 0;
    if (rebuild || !existsSync(copy)) {
      rmSync(copy, { force: true });
      copyFileSync(fixture.dbPath, copy);
      const started = performance.now();
      searchCorpus(copy, { revisions, sessionId: fixture.sessionId, branch: fixture.branch, headTurnId: fixture.headTurnId });
      built = performance.now() - started;
    }
    const memory = TraceMemory(copy, async () => { throw new Error("the performance suite must not call a model"); });
    try {
      const query = "SEARCHNEEDLE";
      const scope = { cap: 1, sessionId: fixture.sessionId, headTurnId: fixture.headTurnId };
      const hits = memory.store.searchAddresses(query, "knowledge").length;
      const all = () => { // the complete continuation: every page, one hit at a time
        let page = memory.search(query, "knowledge", scope), pages = 1;
        for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
          page = memory.search("", "knowledge", { ...scope, cursor }); pages++;
        }
        return pages;
      };
      const graphed = (run: () => unknown) => {
        const counter = countGraphResolutions();
        try { counter.reset(); run(); return counter.resolutions(); } finally { counter.restore(); }
      };
      const firstGraph = graphed(() => memory.search(query, "knowledge", scope));
      samples.push(measure(`search first page (${revisions} matches, cap 1)`, () => memory.search(query, "knowledge", scope),
        `${hits} hits, ${firstGraph} graph resolutions${built ? `, corpus built in ${(built / 1000).toFixed(1)} s` : ", cached corpus"}`));
      const pages = all();
      samples.push(measure(`search full continuation (${revisions} matches, cap 1)`, all, `${pages} pages, ${graphed(all)} graph resolutions`));
    } finally { memory.close(); }
  }
  return samples;
}

/** Immutable history, shared owners, pool completion and placement transactions.
 * Completion samples roll back deliberately, so warm samples exercise real terminal processing. All databases are synthetic and confined to the temporary perf directory. */
function dreamingScenarios(size: string): Sample[] {
  const file = join(cache, `${size}-dreaming.db`);
  rmSync(file, { force: true });
  const memory = TraceMemory(file, async () => { throw new Error("perf must not call a model"); });
  const store = memory.store, time = "2026-01-01T00:00:00Z";
  const sessions = size === "baseline" ? 20 : 80, revisions = size === "baseline" ? 100 : 1000;
  try {
    const project = store.createProject({ name: "dreaming-A", declaredBy: "mark" });
    const other = store.createProject({ name: "dreaming-B", declaredBy: "mark" });
    const targets = Array.from({ length: sessions }, (_, i) => {
      const session = store.createSession({ host: "perf", enrollmentChoice: true, projectId: i % 2 ? other.id : project.id, startedAt: time, firstReplyAt: time });
      const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "synthetic evidence", startedAt: time });
      return { sessionId: session.id, branch: "main", headTurnId: turn.id };
    });
    const target = targets[0]!;
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: target.sessionId, createdAt: time }, facts: [{ turnId: target.headTurnId, text: "synthetic evidence", category: "decision", actor: "user", source: [`T${target.headTurnId}#user`], createdAt: time }] });
    if (!noted.ok) throw new Error(noted.problems.join());
    const current: { knowledgeId: number; commit: number }[] = [];
    const pool = `project:${project.id}`;
    const content = (i: number) => ({ text: `small conclusion ${i % 10}, revision ${i}`, topics: [],
      category: "mechanism" as const, scope: "project" as const, supports: [noted.facts[0]!.id], reason: "perf", createdAt: time });
    const create = (i: number) => {
      const result = store.commitConsolidationRun({ path: target,
        run: { kind: "manual", sessionId: target.sessionId, branch: target.branch, createdAt: time },
        operations: [{ op: "create", handle: `$${i}`, author: "perf", ...content(i) }] });
      if (!result.ok) throw new Error(result.problems.join());
      return result.committed[0]!;
    };
    for (let i = 0; i < 10; i++) current.push(create(i));
    const seedClaim = store.acquireClaim(target, "dreaming", "perf-seed");
    if (!seedClaim) throw new Error("seed claim unavailable");
    const seedRange = store.retainKnowledgePoolRange(target, pool, seedClaim);
    const seedExecution = store.beginExecution({ sessionId: target.sessionId, phase: "dreaming", head: seedRange.anchor, origin: seedRange.origin });
    const seedRun = store.bindDreamingRun({ kind: "dreaming", sessionId: target.sessionId, branch: target.branch,
      dreamingRangeId: seedRange.id, executionId: seedExecution, claim: seedClaim, createdAt: time });
    store.transaction(() => {
      for (let i = 10; i < revisions; i++) {
        const base = current[i % 10]!;
        const result = store.commitConsolidationRun({ path: target, run: seedRun,
          operations: [{ op: "update", knowledgeId: base.knowledgeId, baseCommit: base.commit, ...content(i) }] });
        if (!result.ok) throw new Error(result.problems.join());
        current[i % 10] = result.committed[0]!;
      }
    });
    store.completeKnowledgePoolRange(seedRun, "success");
    store.settleExecution(seedExecution, "success", store.dreamingRunId(seedRun)!);
    store.releaseClaim(seedClaim);
    // Ten genuinely new versions supply pending work beside the ten maintained reference bodies.
    for (let i = revisions; i < revisions + 10; i++) create(i);
    const weight = store.pendingPoolWeight(pool, target);
    memory.setKnowledgeBudget("project", weight * 2);
    const claim = store.acquireClaim(target, "dreaming", "perf");
    if (!claim) throw new Error("measurement claim unavailable");
    const counter = countGraphResolutions();
    let eligibilityGraphs: number;
    try { memory.taskEligibility("dreaming", target); eligibilityGraphs = counter.resolutions(); } finally { counter.restore(); }
    if (eligibilityGraphs !== 1) throw new Error(`Dreamer eligibility must share one graph across all pools; got ${eligibilityGraphs}`);
    const note = `${revisions + 10} revisions, ${sessions} sessions in 2 projects, 20 current bodies`;
    const rollback = new Error("sample rollback");
    const samples = [
      measure("Dreaming eligibility", () => memory.taskEligibility("dreaming", target), `${note}; ${eligibilityGraphs} graph resolutions`),
      measure("Dreamer admission/material (rollback each sample)", () => {
        try { store.transaction(() => {
          const frozen = freezeDreaming(store, target, memory.config, claim);
          if (tokens(frozen.material.processed) > frozen.admittedProcessedInputCap
              || tokens(frozen.material.changed) > store.knowledgeBudgets().project || tokens(frozen.material.facts) > 10000)
            throw new Error("Dreamer material exceeded a hard input window");
          throw rollback;
        }); } catch (error) { if (error !== rollback) throw error; }
      }, `${note}; current pool selection and full body/fact rendering`),
    ];
    const frozen = freezeDreaming(store, target, memory.config, claim);
    const executionId = store.beginExecution({ sessionId: target.sessionId, phase: "dreaming", head: frozen.range.anchor, origin: frozen.range.origin });
    const run = store.bindDreamingRun({ kind: "dreaming", sessionId: target.sessionId, branch: target.branch,
      dreamingRangeId: frozen.range.id, executionId, claim, createdAt: time });
    samples.push(measure("Dreaming completion (rollback each sample)", () => {
      try { store.transaction(() => { store.completeKnowledgePoolRange(run, "success"); throw rollback; }); }
      catch (error) { if (error !== rollback) throw error; }
    }, note));
    store.completeKnowledgePoolRange(run, "success");
    store.settleExecution(executionId, "success", store.dreamingRunId(run)!);
    store.releaseClaim(claim);
    samples.push(measure("Dreaming placement A→B→A", () => {
      store.declareProject(target.sessionId, other.name, "mark");
      store.declareProject(target.sessionId, project.name, "mark");
    }, `${note}; full affected pools, identity preserved`));
    return samples;
  } finally { memory.close(); rmSync(file, { force: true }); }
}

/** Ticket 34c: foreground publication scales with candidate changes, not per-candidate SQL. The copy
 * uses the generated path and one real applicable Fact; the two measurements exercise full body
 * selection and evidence suppression over the same exact-version graph without provider traffic. */
function deliveryScenarios(fixture: Fixture, size: string): Sample[] {
  const copy = join(cache, `${size}-delivery.db`);
  rmSync(copy, { force: true });
  copyFileSync(fixture.dbPath, copy);
  const memory = TraceMemory(copy, async () => { throw new Error("the performance suite must not call a model"); });
  try {
    const store = memory.store, count = size === "large" ? 1_000 : 250;
    const path = { sessionId: fixture.sessionId, branch: fixture.branch, headTurnId: fixture.headTurnId };
    const support = store.listBranchFacts(fixture.sessionId, fixture.branch, fixture.headTurnId)[0]!;
    const committed = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: fixture.sessionId, branch: fixture.branch, createdAt: "2026-09-12T00:00:00Z" },
      operations: Array.from({ length: count }, (_, index) => ({ op: "create" as const, handle: `$e${index + 1}`,
        author: "perf", text: `Foreground candidate ${index + 1}`, category: "constraint" as const, scope: "project" as const,
        supports: [support.id], topics: [], reason: "synthetic foreground publication fixture", createdAt: "2026-09-12T00:00:00Z" })) });
    if (!committed.ok) throw new Error(committed.problems.join("; "));
    const hidden = noVisibility(); hidden.factIds.add(support.id);
    const unchanged = noVisibility();
    for (const value of store.currentKnowledge(path)) unchanged.knowledgeCommitIds.add(value.revision.id);
    return [
      measure("foreground Knowledge delivery (body candidates)", () => memory.injection(path, noVisibility()), `${count} new exact revisions; ${store.knowledgeBudgets().injection + memory.config.compaction.sharedAllowanceTokens} rendered cap`),
      measure("foreground Knowledge delivery (exact no-delta)", () => memory.injection(path, unchanged), `${unchanged.knowledgeCommitIds.size} current exact bodies visible`),
      measure("foreground Knowledge delivery (Fact-suppressed)", () => memory.injection(path, hidden), `${count} new exact revisions sharing one visible support`),
    ];
  } finally { memory.close(); rmSync(copy, { force: true }); }
}

const notingQueryBaselines = new Map<string, number>();
function notingNearScale(fixture: Fixture, size: string, factCount: 2_000 | 20_000): Sample {
  const warmBound = factCount === 2_000 ? 100 : 1_000;
  const copy = join(cache, `${size}-noting-near-${factCount}.db`);
  rmSync(copy, { force: true });
  copyFileSync(fixture.dbPath, copy);
  const store = new Store(copy);
  try {
    const seed = store.db.prepare("SELECT run_id, turn_id, category, actor, quote, status, source, source_time FROM facts WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?) LIMIT 1")
      .get(fixture.sessionId) as Record<string, unknown>;
    const existing = Number((store.db.prepare("SELECT COUNT(*) count FROM facts f JOIN turns t ON t.id = f.turn_id WHERE t.session_id = ?").get(fixture.sessionId) as { count: number }).count);
    const insert = store.db.prepare("INSERT INTO facts (run_id, turn_id, category, actor, text, quote, status, source, source_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const relation = store.db.prepare("INSERT INTO fact_relations (from_fact, to_fact, kind, strength) VALUES (?, 1, 'support', 'weak')");
    store.db.exec("BEGIN");
    try {
      for (let i = existing; i < factCount; i++) {
        const added = insert.run(Number(seed.run_id), Number(seed.turn_id), String(seed.category), String(seed.actor),
          `NEAR scale package trace memory candidate ${i}`, seed.quote === null ? null : String(seed.quote),
          seed.status === null ? null : String(seed.status), String(seed.source), String(seed.source_time));
        relation.run(Number(added.lastInsertRowid));
      }
      store.db.exec("COMMIT");
    } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    const path = { sessionId: fixture.sessionId, branch: fixture.branch, headTurnId: fixture.headTurnId };
    const snapshot = store.pathSnapshot(path);
    const proposed = Array.from({ length: 15 }, (_, i) => ({ turnId: fixture.headTurnId, category: "observation" as const,
      actor: "agent" as const, text: `NEAR scale package trace memory candidate ${i}`, source: [`T${fixture.headTurnId}#assistant`],
      createdAt: "2026-09-13T00:00:00Z" }));
    let queryCount = 0, counting = false;
    const original = store.db.prepare.bind(store.db);
    (store.db as unknown as { prepare(sql: string): unknown }).prepare = ((sql: string) => { if (counting) queryCount++; return original(sql); }) as never;
    const sample = measure(`noting NEAR whole chain (${factCount} facts)`, () => {
      queryCount = 0; counting = true;
      try {
        const held = captureNotingNear(store, fixture.sessionId, path, snapshot, proposed, { facts: proposed }, 0.40);
        if (held.candidates.length !== factCount || held.shown.length !== proposed.length) throw new Error("invalid Noting NEAR performance fixture");
        notingNearFeedback(held);
      } finally { counting = false; }
    }, `${factCount} applicable facts × 15 proposed; path filter + similarity + relation read + feedback; constant queries measured below`);
    sample.note += `; ${queryCount} pool queries; warm median < ${warmBound} ms acceptance`;
    if (factCount === 2_000) notingQueryBaselines.set(size, queryCount);
    else if (queryCount !== notingQueryBaselines.get(size))
      throw new Error(`Noting NEAR query count grew with the pool: 2k=${notingQueryBaselines.get(size)}, ${factCount}=${queryCount}`);
    if (!(sample.warm < warmBound)) throw new Error(`Noting NEAR ${factCount}-fact warm median ${sample.warm.toFixed(1)} ms exceeds < ${warmBound} ms`);
    return sample;
  } finally { store.close(); rmSync(copy, { force: true }); }
}

async function runSize(size: string) {
  const options = SIZES[size];
  if (!options) throw new Error(`unknown size ${size}; use ${Object.keys(SIZES).join(" | ")}`);
  mkdirSync(cache, { recursive: true });
  const dbPath = join(cache, `${size}.db`);
  let generation = 0;
  if (rebuild || !existsSync(dbPath)) {
    rmSync(dbPath, { force: true });
    const started = performance.now();
    generate(dbPath, options);
    generation = performance.now() - started;
  }
  // The generator is deterministic, so a cached database is reused; its shape is read back here.
  const probe = new Store(dbPath);
  const heavy = probe.db.prepare("SELECT turn_id, COUNT(*) n FROM tool_calls GROUP BY turn_id ORDER BY n DESC LIMIT 1").get() as { turn_id: number; n: number };
  const fixture: Fixture = {
    dbPath, sessionId: 1, projectId: 1, branch: "main", siblingBranch: "sibling",
    headTurnId: Number((probe.db.prepare("SELECT MAX(id) id FROM turns WHERE session_id = 1 AND id NOT IN (SELECT parent_turn_id FROM turns WHERE parent_turn_id IS NOT NULL)").get() as { id: number }).id),
    siblingHeadTurnId: 0, heavyTurnId: heavy.turn_id,
    turnCount: Number((probe.db.prepare("SELECT COUNT(*) n FROM turns").get() as { n: number }).n),
    entryCount: Number((probe.db.prepare("SELECT COUNT(*) n FROM source_entries").get() as { n: number }).n),
    rawChars: Number((probe.db.prepare("SELECT SUM(LENGTH(json_extract(content, '$.raw'))) n FROM source_entries").get() as { n: number }).n),
    factCount: Number((probe.db.prepare("SELECT COUNT(*) n FROM facts").get() as { n: number }).n),
    pathFactCount: 0, knowledgeCount: Number((probe.db.prepare("SELECT COUNT(*) n FROM knowledge_revisions").get() as { n: number }).n),
    pendingEntryCount: 0,
  };
  probe.close();

  const memory = TraceMemory(dbPath, async () => { throw new Error("the performance suite must not call a model"); });
  const store = memory.store;
  const head = fixture.headTurnId;
  const path = { sessionId: fixture.sessionId, headTurnId: head, branch: fixture.branch };
  fixture.pathFactCount = store.listBranchFacts(fixture.sessionId, fixture.branch, head).length;
  fixture.pendingEntryCount = store.pendingEntries(fixture.sessionId, fixture.branch, head).length;
  const citations = store.listBranchFacts(fixture.sessionId, fixture.branch, head).slice(0, 20).map(f => f.id);

  console.log(`\n=== ${size} ===`);
  console.log(`node ${process.version}  ${process.platform}/${process.arch}  repeats=${REPEATS} (first = cold, rest = warm)`);
  console.log(`fixture ${dbPath} (${(statSync(dbPath).size / 1e6).toFixed(1)} MB${generation ? `, generated in ${(generation / 1000).toFixed(1)} s` : ", cached"})`);
  console.log(`  ${fixture.entryCount} source entries, ${(fixture.rawChars / 1e6).toFixed(1)} M Raw characters, ${fixture.turnCount} turns ` +
    `(heaviest T${fixture.heavyTurnId} with ${heavy.n} tool calls), ${fixture.factCount} facts (${fixture.pathFactCount} on this branch), ` +
    `${fixture.knowledgeCount} knowledge revisions, ${fixture.pendingEntryCount} pending entries`);

  const nearPath = { sessionId: fixture.sessionId, branch: fixture.branch, headTurnId: head };
  const nearSnapshot = store.pathSnapshot(nearPath);
  const nearFact = { turnId: head, category: "observation" as const, actor: "agent" as const,
    text: "deterministic performance candidate", source: [`T${head}#assistant`], createdAt: "2026-09-13T00:00:00Z" };
  const samples: Sample[] = [
    ...(size === "baseline" ? [notingNearScale(fixture, size, 2_000), notingNearScale(fixture, size, 20_000)] : []),
    measure("noting NEAR capture (one proposed fact)", () => captureNotingNear(store, fixture.sessionId, nearPath, nearSnapshot,
      [nearFact], { facts: [nearFact] }, memory.config.noting.nearThreshold)),
    measure("listBranchFacts", () => store.listBranchFacts(fixture.sessionId, fixture.branch, head)),
    measure("consolidationBatch", () => store.consolidationBatch(fixture.sessionId, fixture.branch, head)),
    measure("branchSummary", () => memory.branchSummary(fixture.sessionId, fixture.branch, head)),
    measure("citationProblem (20 facts)", () => store.citationProblem(citations, "session", path)),
    measure("pendingEntries (whole selected path)", () => store.pendingEntries(fixture.sessionId, fixture.branch, head)),
    measure("taskEligibility noting (the trigger alone)", () => memory.taskEligibility("noting", { ...path, headTurnId: head }),
      `${fixture.pendingEntryCount} pending entries`),
    // Keep the historical synthetic workload comparable: current progress plus one session's spend.
    // The live footer instead reports today's database-wide spend, so this is not its full refresh.
    measure("progress plus session spend", () => {
      memory.progress(fixture.sessionId, fixture.branch, head);
      memory.spend(fixture.sessionId);
    }, "synthetic progress + session spend; not the live footer's daily database total"),
    measure("footer progress alone (enabled)", () => memory.progress(fixture.sessionId, fixture.branch, head),
      `notes ${fixture.pendingEntryCount}->${fixture.pathFactCount}, memory facts->changed/current Knowledge`),
    // 22c: one full tool occurrence inside the Turn with 40 tool calls.
    measure("trace full (heavy Turn, one occurrence)", () => memory.trace(`T${fixture.heavyTurnId}`, { tool: 1, full: true }),
      `T${fixture.heavyTurnId}, ${store.listToolCalls(fixture.heavyTurnId).length} tool calls`),
    // 23b: the same Turn assembled from its entries under the tier-1 profile — the same Turn-scoped read.
    measure("trace assembled (heavy Turn, no full)", () => memory.trace(`T${fixture.heavyTurnId}`),
      `T${fixture.heavyTurnId}, ${store.listSourceEntries(fixture.sessionId, fixture.heavyTurnId).length} entries`),
    ...deliveryScenarios(fixture, size),
    ...dreamingScenarios(size),
    ...await searchScenarios(fixture, size),
    ...await capacityScenarios(fixture, size, memory),
    ...await spendScenarios(fixture, size),
    ...await disabledHost(fixture, size),
    ...await triggerBacklog(fixture, size),
    ...await hostReconciliation(size, options.entries),
  ];
  memory.close();

  const width = Math.max(...samples.map(s => s.name.length));
  console.log(`\n${"scenario".padEnd(width)} ${"cold ms".padStart(9)} ${"warm ms".padStart(9)} ${"p95 ms".padStart(9)} ${"reads".padStart(9)}  note`);
  for (const s of samples) {
    if (Number.isNaN(s.cold)) { console.log(s.name); continue; }
    console.log(`${s.name.padEnd(width)} ${ms(s.cold)} ${ms(s.warm)} ${ms(s.p95)} ${String(s.reads).padStart(9)}  ${s.note}`);
  }
}

for (const size of sizes) await runSize(size);
