import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedCcHostConfig, CcHostConfig } from "../../src/hosts/cc/config.ts";

const observed = vi.hoisted(() => ({ hook: [] as ResolvedCcHostConfig[], coordinator: [] as ResolvedCcHostConfig[] }));
vi.mock("../../src/hosts/cc/injection.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/hosts/cc/injection.ts")>(),
  ccSessionStartInjection: vi.fn(async (config: ResolvedCcHostConfig) => { observed.hook.push(config); return null; }),
}));
vi.mock("../../src/hosts/cc/lifecycle.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/hosts/cc/lifecycle.ts")>(),
  CcCoordinator: class {
    constructor(config: ResolvedCcHostConfig) {
      observed.coordinator.push(config);
      throw new Error("coordinator captured");
    }
  },
}));
vi.mock("../../src/hosts/cc/native-rejection.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/hosts/cc/native-rejection.ts")>(),
  installCcNativeRejectionGuard: () => () => {},
}));

import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { handleCcHook, runCcCommand } from "../../src/hosts/cc/index.ts";

const directories: string[] = [];
afterEach(() => {
  observed.hook.length = 0; observed.coordinator.length = 0;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { raw: CcHostConfig; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tm-cc-entry-config-")); directories.push(dir);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("CLAUDE_PID", undefined);
  const raw: CcHostConfig = { dbPath: join(dir, "trace.sqlite"), stateDir: join(dir, "state"),
    "noting.triggerTokens": 13, "noting.forkModeDefault": true,
    "dreaming.triggerTokens": 29, "dreaming.timeoutMs": 47_000,
    "compaction.sharedAllowanceTokens": 1_789 };
  const path = join(dir, "cc.config.json"); writeFileSync(path, JSON.stringify(raw));
  return { raw, path, dir };
}

function expectControls(config: ResolvedCcHostConfig) {
  expect(config.coreConfig).toMatchObject({
    noting: { triggerTokens: 13, forkModeDefault: true },
    dreaming: { triggerTokens: 29, timeoutMs: 47_000 },
    compaction: { sharedAllowanceTokens: 1_789 },
  });
}

test("SessionStart forwards flat and already-resolved phase controls to injection", async () => {
  const f = fixture();
  const input = { hook_event_name: "SessionStart" as const, source: "startup" as const,
    session_id: "config-entry", transcript_path: join(f.dir, "transcript.jsonl") };
  await handleCcHook(f.raw, input);
  await handleCcHook(resolveCcHostConfig(f.raw), { ...input, source: "resume" });
  expect(observed.hook).toHaveLength(2);
  observed.hook.forEach(expectControls);
});

test("MCP config-file read preserves phase controls at coordinator construction", async () => {
  const f = fixture();
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "config-entry");
  await expect(runCcCommand(["mcp", "--config", f.path])).rejects.toThrow("coordinator captured");
  expect(observed.coordinator).toHaveLength(1);
  expectControls(observed.coordinator[0]!);
});
