/** Address syntax only. No database access and no cursor side effects. */
export type Selector = { kind: "role"; role: "user" | "assistant" | "toolResult" }
  | { kind: "text" | "thinking" | "facts" } | { kind: "call"; id: string };
export interface TurnAddress {
  turn: number; session?: number; legacy?: "user" | "assistant" | `t${number}`;
  entries?: { from: number; to?: number }[]; selector?: Selector;
}
const positive = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`invalid address integer: ${value}`);
  return Number(value);
};
const reserved = new Set(["text", "thinking", "user", "assistant", "toolResult", "F*"]);
/** Delimiters and reserved selectors require JSON quoting; opaque IDs are never normalized. */
export const callSelector = (id: string): string => reserved.has(id) || !/^[^\s,@#*"\\\[\]\x00-\x1f]+$/u.test(id)
  ? JSON.stringify(id) : id;
function selector(value: string): Selector {
  if (value.startsWith('"')) {
    let id: unknown;
    try { id = JSON.parse(value); } catch { throw new Error("invalid quoted tool call ID"); }
    if (typeof id !== "string" || !id.length || /[\uD800-\uDFFF]/u.test(id)) throw new Error("invalid tool call ID");
    return { kind: "call", id };
  }
  if (value === "F*") return { kind: "facts" };
  if (value === "text" || value === "thinking") return { kind: value };
  if (value === "user" || value === "assistant" || value === "toolResult") return { kind: "role", role: value };
  if (!value || /[\uD800-\uDFFF]/u.test(value) || callSelector(value) !== value) throw new Error("invalid content selector; quote opaque IDs containing delimiters as JSON strings");
  return { kind: "call", id: value };
}
export function parseTurnAddress(address: string): TurnAddress | null {
  const match = /^(?:S([1-9]\d*)\/)?T([1-9]\d*)(.*)$/su.exec(address);
  if (!match) return null;
  const result: TurnAddress = { turn: positive(match[2]!), ...(match[1] ? { session: positive(match[1]) } : {}) };
  let rest = match[3]!;
  const legacy = /^#(user|assistant|t[1-9]\d*)$/.exec(rest);
  if (legacy) { result.legacy = legacy[1] as TurnAddress["legacy"]; if (result.legacy!.startsWith("t")) positive(result.legacy!.slice(1)); return result; }
  if (rest.startsWith("#")) {
    const end = rest.indexOf("@");
    const selection = rest.slice(1, end < 0 ? undefined : end);
    result.entries = selection.split(",").map(item => {
      const m = /^E([1-9]\d*)(?:\.\.E([1-9]\d*))?$/.exec(item.trim());
      if (!m) throw new Error(`invalid entry selection: ${selection}`);
      const from = positive(m[1]!), to = m[2] ? positive(m[2]) : undefined;
      if (to !== undefined && to < from) throw new Error("entry range endpoints must ascend");
      return { from, ...(to === undefined ? {} : { to }) };
    });
    rest = end < 0 ? "" : rest.slice(end);
  }
  if (rest) {
    if (!rest.startsWith("@")) throw new Error(`invalid trace address: ${address}`);
    result.selector = selector(rest.slice(1));
    if (result.entries && result.selector.kind === "facts") throw new Error("@F* selects Turn-owned facts, not entry facts");
  }
  return result;
}
/** Scan commas outside JSON-quoted IDs, then retain inherited E items in their Turn target. */
export function traceTargets(expression: string): string[] {
  const pieces: string[] = [];
  let start = 0, quoted = false, escaped = false;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === ",") { pieces.push(expression.slice(start, i).trim()); start = i + 1; }
  }
  if (quoted) throw new Error("unterminated quoted tool call ID");
  pieces.push(expression.slice(start).trim());
  const targets: string[] = [];
  for (const piece of pieces) {
    if (!piece) throw new Error("invalid empty trace target");
    if (/^E\d/.test(piece)) {
      const previous = targets.at(-1);
      if (!previous || !/^(?:S\d+\/)?T\d+#E/.test(previous) || previous.includes("@")) throw new Error("entry shorthand requires a preceding Turn entry selection; @ applies to the entire selection");
      targets[targets.length - 1] += `,${piece}`;
    } else targets.push(piece);
  }
  for (const target of targets) if (/^(?:S\d+\/)?T\d/.test(target)) {
    if (!parseTurnAddress(target)) throw new Error(`invalid trace address: ${target}`);
  }
  return targets;
}
