// The Pi adapter's settings layer: where a value comes from, what it is called, whether it is valid,
// how it is written back and how it is described in the read-only Settings view. Everything here is a
// function of its arguments — file paths, a parsed layer set, a preference — so the host entry keeps
// the mutable session state and hands this module values.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CONFIG_SECTIONS, DEFAULT_CONFIG, canonicalFlatConfig, validateConfig, type ConfigOverride, type ClosedSessionScope } from "../../core/api/index.ts";
import { CLASSIFY_SETTING_KEYS, PHASE_SETTING_KEYS, THINKING_LEVELS } from "../phase-settings.ts";
import { retireConsolidationSettings, upgradeSettingsFile } from "../retired-settings.ts";

/** The section of a Pi settings file this extension owns, and its status/entry identity in the host. */
export const tag = "trace-memory";
export type FlatConfig = Record<string, string | number | boolean>;

export const agentDirectory = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** Settings accepts one unambiguous decimal integer, without normalization or coercion. */
export function parseKnowledgeBudgetInput(input: string, name: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(input)) throw new Error(`${name} must be an exact nonnegative safe integer in decimal notation`);
  const value = Number(input);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an exact nonnegative safe integer in decimal notation`);
  return value;
}
function settings(cwd: string, agentDir = agentDirectory()) {
  const read = (path: string): Record<string, any> => {
    try {
      upgradeSettingsFile(path, tag, values => parseLayer(values as FlatConfig), message => console.warn(message));
      return JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`Invalid settings.json ${path}: ${String(error)}`); }
  };
  return { global: read(join(agentDir, "settings.json")), project: read(join(cwd, ".pi", "settings.json")) };
}
// Host settings that are not core config sections. `runsDir` places the native worker logs
// (default since 24c: `<Pi agent directory>/sessions/trace-memory`). 19c deleted `nativeRunner`:
// the native runner is the only runner, so the key no longer selects anything and 18a's unknown-key
// rule rejects it like any other misspelling instead of silently accepting a setting that does nothing.
// Each live phase has its own configured worker thinking level,
// `inherit` (the default) or one of Pi's own levels.
const settingKeyPairs = [...Object.values(PHASE_SETTING_KEYS), CLASSIFY_SETTING_KEYS];
const phaseSettingKeys = settingKeyPairs.flatMap(keys => [keys.model, keys.thinking]);
const hostStrings = ["dbPath", "runsDir", ...phaseSettingKeys];
export const thinkingChoices = ["inherit", ...THINKING_LEVELS];
const thinkingKeys = settingKeyPairs.map(keys => keys.thinking);
/** The key that decides classify's model or thinking. Pi's Dreamer tasks follow the main agent's model unless `dreaming.model`
 * is set (user ruling, 2026-10-22), and a classify key that is absent follows the Dreamer's. */
export const classifySettingKey = (flat: FlatConfig, kind: "model" | "thinking") =>
  flat[CLASSIFY_SETTING_KEYS[kind]] === undefined ? PHASE_SETTING_KEYS.dreaming[kind] : CLASSIFY_SETTING_KEYS[kind];
/** One flat `section.key` layer, checked exactly as the load path checks it: every known section key
 * typed against its default, unknown keys and misspellings rejected by name, host strings required to
 * be strings, and core's own `validateConfig` over the result. 24b's settings writer validates the
 * merged Global layer through this same function before it writes, so a menu edit can never leave a
 * file the next load would refuse. */
export function parseLayer(flat: FlatConfig) {
  flat = canonicalFlatConfig(flat);
  const core: ConfigOverride = { closedSessionScope: (flat.closedSessionScope === undefined ? DEFAULT_CONFIG.closedSessionScope : flat.closedSessionScope) as ClosedSessionScope };
  for (const section of CONFIG_SECTIONS) {
    const values: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(DEFAULT_CONFIG[section])) {
      const override = flat[`${section}.${key}`];
      if (override !== undefined && (typeof override !== typeof value ||
        (typeof override === "number" && (!Number.isFinite(override) || override < 0)))) throw new Error(`Invalid ${`${section}.${key}`}`);
      values[key] = (override ?? value) as number | boolean;
    }
    Object.assign(core, { [section]: values });
  }
  for (const key of Object.keys(flat)) if (key !== "closedSessionScope" && !hostStrings.includes(key) &&
    !CONFIG_SECTIONS.some(s => key.startsWith(`${s}.`) && Object.hasOwn(DEFAULT_CONFIG[s], key.slice(s.length + 1)))) throw new Error(`Unknown setting ${key}`);
  for (const key of hostStrings) if (flat[key] !== undefined && typeof flat[key] !== "string") throw new Error(`Invalid ${key}`);
  // 26d: an unrecognized level is rejected by name with the accepted list, never normalized silently.
  for (const key of thinkingKeys) if (flat[key] !== undefined && !thinkingChoices.includes(flat[key] as string))
    throw new Error(`Invalid ${key}: expected one of ${thinkingChoices.join(", ")}`);
  validateConfig(core);
  return core;
}
/** The load path: the three layers, merged, validated, with the layer each effective key came from. */
export function configuration(cwd: string, environment = process.env.TRACE_MEMORY_CONFIG, agentDir = agentDirectory()) {
  const files = settings(cwd, agentDir);
  const rawEnvironment = JSON.parse(environment ?? "{}");
  if (!rawEnvironment || typeof rawEnvironment !== "object" || Array.isArray(rawEnvironment)) throw new Error("Invalid trace-memory Environment: expected an object");
  const upgradedEnvironment = retireConsolidationSettings(rawEnvironment);
  if (upgradedEnvironment.removed.length) console.warn(`Trace Memory removed retired Environment settings: ${upgradedEnvironment.removed.join(", ")}`);
  const supplied = { Global: files.global[tag] ?? {}, Project: files.project[tag] ?? {}, Environment: upgradedEnvironment.values };
  for (const [name, layer] of Object.entries(supplied)) if (!layer || typeof layer !== "object" || Array.isArray(layer)) throw new Error(`Invalid trace-memory ${name}: expected an object`);
  // A removed key in any layer fails the load by name (core's removed-settings table). Layers still
  // mask one another as before.
  const layers = Object.fromEntries(Object.entries(supplied).map(([name, values]) => [name, canonicalFlatConfig(values as FlatConfig)])) as Record<keyof typeof supplied, FlatConfig>;
  // A retired database-owned injection cap is refused above by `canonicalFlatConfig`, including an
  // environment value. It is never ignored, inferred as three owner limits, or written back.
  const flat: FlatConfig = Object.assign({}, ...Object.values(layers));
  const sources: Record<string, string> = {};
  for (const [layer, values] of Object.entries(layers)) for (const key of Object.keys(values)) sources[key] = layer;

  for (const values of Object.values(layers)) parseLayer(values);
  const core = parseLayer(flat);
  return { flat, core, sources, layers };
}
/** What one load produced, as the settings view and the writer read it back. */
export type Loaded = ReturnType<typeof configuration>;

/** The core values a running session cannot replace: every section value, plus the database path. Host strings (models, thinking levels, runs directory) and the closed-session
 * scope are read live and are not listed. */
export function fixedSettings(flat: FlatConfig, core: ConfigOverride): Record<string, unknown> {
  const fixed: Record<string, unknown> = { dbPath: flat.dbPath };
  for (const section of CONFIG_SECTIONS) for (const [key, value] of Object.entries(core[section] ?? {}))
    fixed[`${section}.${key}`] = value;
  return fixed;
}

/** 24b "Global settings", the write itself: re-read the resolved global settings file, merge the
 * one edited preference into its `trace-memory` section, validate the merged layer through the load
 * path (`parseLayer` over `canonicalFlatConfig`), then replace the file atomically. Everything else
 * in the file — Trace Memory's advanced values and every other extension's settings — is carried
 * over as parsed. A malformed file, a non-object section or a value the next load would reject
 * throws before anything is written, so a failed edit reports the failure and changes nothing. */
export function writeGlobal(settingsFile: string, key: string, value: string): void {
  let file: Record<string, unknown> = {};
  try { file = JSON.parse(readFileSync(settingsFile, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid settings.json ${settingsFile}: ${String(error)}`); }
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error(`Invalid settings.json ${settingsFile}: expected an object`);
  const existing = file[tag] ?? {};
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error(`Invalid trace-memory Global: expected an object`);
  const layer: FlatConfig = { ...existing as FlatConfig, [key]: value };
  parseLayer(canonicalFlatConfig(layer));
  const temporary = `${settingsFile}.${randomUUID()}`;
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ ...file, [tag]: layer }, null, 2)}\n`, { flag: "wx" });
  try { renameSync(temporary, settingsFile); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

// ---- 24b: the preferences the Settings view offers, and how each one reads ----------------------
// Global preferences: the model/thinking keys of both phases plus the closed-session borrowing scope.
// No advanced editor or second scheduling mechanism.
export type Preference = { name: string; key: string } & ({ phase: "noting" | "dreaming" | "classify"; kind: "model" | "thinking" } | { phase?: never; kind: "scope" });
export const preferences: Preference[] = [
  { name: "Noter model", key: PHASE_SETTING_KEYS.noting.model, phase: "noting", kind: "model" },
  { name: "Noter thinking", key: PHASE_SETTING_KEYS.noting.thinking, phase: "noting", kind: "thinking" },
  { name: "Dreamer model", key: PHASE_SETTING_KEYS.dreaming.model, phase: "dreaming", kind: "model" },
  { name: "Dreamer thinking", key: PHASE_SETTING_KEYS.dreaming.thinking, phase: "dreaming", kind: "thinking" },
  { name: "Classify model", key: CLASSIFY_SETTING_KEYS.model, phase: "classify", kind: "model" },
  { name: "Classify thinking", key: CLASSIFY_SETTING_KEYS.thinking, phase: "classify", kind: "thinking" },
  { name: "Closed-session scope", key: "closedSessionScope", kind: "scope" },
];
const preferenceDefault = (p: Preference) => p.kind === "scope" ? DEFAULT_CONFIG.closedSessionScope
  : p.kind === "model" ? "session" : "inherit";
export const preferenceValue = (flat: FlatConfig, p: Preference) => p.phase === "classify"
  ? flat[classifySettingKey(flat, p.kind)] ?? preferenceDefault(p) : flat[p.key] ?? preferenceDefault(p);
export const shownValue = (raw: unknown) => raw === "session" ? "follow foreground" : String(raw);
/** One Settings line: the effective value, its layer and the layers it masks. */
export const preferenceLine = (p: Preference, loaded: Pick<Loaded, "flat" | "sources" | "layers">) => {
  const { flat, sources, layers } = loaded;
  const masked = Object.entries(layers).filter(([layer, values]) => layer !== sources[p.key] && Object.hasOwn(values, p.key))
    .map(([layer, values]) => `${layer}=${shownValue(values[p.key])} masked`);
  return `${p.name}: ${shownValue(preferenceValue(flat, p))} (${sources[p.key] ?? "Default"})${masked.length ? `; ${masked.join("; ")}` : ""}`;
};
