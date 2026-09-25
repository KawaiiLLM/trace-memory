import { afterEach, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TraceMemory } from "../../src/core/api/index.ts";
import { bindingPath } from "../../src/hosts/cc/binding.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { databaseIdentity, decodeCcInjection } from "../../src/hosts/cc/injection.ts";
import { encodeCcInjection } from "../../src/hosts/cc/injection.ts";
import { readCcMenu } from "../../src/hosts/cc/menu.ts";
import type { TransportItem } from "../../src/core/render/material.ts";

const root = "/private/tmp/tm-66-implementation.lyQREJ";
const created: string[] = [];
afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("66 parallel 24 clear slots preserve frozen facts, warn once for transport omission and persist menu notice", async () => {
  const dir = mkdtempSync(join(root, "overflow-")); created.push(dir);
  const dbPath = join(dir, "db.sqlite"), stateDir = join(dir, "state");
  const nativeSessionId = "clear-overflow", transcriptPath = join(dir, "native.jsonl");
  const config = resolveCcHostConfig({ dbPath, stateDir, baseline: "2025-01-01T00:00:00.000Z" });
  const memory = TraceMemory(dbPath, async () => { throw new Error("no model calls"); });
  const project = memory.store.createProject({ name: "fixture", declaredBy: "mark" });
  memory.store.close();
  mkdirSync(join(stateDir, "bindings"), { recursive: true });
  const binding = { version: 1, nativeSessionId, transcriptPath, dbPath, nativeCreatedAt: null,
    enrollment: { defaultEnabled: false, choice: true }, coreSessionId: null,
    projectId: project.id, branch: "main", selectedLeafUuid: null, executor: null, lastClose: null,
    clearedFrom: { nativeSessionId: "parent-overflow", at: "2026-01-01T00:00:00.000Z",
      compactionTurnId: null, inheritedEntryIds: [] } };
  writeFileSync(bindingPath(config, nativeSessionId), JSON.stringify(binding));
  const plugin = join(dir, "plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.1.0-beta.7" }));
  const configPath = join(plugin, "cc.config.json");
  writeFileSync(configPath, JSON.stringify({ dbPath, stateDir, baseline: config.baseline }));
  // The test-only plugin dir uses the candidate bundle; no installed plugin or provider is contacted.
  symlinkSync(join(root, "worktree", "plugin", "dist"), join(plugin, "dist"));
  const visible = { db: databaseIdentity(dbPath), nativeSession: nativeSessionId, coreSession: null };
  const items: TransportItem[] = [
    { kind: "knowledge", category: "constraint", commitId: 1, address: "K1@1", text: "frozen knowledge" },
    { kind: "fact", factId: 2, pending: true, text: "[F2] preserved fact" },
    { kind: "raw", entryId: 3, address: "T3#E1", pending: true, text: "[T3#E1@text] user: " + "r".repeat(12_000) },
  ];
  const frozen = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: encodeCcInjection(visible, {
    text: items.map(item => item.text).join("\n\n"), knowledgeCommitIds: [1], factIds: [2], entryIds: [3] }) },
    transportItems: items, systemMessage: "Trace Memory: original compact warning." };
  mkdirSync(join(stateDir, "session-start"), { recursive: true });
  writeFileSync(join(stateDir, "session-start", `${nativeSessionId}.clear.json`), JSON.stringify(frozen));
  const input = JSON.stringify({ hook_event_name: "SessionStart", source: "clear",
    session_id: nativeSessionId, transcript_path: transcriptPath });
  const stage = join(root, "worktree", "plugin", "hooks", "slice.mjs");
  const run = (slot: number) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [stage, configPath, String(slot)], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(`slot ${slot}: ${stderr}`)));
    child.stdin.end(input);
  });
  const outputs = (await Promise.all(Array.from({ length: 24 }, (_, slot) => run(slot)))).map(value => value ? JSON.parse(value) : null);
  expect(outputs.filter(value => value?.systemMessage)).toHaveLength(1);
  expect(outputs[0]?.systemMessage).toContain("original compact warning");
  expect(outputs[0]?.systemMessage).toContain("1 pending Raw entry");
  const bodies = outputs.filter(Boolean).map(value => value.hookSpecificOutput.additionalContext);
  expect(bodies.every(text => text.length <= 10000)).toBe(true);
  const delivered = bodies.flatMap(text => decodeCcInjection(text, visible)?.factIds ?? []);
  expect(delivered).toEqual([2]);
  expect(bodies.flatMap(text => decodeCcInjection(text, visible)?.entryIds ?? [])).toEqual([]);
  expect(bodies.join(" ")).toContain("expand: T3#E1");
  expect(JSON.parse(readFileSync(join(stateDir, "session-start", `${nativeSessionId}.clear.json`), "utf8"))).toEqual(frozen);
  const persisted = JSON.parse(readFileSync(bindingPath(config, nativeSessionId), "utf8"));
  expect(persisted.lastCompactionNotice).toEqual(outputs[0].systemMessage);
  expect(readCcMenu(config, nativeSessionId).menu.notices).toContain(outputs[0].systemMessage);
});
