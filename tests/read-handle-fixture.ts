import type { ToolDefinition } from "../src/core/api/index.ts";

/** Explicitly read one fixture identity's complete body and use the address actually returned.
 * Call this where the scenario reads, never automatically for a candidate pool or at write time. */
export function readHandle(tools: ToolDefinition[], address: string): string {
  const text = tools.find(t => t.name === "trace")!.execute({ address, cap: Number.MAX_SAFE_INTEGER });
  if (text.includes("rejected:")) throw new Error(text);
  if (/^K\d+@\d+$/.test(address)) return address;
  const line = text.split("\n").find(line => line.includes(`${address} path current:`));
  const handles = line?.split("path current:")[1]?.match(/K\d+@\d+/g) ?? [];
  if (handles.length !== 1) throw new Error(`Expected one read fixture handle: ${text}`);
  return handles[0]!;
}
