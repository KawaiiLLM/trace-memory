import { expect, test } from "vitest";
import { cacheMinimum, cacheMissWarning, cacheObservation } from "../../../src/core/api/cache-miss.ts";

// The one fork cache-miss observation rule, shared by Pi and Claude Code (ticket 108).

test("cache eligibility rejects small, missing, placeholder and unsupported usage, unknown providers and a disabled cache", () => {
  const openai = { api: "openai-completions", id: "test", provider: "fake" };
  const anthropic = { api: "anthropic-messages", id: "claude-sonnet-4", provider: "fake" };
  const haiku = { api: "anthropic-messages", id: "claude-3-5-haiku", provider: "fake" };
  const zero = { input: 32000, cacheRead: 0, cacheWrite: 0 };
  // Eligible: a listed provider, reported cache counts, 32,000 input tokens and nothing read: a miss.
  expect(cacheObservation(openai, zero, true)).toEqual({ model: "fake/test", api: "openai-completions", minimum: 1024, ratio: 0.5, input: 32000, cacheRead: 0, cacheWrite: 0, total: 32000, miss: true });
  // pi-ai reports `input` without the cached tokens on both families; a cache write is not a read,
  // so an Anthropic first write of 31,000 tokens is a miss on a 31,024-token input.
  expect(cacheObservation(anthropic, { input: 24, cacheRead: 0, cacheWrite: 31000 }, true)).toMatchObject({ total: 31024, miss: true });
  // Eligible hits are observed too (they reset the host's count), never recorded as misses.
  expect(cacheObservation(openai, { input: 2000, cacheRead: 40000, cacheWrite: 0 }, true)).toMatchObject({ total: 42000, miss: false });
  expect(cacheObservation(openai, { input: 1, cacheRead: 1023, cacheWrite: 0 }, true)).toMatchObject({ total: 1024, miss: false }); // exactly the minimum, almost all read
  // Not eligible, one reason each.
  expect(cacheObservation(openai, { input: 1000, cacheRead: 0, cacheWrite: 0 }, true)).toBeUndefined(); // below the cacheable minimum
  expect(cacheObservation(openai, undefined, true)).toBeUndefined(); // missing usage
  expect(cacheObservation(openai, { input: 0, cacheRead: 0, cacheWrite: 0 }, true)).toBeUndefined(); // placeholder zeros
  expect(cacheObservation(openai, { input: 32000 }, true)).toBeUndefined(); // no cache reporting at all
  expect(cacheObservation(openai, zero, false)).toBeUndefined(); // the request asked for no caching
  expect(cacheObservation({ api: "google-generative-ai", id: "gemini", provider: "g" }, zero, true)).toBeUndefined(); // unlisted provider
  // The provider table still records the documented minimum on the observation.
  expect(cacheObservation(haiku, zero, true)?.minimum).toBe(2048);
  expect(cacheMinimum("openai-responses", "gpt-5")).toBe(1024);
  expect(cacheMinimum("google-generative-ai", "gemini")).toBeUndefined();
});

test("ruling 2026-09-09: a response is a miss when its cacheRead is below half of its input (input + cacheRead + cacheWrite)", () => {
  const openai = { api: "openai-completions", id: "test", provider: "fake" };
  const codex = { api: "openai-codex-responses", id: "gpt-5.6-sol", provider: "openai-codex" };
  // The live run's R2: 5,277 input tokens, nothing read: a miss now, but one miss alone downgrades nothing.
  expect(cacheObservation(codex, { input: 5277, cacheRead: 0, cacheWrite: 0 }, true)?.miss).toBe(true);
  // The boundary: exactly half read is a hit; one token below half is a miss.
  expect(cacheObservation(openai, { input: 5000, cacheRead: 5000, cacheWrite: 0 }, true)?.miss).toBe(false);
  expect(cacheObservation(openai, { input: 5001, cacheRead: 4999, cacheWrite: 0 }, true)?.miss).toBe(true);
  // A large partial hit is a hit whatever it re-sent; the old 30,000-uncached rule no longer applies.
  expect(cacheObservation(openai, { input: 35000, cacheRead: 40000, cacheWrite: 0 }, true)).toMatchObject({ total: 75000, miss: false });
  expect(cacheObservation(openai, { input: 35000, cacheRead: 4000, cacheWrite: 0 }, true)).toMatchObject({ total: 39000, miss: true });
  // Cache-write tokens were not read, so they count against the ratio.
  expect(cacheObservation({ api: "anthropic-messages", id: "claude-sonnet-4", provider: "fake" }, { input: 100, cacheRead: 0, cacheWrite: 29900 }, true)).toMatchObject({ total: 30000, miss: true });
});


test("ticket 108: the warning names how many input tokens the cache served", () => {
  const observed = cacheObservation({ api: "anthropic-messages", id: "claude-sonnet-5-5", provider: "anthropic" }, { input: 100, cacheRead: 4000, cacheWrite: 26000 }, true)!;
  expect(observed.miss).toBe(true);
  expect(cacheMissWarning(observed)).toBe("Trace Memory: fork cache miss (4000 of 30100 input tokens read from cache).");
});
