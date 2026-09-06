import { afterEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { complete } from "@earendil-works/pi-ai/compat";
import * as branch from "./branch.ts";
import { host as createHost, reply, usage } from "./test-host.ts";

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: vi.fn() }));
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); vi.restoreAllMocks(); vi.mocked(complete).mockReset(); });
const payload = () => ({ model: "test", stream: true, temperature: 0.3, system: "System\n  exact 漢字 é",
  messages: [{ role: "user", content: "Raw  \ncontext" }, { role: "assistant", content: "Previous reply" }],
  tools: [{ type: "function", function: { name: "trace", parameters: { type: "object", properties: {} } } }] });
async function setup() {
  const h = createHost({ "note.triggerAnsweredTurns": 1, noteModel: "fake/ignored" });
  disposers.push(h.dispose);
  await h.emit("session_start");
  const sent: branch.Body[] = [];
  vi.mocked(complete).mockImplementation(async (model, _conversation, options) => {
    const body = await options!.onPayload!({ irrelevantSerializerDefaults: true }, model) as branch.Body;
    sent.push(structuredClone(body));
    return reply("[]");
  });
  const capture = (body = payload()) => h.emit("before_provider_request", { payload: body });
  return { ...h, sent, capture, run: () => h.memory.store.listRuns(1).at(-1)! };
}

test("branch note preserves prefix bytes, options and tools; record contains independent body hashes", async () => {
  const h = await setup(), captured = payload();
  await h.capture(captured);
  captured.system = "mutation of hook owner after capture";
  await h.turn();
  expect(h.requests).toHaveLength(0); // Registry completion is subagent-only.
  const request = h.sent[0]!, original = payload();
  const messages = request.messages as unknown[];
  expect(Buffer.from(branch.serialize(messages.slice(0, -1)))).toEqual(Buffer.from(branch.serialize(original.messages)));
  expect(request).toEqual({ ...original, messages: [...original.messages, expect.objectContaining({ role: "user" })] });
  const prompt = readFileSync(new URL("../../core/prompts/note.md", import.meta.url), "utf8");
  expect((messages.at(-1) as { content: string }).content).toBe(prompt + "\n\nRange: S1/T1..S1/T1\n\nThe raw turns of this range, the facts delivered after earlier notes, and the active entries are already in this conversation.");
  const run = h.run(), response = JSON.parse(run.response!);
  expect(run.mode).toBe("branch"); expect(run.model).toBe("fake/test");
  expect(run.outcome).toBe("success"); expect(JSON.parse(run.request!)).toEqual(request);
  expect(response.verification).toMatchObject({ passed: true, capturedHash: branch.hash(original), requestHash: branch.hash(request), differingPath: null, firstForKey: true });
  expect(response.verification.appendedMessage).toEqual(messages.at(-1));
  expect(vi.mocked(complete).mock.calls[0]![0]).toMatchObject({ id: "test", baseUrl: "https://fake.invalid" });
  expect(vi.mocked(complete).mock.calls[0]![2]).toMatchObject({ apiKey: "fake-key", headers: { "x-test": "header" }, sessionId: "pi-test" });
  expect(JSON.stringify(h.entries)).not.toContain(original.system);
});

test.each(["system", "tools"])("mutated %s fails before send, falls back with full input and notifies once", async field => {
  const h = await setup();
  const build = branch.buildRequest;
  vi.spyOn(branch, "buildRequest").mockImplementation((...args) => ({ ...build(...args), [field]: field === "system" ? "changed" : [{ name: "changed" }] }));
  await h.capture(); await h.turn();
  expect(complete).not.toHaveBeenCalled();
  expect(h.requests).toHaveLength(1);
  expect(h.conversations[0]!.messages[0]!.content).toContain("Raw:");
  expect(h.conversations[0]!.messages[0]!.content).toContain("用 pnpm");
  const run = h.run(), response = JSON.parse(run.response!);
  expect(run.mode).toBe("subagent"); expect(run.outcome).toBe("success");
  expect(JSON.parse(run.request!)).toEqual(h.requests[0]);
  expect(response.verification.passed).toBe(false);
  expect(response.verification.differingPath).toContain(`$.${field}`);
  expect(response.verification.capturedHash).toBe(branch.hash(payload()));
  expect(response.verification.requestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(response.fallbackReason).toContain("Prefix mismatch");
  await h.turn(); expect(h.notices.filter(n => n.includes("fell back"))).toHaveLength(1);
});

test("verification runs on every attempt and resets after model, provider or tool changes", async () => {
  const h = await setup();
  await h.capture(); await h.turn();
  expect(JSON.parse(h.run().response!).verification.firstForKey).toBe(true);
  await h.capture(); await h.turn();
  expect(JSON.parse(h.run().response!).verification.firstForKey).toBe(false);
  for (const change of ["model", "tools", "provider"]) {
    if (change === "model") h.ctx.model = { ...h.ctx.model!, id: "next" };
    if (change === "provider") h.ctx.model = { ...h.ctx.model!, provider: "next-provider" };
    const body = payload(); body.model = h.ctx.model!.id;
    if (change === "tools") body.tools[0]!.function.name = "search";
    await h.capture(body); await h.turn();
    expect(h.run().mode).toBe("branch");
    expect(JSON.parse(h.run().response!).verification).toMatchObject({ passed: true, firstForKey: true });
  }
});

test.each([8192, 0, undefined])("cache reads %s are observations only", async cacheRead => {
  const h = await setup();
  vi.mocked(complete).mockImplementation(async (model, _context, options) => {
    await options!.onPayload!({}, model);
    const result = reply("[]");
    result.usage = { ...usage, cacheRead } as typeof usage;
    return result;
  });
  await h.capture(); await h.turn();
  const response = JSON.parse(h.run().response!);
  expect(response.verification.passed).toBe(true);
  expect(response.verification.cache_read).toBe(cacheRead);
  expect(response.usage.cacheRead).toBe(cacheRead);
  expect("cache_read" in response.verification).toBe(cacheRead !== undefined);
});

test("capture invalidates on tree switch and cannot be inherited by a new Pi session", async () => {
  const h = await setup();
  await h.capture(); await h.turn();
  await h.emit("session_tree"); await h.turn();
  expect(h.run().mode).toBe("subagent");
  expect(JSON.parse(h.run().response!).fallbackReason).toContain("No current-branch");
  h.ctx.sessionManager.getSessionId = () => "new-session";
  await h.emit("session_start"); await h.turn();
  expect(h.run().mode).toBe("subagent");
  expect(complete).toHaveBeenCalledTimes(1);
});

test("model change without a fresh capture falls back; explicit subagent never uses a capture", async () => {
  const h = await setup();
  await h.capture(); h.ctx.model = { ...h.ctx.model!, id: "next" }; await h.turn();
  expect(JSON.parse(h.run().response!).fallbackReason).toContain("model changed");
  expect(complete).not.toHaveBeenCalled();
  const subagent = createHost({ "note.branchModeDefault": false, "note.triggerAnsweredTurns": 1, noteModel: "fake/noter" });
  disposers.push(subagent.dispose);
  await subagent.emit("before_provider_request", { payload: payload() }); await subagent.turn();
  expect(subagent.memory.store.listRuns(1)[0]).toMatchObject({ mode: "subagent", model: "fake/noter" });
});

test.each(["anthropic-messages", "openai-completions", "openai-responses"])("%s uses its native append without changing any prefix character", api => {
  const body: branch.Body = api === "openai-responses" ? { instructions: "system", input: payload().messages, tools: [] }
    : { system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }], messages: payload().messages, tools: [] };
  const request = branch.buildRequest(body, api, "note\n\nrange");
  expect(branch.verifyRequest(body, request, api, "note\n\nrange").passed).toBe(true);
  (request[branch.messageKey(api)] as branch.Body[])[0]!.content = "Raw \ncontext";
  expect(branch.verifyRequest(body, request, api, "note\n\nrange").differingPath).toContain(".0.content");
});

test("an in-flight branch request keeps its captured body and session routing across a switch", async () => {
  const h = await setup();
  let release!: () => void;
  const auth = h.ctx.modelRegistry.getApiKeyAndHeaders.bind(h.ctx.modelRegistry);
  h.ctx.modelRegistry.getApiKeyAndHeaders = async model => {
    await new Promise<void>(resolve => { release = resolve; });
    return auth(model);
  };
  await h.capture(); await h.prompt(); await h.answer(); await h.emit("agent_settled");
  h.ctx.sessionManager.getSessionId = () => "switched";
  await h.emit("session_start"); await h.capture({ ...payload(), system: "other branch" });
  release(); await h.drain();
  expect(vi.mocked(complete).mock.calls[0]![2]!.sessionId).toBe("pi-test");
  expect(h.sent[0]!.system).toBe(payload().system);
  expect(h.run()).toMatchObject({ mode: "branch", branch: "main", outcome: "success" });
});

test("the verifier independently rejects extra appends and provider option changes", () => {
  const original = payload(), request = branch.buildRequest(original, "openai-completions", "instruction");
  request.temperature = 0.9;
  expect(branch.verifyRequest(original, request, "openai-completions", "instruction").differingPath).toBe("$.temperature");
  request.temperature = original.temperature;
  (request.messages as unknown[]).push({ role: "user", content: "instruction" });
  expect(branch.verifyRequest(original, request, "openai-completions", "instruction").passed).toBe(false);
});
