import { afterEach, expect, test, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETIRED_CONSOLIDATION_KEYS, retireConsolidationSettings, upgradeSettingsFile } from "../../src/hosts/retired-settings.ts";
import { configuration, parseLayer, type FlatConfig } from "../../src/hosts/pi/settings.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";

const faults = vi.hoisted(() => ({ rename: false }));
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, renameSync: (...args: Parameters<typeof original.renameSync>) => {
    if (faults.rename) throw new Error("fixture rename failed");
    return original.renameSync(...args);
  } };
});
const dirs: string[] = [];
afterEach(() => { faults.rename = false; vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = fs.mkdtempSync(join(tmpdir(), "tm-92-retired-settings-")); dirs.push(dir); return dir; }
const retired = Object.fromEntries(RETIRED_CONSOLIDATION_KEYS.map(key => [key, "old-value"]));
const live = { notingModel: "noter", notingThinking: "high", "dreaming.model": "dreamer", "dreaming.thinking": "medium", "noting.forkModeDefault": true };

test("92/07: exact C keys only; unknown and similar user keys survive the pure upgrade", () => {
  const original = { ...retired, ...live, consolidationModelBackup: "keep", "consolidation.custom": "keep", custom: 42 };
  const result = retireConsolidationSettings(original);
  expect(result.removed).toEqual([...RETIRED_CONSOLIDATION_KEYS]);
  expect(result.values).toEqual({ ...live, consolidationModelBackup: "keep", "consolidation.custom": "keep", custom: 42 });
  expect(original).toEqual({ ...retired, ...live, consolidationModelBackup: "keep", "consolidation.custom": "keep", custom: 42 });
  expect(retireConsolidationSettings(result.values).removed).toEqual([]);
});

test("92/07: Pi upgrade saves validated layer once, lists actual removals and preserves N/D and other plugins", () => {
  const root = fixture(), agent = join(root, "agent"); fs.mkdirSync(agent);
  const file = join(agent, "settings.json"), original = { unrelated: { x: 1 }, "trace-memory": { ...retired, ...live } };
  fs.writeFileSync(file, JSON.stringify(original));
  const report = vi.spyOn(console, "warn").mockImplementation(() => {});
  const loaded = configuration(root, "{}", agent);
  expect(loaded.flat).toEqual(live);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ unrelated: { x: 1 }, "trace-memory": live });
  const saved = fs.readFileSync(file, "utf8");
  expect(report).toHaveBeenCalledTimes(1);
  for (const key of RETIRED_CONSOLIDATION_KEYS) expect(report.mock.calls[0]![0]).toContain(key);
  configuration(root, "{}", agent);
  expect(fs.readFileSync(file, "utf8")).toBe(saved); expect(report).toHaveBeenCalledTimes(1);
});

test("92/07: validation and rename failures preserve original bytes and never report success", () => {
  const path = join(fixture(), "settings.json"), report = vi.fn();
  const original = JSON.stringify({ "trace-memory": { ...retired, ...live, "consolidation.custom": "unknown" } });
  fs.writeFileSync(path, original);
  expect(() => upgradeSettingsFile(path, "trace-memory", values => parseLayer(values as FlatConfig), report)).toThrow("Unknown setting consolidation.custom");
  expect(fs.readFileSync(path, "utf8")).toBe(original); expect(report).not.toHaveBeenCalled();
  faults.rename = true;
  expect(() => upgradeSettingsFile(path, "trace-memory", () => {}, report)).toThrow("fixture rename failed");
  expect(fs.readFileSync(path, "utf8")).toBe(original); expect(report).not.toHaveBeenCalled();
  faults.rename = false;
  expect(fs.readdirSync(join(path, ".."))).toEqual(["settings.json"]);
});

test("92/07: CC uses the same canonical upgrade and preserves frozen phase snapshots", () => {
  const path = join(fixture(), "cc.json");
  const input = { ...retired, notingModel: "sonnet", notingThinking: "high", "dreaming.model": "opus", "dreaming.thinking": "high",
    stateDir: "/tmp/fixture", worker: { claudeExecutable: "/tmp/unused-claude",
      cwd: "/tmp/worker", contextWindows: { sonnet: 200000, opus: 200000 } }, custom: { untouched: true } };
  fs.writeFileSync(path, JSON.stringify(input)); const report = vi.fn();
  const before = resolveCcHostConfig(input);
  expect(before.removedSettings).toEqual([...RETIRED_CONSOLIDATION_KEYS]);
  expect(Object.keys(before.worker!.phases)).toEqual(["noting", "dreaming"]);
  upgradeSettingsFile(path, undefined, values => resolveCcHostConfig(values as unknown as typeof input), report);
  const upgraded = JSON.parse(fs.readFileSync(path, "utf8"));
  expect(upgraded.notingModel).toBe("sonnet"); expect(upgraded["dreaming.model"]).toBe("opus");
  expect(upgraded.custom).toEqual({ untouched: true });
  const after = resolveCcHostConfig({ ...upgraded, notingModel: "opus" });
  expect(after.worker!.phases.noting.model).toBe("opus");
  expect(before.worker!.phases.noting.model).toBe("sonnet");
  expect(upgradeSettingsFile(path, undefined, () => {}, report)).toEqual([]); expect(report).toHaveBeenCalledTimes(1);
});
