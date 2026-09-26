import type { ToolDefinition } from "../src/core/api/index.ts";
import { drainTrace } from "./trace-pages.ts";

/** Explicitly read one fixture identity's complete body and use the address actually returned.
 * Call this where the scenario reads, never automatically for a candidate pool or at write time. */
export function readHandle(tools: ToolDefinition[], address: string): string {
  const identity = /^(K[1-9][0-9]*)(?:@v[1-9][0-9]*|#[a-z]{4,})?$/.exec(address)?.[1];
  if (!identity) throw new Error(`Expected one current, tagged or @v fixture address: ${address}`);
  const trace = tools.find(t => t.name === "trace")!;
  const first = trace.execute({ address, itemBudget: null });
  if (first.includes("rejected:")) throw new Error(first);
  const text = drainTrace({ trace: (next, options) => trace.execute({ address: next, ...options }) }, first).joined;
  const handles = [...new Set(text.match(new RegExp(`\\b${identity}#[a-z]{4,}\\b`, "g")) ?? [])];
  if (handles.length !== 1) throw new Error(`Expected one complete fixture version tag: ${text}`);
  return handles[0]!;
}
