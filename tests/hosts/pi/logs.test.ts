// Ticket 24c — where a native worker writes its log, and whether an external file-based daily-cost
// reader can find it. Every case uses a temporary agent root (`PI_CODING_AGENT_DIR`, set by
// test-host.ts); nothing here reads the real `~/.pi/agent` or `~/.trace-memory`, and no request
// leaves the process.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { noteAndMemory, fixture, forkFixture, noteBatch, say, settled, toolResults, worker } from "./native-fixture.ts";
import { host } from "./test-host.ts";

const notingRun = (body: Record<string, any>) =>
  !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : noteAndMemory("t1", noteBatch);
const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
const assistants = (file: string) => lines(file).filter(entry => entry.type === "message" && entry.message.role === "assistant");
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
/** Every `.jsonl` under a directory, at any depth. */
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".jsonl") ? [join(dir, entry.name)] : []);

// ------------------------------------------------------------------ checkbox 1: the log location

test("24c: with no runsDir configured a fork's log is a direct child of sessions/trace-memory, keeping its linkage, history and usage", async () => {
  const f = await forkFixture();
  try {
    f.script(notingRun);
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    const log = response.nativeLog as string;

    // Exactly one directory level under Pi's own sessions root, with Pi's native filename.
    expect(dirname(log)).toBe(join(f.agentDir, "sessions", "trace-memory"));
    expect(dirname(dirname(log))).toBe(f.sessionsRoot);
    expect(log.split("/").at(-1)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]+\.jsonl$/);
    // The audit names the file that really exists, and it is the child's own session.
    expect(statSync(log).isFile()).toBe(true);
    const child = lines(log);
    expect(child[0].type).toBe("session");
    expect(child[0].id).not.toBe(f.original.id);
    // Native parent/child linkage: the header points back at the parent's own file.
    expect(child[0].parentSession).toBe(f.original.file);
    // Source-entry identities: the copied ancestry keeps the parent's own entry ids, byte-identical
    // messages and original timestamps — nothing was cleared to please a statistics consumer.
    const parent = lines(f.original.file);
    const inherited = parent.filter(entry => child.some(c => c.id === entry.id));
    expect(inherited.length).toBeGreaterThan(0);
    for (const entry of inherited) {
      const copy = child.find(c => c.id === entry.id)!;
      expect(copy.timestamp).toBe(entry.timestamp);
      expect(copy.message).toEqual(entry.message);
    }
    // Tool history and usage of the child's own work.
    const text = readFileSync(log, "utf8");
    expect(text).toContain('"toolCall"');
    expect(text).toContain('"note"');
    expect(text).toContain('"toolResult"');
    const own = assistants(log).filter(entry => !parent.some(p => p.id === entry.id));
    expect(own.length).toBeGreaterThanOrEqual(2); // the note call, then the closing reply
    for (const entry of own) expect(entry.message.usage.totalTokens).toBeGreaterThan(0);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
  } finally { await f.dispose(); }
}, 20000);

test("24c: a fresh subagent's log is a direct child of the same directory — no per-parent level, and no directories inside it", async () => {
  const f = await fixture({ "noting.forkModeDefault": false });
  try {
    f.script(notingRun);
    await f.turn();
    const run = await settled(f);
    expect(run.mode).toBe("subagent");
    const log = JSON.parse(run.response!).nativeLog as string;
    expect(dirname(log)).toBe(f.runsDir);
    // No parent-session directory anywhere on the path: one level, shared by every parent.
    expect(log).not.toContain(f.original.id);
    expect(readdirSync(f.runsDir).every(name => statSync(join(f.runsDir, name)).isFile())).toBe(true);
    // A fresh child, not a fork: none of the parent's entry ids are in it.
    const parent = new Set(lines(f.original.file).map(entry => entry.id));
    expect(lines(log).filter(entry => parent.has(entry.id))).toEqual([]);
    expect(lines(log)[0].parentSession).toBeUndefined();
  } finally { await f.dispose(); }
}, 20000);

test("24c: an explicit runsDir keeps 19a's precedence and its per-parent layout", async () => {
  const custom = mkdtempSync(join(tmpdir(), "trace-memory-runs-"));
  const f = await fixture({ runsDir: custom });
  try {
    f.script(notingRun);
    await f.turn();
    const run = await settled(f);
    const log = JSON.parse(run.response!).nativeLog as string;
    expect(dirname(log)).toBe(join(custom, f.original.id)); // <runsDir>/<parent Pi session id>/
    expect(existsSync(log)).toBe(true);
    expect(existsSync(f.runsDir)).toBe(false); // the superseded default was not used at all
  } finally { await f.dispose(); rmSync(custom, { recursive: true, force: true }); }
}, 20000);

test("82 Settings omits worker-log diagnostics without changing configured runsDir", async () => {
  const outside = join(tmpdir(), "trace-memory-outside");
  const h = host({ runsDir: outside });
  try {
    await h.emit("session_start");
    const before = readFileSync(join(h.dir, "agent", "settings.json"));
    h.ctx.hasUI = true;
    h.answers.push("Settings…", undefined); await command(h, "");
    expect(h.dialogs.at(-1)!.title).toContain("Knowledge budgets");
    expect(h.dialogs.at(-1)!.title).not.toContain("Worker logs:");
    expect(h.dialogs.at(-1)!.title).not.toContain("outside Pi's scanned sessions tree");
    expect(readFileSync(join(h.dir, "agent", "settings.json"))).toEqual(before);
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
});

test("24c: changing the default moves nothing — an earlier run's recorded path and its log's bytes are untouched", async () => {
  // A shared database and an "old" runs directory, both outside either host's temporary tree.
  const shared = mkdtempSync(join(tmpdir(), "trace-memory-shared-"));
  const dbPath = join(shared, "trace.db"), old = join(shared, "runs");
  try {
    const before = await fixture({ dbPath, runsDir: old });
    let oldLog: string, oldRun: string;
    try {
      before.script(notingRun);
      await before.turn();
      const run = await settled(before);
      oldLog = JSON.parse(run.response!).nativeLog as string;
      oldRun = run.response!;
      expect(dirname(oldLog)).toBe(join(old, before.original.id));
    } finally { await before.dispose(); }
    const bytes = readFileSync(oldLog), stamp = statSync(oldLog).mtimeMs;

    // A second session on the same database, now on the 24c default.
    const after = await fixture({ dbPath });
    try {
      after.script(notingRun);
      await after.turn();
      // The second Pi session is the second memory session in the shared database.
      const run = await vi.waitFor(() => { const found = after.h.memory.store.listRuns(2).find(r => r.response); expect(found).toBeTruthy(); return found!; }, { timeout: 5000 });
      expect(dirname(JSON.parse(run.response!).nativeLog)).toBe(after.runsDir);
      // The first run's audited path and its file are exactly as they were: not moved, not copied,
      // not rewritten, and no new file joined the old directory.
      expect(after.h.memory.store.listRuns(1)[0]!.response).toBe(oldRun);
      expect(readFileSync(oldLog)).toEqual(bytes);
      expect(statSync(oldLog).mtimeMs).toBe(stamp);
      expect(readdirSync(join(old, before.original.id))).toHaveLength(1);
      expect(readdirSync(old)).toEqual([before.original.id]);
    } finally { await after.dispose(); }
  } finally { rmSync(shared, { recursive: true, force: true }); }
}, 30000);

test("24c: the external reader is not a dependency — no shipped file names it and no manifest entry declares it", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
  const named = sources(join(root, "src")).filter(file => /pi-statusline|usage-spend|pi-extensions/.test(readFileSync(file, "utf8")));
  expect(named).toEqual([]);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies });
  expect(declared.filter(name => /statusline|pi-extensions/.test(name))).toEqual([]);
});

// ---------------------------------------------------- checkbox 2: daily statistics compatibility
//
// The consumer is the user's working copy of pi-statusline's `usage-spend.ts`, imported here by
// absolute path. It is deliberately NOT a dependency of this repository: nothing in `src/` refers to
// it, and this is the only place that loads it. When the checkout is absent the case skips rather
// than failing, because Trace Memory does not require pi-statusline to work.
const readerPath = join(homedir(), "Projects", "pi-extensions", "packages", "pi-statusline", "src", "usage-spend.ts");
const reader: { sumProviderSpend(dir: string, provider: string, sinceMs: number): Promise<number>;
  entryCost(entry: unknown, provider: string, sinceMs: number): number } | undefined =
  existsSync(readerPath) ? await import(readerPath) : undefined;

test.skipIf(!reader)("24c: the external daily reader charges every new worker response once, never an inherited one, and drops entries outside its window", async () => {
  const { sumProviderSpend, entryCost } = reader!;
  const f = await forkFixture();
  try {
    // $1 per token on both sides: every scripted reply below reports 10 input and 2 output tokens,
    // so each billable response is worth exactly $12 and the arithmetic is checkable by hand.
    (f.model as { cost: unknown }).cost = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
    const REPLY = 12;
    // Every worker reply is the same three words, so identical text cannot be what tells two
    // responses apart.
    // 26a: a Noting worker completes its batch by submitting; with nothing to record it sends `{facts: []}`.
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : noteAndMemory("t1", { facts: [] }));
    await f.turn();                        // the parent's own reply, then a fork noting run
    await settled(f);
    await f.turn("tick", { capture: false });  // a second parent reply, too small to trigger anything
    await f.h.commands.get("trace").handler("catchup", f.h.ctx); // drains it as an independent subagent
    await vi.waitFor(() => expect(f.h.memory.store.listRuns(1).filter(run => run.response)).toHaveLength(2), { timeout: 8000 });
    expect(f.h.memory.store.listRuns(1).map(run => run.mode)).toEqual(["fork", "subagent"]);

    // Ground truth is a full recursive walk of the tree, so the reader — not the test's own
    // bookkeeping — is what has to find the worker logs wherever they were put.
    const root = f.sessionsRoot;
    expect(readdirSync(root).sort()).toEqual(["parent", "trace-memory"]);
    const files = walk(root);
    expect(files).toHaveLength(3); // the parent, its fork, and the independent subagent
    const entries = files.flatMap(file => assistants(file));
    const distinct = new Set(entries.map(entry => entry.id));

    // Every response this process really made, charged exactly once. `f.sent` is the wire: one
    // request, one reply, whether the parent's, the fork's or the subagent's.
    const all = await sumProviderSpend(root, "fake", 0);
    expect(distinct.size).toBe(f.sent.length);
    expect(all).toBe(f.sent.length * REPLY);
    // The fork really carries the parent's reply forward, so a consumer without deduplication would
    // charge more than there is: this reader does not.
    const perEntry = files.flatMap(file => lines(file)).reduce((sum, entry) => sum + entryCost(entry, "fake", 0), 0);
    expect(perEntry).toBe(entries.length * REPLY);
    expect(entries.length).toBeGreaterThan(distinct.size);

    // Identical text, distinct responses: the fork's reply and the subagent's reply are both
    // "Done.", written to different files, and both are charged.
    const done = entries.filter(entry => JSON.stringify(entry.message.content).includes("Done."));
    expect(new Set(done.map(entry => entry.id)).size).toBe(2);

    // The day boundary is the consumer's own. A window that starts just after the parent's first
    // reply drops it — and drops the fork's inherited copy of it too, although that file was written
    // inside the window and every other entry in it still counts.
    const first = assistants(join(f.sessionsDir, readdirSync(f.sessionsDir)[0]!))[0]!;
    const boundary = Date.parse(first.timestamp) + 1;
    expect(entries.filter(entry => Date.parse(entry.timestamp) < boundary).map(entry => entry.id)).toEqual([first.id, first.id]);
    const fork = files.find(file => dirname(file) === f.runsDir && lines(file).some(entry => entry.id === first.id))!;
    expect(fork).toBeTruthy();                                        // the fork holds the copy
    expect(statSync(fork).mtimeMs).toBeGreaterThanOrEqual(boundary);  // and is itself in the window
    expect(await sumProviderSpend(root, "fake", boundary)).toBe(all - REPLY);

    // Another provider's day is not ours, and a tree with no sessions costs nothing.
    expect(await sumProviderSpend(root, "someone-else", 0)).toBe(0);
    expect(await sumProviderSpend(join(root, "nonexistent"), "fake", 0)).toBe(0);
  } finally { await f.dispose(); }
}, 30000);
