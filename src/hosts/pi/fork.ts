import { createHash } from "node:crypto";

export type Body = Record<string, unknown>;
export const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value));
// Sort object keys only. Array order, strings, whitespace and Unicode stay exact.
export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export const hash = (value: unknown) => createHash("sha256").update(serialize(value)).digest("hex");
// openai-codex-responses (Pi's ChatGPT-subscription Codex backend) sends the same body as openai-responses.
const responsesApi = (api: string) => api === "openai-responses" || api === "openai-codex-responses";
export function messageKey(api: string): "messages" | "input" {
  if (responsesApi(api)) return "input";
  if (api === "anthropic-messages" || api === "openai-completions") return "messages";
  throw new Error(`Unsupported fork payload API: ${api}`);
}
/** The parent's own system prompt bytes, read back out of its captured body (19a). */
export function capturedSystemPrompt(api: string, payload: Body): string {
  if (responsesApi(api)) {
    if (typeof payload.instructions !== "string") throw new Error("Captured payload has no instructions string");
    return payload.instructions;
  }
  if (api === "anthropic-messages") {
    const system = payload.system;
    if (typeof system === "string") return system;
    if (Array.isArray(system) && system.length === 1 && (system[0] as Body)?.type === "text" && typeof (system[0] as Body).text === "string") return (system[0] as Body).text as string;
    throw new Error("Captured payload system is not a single text block");
  }
  const first = (payload[messageKey(api)] as Body[] | undefined)?.[0];
  if (!first || (first.role !== "system" && first.role !== "developer") || typeof first.content !== "string") throw new Error("Captured payload has no leading system message");
  return first.content;
}
/** The parent's tool definitions, in the parent's order, as the child must re-register them (19a). */
export function capturedTools(api: string, payload: Body): { name: string; description: string; parameters: Body }[] {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((raw, index) => {
    const tool = (api === "openai-completions" ? (raw as Body).function : raw) as Body | undefined;
    const parameters = (api === "anthropic-messages" ? tool?.input_schema : tool?.parameters) as Body | undefined;
    if (!tool || typeof tool.name !== "string" || typeof tool.description !== "string" || !parameters || typeof parameters !== "object")
      throw new Error(`Captured tool ${index} is not a name/description/schema function definition`);
    return { name: tool.name, description: tool.description, parameters };
  });
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
/** Remove provider cache markers (`cache_control`) everywhere; the only field the fork gate ignores. */
export function stripCacheControl<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripCacheControl) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as object).filter(([k]) => k !== "cache_control").map(([k, v]) => [k, stripCacheControl(v)])) as T;
  return value;
}

/** The native fork gate (user ruling 2026-09-08, ticket 19 gate 1 amendment): the captured parent body
 * and the child's outgoing body are compared with `cache_control` markers stripped from both sides and
 * nothing else. pi-ai's Anthropic adapter moves the ephemeral breakpoint to the body's last user message,
 * so a child that appends a message cannot keep the parent's marker; the marker is a caching hint, not
 * content, and the provider's cache lookup walks the identical bytes before it. Hashes are of the raw bodies. */
export function verifyForkRequest(payload: Body, request: Body, api: string) {
  const key = messageKey(api), captured = stripCacheControl(payload), outgoing = stripCacheControl(request);
  const messages = outgoing[key];
  const appended = Array.isArray(messages) ? messages.slice((captured[key] as unknown[] | undefined)?.length ?? messages.length) : [];
  return { ...verifyNativeRequest(captured, outgoing, api, appended), capturedHash: hash(payload), requestHash: hash(request), normalized: ["cache_control"] as const };
}

export function verifyNativeRequest(payload: Body, request: Body, api: string, expected: unknown[]) {
  const key = messageKey(api), messages = request[key];
  const appendedMessages = Array.isArray(messages) ? messages.slice(messages.length - expected.length) : [];
  const differingPath = (!Array.isArray(messages) || messages.length < expected.length ? `$.${key}`
    : difference(payload, { ...request, [key]: messages.slice(0, messages.length - expected.length) })
      ?? difference(expected, appendedMessages, `$.${key}.append`)) ?? null;
  return { passed: differingPath === null, capturedHash: hash(payload), requestHash: hash(request),
    appendedMessages, differingPath };
}
