// The serial performance runner (ticket 22 "Workloads and acceptance"). Not part of `npm test`:
// `npm run perf` invokes it, one scenario at a time, and prints the runtime version, the fixture
// size and the warm/cold state with every number. No provider traffic: the fake host's wire is not
// even installed, and the run asserts that no request was made.
//
//   npm run perf                 both sizes
//   npm run perf -- baseline     one size
//   npm run perf -- --rebuild    regenerate the cached fixture databases
//   npm run perf -- --repeats=3  fewer samples per scenario (the first is always the cold one)

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, nativeAncestry, countSourceReads, countGraphResolutions, searchCorpus, type Fixture } from "./fixture.ts";
import { TraceMemory } from "../../src/core/api/index.ts";
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
    if (!status.includes("Disabled")) throw new Error(`disabled footer does not say Disabled: ${status}`);
    samples.push({ name: `  footer text: ${status}`, cold: NaN, warm: NaN, p95: NaN, reads: 0, note: "" });
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
    const pending = memory.pendingEntries(fixture.sessionId, fixture.branch, head).length;
    return [
      measure("pendingEntries (whole backlog pending)", () => memory.pendingEntries(fixture.sessionId, fixture.branch, head), `${pending} pending entries`),
      measure("taskEligibility noting (whole backlog pending)", () => memory.taskEligibility("noting", target, "subagent"), `${pending} pending entries`),
    ];
  } finally { memory.close(); rmSync(copy, { force: true }); }
}

/** Ticket 22b, hotspot families 1 and 2: the host's own reconciliation. A fresh fake host is given a
 * long native ancestry and nothing else; `/trace enable` is the one-time import, `/trace enable` again
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
    await command("enable");
    single("host /trace enable (import)", performance.now() - started, counter.reads(), `${ancestry.length} native entries, single shot`);
    counter.reset();
    started = performance.now();
    await command("enable");
    single("host /trace enable (repeat)", performance.now() - started, counter.reads(), "already reconciled");

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

  const samples: Sample[] = [
    measure("listBranchFacts", () => store.listBranchFacts(fixture.sessionId, fixture.branch, head)),
    measure("consolidationBatch", () => store.consolidationBatch(fixture.sessionId, fixture.branch, head)),
    measure("branchSummary", () => memory.branchSummary(fixture.sessionId, fixture.branch, head)),
    measure("citationProblem (20 facts)", () => store.citationProblem(citations, "session", path)),
    measure("pendingEntries (whole selected path)", () => store.pendingEntries(fixture.sessionId, fixture.branch, head)),
    measure("taskEligibility noting (the trigger alone)", () => memory.taskEligibility("noting", { ...path, headTurnId: head }, "subagent"),
      `${fixture.pendingEntryCount} pending entries`),
    measure("footer counts (enabled)", () => {
      store.listBranchFacts(fixture.sessionId, fixture.branch, head).length;
      store.listCurrentKnowledge({ sessionId: fixture.sessionId, headTurnId: head }).length;
      memory.spend(fixture.sessionId);
    }, "the three reads showSpend makes"),
    // 22c: one full tool occurrence inside the Turn with 40 tool calls.
    measure("trace full (heavy Turn, one occurrence)", () => memory.trace(`T${fixture.heavyTurnId}`, { tool: 1, full: true }),
      `T${fixture.heavyTurnId}, ${store.listToolCalls(fixture.heavyTurnId).length} tool calls`),
    ...await searchScenarios(fixture, size),
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
