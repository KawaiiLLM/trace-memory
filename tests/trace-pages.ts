import { expect } from "vitest";
import type { ListingOptions, TraceMemory } from "../src/core/api/index.ts";
import { tokens } from "../src/core/render/index.ts";

/** Strip only the paginator's trailing receipt, never a source's own receipt block. */
export function tracePage(text: string) {
  const suffix = /\n\nReceipts:\n(?:versions: (?:current|history|all)(?:\n|$))?(Hit continues on next page; concatenate without a newline\.\n)?(?:cursor=([\da-f-]{36}))?$/.exec(text);
  return { body: suffix ? text.slice(0, suffix.index) : text, cursor: suffix?.[2], fragment: !!suffix?.[1] };
}
export function drainTrace(memory: Pick<TraceMemory, "trace">, first: string, options: ListingOptions = {}, between?: (page: number) => void) {
  let text = first, joined = "", separator = "", pages = 0;
  const seen = new Set<string>();
  for (;;) {
    const page = tracePage(text);
    expect(tokens(text)).toBeLessThanOrEqual(options.maxTokens ?? 2000);
    expect([...page.body].some(point => point.length === 1 && /[\uD800-\uDFFF]/.test(point))).toBe(false);
    expect(page.body.split("\n").length).toBeLessThanOrEqual(options.cap ?? 100);
    joined += separator + page.body;
    pages++;
    if (!page.cursor) return { joined, pages };
    expect(seen.has(page.cursor)).toBe(false); seen.add(page.cursor);
    expect(pages).toBeLessThan(10_000);
    between?.(pages);
    separator = page.fragment ? "" : "\n";
    text = memory.trace(`cursor=${page.cursor}`, options);
  }
}
export const wholeTrace = (memory: Pick<TraceMemory, "trace">, address: string, options: ListingOptions = {}) =>
  drainTrace(memory, memory.trace(address, options), options).joined;
