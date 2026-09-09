// The Pi adapter's settings layer: where a value comes from, what it is called, whether it is valid,
// how it is written back and how it is described in the read-only Settings view. Everything here is a
// function of its arguments — file paths, a parsed layer set, a preference — so the host entry keeps
// the mutable session state and hands this module values.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CONFIG_ALIASES, DEFAULT_CONFIG, canonicalFlatConfig, validateConfig, type ConfigOverride, type ClosedSessionScope } from "../../core/api/index.ts";

/** The section of a Pi settings file this extension owns, and its status/entry identity in the host. */
export const tag = "trace-memory";
export type FlatConfig = Record<string, string | number | boolean>;

export const agentDirectory = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
function settings(cwd: string, agentDir = agentDirectory()) {
  const read = (path: string): Record<string, any> => {
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`Invalid settings.json ${path}: ${String(error)}`); }
  };
  return { global: read(join(agentDir, "settings.json")), project: read(join(cwd, ".pi", "settings.json")) };
}
// Host settings that are not core config sections. `runsDir` places the native worker logs
// (default since 24c: `<Pi agent directory>/sessions/trace-memory`). 19c deleted `nativeRunner`:
// the native runner is the only runner, so the key no longer selects anything and 18a's unknown-key
// rule rejects it like any other misspelling instead of silently accepting a setting that does nothing.
const hostStrings = ["dbPath", "notingModel", "consolidationModel", "runsDir"];
/** One flat `section.key` layer, checked exactly as the load path checks it: every known section key
 * typed against its default, unknown keys and misspellings rejected by name, host strings required to
 * be strings, and core's own `validateConfig` over the result. 24b's settings writer validates the
 * merged Global layer through this same function before it writes, so a menu edit can never leave a
 * file the next load would refuse. `named` reports a value under the spelling the user wrote (18a). */
export function parseLayer(flat: FlatConfig, named: (key: string) => string = key => key) {
  const core: ConfigOverride = { closedSessionScope: (flat.closedSessionScope === undefined ? DEFAULT_CONFIG.closedSessionScope : flat.closedSessionScope) as ClosedSessionScope };
  for (const section of ["render", "noting", "consolidation"] as const) {
    const values: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(DEFAULT_CONFIG[section])) {
      const override = flat[`${section}.${key}`];
      if (override !== undefined && (typeof override !== typeof value ||
        (typeof override === "number" && (!Number.isFinite(override) || override < 0)))) throw new Error(`Invalid ${named(`${section}.${key}`)}`);
      values[key] = (override ?? value) as number | boolean;
    }
    Object.assign(core, { [section]: values });
  }
  for (const key of Object.keys(flat)) if (key !== "closedSessionScope" && !hostStrings.includes(key) &&
    !["render", "noting", "consolidation"].some(s => key.startsWith(`${s}.`) && Object.hasOwn(DEFAULT_CONFIG[s as "render" | "noting" | "consolidation"], key.slice(s.length + 1)))) throw new Error(`Unknown setting ${named(key)}`);
  for (const key of hostStrings) if (flat[key] !== undefined && typeof flat[key] !== "string") throw new Error(`Invalid ${key}`);
  validateConfig(core);
  return core;
}
/** The load path: the three layers, merged, validated, with the layer each effective key came from. */
export function configuration(cwd: string, environment = process.env.TRACE_MEMORY_CONFIG, agentDir = agentDirectory()) {
  const files = settings(cwd, agentDir);
  const supplied = { Global: files.global[tag] ?? {}, Project: files.project[tag] ?? {}, Environment: JSON.parse(environment ?? "{}") };
  for (const [name, layer] of Object.entries(supplied)) if (!layer || typeof layer !== "object" || Array.isArray(layer)) throw new Error(`Invalid trace-memory ${name}: expected an object`);
  // Ticket 19 "Legacy input": every layer's legacy execution-mode key (`noting.branchModeDefault`)
  // is mapped onto the canonical one by core's own alias table, keeping that layer as its source, so
  // an existing settings.json keeps working and the read-only menu shows the canonical key. A layer
  // supplying both spellings with different values fails the load naming both keys. Layers still
  // mask one another exactly as before, so a project layer may override a global legacy spelling.
  const layers = Object.fromEntries(Object.entries(supplied).map(([name, values]) => [name, canonicalFlatConfig(values as FlatConfig)])) as Record<keyof typeof supplied, FlatConfig>;
  const spelling: Record<string, string> = {};
  for (const values of Object.values(supplied)) for (const key of Object.keys(values)) spelling[CONFIG_ALIASES[key] ?? key] = key;
  // A value rejected under an accepted legacy spelling names the key the user actually wrote (18a).
  const named = (key: string) => spelling[key] && spelling[key] !== key ? `${key} (supplied as ${spelling[key]})` : key;
  const flat: FlatConfig = Object.assign({}, ...Object.values(layers));
  const sources: Record<string, string> = {};
  for (const [layer, values] of Object.entries(layers)) for (const key of Object.keys(values)) sources[key] = layer;

  const parse = (values: FlatConfig) => parseLayer(values, named);
  for (const values of Object.values(layers)) parse(values);
  const core = parse(flat);
  return { flat, core, sources, layers };
}
/** What one load produced, as the settings view and the writer read it back. */
export type Loaded = ReturnType<typeof configuration>;

/** 24b "Global settings", the write itself: re-read the resolved global settings file, merge the
 * one edited preference into its `trace-memory` section, validate the merged layer through the load
 * path (`parseLayer` over `canonicalFlatConfig`), then replace the file atomically. Everything else
 * in the file — Trace Memory's advanced values and every other extension's settings — is carried
 * over as parsed. A malformed file, a non-object section or a value the next load would reject
 * throws before anything is written, so a failed edit reports the failure and changes nothing.
 * Returns the legacy spelling of this same preference if the write replaced one (19 "Legacy
 * input": the two spellings must not be left beside each other for the next load to refuse). */
export function writeGlobal(settingsFile: string, key: string, value: string | boolean): string | undefined {
  let file: Record<string, unknown> = {};
  try { file = JSON.parse(readFileSync(settingsFile, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Invalid settings.json ${settingsFile}: ${String(error)}`); }
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error(`Invalid settings.json ${settingsFile}: expected an object`);
  const existing = file[tag] ?? {};
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error(`Invalid trace-memory Global: expected an object`);
  const layer: FlatConfig = { ...existing as FlatConfig, [key]: value };
  const legacy = Object.entries(CONFIG_ALIASES).find(([, canonical]) => canonical === key)?.[0];
  const replaced = legacy && Object.hasOwn(layer, legacy) ? legacy : undefined;
  if (replaced) delete layer[replaced];
  parseLayer(canonicalFlatConfig(layer));
  const temporary = `${settingsFile}.${randomUUID()}`;
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ ...file, [tag]: layer }, null, 2)}\n`, { flag: "wx" });
  try { renameSync(temporary, settingsFile); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return replaced;
}

// ---- 24b: the preferences the Settings view offers, and how each one reads ----------------------
// Global preferences: the existing mode/model keys plus the closed-session borrowing scope.
// No advanced editor or second scheduling mechanism. Ticket 25 amendment 2 withdrew 24b's
// Consolidator-mode entry: that phase has no mode to choose, so three preferences remain here.
export type Preference = { name: string; key: string } & ({ phase: "noting"; kind: "mode" } | { phase: "noting" | "consolidation"; kind: "model" } | { phase?: never; kind: "scope" });
export const preferences: Preference[] = [
  { name: "Noter mode", key: "noting.forkModeDefault", phase: "noting", kind: "mode" },
  { name: "Noter model", key: "notingModel", phase: "noting", kind: "model" },
  { name: "Consolidator model", key: "consolidationModel", phase: "consolidation", kind: "model" },
  { name: "Closed-session scope", key: "closedSessionScope", kind: "scope" },
];
// Noting stores "runs in fork mode": one preference reads that boolean without inventing a second
// spelling of the same choice.
export const modeName = (value: boolean) => value ? "fork" : "subagent";
const preferenceDefault = (p: Preference) => p.kind === "scope" ? DEFAULT_CONFIG.closedSessionScope
  : p.kind === "model" ? "session" : DEFAULT_CONFIG.noting.forkModeDefault;
export const preferenceValue = (flat: FlatConfig, p: Preference) => flat[p.key] ?? preferenceDefault(p);
export const shownValue = (p: Preference, raw: unknown) => p.kind === "mode" ? modeName(raw as boolean)
  : raw === "session" ? "follow foreground" : String(raw);
/** The mode this phase is configured to request. Consolidation has one (25b). For Noting, cache
 * suppression, capacity/readiness fallback and post-compaction mode still decide what actually runs
 * (`effectiveMode`); a fallback does not grant a different model-selection policy, so the display
 * follows the configured mode. */
export const configuredMode = (flat: FlatConfig, phase: "noting" | "consolidation") => phase === "consolidation" ? "subagent"
  : modeName(preferenceValue(flat, preferences.find(p => p.kind === "mode")!) as boolean);
/** One Settings line: the effective value, its layer, the layers it masks, and — for a model whose
 * phase is configured to fork — the foreground model that fork would inherit instead. */
export const preferenceLine = (p: Preference, loaded: Pick<Loaded, "flat" | "sources" | "layers">, foregroundModel: string) => {
  const { flat, sources, layers } = loaded;
  const masked = Object.entries(layers).filter(([layer, values]) => layer !== sources[p.key] && Object.hasOwn(values, p.key))
    .map(([layer, values]) => `${layer}=${shownValue(p, values[p.key])} masked`);
  // Fork mode has no model of its own: the child inherits the foreground model, so the saved
  // subagent preference is shown but never presented as the model this phase would use now.
  const inherited = p.kind === "model" && configuredMode(flat, p.phase) === "fork" ? `; fork mode inherits the foreground model ${foregroundModel}` : "";
  return `${p.name}: ${shownValue(p, preferenceValue(flat, p))} (${sources[p.key] ?? "Default"})${masked.length ? `; ${masked.join("; ")}` : ""}${inherited}`;
};
