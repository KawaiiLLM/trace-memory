import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
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

/** Find top-level JSON property value spans without re-serializing the hand-edited document. */
function propertySpans(text: string): Map<string, [number, number]> {
  const spans = new Map<string, [number, number]>();
  let index = text.indexOf("{") + 1;
  if (!index) throw new Error("CC configuration must be a JSON object");
  const whitespace = () => { while (/\s/.test(text[index] ?? "")) index++; };
  const stringEnd = () => {
    const begin = index++;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index++] === '"') return { value: JSON.parse(text.slice(begin, index)) as string, end: index };
    }
    throw new Error("unterminated JSON string");
  };
  while (index < text.length) {
    whitespace();
    if (text[index] === "}") return spans;
    if (text[index] === ",") { index++; whitespace(); }
    if (text[index] !== '"') throw new Error("invalid CC configuration property");
    const key = stringEnd().value;
    whitespace(); if (text[index++] !== ":") throw new Error("invalid CC configuration property separator");
    whitespace(); const start = index;
    if (text[index] === '"') stringEnd();
    else if (text[index] === "{" || text[index] === "[") {
      let depth = 0, quoted = false;
      while (index < text.length) {
        const ch = text[index++];
        if (quoted) { if (ch === "\\") index++; else if (ch === '"') quoted = false; }
        else if (ch === '"') quoted = true;
        else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") { depth--; if (!depth) break; }
      }
      if (depth) throw new Error("unterminated CC configuration value");
    } else while (index < text.length && !/[\s,}]/.test(text[index]!)) index++;
    if (spans.has(key)) throw new Error(`duplicate CC configuration key ${key}`);
    spans.set(key, [start, index]);
    whitespace(); if (text[index] !== "," && text[index] !== "}") throw new Error("invalid CC configuration value terminator");
  }
  throw new Error("unterminated CC configuration object");
}

export function replaceCcConfigValues(text: string, changes: Record<string, unknown>): string {
  const parsed = JSON.parse(text) as CcHostConfig;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CC configuration must be a JSON object");
  const spans = propertySpans(text), edits: { start: number; end: number; value: string }[] = [];
  const missing: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    const span = spans.get(key);
    if (span) edits.push({ start: span[0], end: span[1], value: JSON.stringify(value) });
    else missing.push(`${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  }
  const close = text.lastIndexOf("}");
  if (missing.length) {
    const indent = text.match(/\n([ \t]*)"[^"\n]+"\s*:/)?.[1] ?? "  ";
    const multiline = text.slice(0, close).includes("\n");
    const at = close - (text.slice(0, close).match(/\s*$/)?.[0].length ?? 0);
    const prefix = spans.size ? "," : "";
    edits.push({ start: at, end: at, value: multiline
      ? `${prefix}\n${indent}${missing.join(`,\n${indent}`)}` : `${prefix}${missing.join(", ")}` });
  }
  return edits.sort((a, b) => b.start - a.start).reduce((current, edit) =>
    current.slice(0, edit.start) + edit.value + current.slice(edit.end), text);
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
  let changes: Record<string, unknown> = { [key]: value };
  if (id.endsWith(".model")) {
    if (!input.worker) throw new Error("CC worker must be configured to edit models");
    const known = Object.hasOwn(input.worker.contextWindows, value);
    if (known && capacity !== undefined) throw new Error("capacity already exists for this model");
    if (!known) {
      const amount = Number(capacity);
      if (!Number.isSafeInteger(amount) || amount <= CC_CONTEXT_HEADROOM)
        throw new Error(`new model requires a context capacity greater than ${CC_CONTEXT_HEADROOM}`);
      const workerSpan = propertySpans(text).get("worker")!;
      const workerText = text.slice(...workerSpan);
      const capacitySpan = propertySpans(workerText).get("contextWindows")!;
      const capacityText = workerText.slice(...capacitySpan);
      const editedCapacity = replaceCcConfigValues(capacityText, { [value]: amount });
      // The generic property replacement would serialize nested formatting; splice the edited
      // contextWindows bytes directly instead, retaining all unrelated lines and indentation.
      const output = replaceCcConfigValues(text, { [key]: value });
      const span = propertySpans(output).get("worker")!;
      const windows = propertySpans(output.slice(...span)).get("contextWindows")!;
      const start = span[0] + windows[0], end = span[0] + windows[1];
      const result = output.slice(0, start) + editedCapacity + output.slice(end);
      resolveCcHostConfig(JSON.parse(result) as CcHostConfig);
      return result;
    }
  } else if (capacity !== undefined) throw new Error("capacity applies only to a new model");
  const output = replaceCcConfigValues(text, changes);
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
