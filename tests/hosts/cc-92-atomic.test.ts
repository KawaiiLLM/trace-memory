import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sourceSeededMemory } from "../source-fixture.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { CcAgentWorker, type CcAgentTask } from "../../src/hosts/cc/worker.ts";
import { TEST_CC_VERSION } from "../support/cc-version.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
for (const ending of ["success", "error", "cancel", "native rejection", "corrected native rejection", "direct rejection", "corrected direct rejection", "unreported rejection",
  "native envelope rejection", "corrected native envelope rejection", "native memory envelope rejection", "corrected native memory envelope rejection"] as const)
  test(`04: real CC MCP/worker adapter holds note and memory through ${ending} terminal`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "tm-92-cc-held-")); dirs.push(directory);
    // This is a fixture shell, not the native CC CLI. No provider or native executable runs.
    const executable = join(directory, "fixture-version");
    writeFileSync(executable, "#!/bin/sh\nprintf '2.1.280 (Claude Code)\\n'\n"); chmodSync(executable, 0o700);
    const config = resolveCcHostConfig({ dbPath: join(directory, "memory.sqlite"), stateDir: join(directory, "state"),
      notingModel: "test", notingThinking: "medium",
      "dreaming.model": "test", "dreaming.thinking": "medium", worker: { claudeExecutable: executable,
        contextWindows: { test: 200_000 }, cwd: directory } });
    const replies: string[] = [];
    let target!: { session: { id: number }; path: { sessionId: number; branch: string; headTurnId: number } };
    const query = ((request: { options: Record<string, any> }) => {
      const stream = (async function* () {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await request.options.mcpServers.trace_memory.instance.connect(serverTransport);
        const client = new Client({ name: "atomic-test", version: "1" }); await client.connect(clientTransport);
        try {
          yield { type: "system", subtype: "init", claude_code_version: TEST_CC_VERSION, cwd: directory,
            tools: ["mcp__trace_memory__note", "mcp__trace_memory__memory", "mcp__trace_memory__trace", "mcp__trace_memory__search"],
            plugins: [], skills: [], slash_commands: [], mcp_servers: [{ name: "trace_memory", status: "connected" }] };
          for (const [name, args] of [
            ["note", { facts: [{ title: "User rule", sources: [{ address: "T1#E1", text: "User set a rule" }] }] }],
            ["memory", { operations: [{ op: "create", text: "Follow the rule", category: "constraint", scope: "session",
              topics: [], supports: ["$1"], reason: "User requirement" }], skipped: [] }],
          ] as const) {
            const id = `held-${name}`;
            yield { type: "assistant", message: { id: `response-${name}`, content: [{ type: "tool_use", id, name, input: args }] } };
            const result = await client.callTool({ name, arguments: args, _meta: { "claudecode/toolUseId": id } });
            replies.push(JSON.stringify(result));
            expect(result.isError).not.toBe(true);
            expect(memory.store.listSessionFacts(target.session.id)).toEqual([]);
            expect(memory.store.currentKnowledge(target.path)).toEqual([]);
          }
          if (ending.includes("rejection")) {
            const kind = ending.includes("memory") ? "memory" : "note";
            const field = kind === "note" ? "facts" : "operations", slot = kind === "note" ? "$1" : "M1";
            const base = kind === "note" ? {} : { skipped: [] };
            const args = { ...base, [field]: [{ slot, source: ["T1#E1"] }], ...(ending.includes("envelope") ? { unexpected: true } : {}) };
            yield { type: "assistant", message: { id: "invalid-response", content: [{ type: "tool_use", id: "invalid-note", name: `mcp__trace_memory__${kind}`, input: args }] } };
            if (ending.includes("direct")) {
              const refused = await client.callTool({ name: "note", arguments: args, _meta: { "claudecode/toolUseId": "invalid-note" } });
              expect(refused.isError).toBe(true); // original MCP schema is advertised, but core validates raw arguments
            } else if (!ending.startsWith("unreported")) {
              const refusal = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "invalid-note", is_error: true, content: "native argument validation refused" }] } };
              yield refusal; yield refusal; // duplicate native observation must not create another rejected slot
            }
            if (ending.includes("envelope")) {
              const inspect = { ...base, [field]: [] };
              yield { type: "assistant", message: { id: "inspect-response", content: [{ type: "tool_use", id: "inspect", name: kind, input: inspect }] } };
              const inspected = await client.callTool({ name: kind, arguments: inspect, _meta: { "claudecode/toolUseId": "inspect" } });
              expect(JSON.stringify(inspected)).toContain(slot);
            }
            if (ending.startsWith("corrected")) {
              const value = kind === "note" ? { title: "Corrected rule", sources: [{ address: "T1#E1", text: "Corrected rule" }] }
                : { op: "create", text: "Corrected rule", category: "constraint", scope: "session", topics: [], supports: ["$1"], reason: "User requirement" };
              const corrected = { ...base, [field]: [{ slot, ...value }] };
              yield { type: "assistant", message: { id: "corrected-response", content: [{ type: "tool_use", id: "corrected-note", name: kind, input: corrected }] } };
              expect((await client.callTool({ name: kind, arguments: corrected, _meta: { "claudecode/toolUseId": "corrected-note" } })).isError).not.toBe(true);
            }
          }
          if (ending === "cancel") memory.cancelTasks();
          yield { type: "result", subtype: "success", is_error: false, result: "done", errors: [], num_turns: 2,
            usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
            modelUsage: {}, total_cost_usd: 0.125 };
          if (ending === "error") throw new Error("late native transport error");
        } finally { await client.close(); }
      })() as any;
      stream.supportedModels = async () => [{ value: "test", supportedEffortLevels: ["medium"] }];
      return stream;
    }) as any;
    const worker = new CcAgentWorker(config, { query, environment: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, "claude") } });
    const memory = sourceSeededMemory(config.dbPath, raw => worker.run(raw as CcAgentTask, 0));
    try {
      const project = memory.store.createProject({ name: "cc-atomic", declaredBy: "mark" });
      const session = memory.store.createSession({ host: "cc:atomic", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
      const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "A rule", assistantText: "Acknowledged", startedAt: "now" });
      const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
      // The query closes over the same target through these bindings.
      target = { session, path };
      const result = await memory.noting({ ...path, model: "test", mode: "subagent" });
      expect(replies, JSON.stringify(result)).toHaveLength(2);
      expect(replies[0]).toContain("held: $1"); expect(replies[1]).toContain("held: M1");
      const succeeds = ending === "success" || ending.startsWith("corrected");
      expect(result.outcome).toBe(succeeds ? "success" : ending === "cancel" ? "cancelled"
        : ending === "error" || ending.startsWith("unreported") ? "failure" : "bounced");
      expect(memory.store.listSessionFacts(session.id)).toHaveLength(succeeds ? 1 : 0);
      expect(memory.store.currentKnowledge(path)).toHaveLength(succeeds ? 1 : 0);
    } finally { memory.close(); }
  });
