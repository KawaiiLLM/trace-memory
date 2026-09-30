// Ticket 25a, checkbox 1: what each Noter mode actually puts on the wire, read off the real request
// the installed pi-ai adapter serialized. The fixture stubs HTTP only, so every body inspected here
// is one a provider would have received: a real parent session, a real native child, the production
// prompt and the production tool definitions.
import { expect, test, vi } from "vitest";
// Pin fork for inherited-material cases; the fresh-material case explicitly overrides it.
import { noteAndMemory, stableForkFixture as fixture, noteBatch, say, settled, toolResults, worker, type Body } from "./native-fixture.ts";
import { tokens } from "../../source-fixture.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { toolDefinitions } from "../../../src/core/api/tools.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The first worker call writes F1 so the second task has a history to show; later ones stop with no
 * facts, which is a normal zero-fact success and leaves the second batch's material alone. */
const script = (f: Fixture) => {
  let workers = 0;
  f.script(body => {
    if (!worker(body)) return say("好的。");
    if (toolResults(body)) return say("Done.");
    return noteAndMemory(`n${++workers}`, workers === 1 ? noteBatch : { facts: [] });
  });
};
/** The task message of a worker request: the last message, which is what core's text was placed in. */
const task = (body: Body) => String(JSON.stringify(body.messages.at(-1)));
/** The same message as the text the model reads, so a block can be measured in tokens. */
const text = (message: Body): string => typeof message.content === "string" ? message.content
  : (message.content as Body[]).filter(part => part.type === "text").map(part => String(part.text)).join("\n");
const nthRun = async (f: Fixture, n: number) =>
  await vi.waitFor(() => {
    const runs = f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response);
    expect(runs.length).toBeGreaterThanOrEqual(n);
    return runs.at(-1)!;
  }, { timeout: 5000 });

/** One run writes F1 without delivering it to the foreground. The next prompt advances the native
 * conversation; the third prompt is the task under test. Its fork inherits Raw without an extra
 * preceding-fact block; a fresh child receives those facts. Returns the third prompt's requests. */
async function thirdPrompt(f: Fixture, options: { capture?: boolean } = {}) {
  script(f);
  await f.turn("用 pnpm，不要 npm", options);
  await settled(f);
  await f.turn("再来一次", options); // No background-result delivery or receipt wait.
  const before = f.sent.length;
  await f.turn("第三次", options);
  const run = await nthRun(f, 2);
  return { run, child: f.sent.slice(before).find(body => worker(body))! };
}

/** 92 supersedes the old missing-history supplement: the fork inherits its stable parent.
 * Retained target entries are not repeated, and historical facts are a fresh-child input only. */
test("92: the Noter fork inherits its stable parent without a Raw or preceding-fact supplement", async () => {
  const f = await fixture({ "noting.triggerTokens": 1 });
  try {
    const { run, child } = await thirdPrompt(f);
    expect(run.mode).toBe("fork");
    const increment = task(child);
    const instructions = loadPrompt("noting.md");
    const registered = child.tools.map((tool: Body) => tool.function.name);
    expect(new Set(registered.filter((name: string) => name !== "read")))
      .toEqual(new Set(toolDefinitions.filter(tool => tool.name !== "check").map(tool => tool.name)));
    expect(child.tools.find((tool: Body) => tool.function.name === canonicalToolNames.note)?.function.parameters)
      .toEqual(toolDefinitions.find(tool => tool.name === "note")!.parameters);
    expect(instructions).toContain(`\`${canonicalToolNames.note}({facts: []})\``);
    expect(text(child.messages.at(-1)!)).toContain(`${instructions}\n\n`);
    expect(text(child.messages.at(-1)!).split(instructions)).toHaveLength(2);
    // Mandatory framing, whatever the data delta is: instruction, range, head reply, source index.
    expect(increment).toContain("Noting (facts and knowledge)");
    expect(increment).toContain("Range: ");
    expect(increment).toContain("Sources:");
    expect(increment).not.toContain("<knowledge>"); // 25a: no knowledge block in either Noter mode
    expect(increment).not.toContain("Raw:"); // the target entries are visible in the inherited context
    expect(increment).not.toContain("Recent facts (by Turn):");
    expect(increment).not.toContain("[F1]"); // 92: fork adds no preceding-fact supplement
    // Worker completion creates neither foreground delivery nor a legacy queue table.
    expect(f.h.memory.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending_deliveries'").all()).toEqual([]);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.id)).toEqual([1]);
  } finally { await f.dispose(); }
});

test("25a 2026-09-09: the same task in subagent mode carries full history and tier-1 Raw, each inside its own 10,000-token allowance", async () => {
  const f = await fixture({ "noting.forkModeDefault": false, "noting.triggerTokens": 1 });
  try {
    const { run, child } = await thirdPrompt(f);
    expect(run.mode).toBe("subagent");
    // A fresh child: core's prompt as the system message, the whole fresh material as the task.
    expect(String(child.messages[0].content)).toBe(loadPrompt("noting.md"));
    expect(child.tools.map((tool: Body) => tool.function.name)).toEqual(expect.arrayContaining(["trace", "search", "note", "memory"]));
    expect(String(child.messages[0].content)).toContain("`note({facts: []})`");
    const body = text(child.messages.at(-1)!);
    expect(body).toContain("Recent facts (by Turn):");
    expect(body).toContain("[F1]"); // Both modes must supply this missing fact history.
    expect(body).toContain("Range: ");
    expect(body).toContain("Raw:");
    expect(body).not.toContain("<knowledge>"); // neither mode carries knowledge (25a)
    // Two independent allowances, priced off the wire: history within what the episodic budget leaves
    // once the Raw ceiling is reserved, and Raw within that ceiling.
    const facts = body.slice(0, body.indexOf("\n\nRange: ")), raw = body.slice(body.indexOf("\nRaw:"));
    expect(tokens(facts)).toBeLessThanOrEqual(20_000 - 10_000);
    expect(tokens(raw)).toBeLessThanOrEqual(10_000);
  } finally { await f.dispose(); }
});

test("25a 2026-09-09: a fork that cannot be prepared sends the complete subagent material and is recorded as subagent", async () => {
  const f = await fixture({ "noting.triggerTokens": 1 });
  try {
    // No captured parent body on any prompt: every fork request falls back to a fresh native child.
    const { run, child } = await thirdPrompt(f, { capture: false });
    expect(run.mode).toBe("subagent");
    const response = JSON.parse(run.response!);
    expect(response.requestedMode).toBe("fork");
    expect(response.fallbackReason).toContain("native runner:");
    const fresh = task(child);
    expect(fresh).toContain("Recent facts (by Turn):");
    expect(fresh).toContain("Raw:");
    expect(fresh).not.toContain("<knowledge>");
    expect(String(child.messages[0].content)).toBe(loadPrompt("noting.md")); // a fresh child, not a fork
  } finally { await f.dispose(); }
});
