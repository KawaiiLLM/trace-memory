import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { applyEdits, modify, type FormattingOptions } from "jsonc-parser";
import { CC_CONTEXT_HEADROOM, CC_EFFORT_LEVELS, resolveCcHostConfig, type CcHostConfig, type ResolvedCcHostConfig } from "./config.ts";
import type { SettingsRowId } from "../trace-menu.ts";

export type CcSettingId = Exclude<SettingsRowId, `${string}.mode`>;
export interface SettingOutcome { saved: boolean; applied: boolean; diagnostic?: string }
const PHASE_KEYS: Partial<Record<CcSettingId, keyof CcHostConfig>> = {
  "noting.model": "notingModel", "noting.thinking": "notingThinking",
  "consolidation.model": "consolidationModel", "consolidation.thinking": "consolidationThinking",
  "dreaming.model": "dreaming.model", "dreaming.thinking": "dreaming.thinking",
  closedSessionScope: "closedSessionScope",
};

/** Edit the maintainer's hand-edited file in place with jsonc-parser (VS Code's own settings
 * editor): untouched bytes stay as they are, and an inserted property follows the file's indent. */
function editJson(text: string, path: string[], value: unknown): string {
  const indent = text.match(/\n([ \t]+)"/)?.[1] ?? "  ";
  const formattingOptions: FormattingOptions = { insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" };
  return applyEdits(text, modify(text, path, value, { formattingOptions }));
}

export function editedCcConfig(text: string, id: CcSettingId, value: string, capacity?: string): string {
  const input = JSON.parse(text) as CcHostConfig;
  resolveCcHostConfig(input);
  const key = PHASE_KEYS[id];
  if (!key) throw new Error(`unsupported CC setting ${id}`);
  if (id !== "closedSessionScope" && !input.worker) throw new Error("CC worker must be configured to edit phase settings");
  if (id === "closedSessionScope" && !["off", "project", "global"].includes(value))
    throw new Error("closedSessionScope must be off, project or global");
  if (id.endsWith(".thinking") && !CC_EFFORT_LEVELS.includes(value as typeof CC_EFFORT_LEVELS[number]))
    throw new Error(`thinking must be ${CC_EFFORT_LEVELS.join(", ")}`);
  if (id.endsWith(".model") && (!value.trim() || value === "session" || value === "follow foreground"))
    throw new Error("CC model must be an explicit model id");
  let output = editJson(text, [key], value);
  if (id.endsWith(".model")) {
    const known = Object.hasOwn(input.worker!.contextWindows, value);
    if (known && capacity !== undefined) throw new Error("capacity already exists for this model");
    if (!known) {
      const amount = Number(capacity);
      if (!Number.isSafeInteger(amount) || amount <= CC_CONTEXT_HEADROOM)
        throw new Error(`new model requires a context capacity greater than ${CC_CONTEXT_HEADROOM}`);
      output = editJson(output, ["worker", "contextWindows", value], amount);
    }
  } else if (capacity !== undefined) throw new Error("capacity applies only to a new model");
  resolveCcHostConfig(JSON.parse(output) as CcHostConfig);
  return output;
}

export function saveCcConfig(path: string, original: string, updated: string): ResolvedCcHostConfig {
  const next = resolveCcHostConfig(JSON.parse(updated) as CcHostConfig);
  if (readFileSync(path, "utf8") !== original) throw new Error("CC configuration changed before save; reopen Settings");
  const temporary = `${path}.${process.pid}.${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, updated); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    const dir = openSync(dirname(path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); throw error; }
  return next;
}
