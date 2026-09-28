// 101: Claude Code's Read, Grep and Glob on /tm. The function hook answers only an exact /tm path and
// hands every other call to `next` untouched, since its own answer skips Claude Code's permission and
// path checks; `cc.cjs fs` serves the files for the native session's bound reader and writes nothing.
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { runCcCommand } from "../../src/hosts/cc/index.ts";
import { MEMORY_READ_ONLY } from "../../src/core/model/address.ts";
import { Store } from "../../src/core/store/index.ts";
import { fact, knowledge } from "../support/seed.ts";
import { TraceMemory } from "../../src/core/api/index.ts";

type Hook = (host: any, event: any, next: any) => Promise<any> | any;
const hooks = new Map<string, Hook>();
beforeAll(async () => {
  const output = await build({ entryPoints: [resolve("plugin/hooks/index.tsx")], bundle: true, write: false,
    format: "esm", platform: "neutral", jsx: "transform", jsxFactory: "jsx" });
  const { register } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0]!.contents).toString("base64")}`);
  register((name: string, ...args: any[]) => { if (name === "tool.call") hooks.set(args[0].tool, args.at(-1)); });
});

function host(reply: unknown = { lines: ["line one"], startLine: 1, totalLines: 1 }, exitCode = 0) {
  const run = vi.fn(async (_argv: string[]) => exitCode ? { exitCode, stdout: "", stderr: "Trace Memory CC: session S9 does not exist" }
    : { exitCode: 0, stdout: JSON.stringify(reply), stderr: "" });
  const next = vi.fn(async (_event: unknown) => ({ result: "native" }));
  return { $: { plugin: { root: "/plugin" }, session: { id: async () => "native-1" }, process: { run } }, run, next };
}
const fs = (...args: string[]) => ["node", "/plugin/dist/cc.cjs", "fs", "--config", "/plugin/cc.config.json", "--session", "native-1", ...args];

test("every path that is not exactly /tm reaches the real tool untouched and runs nothing", async () => {
  const outside = ["/tmp/K1", "/tm-foo/K1", "/tmx", "/TM/K1", "/tm/../etc/passwd", "/tm/S1/../../private/secret", "tm/K1", "./tm/K1",
    "~/tm/K1", "/private/tm/K1", "/Users/me/link-to-tm/K1", undefined];
  for (const path of outside) {
    for (const [tool, event] of [["Read", { file_path: path }], ["Grep", { pattern: "x", path }], ["Glob", { pattern: path ?? "*" }],
      ["Glob", { pattern: "*", path }], ["Edit", { file_path: path, old_string: "a", new_string: "b" }], ["Write", { file_path: path, content: "x" }],
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

test("Read, Grep and Glob under /tm are answered by cc.cjs fs for this session, in their tools' own result shapes", async () => {
  let h = host({ lines: ["a", "b"], startLine: 3, totalLines: 9, cut: "[lines 5-9 of 9 not shown; continue with offset=5]" });
  expect(await hooks.get("Read")!(h.$, { tool: "Read", file_path: "/tm//K1/", offset: 3, limit: 2 }, h.next)).toEqual({ result: { type: "text",
    file: { filePath: "/tm//K1/", content: "a\nb\n[lines 5-9 of 9 not shown; continue with offset=5]", numLines: 3, startLine: 3, totalLines: 9 } } });
  expect(h.run).toHaveBeenCalledExactlyOnceWith(fs("read", "/tm/K1", "3", "2"));
  expect(h.next).not.toHaveBeenCalled();

  h = host({ lines: ["/tm/S1/T2", "/tm/S1/T2/E4"] });
  expect(await hooks.get("Grep")!(h.$, { tool: "Grep", pattern: "-hashline", path: "/tm/S1", "-i": true }, h.next))
    .toEqual({ result: { mode: "files_with_matches", numFiles: 2, filenames: ["/tm/S1/T2", "/tm/S1/T2/E4"] } });
  expect(h.run).toHaveBeenCalledExactlyOnceWith(fs("grep", "-l", "-i", "--", "-hashline", "/tm/S1"));

  h = host({ lines: ["/tm/K1:1:x"], cut: "[more matching lines follow; continue with offset=1]" });
  expect(await hooks.get("Grep")!(h.$, { tool: "Grep", pattern: "x", path: "/tm", output_mode: "content", "-C": 2, "-A": 1,
    glob: "E*", offset: 4, head_limit: 10 }, h.next)).toEqual({ result: { mode: "content", numFiles: 0, filenames: [],
    content: "/tm/K1:1:x\n[more matching lines follow; continue with offset=1]", numLines: 2 } });
  expect(h.run).toHaveBeenCalledExactlyOnceWith(fs("grep", "-n", "-C", "2", "-A", "1", "--glob", "E*", "--offset", "4", "--limit", "10", "--", "x", "/tm"));

  h = host({ lines: ["/tm/S1/T2", "/tm/S1/T3"] });
  expect(await hooks.get("Glob")!(h.$, { tool: "Glob", pattern: "S1/T*", path: "/tm" }, h.next))
    .toEqual({ result: { durationMs: 0, numFiles: 2, filenames: ["/tm/S1/T2", "/tm/S1/T3"], truncated: false } });
  expect(h.run).toHaveBeenCalledExactlyOnceWith(fs("glob", "/tm/S1/T*"));
});

test("edits and writes under /tm are refused with a pointer to note and memory; a failed read is refused with its reason", async () => {
  for (const [tool, event] of [["Edit", { file_path: "/tm/K1", old_string: "a", new_string: "b" }], ["Write", { file_path: "/tm/S1/new", content: "x" }],
    ["NotebookEdit", { notebook_path: "/tm/K1", new_source: "x" }]] as const) {
    const h = host();
    expect(await hooks.get(tool)!(h.$, { tool, ...event }, h.next)).toEqual({ deny: MEMORY_READ_ONLY });
    expect(h.next).not.toHaveBeenCalled();
  }
  expect(MEMORY_READ_ONLY).toMatch(/note.*memory/);
  const h = host(undefined, 1);
  expect(await hooks.get("Read")!(h.$, { tool: "Read", file_path: "/tm/S9" }, h.next)).toEqual({ deny: "session S9 does not exist" });
  expect(h.next).not.toHaveBeenCalled();
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("cc.cjs fs reads for the bound native session, accepts combined grep flags, and leaves the database unchanged", async () => {
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
  expect((await cli("read", "/tm/knowledge")).lines).toEqual([expect.stringMatching(/^\/tm\/K1  \[constraint\/project\] Hashline uses an LRU cache\.$/)]);
  const combined = await cli("grep", "-in", "HASHLINE", `/tm/S${core}`);
  expect(combined).toEqual(await cli("grep", "-n", "-i", "HASHLINE", `/tm/S${core}`));
  expect(combined.lines.length).toBeGreaterThan(1);
  for (const line of combined.lines) expect(line).toMatch(new RegExp(`^/tm/S${core}/T\\d+(/E\\d+)?:\\d+:.*hashline`, "i"));
  expect((await cli("grep", "-ic", "hashline", `/tm/S${core}`)).lines.every((line: string) => /:\d+$/.test(line))).toBe(true);
  expect((await cli("read", `/tm/S${core}/knowledge`)).lines).toContain(`Session S${core}: a subagent inherits this session's knowledge by reading /tm/S${core}/knowledge.`);
  expect((await cli("glob", `/tm/S${core}/*/*`)).lines).toEqual([expect.stringMatching(new RegExp(`^/tm/S${core}/T\\d+/E1$`)), expect.stringMatching(/E2$/)]);
  await expect(cli("write", "/tm/K1")).rejects.toThrow(/read-only/);
  // A native session with no binding reads unbound: explicit addresses, and no visible knowledge.
  const unbound = async (...args: string[]) => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { written.push(String(chunk)); return true; });
    try { await runCcCommand(["fs", "--config", configPath, "--session", "never-bound", ...args]); } finally { spy.mockRestore(); }
    return JSON.parse(written.join(""));
  };
  expect((await unbound("read", "/tm/knowledge")).lines).toEqual(["(empty)"]);
  expect((await unbound("read", "/tm/K1")).lines.join("\n")).toContain("Hashline uses an LRU cache.");
  expect(digest()).toBe(before);
});
