import assert from "node:assert/strict";
import { host, recordingFact } from "./test-host.ts";

const h = host({ "recording.triggerAnsweredTurns": 1 });
try {
  assert.deepEqual([...h.tools.keys()], ["trace", "search", "note", "memory"]);
  h.provider(async conversation => recordingFact(conversation));
  await h.emit("session_start");
  await h.turn();
  const runs = h.memory.store.listRuns(1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.kind, "recording");
  assert.equal(runs[0]!.outcome, "success");
  assert.deepEqual(JSON.parse(runs[0]!.request!), h.requests.at(-1));
  const facts = h.memory.store.listSessionFacts(1);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.text, "用 pnpm，不要 npm");
  assert.equal(h.memory.store.getWatermark(1, "main")?.lastRecordedTurn, 1);
  console.log(`Pi smoke passed on Node ${process.versions.node}: one recording run and one fact committed.`);
} finally {
  await h.dispose();
}
