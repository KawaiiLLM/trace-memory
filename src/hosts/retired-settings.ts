import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Canonical C settings only. Unknown spellings still fail ordinary validation. */
export const RETIRED_CONSOLIDATION_KEYS = [
  "consolidationModel", "consolidationThinking", "consolidation.forkModeDefault",
  "consolidation.triggerTokens", "consolidation.batchTokens", "consolidation.maxToolRounds",
] as const;

export function retireConsolidationSettings<T extends object>(input: T): { values: T; removed: string[] } {
  const values = { ...input } as Record<string, unknown>;
  const removed = RETIRED_CONSOLIDATION_KEYS.filter(key => Object.hasOwn(values, key));
  for (const key of removed) delete values[key];
  return { values: values as T, removed };
}

/** Upgrade one owned settings layer after validating the entire resulting file. No model mapping. */
export function upgradeSettingsFile(path: string, section: string | undefined,
  validate: (values: Record<string, unknown>) => unknown, report: (message: string) => void): string[] {
  const original = readFileSync(path, "utf8"), document = JSON.parse(original);
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error(`Invalid settings ${path}: expected an object`);
  const layer = section === undefined ? document : document[section];
  if (layer === undefined) return [];
  if (!layer || typeof layer !== "object" || Array.isArray(layer)) throw new Error(`Invalid settings ${path}: expected an object layer`);
  const { values, removed } = retireConsolidationSettings(layer);
  if (!removed.length) return [];
  validate(values);
  const next = section === undefined ? values : { ...document, [section]: values };
  const temporary = `${path}.${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (readFileSync(path, "utf8") !== original) throw new Error(`Settings changed during upgrade: ${path}`);
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  report(`Trace Memory removed retired settings from ${path}: ${removed.join(", ")}`);
  return removed;
}
