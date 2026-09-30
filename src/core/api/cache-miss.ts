// The shared fork cache-miss observation rule (Pi and Claude Code judge a fork response by it).
/** Minimum cacheable prefix length, by provider family and model, from the providers' own
 * documentation. There is deliberately no universal fallback: an API or model that is not listed has
 * an unknown minimum, and an unknown minimum can never establish an eligible miss.
 * - `anthropic-messages`: 1024 tokens, and 2048 for the Haiku family (Anthropic prompt caching).
 * - OpenAI-family completions/responses: a 1024-token prefix (OpenAI automatic prompt caching). */
const CACHE_MINIMUM: { api: string; model?: RegExp; tokens: number }[] = [
  { api: "anthropic-messages", model: /haiku/i, tokens: 2048 },
  { api: "anthropic-messages", tokens: 1024 },
  { api: "openai-completions", tokens: 1024 },
  { api: "openai-responses", tokens: 1024 },
  { api: "openai-codex-responses", tokens: 1024 },
];
export const cacheMinimum = (api: string, model: string): number | undefined =>
  CACHE_MINIMUM.find(entry => entry.api === api && (!entry.model || entry.model.test(model)))?.tokens;

/** User ruling 2026-09-09 (supersedes the 2026-09-08 30,000-uncached-token rule): a completed fork
 * response is a miss when the tokens the provider served from cache are below half of the request's
 * input — `cacheRead < CACHE_MISS_READ_RATIO × (input + cacheRead + cacheWrite)`. Ticket 108 removed
 * the session downgrade: a miss is audited and warned once, and nothing else follows from it. A
 * response whose input is below the provider's documented cacheable minimum cannot have hit and says
 * nothing (ticket 19 "Unknown is not zero"). */
export const CACHE_MISS_READ_RATIO = 0.5;

/** What one eligible response says: its own reported accounting, the model it was measured on, the
 * provider's documented minimum cacheable length, the ratio it was judged by, its input length and
 * whether it was a miss. */
export interface CacheObservation { model: string; api: string; minimum: number; ratio: number; input: number; cacheRead: number; cacheWrite: number; total: number; miss: boolean }

/** One completed fork response, judged on its own reported usage (never a run's sum).
 *
 * pi-ai normalizes both families to the same counting convention: `input` excludes both `cacheRead`
 * and `cacheWrite` (`openai-completions` subtracts them from `prompt_tokens`; `anthropic-messages`
 * copies `input_tokens`, which already excludes them), so the request's actual input length is
 * `input + cacheRead + cacheWrite` on either. Compressed Raw size is never used.
 *
 * Everything unknown returns undefined: missing or non-numeric usage, an unreported cache count, a
 * provider cache that was not requested at all, an unlisted provider (whose cache reporting is
 * unknown), and an input below the provider's cacheable minimum. Otherwise the response is observed,
 * hit or miss. */
export function cacheObservation(model: { api: string; id: string; provider: string }, usage: unknown, cacheEnabled: boolean, ratio = CACHE_MISS_READ_RATIO): CacheObservation | undefined {
  if (!cacheEnabled) return; // the request asked for no caching: its cache count says nothing
  const minimum = cacheMinimum(model.api, model.id);
  if (minimum === undefined) return; // unlisted provider: cache reporting unknown
  if (!usage || typeof usage !== "object") return;
  const reported = usage as { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
  if (typeof reported.input !== "number" || typeof reported.cacheRead !== "number") return;
  const cacheWrite = typeof reported.cacheWrite === "number" ? reported.cacheWrite : 0;
  const total = reported.input + reported.cacheRead + cacheWrite;
  if (!Number.isFinite(total) || total < minimum) return; // too small to have been cached at all
  return { model: `${model.provider}/${model.id}`, api: model.api, minimum, ratio, input: reported.input, cacheRead: reported.cacheRead, cacheWrite, total, miss: reported.cacheRead < ratio * total };
}


/** The one warning both hosts show for a miss: how much of the request's input the cache served. */
export const cacheMissWarning = (observation: CacheObservation): string =>
  `Trace Memory: fork cache miss (${observation.cacheRead} of ${observation.total} input tokens read from cache).`;
