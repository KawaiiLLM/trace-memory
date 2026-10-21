// Ticket 25a, checkbox 1: what the Noter actually puts on the wire, read off the real request
// the installed pi-ai adapter serialized. The fixture stubs HTTP only, so every body inspected here
// is one a provider would have received: a real parent session, a real fresh native child, the production
// prompt and the production tool definitions.
import { expect, test, vi } from "vitest";
import { noteAndMemory, fixture, noteBatch, say, settled, toolResults, worker, type Body } from "./native-fixture.ts";
import { tokens } from "../../source-fixture.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { withRetrievalPolicy } from "../../../src/core/render/retrieval-policy.ts";
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
    return noteAndMemory(`n${++workers}`, workers === 1 ? noteBatch : {});
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
 * conversation; the third prompt is the task under test: a fresh child receives those facts.
 * Returns the third prompt's requests. */
async function thirdPrompt(f: Fixture) {
  script(f);
  await f.turn("用 pnpm，不要 npm");
  await settled(f);
  await f.turn("再来一次"); // No background-result delivery or receipt wait.
  const before = f.sent.length;
  await f.turn("第三次");
  const run = await nthRun(f, 2);
  return { run, child: f.sent.slice(before).find(body => worker(body))! };
}

/** Historical facts are a fresh-child input. */
test("25a 2026-09-09: the same task in subagent mode carries full history and tier-1 Raw, each inside its own 10,000-token allowance", async () => {
  const f = await fixture({ "noting.triggerTokens": 1 });
  try {
    const { run, child } = await thirdPrompt(f);
    expect(run.mode).toBe("subagent");
    // A fresh child: core's prompt as the system message, the whole fresh material as the task.
    expect(String(child.messages[0].content)).toBe(withRetrievalPolicy(loadPrompt("noting.md"), canonicalToolNames));
    expect(child.tools.map((tool: Body) => tool.function.name)).toEqual(expect.arrayContaining(["read", "search", "note", "memory"]));
    expect(String(child.messages[0].content)).toContain("`note({})`");
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
