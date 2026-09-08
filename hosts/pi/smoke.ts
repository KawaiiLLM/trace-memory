// 19c: one Noting task, committed through the only runner there is — a real Pi child `AgentSession`
// built by hosts/pi/native.ts, with the provider stubbed at the wire (test-host.ts). Nothing here
// touches a network or a credential.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { host, notingFact } from "./test-host.ts";

const h = host({ "noting.triggerTokens": 60 });
try {
  assert.deepEqual([...h.tools.keys()], ["trace", "search", "note", "memory"]);
  h.provider(async conversation => notingFact(conversation));
  await h.emit("session_start");
  await h.turn();
  const runs = h.memory.store.listRuns(1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.kind, "noting");
  assert.equal(runs[0]!.outcome, "success");
  assert.deepEqual(JSON.parse(runs[0]!.request!), h.requests.at(-1));
  const response = JSON.parse(runs[0]!.response!);
  assert.ok(response.nativeLog?.includes("/runs/"), "the run links the native child log"); // it really ran natively
  assert.ok(existsSync(response.nativeLog), "the child wrote its own session file");
  const facts = h.memory.store.listSessionFacts(1);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.text, "用 pnpm，不要 npm");
  assert.ok(h.memory.store.sourcePath(1, "main", 1).every(e => h.memory.store.entryNoted(e.id)));
  console.log(`Pi smoke passed on Node ${process.versions.node}: one native noting run and one fact committed.`);
} finally {
  await h.dispose();
}
