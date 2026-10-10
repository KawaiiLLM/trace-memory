// 137: a real Pi AgentSession with the real extension and a scripted provider. The retrieval policy is a prompt
// section, so the model sees it once in the system prompt however many prompts follow.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../../../src/hosts/pi/index.ts";
import { canonicalToolNames, retrievalPolicy } from "../../../src/core/api/index.ts";
import { piSession, say } from "./native-fixture.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("137: a Pi main session sends the retrieval policy once in its system prompt, with Pi's search name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-pi-policy-")); dirs.push(dir);
  const f = await piSession({ extensions: [extension], activeTools: ["read", "grep"], env: { TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath: join(dir, "trace.db") }) } });
  try {
    f.script(() => say("ok"));
    await f.session.bindExtensions({});
    const systemOf = (body: { messages?: { role: string }[] }) => JSON.stringify((body.messages ?? []).filter(m => m.role === "system" || m.role === "developer"));
    await f.session.prompt("memory is off"); // a session older than the install baseline starts disabled
    expect(systemOf(f.sent[0]!)).not.toContain("When to look up memory");
    await f.session.prompt("/trace on");
    for (const prompt of ["first prompt", "second prompt"]) await f.session.prompt(prompt);
    expect(f.sent).toHaveLength(3);
    const policy = retrievalPolicy(canonicalToolNames);
    for (const body of f.sent.slice(1)) {
      const system = (body.messages ?? []).filter((m: { role: string }) => m.role === "system" || m.role === "developer");
      expect(JSON.stringify(system).split("When to look up memory")).toHaveLength(2);
      expect(JSON.stringify(system)).toContain(JSON.stringify(policy).slice(1, -1));
    }
  } finally { f.dispose(); }
});
