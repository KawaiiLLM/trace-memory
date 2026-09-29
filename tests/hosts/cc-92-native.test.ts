import { afterAll, afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourceSeededMemory } from "../source-fixture.ts";
import { fact as seedFact } from "../support/seed.ts";
import { Store } from "../../src/core/store/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { CcAgentWorker, type CcAgentTask } from "../../src/hosts/cc/worker.ts";
import { assertPinnedClaudeVersion, createFencedClaudeExecutable, fenceToolsAvailable, preflightNetworkFence } from "./cc-native-fence.ts";
import { startLoopbackAnthropic, type LoopbackTurn } from "./cc-native-loopback.ts";

const executable = process.env.TM_NATIVE_CLAUDE_EXECUTABLE ?? "/opt/homebrew/bin/claude";
const available = fenceToolsAvailable(executable);
const dirs: string[] = [];
function directory() { const dir = realpathSync(mkdtempSync(join(tmpdir(), "tm92-native-"))); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const opts = { DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1" };
function config(cwd: string, claudeExecutable: string) { return resolveCcHostConfig({ dbPath: join(cwd, "memory.sqlite"), stateDir: join(cwd, "state"),
  notingModel: "sonnet", notingThinking: "medium", "dreaming.model": "sonnet", "dreaming.thinking": "medium",
  worker: { claudeExecutable, claudeVersion: "2.1.280", contextWindows: { sonnet: 200_000 }, cwd } }); }
const fact = (text: string, source = "T2#E1") => ({ title: text, sources: [{ address: source, text }] });
const empty = { operations: [], skipped: [] };
const tool = (id: number, name: "note" | "memory", input: unknown): LoopbackTurn => ({
  blocks: [{ type: "tool_use", id: `toolu_${id}`, name: `mcp__trace_memory__${name}`, input }], stopReason: "tool_use",
});

for (const variant of ["nine-corrected", "empty-knowledge", "unresolved-block", "corrected-block"] as const)
  test(`real pinned CC one-Noter publication: ${variant}`, async () => {
    const cwd = directory(), home = directory(), configDir = directory();
    let settings!: ReturnType<typeof config>;
    let memory!: ReturnType<typeof sourceSeededMemory>;
    let session!: { id: number };
    let beforeKnowledge!: ReturnType<Store["currentKnowledge"]>;
    let observed = false;
    let checkpointError: unknown;
    let nativeLog: string | undefined;
    const requests: unknown[] = [];
    let path!: { sessionId: number; branch: string; headTurnId: number };
    let entries!: { id: number }[];
    let oldId = 0, tag = "";
    const steps: LoopbackTurn[] = variant === "nine-corrected" ? [
      tool(1, "note", { facts: [...Array.from({ length: 8 }, (_, i) => fact(`Episode ${i + 1}`)), fact("Ninth episode", "T2#E99")] }),
      tool(2, "note", { facts: [{ slot: "$9", ...fact("Corrected ninth episode") }] }),
      tool(3, "memory", { operations: [
        { op: "update", id: "BASE", text: "Claude Code retains the user rule", category: "constraint", scope: "session", topics: [], supports: ["OLD", "$9"], reason: "New episode confirms rule" },
        { op: "create", text: "Claude Code suggests a possible explanation, not a confirmed finding", category: "open", scope: "session", topics: [], supports: ["$1"], reason: "Speculative discussion" },
      ], skipped: [] }),
    ] : variant === "empty-knowledge" ? [tool(1, "note", { facts: [fact("Useful discussion with no durable rule")] }), tool(2, "memory", empty)]
      : [tool(1, "note", { facts: [fact("Original accepted fact")] }),
        tool(2, "note", { facts: [{ slot: "$1", ...fact("Illegal selected block", "T2#E1@text") }] }),
        ...(variant === "corrected-block" ? [tool(3, "note", { facts: [{ slot: "$1", ...fact("Claude Code corrected whole entry", "T2#E2") }] })] : []),
        tool(4, "memory", empty)];
    const loopback = await startLoopbackAnthropic((index, body) => {
      requests.push(body);
      if (index === steps.length) {
        const reader = new Store(settings.dbPath);
        try {
          expect(reader.listSessionFacts(session.id)).toHaveLength(variant === "nine-corrected" ? 1 : 0);
          expect(reader.currentKnowledge(path)).toEqual(beforeKnowledge);
          expect(entries.every(e => !reader.entryNoted(e.id))).toBe(true);
          observed = true;
        } catch (error) { checkpointError = error; } finally { reader.close(); }
      }
      return steps[index] ?? { blocks: [{ type: "text", text: "finished" }], stopReason: "end_turn" };
    });
    if (!available) throw new Error("native CC acceptance requires pinned CLI and sandbox-exec");
    const fence = createFencedClaudeExecutable(join(cwd, "fence"), executable, [Number(new URL(loopback.url).port)], cwd);
    await preflightNetworkFence(fence.profilePath, [Number(new URL(loopback.url).port)], cwd);
    await assertPinnedClaudeVersion(fence.wrapperPath, cwd);
    settings = config(cwd, fence.wrapperPath);
    memory = sourceSeededMemory(settings.dbPath, async raw => {
      const result = await new CcAgentWorker(settings, { environment: {
      PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: configDir, TMPDIR: cwd, CLAUDE_CODE_TMPDIR: cwd,
      ANTHROPIC_BASE_URL: loopback.url, ANTHROPIC_API_KEY: "sk-ant-local-only", CLAUDE_CODE_MAX_RETRIES: "0", ...opts,
    } }).run(raw as CcAgentTask, 0);
      nativeLog = result.nativeLog;
      return result;
    });
    const project = memory.store.createProject({ name: "native-92", declaredBy: "mark" });
    session = memory.store.createSession({ projectId: project.id, host: "cc:native", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const first = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "User established an earlier rule", assistantText: "Claude Code recorded the rule", startedAt: "now" });
    if (variant === "nine-corrected") {
      const manual = memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: first.id });
      const source = memory.store.sourcePath(session.id, "main", first.id).find(entry => entry.entryOrdinal === 1)!;
      oldId = seedFact(memory, memory.store.knowledgePath(session.id, "main", first.id), "Earlier user rule",
        [{ entry: memory.store.getSourceEntry(source.id)!, text: "Earlier user rule" }]).id;
      expect(manual.find(t => t.name === "memory")!.execute({ operations: [{ op: "create", text: "Earlier rule", category: "constraint", scope: "session", topics: [], supports: [`F${oldId}`], reason: "Earlier user rule" }], skipped: [] })).toContain("committed");
      const prior = memory.store.currentKnowledge({ sessionId: session.id, branch: "main", headTurnId: first.id })[0]!;
      tag = `K${prior.knowledge.id}#${memory.store.versionTag(prior.knowledge.id, prior.revision.id)}`;
      const operation = (steps[2]!.blocks[0] as { input: { operations: { id?: string; supports: string[] }[] } }).input.operations[0]!;
      operation.id = tag; operation.supports[0] = `F${oldId}`;
    }
    const second = memory.store.appendTurn({ sessionId: session.id, parentTurnId: first.id, kind: "turn", userPrompt: "New discussion", assistantText: "Claude Code considered it", startedAt: "later" });
    path = { sessionId: session.id, branch: "main", headTurnId: second.id };
    entries = memory.store.sourcePath(session.id, "main", second.id).filter(e => e.turnId === second.id);
    beforeKnowledge = memory.store.currentKnowledge(path);
    try {
      const outcome = await memory.noting({ ...path, model: "sonnet", mode: "subagent" });
      const evidenceDir = join(cwd, "evidence");
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, `${variant}.requests.json`), JSON.stringify(requests, null, 2) + "\n");
      if (nativeLog) writeFileSync(join(evidenceDir, `${variant}.jsonl`), readFileSync(nativeLog));
      expect(checkpointError).toBeUndefined();
      expect(observed, JSON.stringify(outcome)).toBe(true);
      expect(requests).toHaveLength(steps.length + 1);
      const succeeded = variant === "nine-corrected" || variant === "empty-knowledge" || variant === "corrected-block";
      expect(outcome.outcome, JSON.stringify(outcome)).toBe(succeeded ? "success" : "bounced");
      const facts = memory.store.listSessionFacts(session.id);
      expect(facts).toHaveLength((variant === "nine-corrected" ? 9 : succeeded ? 1 : 0) + (variant === "nine-corrected" ? 1 : 0));
      for (const entry of entries) expect(memory.store.entryNoted(entry.id), `entry ${entry.id} processed in ${variant}`).toBe(succeeded);
      if (variant === "nine-corrected") {
        const current = memory.store.currentKnowledge(path);
        expect(current).toHaveLength(2);
        const ninth = facts.find(f => f.text === "Corrected ninth episode")!;
        expect(ninth.source).toEqual(["T2#E1"]);
        const updated = current.find(k => k.knowledge.id === Number(tag.match(/^K(\d+)/)![1]))!.revision;
        expect(updated.text).toBe("Claude Code retains the user rule");
        expect(updated.supports).toEqual([oldId, ninth.id]);
        const speculative = current.find(k => k.revision.category === "open")!.revision;
        expect(speculative.text).toBe("Claude Code suggests a possible explanation, not a confirmed finding");
        expect(speculative.supports).toEqual([facts.find(f => f.text === "Episode 1")!.id]);
      } else expect(memory.store.currentKnowledge(path)).toHaveLength(0);
      if (variant === "corrected-block") {
        expect(facts[0]!.text).toBe("Claude Code corrected whole entry");
        expect(facts[0]!.source).toEqual(["T2#E2"]);
        expect(facts[0]!.roles).toEqual([{ role: "assistant", harness: "Claude Code" }]);
      }
      expect(nativeLog && existsSync(nativeLog), JSON.stringify(outcome)).toBe(true);
      const transcript = readFileSync(nativeLog!, "utf8");
      expect(transcript).toContain("mcp__trace_memory__note");
      expect(transcript).toContain("mcp__trace_memory__memory");
      expect(transcript).toContain("held: ");
      expect(transcript).not.toContain("mcp__trace_memory__consolidation");
      expect(JSON.stringify(requests)).not.toContain("mcp__trace_memory__consolidation");
      if (variant === "nine-corrected") {
        expect(transcript).toContain("held: $8");
        expect(transcript).toContain("rejected: $9");
        expect(transcript).toContain("held: $9");
        expect(transcript).toContain("held: M1");
      }
      if (variant.includes("block")) expect(transcript).toContain("rejected:");
    } finally { memory.close(); await loopback.close(); }
  }, 90_000);
