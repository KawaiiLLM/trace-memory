// Ticket 144, stage 4 §1.2: one execution is one worker. The importer pins the runner an execution's first dispatch ran on, under
// the `executionId` core stamps on every call, and releases the pin when the execution ends.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function importer() {
  const dir = mkdtempSync(join(tmpdir(), "cc-pin-")); dirs.push(dir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "state"), baseline: "2025-01-01T00:00:00.000Z" });
  const transcript = join(dir, "native.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", uuid: "u", parentUuid: null, type: "user", promptId: "p", promptSource: "typed", message: { role: "user", content: "hello" } })}\n`);
  const subject = new CcImporter(config, await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: "pin", transcript_path: transcript }, "2026-01-01T00:00:00.000Z"));
  const seen: string[] = [];
  const runner = (name: string, outcome: "success" | "failure" | "cancelled" = "success") =>
    async () => { seen.push(name); return { outcome, output: name, request: {} }; };
  const internals = subject as unknown as { runAgent: unknown; dispatch(input: unknown): Promise<unknown> };
  const use = (name: string, outcome?: "success" | "failure" | "cancelled") => { internals.runAgent = runner(name, outcome); };
  return { subject, seen, use, dispatch: (executionId: string) => internals.dispatch({ executionId }) };
}

test("an execution keeps the worker its first dispatch ran on; a new execution takes the current one", async () => {
  const f = await importer();
  try {
    f.use("old");
    await f.dispatch("e1");
    f.use("new");
    await f.dispatch("e1");
    await f.dispatch("e2");
    expect(f.seen).toEqual(["old", "old", "new"]);
  } finally { f.subject.memory.close(); }
});

// 146 §3.3: Dreaming runs groups side by side, so one failing dispatch must not release the pin its siblings share.
test.each(["failure", "cancelled"] as const)("a %s dispatch keeps the pin: its sibling dispatches stay on the same worker", async outcome => {
  const f = await importer();
  try {
    f.use("old", outcome);
    await f.dispatch("e1");
    f.use("new");
    await f.dispatch("e1");
    expect(f.seen).toEqual(["old", "old"]);
  } finally { f.subject.memory.close(); }
});

test("the pin is set when the first dispatch starts, so a sibling that starts while it runs takes the same worker", async () => {
  const f = await importer();
  try {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    (f.subject as unknown as { runAgent: unknown }).runAgent = async () => {
      f.seen.push("first");
      if (calls++ === 0) await held;
      return { outcome: "failure", output: "first", request: {} };
    };
    const first = f.dispatch("e1");
    f.use("new"); // a configuration change while the first dispatch is still running
    await f.dispatch("e1");
    release();
    await first;
    expect(f.seen).toEqual(["first", "first"]);
  } finally { f.subject.memory.close(); }
});

test("a pin of a settled execution is gone at the next dispatch", async () => {
  const f = await importer();
  try {
    const store = f.subject.memory.store;
    const project = store.createProject({ name: "pin", declaredBy: "mark" });
    const session = store.createSession({ projectId: project.id, host: "cc:pin", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const id = store.beginExecution({ sessionId: session.id, phase: "dreaming" });
    f.use("old");
    await f.dispatch(id);
    store.db.prepare("UPDATE task_executions SET outcome = 'success' WHERE id = ?").run(id);
    f.use("new");
    await f.dispatch(id); // would take "old" if the pin had survived the settlement
    expect(f.seen).toEqual(["old", "new"]);
  } finally { f.subject.memory.close(); }
});
