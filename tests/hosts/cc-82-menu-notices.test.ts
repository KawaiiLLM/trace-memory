import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingPath, readBinding, recordSessionStart, updateBinding } from "../../src/hosts/cc/binding.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-82-notices-")); dirs.push(dir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state") });
  const input = { hook_event_name: "SessionStart" as const, source: "startup" as const,
    session_id: "native-notice", transcript_path: join(dir, "native.jsonl") };
  return { config, input };
};

test("old binding has no notice; exact warning bytes survive binding reads and clean state clears them", async () => {
  const { config, input } = fixture();
  await recordSessionStart(config, input, null);
  const path = bindingPath(config, input.session_id);
  expect(readBinding(config, input.session_id)!.lastCompactionNotice).toBeUndefined();
  const warning = "Trace Memory: compaction omitted 2 pending Raw entries and 1 unconsolidated fact (12 tokens); they remain pending for Noting and Consolidation.";
  await updateBinding(config, input.session_id, current => ({ ...current!, lastCompactionNotice: warning }));
  expect(readBinding(config, input.session_id)!.lastCompactionNotice).toBe(warning);
  expect(JSON.parse(readFileSync(path, "utf8")).lastCompactionNotice).toBe(warning);
  await updateBinding(config, input.session_id, current => ({ ...current!, lastCompactionNotice: null }));
  expect(readBinding(config, input.session_id)!.lastCompactionNotice).toBeNull();
});

test("malformed persisted notice fails explicitly, rather than displaying an invented warning", async () => {
  const { config, input } = fixture();
  await recordSessionStart(config, input, null);
  const path = bindingPath(config, input.session_id);
  const binding = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...binding, lastCompactionNotice: 12 }));
  expect(() => readBinding(config, input.session_id)).toThrow("invalid Claude Code binding record");
});
