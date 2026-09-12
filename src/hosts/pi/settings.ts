// The Pi adapter's settings layer: where a value comes from, what it is called, whether it is valid,
// how it is written back and how it is described in the read-only Settings view. Everything here is a
// function of its arguments — file paths, a parsed layer set, a preference — so the host entry keeps
// the mutable session state and hands this module values.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CONFIG_ALIASES, CONFIG_SECTIONS, DEFAULT_CONFIG, canonicalFlatConfig, validateConfig, type ConfigOverride, type ClosedSessionScope } from "../../core/api/index.ts";
import { THINKING_LEVELS } from "./native.ts";

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
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`Invalid settings.json ${path}: ${String(error)}`); }
  };
  return { global: read(join(agentDir, "settings.json")), project: read(join(cwd, ".pi", "settings.json")) };
}
// Host settings that are not core config sections. `runsDir` places the native worker logs
// (default since 24c: `<Pi agent directory>/sessions/trace-memory`). 19c deleted `nativeRunner`:
// the native runner is the only runner, so the key no longer selects anything and 18a's unknown-key
// rule rejects it like any other misspelling instead of silently accepting a setting that does nothing.
// 26d added `notingThinking`/`consolidationThinking`: each phase's configured worker thinking level,
// `inherit` (the default) or one of Pi's own levels. Subagent execution only — a fork keeps
// inheriting the foreground level 26b freezes, so its request prefix still matches the parent's.
const hostStrings = ["dbPath", "notingModel", "consolidationModel", "runsDir", "notingThinking", "consolidationThinking", "dreaming.model", "dreaming.thinking"];
export const thinkingChoices = ["inherit", ...THINKING_LEVELS];
const thinkingKeys = ["notingThinking", "consolidationThinking", "dreaming.thinking"];
/** One flat `section.key` layer, checked exactly as the load path checks it: every known section key
 * typed against its default, unknown keys and misspellings rejected by name, host strings required to
 * be strings, and core's own `validateConfig` over the result. 24b's settings writer validates the
 * merged Global layer through this same function before it writes, so a menu edit can never leave a
 * file the next load would refuse. `named` reports a value under the spelling the user wrote (18a). */
export function parseLayer(flat: FlatConfig, named: (key: string) => string = key => key) {
  flat = canonicalFlatConfig(flat);
  const core: ConfigOverride = { closedSessionScope: (flat.closedSessionScope === undefined ? DEFAULT_CONFIG.closedSessionScope : flat.closedSessionScope) as ClosedSessionScope };
  for (const section of CONFIG_SECTIONS) {
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
    !CONFIG_SECTIONS.some(s => key.startsWith(`${s}.`) && Object.hasOwn(DEFAULT_CONFIG[s], key.slice(s.length + 1)))) throw new Error(`Unknown setting ${named(key)}`);
  for (const key of hostStrings) if (flat[key] !== undefined && typeof flat[key] !== "string") throw new Error(`Invalid ${key}`);
  // 26d: an unrecognized level is rejected by name with the accepted list, never normalized silently.
  for (const key of thinkingKeys) if (flat[key] !== undefined && !thinkingChoices.includes(flat[key] as string))
    throw new Error(`Invalid ${named(key)}: expected one of ${thinkingChoices.join(", ")}`);
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
  // A retired database-owned injection cap is refused above by `canonicalFlatConfig`, including an
  // environment value. It is never ignored, inferred as three owner limits, or written back.
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
// Consolidator-mode entry; 29e restores it on the same select-and-write path, so each phase now shows
// the same three lines.
// 26d added each phase's thinking level beside its model, on the same select-and-write path.
export type Preference = { name: string; key: string } & ({ phase: "noting" | "consolidation"; kind: "mode" | "model" | "thinking" } | { phase: "dreaming"; kind: "model" | "thinking" } | { phase?: never; kind: "scope" });
export const preferences: Preference[] = [
  { name: "Noter mode", key: "noting.forkModeDefault", phase: "noting", kind: "mode" },
  { name: "Noter model", key: "notingModel", phase: "noting", kind: "model" },
  { name: "Noter thinking", key: "notingThinking", phase: "noting", kind: "thinking" },
  { name: "Consolidator mode", key: "consolidation.forkModeDefault", phase: "consolidation", kind: "mode" },
  { name: "Consolidator model", key: "consolidationModel", phase: "consolidation", kind: "model" },
  { name: "Consolidator thinking", key: "consolidationThinking", phase: "consolidation", kind: "thinking" },
  { name: "Dreamer model", key: "dreaming.model", phase: "dreaming", kind: "model" },
  { name: "Dreamer thinking", key: "dreaming.thinking", phase: "dreaming", kind: "thinking" },
  { name: "Closed-session scope", key: "closedSessionScope", kind: "scope" },
];
// Each phase stores "runs in fork mode": one preference reads that boolean without inventing a second
// spelling of the same choice. Both phases default to subagent; each reads its own config section.
export const modeName = (value: boolean) => value ? "fork" : "subagent";
const preferenceDefault = (p: Preference) => p.kind === "scope" ? DEFAULT_CONFIG.closedSessionScope
  : p.kind === "model" ? "session" : p.kind === "thinking" ? "inherit" : p.kind === "mode" ? DEFAULT_CONFIG[p.phase].forkModeDefault : false;
export const preferenceValue = (flat: FlatConfig, p: Preference) => flat[p.key] ?? preferenceDefault(p);
export const shownValue = (p: Preference, raw: unknown) => p.kind === "mode" ? modeName(raw as boolean)
  : raw === "session" ? "follow foreground" : String(raw);
/** The mode this phase is configured to request (29e: both phases have one again). Cache
 * suppression, capacity/readiness fallback and — for Noting — Raw availability still decide what
 * actually runs (`effectiveMode`); a fallback does not grant a different model-selection policy, so
 * the display follows the configured mode. */
export const configuredMode = (flat: FlatConfig, phase: "noting" | "consolidation" | "dreaming") =>
  phase === "dreaming" ? "subagent" : modeName(preferenceValue(flat, preferences.find(p => p.kind === "mode" && p.phase === phase)!) as boolean);
/** One Settings line: the effective value, its layer, the layers it masks, and — for a model whose
 * phase is configured to fork — the foreground model that fork would inherit instead. */
export const preferenceLine = (p: Preference, loaded: Pick<Loaded, "flat" | "sources" | "layers">, foregroundModel: string) => {
  const { flat, sources, layers } = loaded;
  const masked = Object.entries(layers).filter(([layer, values]) => layer !== sources[p.key] && Object.hasOwn(values, p.key))
    .map(([layer, values]) => `${layer}=${shownValue(p, values[p.key])} masked`);
  // Fork mode has no model and (26d) no thinking level of its own: the child inherits the
  // foreground's, so the saved subagent preference is shown but never presented as what this phase
  // would use now.
  const forks = (p.kind === "model" || p.kind === "thinking") && configuredMode(flat, p.phase) === "fork";
  const inherited = !forks ? "" : p.kind === "model" ? `; fork mode inherits the foreground model ${foregroundModel}`
    : "; fork mode inherits the foreground thinking level";
  return `${p.name}: ${shownValue(p, preferenceValue(flat, p))} (${sources[p.key] ?? "Default"})${masked.length ? `; ${masked.join("; ")}` : ""}${inherited}`;
};
