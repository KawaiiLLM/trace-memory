// Ticket 24c — where a native worker writes its log, and whether an external file-based daily-cost
// reader can find it. Every case uses a temporary agent root (`PI_CODING_AGENT_DIR`, set by
// test-host.ts); nothing here reads the real `~/.pi/agent` or `~/.trace-memory`, and no request
// leaves the process.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { noterTurn, fixture, noteBatch, say, settled, toolResults, worker } from "./native-fixture.ts";
import { host } from "./test-host.ts";

const notingRun = (body: Record<string, any>) =>
  !worker(body) ? say("好的。") : noterTurn(body, noteBatch);
const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);

// ------------------------------------------------------------------ checkbox 1: the log location

test("24c: a fresh subagent's log is a direct child of the same directory — no per-parent level, and no directories inside it", async () => {
  const f = await fixture({});
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
    const bytes = readFileSync(oldLog), stamp = statSync(oldLog).mtimeMs, oldFiles = readdirSync(join(old, before.original.id)).sort();
    expect(oldFiles).toHaveLength(2); // one log per task of the batch

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
      expect(readdirSync(join(old, before.original.id)).sort()).toEqual(oldFiles);
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
