import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ccLastCompactionNotice } from "../../src/hosts/cc/menu-notices.ts";
import { readCompleteTranscript, type CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
const warning = "Trace Memory: compaction omitted 2 pending Raw entries and 1 unconsolidated fact (12 tokens); they remain pending for Noting and Consolidation.";
const child = "child-clear";
const hook = (id: string, parentUuid: string | null, text?: string): CcNativeRecord => ({
  type: "attachment", uuid: id, parentUuid, sessionId: child,
  attachment: { type: "hook_success", hookName: "SessionStart:clear", hookEvent: "SessionStart", toolUseID: id,
    command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/cc.cjs" hook --config "${CLAUDE_PLUGIN_ROOT}/cc.config.json"', exitCode: 0,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" },
      ...(text ? { systemMessage: text } : {}) }) },
});
const shown = (id: string, success: CcNativeRecord, text = warning): CcNativeRecord => ({
  type: "attachment", uuid: id, parentUuid: success.uuid, sessionId: child,
  attachment: { type: "hook_system_message", hookName: "SessionStart:clear", hookEvent: "SessionStart",
    toolUseID: success.uuid, content: text },
});
const source = (id: string, parentUuid: string, sessionId = child): CcNativeRecord => ({
  type: "user", uuid: id, parentUuid, sessionId, promptSource: "sdk", message: { role: "user", content: [{ type: "text", text: "hi" }] },
});
function menuNotice(records: CcNativeRecord[], leaf: string | null = null, current = child, compact = 1) {
  const dir = mkdtempSync(join(tmpdir(), "tm-82-notices-")); dirs.push(dir);
  const path = join(dir, "native.jsonl");
  writeFileSync(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const binding = { nativeSessionId: current, transcriptPath: path, selectedLeafUuid: leaf,
    clearedFrom: { nativeSessionId: "parent", at: "2026-01-01", compactionTurnId: compact, inheritedEntryIds: [] } };
  return ccLastCompactionNotice(readCompleteTranscript(path), binding);
}

test("selected ancestry authenticates the exact warning, including nonadjacent additional context", () => {
  const success = hook("success", null, warning), notice = shown("notice", success);
  const context: CcNativeRecord = { type: "attachment", uuid: "context", parentUuid: notice.uuid,
    sessionId: child, attachment: { type: "hook_additional_context", content: ["some preview"] } };
  expect(menuNotice([success, notice, context, source("user", "context")], "user")).toBe(warning);
  expect(menuNotice([success, notice, context])).toBe(warning); // /clear before the first prompt
});

test("rejects stale native identity, abandoned sibling branch and quoted warning", () => {
  const success = hook("success", null, warning), notice = shown("notice", success);
  expect(menuNotice([success, notice], null, "another-native-id")).toBeNull();
  expect(menuNotice([success, notice, source("old", "notice"), source("active", "success")], "active")).toBeNull();
  expect(menuNotice([{ ...source("quote", "root", child), parentUuid: null }, { type: "assistant", uuid: "quoted", parentUuid: "quote",
    message: { role: "assistant", content: [{ type: "text", text: warning }] } }], "quoted")).toBeNull();
  expect(menuNotice([hook("success", null, warning), shown("notice", hook("success", null, warning), "edited warning")])).toBeNull();
});

test("later clean SessionStart supersedes old warning, even when its output is empty", () => {
  const first = hook("first", null, warning), notice = shown("notice", first);
  const clean = hook("clean", "notice");
  expect(menuNotice([first, notice, clean, source("user", "clean")], "user")).toBeNull();
  expect(menuNotice([first, notice, clean])).toBeNull(); // ambiguous pre-first-prompt chain: never leak old warning
  expect(menuNotice([first, notice, source("user", "notice")], "user", child, 0)).toBeNull();
});
