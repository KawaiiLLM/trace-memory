import { afterEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { complete } from "@earendil-works/pi-ai/compat";
import * as branch from "./branch.ts";
import { host as createHost, reply, usage, recordingFact } from "./test-host.ts";

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: vi.fn() }));
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); vi.restoreAllMocks(); vi.mocked(complete).mockReset(); });
const payload = () => ({ model: "test", stream: true, temperature: 0.3, system: "System\n  exact 漢字 é",
  messages: [{ role: "user", content: "Raw  \ncontext" }, { role: "assistant", content: "Previous reply" }],
  tools: [{ type: "function", function: { name: "trace", parameters: { type: "object", properties: {} } } }] });
async function setup() {
  const h = createHost({ "recording.triggerAnsweredTurns": 1, recordingModel: "fake/ignored" });
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

test("branch recording preserves prefix bytes, options and tools; record contains independent body hashes", async () => {
  const h = await setup(), captured = payload();
  await h.capture(captured);
  captured.system = "mutation of hook owner after capture";
  await h.turn();
  expect(h.requests).toHaveLength(0); // Registry completion is subagent-only.
  const request = h.sent[0]!, original = payload();
  const messages = request.messages as unknown[];
  expect(Buffer.from(branch.serialize(messages.slice(0, -1)))).toEqual(Buffer.from(branch.serialize(original.messages)));
  expect(request).toEqual({ ...original, messages: [...original.messages, expect.objectContaining({ role: "user" })] });
  const prompt = readFileSync(new URL("../../core/prompts/recording.md", import.meta.url), "utf8");
  expect((messages.at(-1) as { content: string }).content).toBe(prompt + "\n\nRange: S1/T1..S1/T1");
  const run = h.run(), response = JSON.parse(run.response!);
  expect(run.mode).toBe("branch"); expect(run.model).toBe("fake/test");
  expect(run.outcome).toBe("success"); expect(JSON.parse(run.request!)).toEqual(request);
  expect(response.verification).toMatchObject({ passed: true, capturedHash: branch.hash(original), requestHash: branch.hash(request), differingPath: null, firstForKey: true });
  expect(response.verification.appendedMessages).toEqual([messages.at(-1)]);
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
  const subagent = createHost({ "recording.branchModeDefault": false, "recording.triggerAnsweredTurns": 1, recordingModel: "fake/recorder" });
  disposers.push(subagent.dispose);
  await subagent.emit("before_provider_request", { payload: payload() }); await subagent.turn();
  expect(subagent.memory.store.listRuns(1)[0]).toMatchObject({ mode: "subagent", model: "fake/recorder" });
});

test.each(["anthropic-messages", "openai-completions", "openai-responses"])("%s uses its native append without changing any prefix character", api => {
  const body: branch.Body = api === "openai-responses" ? { instructions: "system", input: payload().messages, tools: [] }
    : { system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }], messages: payload().messages, tools: [] };
  const request = branch.buildRequest(body, api, "recording\n\nrange");
  expect(branch.verifyRequest(body, request, api, "recording\n\nrange").passed).toBe(true);
  (request[branch.messageKey(api)] as branch.Body[])[0]!.content = "Raw \ncontext";
  expect(branch.verifyRequest(body, request, api, "recording\n\nrange").differingPath).toContain(".0.content");
});

test("an in-flight branch request keeps its captured body across a tree switch and a later capture", async () => {
  const h = await setup();
  let release!: () => void;
  const auth = h.ctx.modelRegistry.getApiKeyAndHeaders.bind(h.ctx.modelRegistry);
  h.ctx.modelRegistry.getApiKeyAndHeaders = async model => {
    await new Promise<void>(resolve => { release = resolve; });
    return auth(model);
  };
  await h.capture(); await h.prompt(); await h.answer(); await h.emit("agent_settled");
  h.entries.splice(0, h.entries.length); await h.emit("session_tree"); await h.capture({ ...payload(), system: "other branch" });
  release(); await h.drain();
  expect(vi.mocked(complete).mock.calls[0]![2]!.sessionId).toBe("pi-test");
  expect(h.sent[0]!.system).toBe(payload().system);
  expect(h.run()).toMatchObject({ mode: "branch", branch: "main", outcome: "success" });
});

test("a model switch during the integration candidate round does not redirect or break the final round", async () => {
  const h = createHost({ "recording.triggerAnsweredTurns": 1, "integration.triggerUnintegratedFacts": 1, "integration.subagentModeDefault": false, "recording.branchModeDefault": false });
  disposers.push(h.dispose);
  await h.emit("session_start");
  h.provider(async c => recordingFact(c));
  let release!: () => void;
  vi.mocked(complete).mockImplementation(async (model, _conversation, options) => {
    const body = await options!.onPayload!({}, model) as branch.Body;
    const last = String((body.messages as { content: string }[]).at(-1)!.content);
    if (/Range: F/.test(last)) await new Promise<void>(resolve => { release = resolve; });
    if (/Range: F/.test(last) || /NEAR:/.test(last)) return reply(integrationOutput);
    return recordingFact({ messages: [{ role: "user", content: last }] } as never);
  });
  await h.emit("before_provider_request", { payload: payload() });
  await h.turn();
  await h.emit("agent_settled"); await h.drain();
  h.ctx.model = { ...h.ctx.model!, id: "next" }; // The user switches the session model mid-integration.
  release(); await h.drain();
  const runs = h.memory.store.listRuns(1).filter(r => r.kind === "integration");
  expect(runs.map(r => [r.mode, r.model, r.outcome])).toEqual([["branch", "fake/test", "success"], ["branch", "fake/test", "success"]]);
  expect(vi.mocked(complete).mock.calls.map(c => c[0].id)).toEqual(["test", "test"]);
  expect((h.requests[0] as { model: { id: string } }).model.id).toBe("test");
  expect(JSON.parse(runs[1]!.response!).verification.passed).toBe(true);
});

test("the verifier independently rejects extra appends and provider option changes", () => {
  const original = payload(), request = branch.buildRequest(original, "openai-completions", "instruction");
  request.temperature = 0.9;
  expect(branch.verifyRequest(original, request, "openai-completions", "instruction").differingPath).toBe("$.temperature");
  request.temperature = original.temperature;
  (request.messages as unknown[]).push({ role: "user", content: "instruction" });
  expect(branch.verifyRequest(original, request, "openai-completions", "instruction").passed).toBe(false);
});

const integrationOutput = JSON.stringify({ new: [], edit: [], merge: [], delete: [], not_admitted: [{ id: "F1", because: "Not durable." }], near_ack: [], over_budget: false });
test("17:01 settle is branch-capable: candidate appends to the captured prefix, final replays the candidate reply plus the feedback on that request", async () => {
  const h = createHost({ "recording.triggerAnsweredTurns": 1, "integration.triggerUnintegratedFacts": 1, "integration.subagentModeDefault": false, "recording.branchModeDefault": false, integrationModel: "fake/ignored" });
  disposers.push(h.dispose);
  await h.emit("session_start");
  h.provider(async c => recordingFact(c));
  const sent: branch.Body[] = [];
  vi.mocked(complete).mockImplementation(async (model, _conversation, options) => {
    const body = await options!.onPayload!({}, model) as branch.Body;
    sent.push(structuredClone(body));
    const last = String((body.messages as { content: string }[]).at(-1)!.content);
    if (/Range: F/.test(last) || /NEAR:/.test(last)) return reply(integrationOutput);
    return recordingFact({ messages: [{ role: "user", content: last }] } as never);
  });
  await h.emit("before_provider_request", { payload: payload() });
  await h.turn();
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(2); expect(complete).toHaveBeenCalledTimes(2);
  expect(h.conversations.at(-1)!.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
  const prompt = readFileSync(new URL("../../core/prompts/integration.md", import.meta.url), "utf8");
  const [candidate, final] = sent as { messages: { role: string; content: string }[] }[];
  expect(candidate!.messages.slice(0, -1)).toEqual(payload().messages);
  expect(candidate!.messages.at(-1)!.content.startsWith(prompt + "\n\nRange: F1..F1")).toBe(true);
  expect(final!.messages.slice(0, -2)).toEqual(candidate!.messages);
  expect(final!.messages.at(-2)).toEqual({ role: "assistant", content: integrationOutput });
  expect(final!.messages.at(-1)!.role).toBe("user");
  expect(final!.messages.at(-1)!.content).toContain("NEAR:");
  expect(final!.messages.at(-1)!.content).toContain("This is the final round.");
  const runs = h.memory.store.listRuns(1).filter(r => r.kind === "integration");
  expect(runs.map(r => [r.mode, r.model, r.outcome])).toEqual([["branch", "fake/test", "success"], ["branch", "fake/test", "success"]]);
  expect(JSON.parse(runs[1]!.request!)).toEqual(final);
  expect(JSON.parse(runs[1]!.response!).verification).toMatchObject({ passed: true, capturedHash: branch.hash(candidate), requestHash: branch.hash(final) });
  expect(h.memory.store.listVisibleKnowledge(1, 1)).toHaveLength(0);
});

test("integration branch mode without a capture falls back to subagent for both rounds and notifies once", async () => {
  const h = createHost({ "recording.triggerAnsweredTurns": 1, "integration.triggerUnintegratedFacts": 1, "integration.subagentModeDefault": false, "recording.branchModeDefault": false, recordingModel: "fake/recorder", integrationModel: "fake/Integrator" });
  disposers.push(h.dispose);
  h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? reply(integrationOutput) : recordingFact(c));
  await h.turn();
  await h.emit("agent_settled"); await h.drain();
  expect(complete).not.toHaveBeenCalled(); expect(h.requests).toHaveLength(4);
  const runs = h.memory.store.listRuns(1).filter(r => r.kind === "integration");
  expect(runs.map(r => [r.mode, r.model, r.outcome])).toEqual([["subagent", "fake/test", "success"], ["subagent", "fake/test", "success"]]);
  expect(JSON.parse(runs[0]!.response!).fallbackReason).toContain("No current-branch");
  expect(JSON.parse(runs[1]!.response!).fallbackReason).toContain("not a branch request");
  expect(h.notices.filter(n => n.includes("integration fell back"))).toHaveLength(1);
});

test.each(["anthropic-messages", "openai-completions", "openai-responses"])("%s replays an assistant reply in pi-ai's native shape before the feedback message", api => {
  const body: branch.Body = api === "openai-responses" ? { instructions: "system", input: payload().messages, tools: [] }
    : { system: "system", messages: payload().messages, tools: [] };
  const appended: branch.Appended[] = [{ role: "assistant", text: "candidate" }, { role: "user", text: "feedback" }];
  const request = branch.buildRequest(body, api, appended);
  const messages = request[branch.messageKey(api)] as branch.Body[];
  expect(messages).toHaveLength(payload().messages.length + 2);
  expect(messages.at(-2)).toEqual(api === "openai-responses"
    ? { type: "message", role: "assistant", content: [{ type: "output_text", text: "candidate", annotations: [] }], status: "completed", id: "msg_pi_branch" }
    : api === "anthropic-messages" ? { role: "assistant", content: [{ type: "text", text: "candidate" }] } : { role: "assistant", content: "candidate" });
  expect(branch.verifyRequest(body, request, api, appended).passed).toBe(true);
  expect(branch.verifyRequest(body, request, api, [appended[1]!]).passed).toBe(false); // The replay is part of the audit.
  (messages.at(-2) as { content: unknown }).content = "tampered";
  expect(branch.verifyRequest(body, request, api, appended).differingPath).toContain(".append");
});
