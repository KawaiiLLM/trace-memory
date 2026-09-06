import { createHash } from "node:crypto";

export type Body = Record<string, unknown>;
export const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value));
// Sort object keys only. Array order, strings, whitespace and Unicode stay exact.
export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export const hash = (value: unknown) => createHash("sha256").update(serialize(value)).digest("hex");
export function messageKey(api: string): "messages" | "input" {
  if (api === "openai-responses") return "input";
  if (api === "anthropic-messages" || api === "openai-completions") return "messages";
  throw new Error(`Unsupported branch payload API: ${api}`);
}
export function buildRequest(payload: Body, api: string, instruction: string): Body {
  const key = messageKey(api);
  if (!Array.isArray(payload[key])) throw new Error(`Missing provider message array: ${key}`);
  const appended = { role: "user", content: api === "openai-responses"
    ? [{ type: "input_text", text: instruction }] : instruction };
  return { ...snapshot(payload), [key]: [...snapshot(payload[key]), appended] };
}
function difference(a: unknown, b: unknown, path = "$"): string | undefined {
  if (serialize(a) === serialize(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = a as Body, right = b as Body;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const found = difference(left[key], right[key], `${path}.${key}`);
      if (found) return found;
    }
  }
  return path;
}
export function verifyRequest(payload: Body, request: Body, api: string, instruction: string) {
  // Independently strip the append and compare to the capture; never rebuild
  // the expected prefix with the builder being verified.
  const key = messageKey(api), messages = request[key];
  const appendedMessage = Array.isArray(messages) ? messages.at(-1) : undefined;
  const expectedAppend = { role: "user", content: api === "openai-responses"
    ? [{ type: "input_text", text: instruction }] : instruction };
  const differingPath = (!Array.isArray(messages) ? `$.${key}`
    : difference(payload, { ...request, [key]: messages.slice(0, -1) })
      ?? difference(expectedAppend, appendedMessage, `$.${key}.append`)) ?? null;
  return { passed: differingPath === null, capturedHash: hash(payload), requestHash: hash(request),
    appendedMessage, differingPath };
}
