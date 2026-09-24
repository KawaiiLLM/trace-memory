import { afterEach, expect, test, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSessionStart, bindingPath, readBinding } from "../../src/hosts/cc/binding.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readCcMenu } from "../../src/hosts/cc/menu.ts";
import { runCcCommand } from "../../src/hosts/cc/index.ts";
import { databaseIdentity, encodeCcInjection } from "../../src/hosts/cc/injection.ts";
import type { CcContextSnapshot } from "../../src/hosts/cc/menu-context.ts";

const monitor = vi.hoisted(() => ({ path: "", attempts: [] as string[] }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const check = (path: unknown, operation: string) => {
    if (String(path) === monitor.path) { monitor.attempts.push(operation); throw new Error(`menu attempted transcript ${operation}`); }
  };
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => { check(args[0], "open"); return fs.openSync(...args); },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => { check(args[0], "read"); return fs.readFileSync(...args); },
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => { check(args[0], "stream"); return fs.createReadStream(...args); },
  };
});
const dirs: string[] = [];
afterEach(() => { monitor.path = ""; monitor.attempts = []; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("menu opens neither small nor grown native transcript, including the actual CLI read path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-82-no-transcript-")); dirs.push(dir);
  const session = "fresh-native", transcript = join(dir, "native.jsonl"), configPath = join(dir, "cc.config.json");
  const input = { dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state") };
  writeFileSync(configPath, JSON.stringify(input));
  const config = resolveCcHostConfig(input);
  await recordSessionStart(config, { hook_event_name: "SessionStart", source: "startup", session_id: session, transcript_path: transcript }, null);
  readCcMenu(config, session); // Prepare the isolated DB before constructing its identity-bearing envelope.
  const original = encodeCcInjection({ db: databaseIdentity(config.dbPath), nativeSession: session, coreSession: null },
    { text: "<knowledge>\nFresh retained memory\n</knowledge>", knowledgeCommitIds: [] });
  const snapshot: CcContextSnapshot = { session, messages: [{ role: "user", content: [{ type: "text",
    text: `<system-reminder>\nSessionStart hook additional context: ${original}\n</system-reminder>` }] }] };
  const warning = "Trace Memory: compaction omitted 1 pending Raw entry; they remain pending for Noting and Consolidation.";
  writeFileSync(bindingPath(config, session), JSON.stringify({ ...readBinding(config, session), lastCompactionNotice: warning }));
  writeFileSync(transcript, '{"type":"progress","data":"old"}\n');
  monitor.path = transcript;
  const first = readCcMenu(config, session, undefined, 10, null, snapshot);
  expect(first.context.presence).toBe("confirmed");
  expect(first.context.memory!.knowledge).toBeGreaterThan(0);
  expect(first.menu.notices).toContain(warning);
  // Grow only irrelevant native history to 150+ MB. Zero read/open calls is a deterministic
  // cost bound, unlike a flaky wall-clock assertion on a shared development machine.
  const chunk = `${JSON.stringify({ type: "progress", data: "x".repeat(4096) })}\n`.repeat(1024);
  for (let i = 0; i < 38; i++) appendFileSync(transcript, chunk);
  const grown = readCcMenu(config, session, undefined, 10, null, snapshot);
  expect(grown).toEqual(first);
  let output = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  try { await runCcCommand(["cli", "--config", configPath, "--session", session, "menu", "--json"]); }
  finally { stdout.mockRestore(); }
  expect(JSON.parse(output).menu.notices).toContain(warning);
  expect(monitor.attempts).toEqual([]);
});
