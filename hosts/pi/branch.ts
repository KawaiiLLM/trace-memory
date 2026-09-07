import { createHash } from "node:crypto";

export type Body = Record<string, unknown>;
/** A message appended after the verified prefix: the recording or integration instruction, or a replayed candidate reply. */
export type Appended = { role: "user" | "assistant"; text: string };
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
  throw new Error(`Unsupported branch payload API: ${api}`);
}
// Native message shapes copied from pi-ai's adapters (openai-responses-shared, anthropic-messages, openai-completions).
function providerMessage(api: string, message: Appended): Body {
  if (responsesApi(api)) return message.role === "user"
    ? { role: "user", content: [{ type: "input_text", text: message.text }] }
    : { type: "message", role: "assistant", content: [{ type: "output_text", text: message.text, annotations: [] }], status: "completed", id: "msg_pi_branch" };
  if (api === "anthropic-messages" && message.role === "assistant") return { role: "assistant", content: [{ type: "text", text: message.text }] };
  return { role: message.role, content: message.text };
}
const list = (appended: string | Appended[]): Appended[] => typeof appended === "string" ? [{ role: "user", text: appended }] : appended;
export function buildRequest(payload: Body, api: string, appended: string | Appended[]): Body {
  const key = messageKey(api);
  if (!Array.isArray(payload[key])) throw new Error(`Missing provider message array: ${key}`);
  return { ...snapshot(payload), [key]: [...snapshot(payload[key]), ...list(appended).map(m => providerMessage(api, m))] };
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
export function verifyRequest(payload: Body, request: Body, api: string, appended: string | Appended[]) {
  // Independently strip the appends and compare to the capture; never rebuild
  // the expected prefix with the builder being verified.
  const key = messageKey(api), messages = request[key], expected = list(appended);
  const appendedMessages = Array.isArray(messages) ? messages.slice(-expected.length) : [];
  const differingPath = (!Array.isArray(messages) || messages.length < expected.length ? `$.${key}`
    : difference(payload, { ...request, [key]: messages.slice(0, -expected.length) })
      ?? difference(expected.map(m => providerMessage(api, m)), appendedMessages, `$.${key}.append`)) ?? null;
  return { passed: differingPath === null, capturedHash: hash(payload), requestHash: hash(request),
    appendedMessages, differingPath };
}
