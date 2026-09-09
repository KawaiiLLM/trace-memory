// Ticket 25a, checkbox 1: what each Noter mode actually puts on the wire, read off the real request
// the installed pi-ai adapter serialized. The fixture stubs HTTP only, so every body inspected here
// is one a provider would have received: a real parent session, a real native child, the production
// prompt and the production tool definitions.
import { expect, test, vi } from "vitest";
import { call, fixture, noteBatch, say, settled, toolResults, worker, type Body } from "./native-fixture.ts";
import { tokens } from "../../source-fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The first worker call writes F1 so the second task has a history to show; later ones stop with no
 * facts, which is a normal zero-fact success and leaves the second batch's material alone. */
const script = (f: Fixture) => {
  let workers = 0;
  f.script(body => {
    if (!worker(body)) return say("好的。");
    if (toolResults(body)) return say("Done.");
    return ++workers === 1 ? call("t1", "note", noteBatch) : say("Done.");
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

/** One run writes F1; the next prompt injects and confirms its `<noted>` receipt (the fork admission
 * wait of ticket 25, kept); the third prompt is the task under test, whose history is already in the
 * foreground it would fork from. Returns the requests sent for that third prompt. */
async function thirdPrompt(f: Fixture, options: { capture?: boolean } = {}) {
  script(f);
  await f.turn("用 pnpm，不要 npm", options);
  await settled(f);
  await f.turn("再来一次", options); // the delivery rides this prompt and is confirmed at its settle
  const before = f.sent.length;
  await f.turn("第三次", options);
  const run = await nthRun(f, 2);
  return { run, child: f.sent.slice(before).find(body => worker(body))! };
}

test("25a 2026-09-09: the Noter fork's captured request carries the increment alone — no knowledge, no history, no index, no Raw", async () => {
  const f = await fixture({ "noting.triggerTokens": 1 });
  try {
    const { run, child } = await thirdPrompt(f);
    expect(run.mode).toBe("fork");
    const increment = task(child);
    // Control material only (ruling 2026-09-06 08:53, kept by 25a): instruction, range, head reply,
    // source-address index.
    expect(increment).toContain("Noting (fact extraction)");
    expect(increment).toContain("Range: ");
    expect(increment).toContain("Sources:");
    expect(increment).not.toContain("<knowledge>");
    expect(increment).not.toContain("Recent facts (by Turn):");
    expect(increment).not.toContain("Raw:");
    expect(increment).not.toContain("[F1]"); // no fact block and no fact index of any kind
    // The inheritance is not a claim: the earlier run really delivered its facts as a foreground
    // `<noted>` receipt, and that delivery was confirmed before this task was admitted.
    expect(f.h.memory.store.listPendingDeliveries(1, "main")).toEqual([]);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.id)).toEqual([1]);
  } finally { await f.dispose(); }
});

test("25a 2026-09-09: the same task in subagent mode carries full history and tier-1 Raw, each inside its own 10,000-token allowance", async () => {
  const f = await fixture({ "noting.forkModeDefault": false, "noting.triggerTokens": 1 });
  try {
    const { run, child } = await thirdPrompt(f);
    expect(run.mode).toBe("subagent");
    // A fresh child: core's prompt as the system message, the whole fresh material as the task.
    expect(String(child.messages[0].content)).toContain("Noting (fact extraction)");
    const body = text(child.messages.at(-1)!);
    expect(body).toContain("Recent facts (by Turn):");
    expect(body).toContain("[F1]"); // the history the fork inherited instead
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
    expect(String(child.messages[0].content)).toContain("Noting (fact extraction)"); // a fresh child, not a fork
  } finally { await f.dispose(); }
});
