// 101: Claude Code's Read on trace://. The function hook answers only an exact trace:// path and
// hands every other call to `next` untouched, since its own answer skips Claude Code's permission and
// path checks; `cc.cjs fs` serves the files for the native session's bound reader and writes nothing.
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { runCcCommand } from "../../src/hosts/cc/index.ts";
import { MEMORY_READ_ONLY } from "../../src/core/model/address.ts";
import { Store } from "../../src/core/store/index.ts";
import { entry, fact, knowledge } from "../support/seed.ts";
import { TraceMemory } from "../../src/core/api/index.ts";
import { materializeCcWorkerRead, runCcFiles } from "../../src/hosts/cc/files.ts";
import { recorded } from "../source-fixture.ts";
import { z } from "zod";

type Hook = (host: any, event: any, next: any) => Promise<any> | any;
const hooks = new Map<string, Hook>();
beforeAll(async () => {
  const output = await build({ entryPoints: [resolve("plugin/hooks/index.tsx")], bundle: true, write: false,
    format: "esm", platform: "neutral", jsx: "transform", jsxFactory: "jsx" });
  const { register } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0]!.contents).toString("base64")}`);
  register((name: string, ...args: any[]) => { if (name === "tool.call") hooks.set(args[0].tool, args.at(-1)); });
});

function host(reply: unknown = { content: "whole", unbounded: true }, exitCode = 0) {
  const run = vi.fn(async (_argv: string[]) => exitCode ? { exitCode, stdout: "", stderr: "Trace Memory CC: session S9 does not exist" }
    : { exitCode: 0, stdout: JSON.stringify(reply), stderr: "" });
  const next = vi.fn(async (_event: unknown) => ({ result: "native" }));
  return { $: { plugin: { root: "/plugin" }, session: { id: async () => "native-1" }, process: { run } }, run, next };
}
const fs = (...args: string[]) => ["node", "/plugin/dist/cc.cjs", "fs", "--config", "/plugin/cc.config.json", "--session", "native-1", ...args];

test("every path that does not start with exactly trace:// reaches the real tool untouched and runs nothing", async () => {
  // 128: `/tm` is an ordinary path now, and so is every lookalike of the scheme.
  const outside = ["/tm", "/tm/K1", "/tm/knowledge/S1", "/tmp/K1", "Trace://K1", "TRACE://K1", "trace:/K1", "trace:K1", "xtrace://K1",
    "./trace://K1", "/private/trace://K1", "tm/K1", undefined];
  for (const path of outside) {
    for (const [tool, event] of [["Read", { file_path: path }],
      ["Edit", { file_path: path, old_string: "a", new_string: "b" }], ["Write", { file_path: path, content: "x" }],
      ["NotebookEdit", { notebook_path: path, new_source: "x" }]] as const) {
      const h = host();
      const e = { tool, ...event };
      expect(await hooks.get(tool)!(h.$, e, h.next)).toEqual({ result: "native" });
      expect(h.next).toHaveBeenCalledExactlyOnceWith(e);
      expect(h.next.mock.calls[0]![0]).toBe(e);
      expect(h.run).not.toHaveBeenCalled();
    }
  }
});

// 137: Claude Code main sessions have no Grep or Glob tool, so no hook answers them; a call on a trace://
// path reaches the host unchanged, and the host rejects it.
test("no hook is registered for Grep or Glob", () => {
  for (const tool of ["Read", "Edit", "Write", "NotebookEdit"]) expect(hooks.has(tool), tool).toBe(true);
  for (const tool of ["Grep", "Glob"]) expect(hooks.has(tool), tool).toBe(false);
});

test("Read under trace:// is answered by cc.cjs fs for this session, in its own result shape", async () => {
  let h = host();
  const ordinary = { tool: "Read", file_path: "trace:///K1/", offset: 3, limit: 2 };
  expect(await hooks.get("Read")!(h.$, ordinary, h.next)).toEqual({ result: "native" });
  expect(h.next).toHaveBeenCalledExactlyOnceWith(ordinary);
  expect(h.run).not.toHaveBeenCalled();
  h = host({ content: "whole\nknowledge", unbounded: true });
  expect(await hooks.get("Read")!(h.$, { tool: "Read", file_path: "trace:///knowledge/S2/T3" }, h.next)).toEqual({ result: { type: "text",
    file: { filePath: "trace:///knowledge/S2/T3", content: "whole\nknowledge", numLines: 2, startLine: 1, totalLines: 2 } } });
  expect(h.run).toHaveBeenCalledExactlyOnceWith(fs("read", "trace://knowledge/S2/T3"));
  expect(h.next).not.toHaveBeenCalled();
  for (const path of ["trace://compact/S2", "trace://compact/S2/T3"]) {
    h = host({ content: "whole\ncompact", unbounded: true });
    expect(await hooks.get("Read")!(h.$, { tool: "Read", file_path: path }, h.next)).toMatchObject({ result: {
      file: { filePath: path, content: "whole\ncompact", startLine: 1, totalLines: 2 } } });
    expect(h.run).toHaveBeenCalledExactlyOnceWith(fs("read", path));
    expect(h.next).not.toHaveBeenCalled();
  }
  h = host({ content: "whole\nentry", unbounded: true });
  const exact = { tool: "Read", file_path: "trace://raw/S2/T3#E4@assistant" };
  expect(await hooks.get("Read")!(h.$, exact, h.next)).toMatchObject({ result: { file: { filePath: exact.file_path, content: "whole\nentry" } } });
  expect(h.run).toHaveBeenCalledExactlyOnceWith(fs("read", exact.file_path));
});

test("edits and writes under trace:// are refused with a pointer to note and memory; a failed read is refused with its reason", async () => {
  for (const [tool, event] of [["Edit", { file_path: "trace://K1", old_string: "a", new_string: "b" }], ["Write", { file_path: "trace://S1/new", content: "x" }],
    ["NotebookEdit", { notebook_path: "trace://K1", new_source: "x" }]] as const) {
    const h = host();
    expect(await hooks.get(tool)!(h.$, { tool, ...event }, h.next)).toEqual({ deny: MEMORY_READ_ONLY });
    expect(h.next).not.toHaveBeenCalled();
  }
  expect(MEMORY_READ_ONLY).toContain("trace://");
  const h = host(undefined, 1);
  expect(await hooks.get("Read")!(h.$, { tool: "Read", file_path: "trace://knowledge/S9" }, h.next)).toEqual({ deny: "session S9 does not exist" });
  expect(h.next).not.toHaveBeenCalled();
});

test("the command hook sees Claude Code's cwd-resolved path, rewrites only trace:// reads and ignores /tm", () => {
  const cwd = "/work/project";
  const hook = (file_path: string) => spawnSync(process.execPath, [resolve("plugin/hooks/read.mjs")], { encoding: "utf8",
    env: { PATH: process.env.PATH }, input: JSON.stringify({ tool_name: "Read", session_id: "s", cwd, tool_input: { file_path } }) });
  // No plugin root in this environment, so a matched read ends in a refusal naming that, and an unmatched one in silence.
  for (const matched of [`${cwd}/trace:/K1`, `${cwd}/trace:`, `${cwd}/trace:/facts/S1/T2`, "trace://K1", "trace:///K1"]) {
    const { stdout } = hook(matched);
    expect(JSON.parse(stdout).hookSpecificOutput, matched).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("plugin root") });
  }
  for (const unmatched of ["/tm/K1", "/tm", `${cwd}/tm/K1`, `${cwd}/Trace:/K1`, "Trace://K1", "trace:/K1", "/other/trace:/K1",
    // Whole views are the function hook's.
    `${cwd}/trace:/knowledge/S1`, `${cwd}/trace:/compact/S1/T2`, `${cwd}/trace:/raw/S1/T2#E3`]) {
    const { stdout, status } = hook(unmatched);
    expect({ unmatched, status, stdout }).toEqual({ unmatched, status: 0, stdout: "" });
  }
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("cc.cjs fs reads for the bound native session and leaves the database unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-cc-files-")); dirs.push(dir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });
  const configPath = join(dir, "cc.config.json"), transcriptPath = join(dir, "native.jsonl"), native = "files-native";
  writeFileSync(configPath, JSON.stringify({ dbPath: config.dbPath, stateDir: config.stateDir, baseline: "2025-01-01T00:00:00.000Z" }));
  await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: native, transcript_path: transcriptPath, source: "startup" }, "2026-01-01T00:00:00.000Z");
  writeFileSync(transcriptPath, [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00.000Z", promptId: "p1", promptSource: "typed", userType: "external", message: { role: "user", content: "Which cache does Hashline use?" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "An LRU cache." }] } },
  ].map(value => `${JSON.stringify(value)}\n`).join(""));
  const importer = new CcImporter(config, readBinding(config, native)!);
  try { expect((await importer.reconcile()).state).toBe("ready"); } finally { importer.close(); }
  const core = readBinding(config, native)!.coreSessionId!;
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("no model work"); });
  try {
    const path = memory.store.knowledgePath(core, readBinding(config, native)!.branch);
    const entry = memory.store.hydrateSourceEntries(memory.store.sourcePath(core, path.branch!, path.headTurnId!).map(e => e.id))[0]!;
    const f1 = fact(memory, path, "Cache choice", [{ entry, text: "The user asks which cache Hashline uses." }]);
    knowledge(memory.store, path, "project", "constraint", [f1.id], "Hashline uses an LRU cache.");
  } finally { memory.close(); }

  const digest = () => {
    const store = new Store(config.dbPath), hash = createHash("sha256");
    try {
      for (const { name } of store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
        hash.update(name + JSON.stringify(store.db.prepare(`SELECT * FROM "${name}"`).all()));
    } finally { store.close(); }
    return hash.digest("hex");
  };
  const before = digest();
  const cli = async (...args: string[]) => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { written.push(String(chunk)); return true; });
    try { await runCcCommand(["fs", "--config", configPath, "--session", native, ...args]); } finally { spy.mockRestore(); }
    return JSON.parse(written.join(""));
  };
  // The bound reader's own knowledge, and its session's Turns.
  expect((await cli("read", "trace://knowledge")).content).toMatch(/^trace:\/\/K1  \[constraint\/project\] Hashline uses an LRU cache\.$/);
  expect((await cli("read", `trace://knowledge/S${core}`)).content).toContain("Hashline uses an LRU cache.");
  const compact = await cli("read", `trace://compact/S${core}`);
  expect(compact.unbounded).toBe(true);
  expect(compact.content).toContain("Hashline uses an LRU cache.");
  const first = await cli("materialize", "trace://K1");
  const body = readFileSync(first.path, "utf8");
  writeFileSync(first.path, "stale rendering");
  const second = await cli("materialize", "trace:///K1/");
  expect(second.path).toBe(first.path);
  expect(readFileSync(second.path, "utf8")).toBe(body);
  const other = await cli("materialize", "trace://F1");
  expect(other.path).not.toBe(first.path);
  expect(first.path.startsWith(join(config.stateDir, "rendered", native))).toBe(true);
  // 137: grep and glob were subcommands only for the Grep and Glob hooks, which are gone.
  for (const op of ["grep", "glob"]) await expect(cli(op, "x", "trace://")).rejects.toThrow(/unknown operation/);
  await expect(cli("write", "trace://K1")).rejects.toThrow(/read-only/);
  // A native session with no binding reads unbound: explicit addresses, and no visible knowledge.
  const unbound = async (...args: string[]) => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { written.push(String(chunk)); return true; });
    try { await runCcCommand(["fs", "--config", configPath, "--session", "never-bound", ...args]); } finally { spy.mockRestore(); }
    return JSON.parse(written.join(""));
  };
  expect((await unbound("read", "trace://knowledge")).content).toBe("(empty)");
  expect((await unbound("read", "trace://K1")).content).toContain("Hashline uses an LRU cache.");
  expect(digest()).toBe(before);
});

test("foreground and worker compact reads use native origin roles and preserve legacy SDK user input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm133-cc-human-read-")); dirs.push(dir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });
  const native = "human-reader", transcriptPath = join(dir, "native.jsonl");
  await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: native, transcript_path: transcriptPath, source: "startup" }, "2026-01-01T00:00:00.000Z");
  const human = "<task-notification> quoted literally by a human", sdk = "SDK-generated user entry";
  const queued = "<system-reminder> queued human words", originHuman = "<command- quoted by origin human";
  const meta = "Meta user words are not human";
  writeFileSync(transcriptPath, [
    { uuid: "human", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00.000Z", promptId: "p1", promptSource: "typed", message: { role: "user", content: human } },
    { uuid: "sdk", parentUuid: "human", type: "user", timestamp: "2026-01-01T00:00:01.000Z", promptId: "p2", promptSource: "sdk", message: { role: "user", content: sdk } },
    { uuid: "queued", parentUuid: "sdk", type: "user", timestamp: "2026-01-01T00:00:02.000Z", promptId: "p3", promptSource: "queued", message: { role: "user", content: queued } },
    { uuid: "origin-human", parentUuid: "queued", type: "user", timestamp: "2026-01-01T00:00:03.000Z", promptId: "p4", origin: { kind: "human" }, message: { role: "user", content: originHuman } },
    { uuid: "meta", parentUuid: "origin-human", type: "user", timestamp: "2026-01-01T00:00:04.000Z", promptId: "p5", promptSource: "typed", isMeta: true, message: { role: "user", content: meta } },
    { uuid: "reply", parentUuid: "meta", type: "assistant", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Acknowledged." }] } },
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const importer = new CcImporter(config, readBinding(config, native)!);
  try { expect((await importer.reconcile()).state).toBe("ready"); } finally { importer.close(); }
  const binding = readBinding(config, native)!, core = binding.coreSessionId!;
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("read must not run a model"); });
  const reader = memory.store.knowledgePath(core, binding.branch);
  const prefixes = ["<task-notification", "<system-reminder", "<command-", "Caveat",
    "[Request interrupted", "Another Claude session", "<local-command"];
  const excluded = prefixes.map((prefix, index) => `${prefix} fallback-only-${index}`);
  for (const [index, text] of excluded.entries()) entry(memory.store, core, reader.headTurnId!, `fallback-${index}`, "user", text);
  const ordinary = "Ordinary fallback human words";
  entry(memory.store, core, reader.headTurnId!, "fallback-human", "user", ordinary);
  memory.store.selectSourcePath(core, binding.branch, memory.store.listSourceEntries(core).map(source => source.id));
  try { recorded(memory, core, binding.branch, reader.headTurnId!); } finally { memory.close(); }
  config.coreConfig.compaction.rawTokens = 1; // historical Raw cannot fit or borrow; selection happens in the user tier
  const path = `trace://compact/S${core}`;
  const foreground = z.object({ content: z.string() }).parse(runCcFiles(config, native, ["read", path])).content;
  const worker = readFileSync(materializeCcWorkerRead(config, reader, path, dir), "utf8");
  for (const text of [foreground, worker]) {
    expect(text).toContain("Earlier user messages:");
    expect(text).toContain(human);
    expect(text).toContain(sdk); // 176: origin-less, non-meta SDK prompts retain the user role.
    expect(text).toContain(queued);
    expect(text).toContain(originHuman);
    expect(text).not.toContain(meta);
    for (const omitted of excluded) expect(text).not.toContain(omitted);
    expect(text).toContain(ordinary);
  }
});
