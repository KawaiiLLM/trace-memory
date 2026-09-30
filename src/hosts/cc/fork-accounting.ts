import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync, mkdirSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { cacheMissWarning, cacheObservation } from "../../core/api/cache-miss.ts";

/** Ticket 108: what a CC fork run cost. Tokens come from the fork's `turn.complete`; the price comes from
 * the fork's own transcript (one usage per response, with the 1h/5m cache split the event lacks) priced
 * with Claude Code's own baked model catalog. Every function here reports "unknown" instead of guessing:
 * an unlisted model, an unreadable catalog or a transcript that never reached the recorded tokens leaves
 * the cost unknown, never zero. */

// ---- The transcript: one usage per response ------------------------------------------------------

export interface CcResponseUsage {
  id: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number;
  /** Cache-creation tokens written at the 1h rate (`cache_creation.ephemeral_1h_input_tokens`). */
  cacheWrite1h: number; geo: string | null; webSearch: number; fast: boolean;
}
export interface CcTokens { input: number; output: number; cacheRead: number; cacheWrite: number }

const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The assistant rows of a fork transcript as one usage per `message.id`, the latest complete counters
 * winning (`worker.ts` `assistantUsage`: partial and replayed rows share an API response id). A torn
 * last line, an unparsable line and a row without the four counters are skipped; synthetic rows are
 * Claude Code's own placeholders, not requests. */
export function transcriptResponses(text: string): CcResponseUsage[] {
  const latest = new Map<string, CcResponseUsage>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    const message = row?.type === "assistant" ? row.message : undefined;
    if (typeof message?.id !== "string" || typeof message.model !== "string" || message.model === "<synthetic>") continue;
    const usage = message.usage;
    const input = count(usage?.input_tokens), output = count(usage?.output_tokens),
      cacheRead = count(usage?.cache_read_input_tokens), cacheWrite = count(usage?.cache_creation_input_tokens);
    if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) continue;
    latest.set(message.id, { id: message.id, model: message.model, input, output, cacheRead, cacheWrite,
      cacheWrite1h: count(usage.cache_creation?.ephemeral_1h_input_tokens) ?? 0,
      geo: typeof usage.inference_geo === "string" ? usage.inference_geo : null,
      webSearch: count(usage.server_tool_use?.web_search_requests) ?? 0, fast: usage.speed === "fast" });
  }
  return [...latest.values()];
}

export function sumTokens(responses: readonly CcResponseUsage[]): CcTokens {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const r of responses) { total.input += r.input; total.output += r.output; total.cacheRead += r.cacheRead; total.cacheWrite += r.cacheWrite; }
  return total;
}

/** The counters of a `turn.complete` usage, or undefined when any is missing (then the usage is unknown). */
export function eventTokens(usage: unknown): CcTokens | undefined {
  const u = usage as Record<string, unknown> | null | undefined;
  const input = count(u?.input_tokens), output = count(u?.output_tokens),
    cacheRead = count(u?.cache_read_input_tokens), cacheWrite = count(u?.cache_creation_input_tokens);
  return input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined ? undefined
    : { input, output, cacheRead, cacheWrite };
}

// ---- The bounded read ------------------------------------------------------------------------------

export interface ForkRead {
  /** `match`: the transcript totals equal the expected tokens. `mismatch`: a counter is already above them, so more time cannot help.
   * `timeout`: the deadline passed short of them. `settled`: with nothing expected, the transcript stopped growing. */
  status: "match" | "mismatch" | "timeout" | "settled";
  responses: CcResponseUsage[];
  /** False when the file never existed. */
  present: boolean;
}
export interface ForkReadOptions {
  deadlineMs?: number; pollMs?: number; stablePolls?: number;
  sleep?: (ms: number) => Promise<void>; now?: () => number; read?: (path: string) => string | null; stop?: () => boolean;
}
export const FORK_READ_DEADLINE_MS = 10_000;

const readIfPresent = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
};

/** Re-reads the fork transcript until its per-response totals equal `expected` (the tokens recorded from
 * `turn.complete`), for at most ten seconds: the transcript is written after the event fires. Without
 * `expected` (a fork stopped before it completed) it reads as far as the transcript goes: until two
 * consecutive polls see the same content. Never prices anything: the caller prices only a match, or the
 * partial usage of a settlement that had no expectation. */
export async function readForkTranscript(path: string, expected: CcTokens | undefined, options: ForkReadOptions = {}): Promise<ForkRead> {
  const { deadlineMs = FORK_READ_DEADLINE_MS, pollMs = 50, stablePolls = 4, sleep = ms => new Promise<void>(r => setTimeout(r, ms)),
    now = Date.now, read = readIfPresent, stop = () => false } = options;
  const deadline = now() + deadlineMs;
  let previous: string | null | undefined, same = 0, seen = false, last: CcResponseUsage[] = [];
  for (;;) {
    const text = read(path);
    seen = seen || text !== null;
    last = text === null ? [] : transcriptResponses(text);
    if (expected) {
      const t = sumTokens(last);
      if (t.input === expected.input && t.output === expected.output && t.cacheRead === expected.cacheRead && t.cacheWrite === expected.cacheWrite)
        return { status: "match", responses: last, present: true };
      if (t.input > expected.input || t.output > expected.output || t.cacheRead > expected.cacheRead || t.cacheWrite > expected.cacheWrite)
        return { status: "mismatch", responses: last, present: true };
    } else {
      same = text === previous ? same + 1 : 0;
      previous = text;
      if (same >= stablePolls) return { status: "settled", responses: last, present: seen };
    }
    if (now() >= deadline || stop()) return { status: expected ? "timeout" : "settled", responses: last, present: seen };
    await sleep(pollMs);
  }
}

// ---- Claude Code's own price list ------------------------------------------------------------------

export interface CcPriceTier { input: number; output: number; cache_write_5m: number; cache_write_1h: number; cache_read: number; web_search: number }
export interface CcPriceCatalog { tiers: Record<string, CcPriceTier>; models: Record<string, string> }

const CATALOG_MARKER = Buffer.from('{"//":"Hand-maintained baked-in model catalog');
const CATALOG_LIMIT = 1 << 20;

/** The catalog object literal out of the executable's bytes, or undefined. The binary embeds the source
 * of its bundle; the catalog is the object whose first key is that hand-maintained comment. */
function catalogLiteral(executable: string): string | undefined {
  const fd = openSync(executable, "r");
  try {
    const chunk = Buffer.alloc(8 << 20);
    let position = 0, carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, position);
      if (n <= 0) return;
      const window = Buffer.concat([carry, chunk.subarray(0, n)]);
      const at = window.indexOf(CATALOG_MARKER);
      if (at >= 0) {
        const tail = Buffer.alloc(CATALOG_LIMIT);
        const start = position - carry.length + at, got = readSync(fd, tail, 0, CATALOG_LIMIT, start);
        return braceSlice(tail.subarray(0, got).toString("utf8"));
      }
      carry = window.subarray(Math.max(0, window.length - CATALOG_MARKER.length));
      position += n;
    }
  } finally { closeSync(fd); }
}

/** The balanced `{...}` at the start of `text`, strings skipped. */
function braceSlice(text: string): string | undefined {
  let depth = 0, inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(0, i + 1);
  }
}

/** The bundle's minified literal (`{key:!0,other:void 0}`) as JSON: bare keys quoted and `!0`, `!1`,
 * `void 0` spelled out, outside string literals only. Anything else that fails JSON.parse is refused. */
export function catalogFromLiteral(literal: string): CcPriceCatalog | undefined {
  const json = literal.split(/("(?:[^"\\]|\\.)*")/).map((part, i) => i % 2 ? part : part
    .replace(/void 0/g, "null").replace(/!0/g, "true").replace(/!1/g, "false").replace(/([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')).join("");
  let parsed: any;
  try { parsed = JSON.parse(json); } catch { return; }
  if (!parsed || typeof parsed.pricing_tiers !== "object" || !Array.isArray(parsed.models)) return;
  const tiers: Record<string, CcPriceTier> = {};
  for (const [name, tier] of Object.entries<any>(parsed.pricing_tiers)) {
    const fields = ["input", "output", "cache_write_5m", "cache_write_1h", "cache_read", "web_search"] as const;
    if (fields.every(f => typeof tier?.[f] === "number")) tiers[name] = Object.fromEntries(fields.map(f => [f, tier[f]])) as unknown as CcPriceTier;
  }
  const models: Record<string, string> = {};
  for (const model of parsed.models) {
    if (typeof model?.id !== "string" || typeof model.pricing !== "string" || !tiers[model.pricing]) continue;
    models[model.id] = model.pricing;
    const firstParty = model.provider_ids?.first_party;
    if (typeof firstParty === "string") models[firstParty] = model.pricing;
  }
  return Object.keys(models).length ? { tiers, models } : undefined;
}

/** Parses the catalog out of `executable`, cached in `cachePath` under the executable's identity (path,
 * size, mtime): a new Claude Code build is a new key, so the executable is scanned once per version. */
export function readPriceCatalog(executable: string, cachePath: string): CcPriceCatalog | { unknown: string } {
  let key: string;
  try { const real = realpathSync(executable), stat = statSync(real); key = `${real}\n${stat.size}\n${stat.mtimeMs}`; }
  catch (error) { return { unknown: `Claude Code executable ${executable} is unreadable: ${String(error)}` }; }
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cached?.key === key && cached.catalog) return cached.catalog as CcPriceCatalog;
  } catch { /* no usable cache: parse the executable */ }
  let catalog: CcPriceCatalog | undefined;
  try { const literal = catalogLiteral(executable); catalog = literal ? catalogFromLiteral(literal) : undefined; }
  catch (error) { return { unknown: `Claude Code executable ${executable} cannot be scanned: ${String(error)}` }; }
  if (!catalog) return { unknown: `no model catalog found in Claude Code executable ${executable}` };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const temporary = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ key, catalog })); renameSync(temporary, cachePath);
  } catch { /* an unwritable cache only costs the next scan */ }
  return catalog;
}

/** The executable of a running process. `/proc` where it exists; else `ps`'s command name when that is a
 * path (macOS shows a path for ordinary binaries, but Claude Code's Bun executable rewrites its own name to
 * a bare `claude`); else the process's first text mapping through `lsof`, which is the executable image. */
export function runningExecutable(pid: number): string | undefined {
  const run = (file: string, args: string[]) => {
    try { return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }); } catch { return ""; }
  };
  try { return readlinkSync(`/proc/${pid}/exe`); } catch { /* not Linux */ }
  const named = run("ps", ["-o", "comm=", "-p", String(pid)]).trim();
  if (isAbsolute(named) && existsSync(named)) return named;
  // `/usr/sbin` is not on every PATH (a hook child's or MCP server's), and is where macOS keeps lsof.
  for (const lsof of ["lsof", "/usr/sbin/lsof"])
    for (const line of run(lsof, ["-p", String(pid), "-a", "-d", "txt", "-Fn"]).split("\n"))
      if (line.startsWith("n/") && existsSync(line.slice(1))) return line.slice(1);
}

/** Claude Code's formula for one response (`V9e`/`iT` in 2.1.284): each token class at its tier rate, the
 * cache writes split by TTL, x1.1 for `inference_geo: "us"`, plus $/request for web searches. */
export function priceResponse(catalog: CcPriceCatalog, r: CcResponseUsage): number | { unknown: string } {
  const tier = catalog.tiers[catalog.models[r.model] ?? ""];
  if (!tier) return { unknown: `model ${r.model} is not in Claude Code's price list` };
  if (r.fast) return { unknown: `response ${r.id} ran in fast mode, which the price list cache does not hold` };
  const oneHour = Math.min(r.cacheWrite1h, r.cacheWrite);
  const writes = oneHour <= 0 ? r.cacheWrite / 1e6 * tier.cache_write_5m
    : oneHour / 1e6 * tier.cache_write_1h + (r.cacheWrite - oneHour) / 1e6 * tier.cache_write_5m;
  const base = r.input / 1e6 * tier.input + r.output / 1e6 * tier.output + r.cacheRead / 1e6 * tier.cache_read + writes;
  return base * (r.geo === "us" ? 1.1 : 1) + r.webSearch * tier.web_search;
}

/** The total of every response, or the first reason one cannot be priced: never a partial sum. */
export function priceResponses(catalog: CcPriceCatalog, responses: readonly CcResponseUsage[]): number | { unknown: string } {
  let total = 0;
  for (const r of responses) { const price = priceResponse(catalog, r); if (typeof price !== "number") return price; total += price; }
  return total;
}

export const forkTranscriptPath = (sessionTranscript: string, agentId: string): string =>
  join(sessionTranscript.replace(/\.jsonl$/, ""), "subagents", `agent-${agentId}.jsonl`);

/** What a settled fork's transcript adds to its recorded run (`Store.amendRunUsage`'s patch) and the cache-miss
 * warnings of its responses. `expected` is the tokens recorded from `turn.complete`; a fork stopped before it
 * completed has none, and whatever its transcript holds becomes partial usage. The patch is absent when there
 * is nothing to add: a stopped fork whose transcript holds no response stays unknown. A cost that cannot be
 * known (catalog, model, undercounted transcript) is absent from the usage and named in a problem. */
export async function accountForkTranscript(path: string, expected: CcTokens | undefined,
  catalog: () => CcPriceCatalog | { unknown: string }, options: ForkReadOptions = {}) {
  const read = await readForkTranscript(path, expected, options);
  const warnings: string[] = [], misses: unknown[] = [];
  for (const r of read.responses) {
    const observed = cacheObservation({ api: "anthropic-messages", id: r.model, provider: "anthropic" },
      { input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite }, true);
    if (observed?.miss) { misses.push(observed); warnings.push(cacheMissWarning(observed)); }
  }
  const patch: { usage?: CcTokens & { cost?: { total: number } }; usageStatus?: "partial"; problem?: string; cacheMiss?: unknown } = {};
  if (expected ? read.status === "match" : read.responses.length > 0) {
    const known = catalog(), price = "unknown" in known ? known : priceResponses(known, read.responses);
    patch.usage = { ...(expected ?? sumTokens(read.responses)), ...(typeof price === "number" ? { cost: { total: price } } : {}) };
    if (typeof price !== "number") patch.problem = `CC fork cost unknown: ${price.unknown}`;
    if (!expected) patch.usageStatus = "partial";
  } else if (expected) patch.problem = `CC fork cost unknown: its transcript ${read.present ? `did not reach the recorded tokens (${read.status})` : "was never written"} within ${(options.deadlineMs ?? FORK_READ_DEADLINE_MS) / 1000} s`;
  if (misses.length) patch.cacheMiss = misses[0];
  return { patch: Object.keys(patch).length ? patch : undefined, warnings };
}
