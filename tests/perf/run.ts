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
import { generate, countSourceReads, type Fixture } from "./fixture.ts";
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
    measure("footer counts (enabled)", () => {
      store.listBranchFacts(fixture.sessionId, fixture.branch, head).length;
      store.listCurrentKnowledge({ sessionId: fixture.sessionId, headTurnId: head }).length;
      memory.spend(fixture.sessionId);
    }, "the three reads showSpend makes"),
    ...await disabledHost(fixture, size),
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
