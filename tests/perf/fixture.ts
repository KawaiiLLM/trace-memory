// The shared performance fixture (ticket 22 "Workloads and acceptance"): a deterministic long-history
// database built from a fixed seed. Nothing here is copied from a conversation — every string is
// assembled out of the small public word pools below, in Latin and CJK, so the fixture can live in the
// repository. 22a records its baseline against it; 22b–22d measure against the same generator.
//
// Shape of the baseline size (defaults): about 2,000 source entries and 15 million Raw characters on
// one session, with tool-heavy Turns (one Turn of 40 calls), non-text user boundaries, repeated text,
// several native occurrences of the same tool call, at least 126 applicable facts, a sibling branch
// whose selected ancestry contains a same-Turn entry that main's does not, facts written without
// entry bindings (the address fallback), knowledge revisions with citations, consolidated facts, and
// a pending tail that no Noting run has taken.

import { Store } from "../../src/core/store/index.ts";
import type { FactCommitInput } from "../../src/core/store/index.ts";

export interface FixtureOptions {
  /** Target number of source entries (the baseline workload is 2,000). */
  entries?: number;
  /** Raw characters per tool result; the bulk of the Raw volume. */
  resultChars?: number;
  /** Applicable facts on the main branch (the baseline workload needs at least 126). */
  facts?: number;
  seed?: number;
}

export interface Fixture {
  dbPath: string;
  sessionId: number;
  projectId: number;
  branch: string;
  siblingBranch: string;
  headTurnId: number;
  siblingHeadTurnId: number;
  turnCount: number;
  entryCount: number;
  rawChars: number;
  factCount: number;
  pathFactCount: number;
  knowledgeCount: number;
  pendingEntryCount: number;
  heavyTurnId: number;
}

const LATIN = ["build", "cache", "commit", "branch", "restore", "budget", "receipt", "token", "entry", "trace",
  "session", "worker", "handle", "ordinal", "payload", "summary", "review", "capacity", "consolidate", "note"];
const CJK = ["缓存", "提交", "分支", "恢复", "预算", "回执", "词元", "条目", "追溯", "会话",
  "执行器", "句柄", "序号", "载荷", "摘要", "复核", "容量", "整合", "记录", "路径"];

/** mulberry32: a small deterministic generator, so a fixture rebuild is byte-identical. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generate(dbPath: string, options: FixtureOptions = {}): Fixture {
  const targetEntries = options.entries ?? 2_000;
  const resultChars = options.resultChars ?? 20_000;
  const targetFacts = options.facts ?? 132;
  const rnd = random(options.seed ?? 0x7ace);
  const store = new Store(dbPath);
  const pick = <T>(values: T[]) => values[Math.floor(rnd() * values.length)]!;
  const words = (chars: number): string => {
    let out = "";
    while (out.length < chars) out += `${pick(LATIN)} ${pick(CJK)} `;
    return out.slice(0, chars);
  };
  // Repeated text: a small pool of prompts that recur verbatim across the history.
  const prompts = Array.from({ length: 8 }, () => words(180));

  try {
    const projectId = store.createProject({ name: "perf", declaredBy: "marker" }).id;
    const sessionId = store.createSession({ enrollmentChoice: true, host: "pi:perf", startedAt: "2026-01-01T00:00:00Z",
      firstReplyAt: "2026-01-01T00:00:05Z", projectId }).id;
    const branch = "main", siblingBranch = "sibling";

    const result = store.transaction(() => {
      const turnCount = Math.max(20, Math.ceil(targetEntries / 3.1)); // a Turn contributes a prompt, a reply and, on average, one tool result
      const heavyTurn = Math.floor(turnCount / 2); // one Turn of 40 tool calls inside a long session
      const siblingAt = Math.floor(turnCount / 3);
      const pendingFrom = turnCount - 10; // the tail no Noting run has taken
      const factEvery = Math.max(1, Math.floor((pendingFrom - 2) / targetFacts));

      let rawChars = 0, entryCount = 0, native = 0, parent: number | null = null;
      let headTurnId = 0, siblingHeadTurnId = 0, heavyTurnId = 0;
      const mainEntries: number[] = [], siblingEntries: number[] = [];
      const facts: FactCommitInput[] = [];
      const pathFactIds: number[] = [];
      let batchEntries: number[] = [], batchFacts: FactCommitInput[] = [];
      let noted = 0;

      const append = (turnId: number, role: "user" | "assistant" | "toolResult", text: string,
        calls: { ordinal: number; name: string; callId: string; input?: string; result?: string; status: string }[],
        onto: number[][] = [mainEntries, siblingEntries]) => {
        const raw = JSON.stringify({ role, text, calls });
        rawChars += raw.length; entryCount++;
        const entry = store.appendSourceEntry({ sessionId, nativeLineage: "perf", nativeId: `n${native++}`, turnId, role, text, raw, calls });
        for (const list of onto) list.push(entry.id);
        return entry.id;
      };
      const flush = () => {
        if (!batchEntries.length && !batchFacts.length) return;
        const committed = store.commitNotingRun({
          run: { kind: "noting", sessionId, branch, rangeFrom: `S${sessionId}/T1`, rangeTo: `S${sessionId}/T${headTurnId}`, createdAt: "2026-01-01T01:00:00Z" },
          facts: batchFacts, entryIds: batchEntries,
        });
        if (!committed.ok) throw new Error(committed.problems.join("; "));
        for (const fact of committed.facts) pathFactIds.push(fact.id);
        noted += batchEntries.length;
        batchEntries = []; batchFacts = [];
      };

      for (let t = 1; t <= turnCount; t++) {
        // A non-text user boundary (an image-only message) every 17th Turn.
        const prompt = t % 17 === 0 ? "" : prompts[t % prompts.length]!;
        const turn = store.appendTurn({ sessionId, parentTurnId: parent, kind: "turn", userPrompt: prompt, startedAt: "2026-01-01T00:10:00Z" });
        parent = turn.id; headTurnId = turn.id;
        if (t === heavyTurn) heavyTurnId = turn.id;
        const userEntry = append(turn.id, "user", prompt, []);
        const callCount = t === heavyTurn ? 40 : t % 3 === 0 ? 2 : t % 3 === 1 ? 1 : 0;
        const calls = [];
        for (let i = 1; i <= callCount; i++) {
          const input = JSON.stringify({ path: `src/${pick(LATIN)}.ts`, note: words(120) });
          const stored = store.appendToolCall({ turnId: turn.id, name: pick(LATIN), input, status: "attempted" });
          calls.push({ ordinal: stored.ordinal, name: stored.name, callId: `call-${stored.id}`, input, status: "attempted" });
        }
        const assistantText = words(400);
        store.updateTurn(turn.id, { assistantText, endedAt: "2026-01-01T00:11:00Z" });
        append(turn.id, "assistant", assistantText, calls.map(c => ({ ...c })));
        for (const call of calls) {
          const payload = JSON.stringify({ content: [{ type: "text", text: words(resultChars) }] });
          store.completeToolCall(turn.id, call.ordinal, payload, "success");
          append(turn.id, "toolResult", "", [{ ordinal: call.ordinal, name: call.name, callId: call.callId, result: payload, status: "success" }]);
          // Several native occurrences of one call: a second persisted result entry for the same ordinal.
          if (call.ordinal === 1 && t % 23 === 0) {
            append(turn.id, "toolResult", "", [{ ordinal: call.ordinal, name: call.name, callId: call.callId, result: payload, status: "success" }]);
          }
        }
        // The sibling branch: an extra assistant occurrence inside this same Turn that only the
        // sibling's selected ancestry carries, and a Turn of its own after it.
        if (t === siblingAt) {
          append(turn.id, "assistant", words(300), [], [siblingEntries]);
          const sibling = store.appendTurn({ sessionId, parentTurnId: turn.id, kind: "turn", userPrompt: prompts[1]!, startedAt: "2026-01-01T00:12:00Z" });
          siblingHeadTurnId = sibling.id;
          append(sibling.id, "user", prompts[1]!, [], [siblingEntries]);
          const text = words(300);
          store.updateTurn(sibling.id, { assistantText: text, endedAt: "2026-01-01T00:12:30Z" });
          append(sibling.id, "assistant", text, [], [siblingEntries]);
        }
        if (t <= pendingFrom) {
          batchEntries.push(...mainEntries.slice(noted + batchEntries.length));
          if (t > 1 && prompt && t % factEvery === 0 && facts.length < targetFacts) {
            // Most facts carry the entry bindings they were written against; a few keep the older
            // shape with no bindings at all, which applicability answers from the addresses.
            const bound = facts.length % 25 !== 0;
            const fact: FactCommitInput = { turnId: turn.id, category: "observation", actor: "user",
              text: `${pick(LATIN)} ${pick(CJK)} ${facts.length}`, source: [`T${turn.id}#user`], createdAt: "2026-01-01T01:00:00Z",
              ...(bound ? { entryIds: [userEntry] } : {}) };
            facts.push(fact); batchFacts.push(fact);
          }
          if (batchEntries.length >= 50) flush();
        }
        if (entryCount >= targetEntries && t >= pendingFrom) break;
      }
      flush();
      store.selectSourcePath(sessionId, branch, mainEntries);
      store.selectSourcePath(sessionId, siblingBranch, siblingEntries);

      // Knowledge: a set of revisions citing path facts, with updates, an archive and a merge, plus
      // consolidated progress for the older half of the facts.
      let knowledgeCount = 0;
      const cite = (n: number) => pathFactIds.slice(n * 3, n * 3 + 2);
      const path = { sessionId, headTurnId, branch };
      let firstKnowledge = 0, firstCommit = 0, secondKnowledge = 0, secondCommit = 0;
      for (let i = 0; i < 20; i++) {
        const supports = cite(i);
        if (supports.length < 2) break;
        const run = { kind: "consolidation" as const, sessionId, branch, createdAt: "2026-01-01T02:00:00Z" };
        const operations = [{ op: "create" as const, handle: `perf-${i}`, author: "perf", text: `${pick(LATIN)} ${pick(CJK)} K${i}`,
          category: "mechanism" as const, scope: "session" as const, supports, reason: "perf fixture", topics: [pick(LATIN)], createdAt: "2026-01-01T02:00:00Z" }];
        const committed = store.commitConsolidationRun({ path, run, operations, consolidated: i < 10 ? supports : [] });
        if (!committed.ok) throw new Error(committed.problems.join("; "));
        knowledgeCount += committed.committed.length;
        if (i === 0) { firstKnowledge = committed.committed[0]!.knowledgeId; firstCommit = committed.committed[0]!.commit; }
        if (i === 1) { secondKnowledge = committed.committed[0]!.knowledgeId; secondCommit = committed.committed[0]!.commit; }
      }
      if (firstCommit && secondCommit) {
        const run = { kind: "consolidation" as const, sessionId, branch, createdAt: "2026-01-01T02:10:00Z" };
        const merged = store.commitConsolidationRun({ path, run, operations: [{ op: "merge", intoKnowledgeId: firstKnowledge, intoBaseCommit: firstCommit,
          absorb: [{ knowledgeId: secondKnowledge, baseCommit: secondCommit }], text: "merged perf knowledge", category: "mechanism",
          scope: "session", supports: cite(0), reason: "perf fixture merge", topics: ["merge"], createdAt: "2026-01-01T02:10:00Z" }] });
        if (merged.ok) knowledgeCount += merged.committed.length;
      }

      return { turnCount, entryCount, rawChars, headTurnId, siblingHeadTurnId, heavyTurnId,
        factCount: facts.length, pathFactCount: pathFactIds.length, knowledgeCount,
        pendingEntryCount: store.pendingEntries(sessionId, branch, headTurnId).length };
    });

    return { dbPath, sessionId, projectId, branch, siblingBranch, ...result };
  } finally {
    store.close();
  }
}

/** Count how often a path's membership is rebuilt. One build per operation is the contract 22a
 * introduces; a count that grows with the fact or commit count is the per-fact rebuild coming back. */
export function countPathBuilds(): { builds: () => number; reset: () => void; restore: () => void } {
  const prototype = Store.prototype as { pathTurns: Store["pathTurns"] };
  const original = prototype.pathTurns;
  let count = 0;
  prototype.pathTurns = function (this: Store, path) { count++; return original.call(this, path); };
  return { builds: () => count, reset: () => { count = 0; }, restore: () => { prototype.pathTurns = original; } };
}

/** Count the reads that load and parse a whole Raw payload — the audit's "source reads". Test-only:
 * it replaces the public method on the prototype (so a store the extension owns is counted too) and
 * restores it afterwards; production carries no hook. */
export function countSourceReads(): { reads: () => number; reset: () => void; restore: () => void } {
  const prototype = Store.prototype as { getSourceEntry: Store["getSourceEntry"] };
  const original = prototype.getSourceEntry;
  let count = 0;
  prototype.getSourceEntry = function (this: Store, id: number) { count++; return original.call(this, id); };
  return { reads: () => count, reset: () => { count = 0; }, restore: () => { prototype.getSourceEntry = original; } };
}

export interface NativeEntry { id: string; parentId: string | null; timestamp: string; type: "message"; message: Record<string, unknown> }

/** The same long history as `generate`, in the shape a host reconciles: the native Pi ancestry of one
 * session (ticket 22b, hotspot families 1 and 2). The generator mirrors `generate` turn for turn — the
 * same seeded word pools, the same tool-heavy Turn of 40 calls, the same non-text user boundaries, the
 * same repeated prompts and the same second native occurrence of one tool call — so an import of this
 * ancestry produces a database of the same shape as the store-level fixture. Nothing is persisted: the
 * caller pushes these entries into the fake host's branch and lets `/trace on` import them. */
export function nativeAncestry(options: FixtureOptions = {}): NativeEntry[] {
  const targetEntries = options.entries ?? 2_000;
  const resultChars = options.resultChars ?? 20_000;
  const rnd = random(options.seed ?? 0x7ace);
  const pick = <T>(values: T[]) => values[Math.floor(rnd() * values.length)]!;
  const words = (chars: number): string => {
    let out = "";
    while (out.length < chars) out += `${pick(LATIN)} ${pick(CJK)} `;
    return out.slice(0, chars);
  };
  const prompts = Array.from({ length: 8 }, () => words(180));
  const entries: NativeEntry[] = [];
  const push = (message: Record<string, unknown>) => {
    entries.push({ id: `n${entries.length}`, parentId: entries.length ? `n${entries.length - 1}` : null,
      timestamp: "2026-01-01T00:10:00Z", type: "message", message });
    return entries.length;
  };
  const turnCount = Math.max(20, Math.ceil(targetEntries / 3.1));
  const heavyTurn = Math.floor(turnCount / 2);
  for (let t = 1; t <= turnCount; t++) {
    const prompt = t % 17 === 0 ? "" : prompts[t % prompts.length]!;
    push(prompt ? { role: "user", content: prompt, timestamp: t }
      : { role: "user", content: [{ type: "image", mimeType: "image/png", data: "synthetic-image" }], timestamp: t });
    const callCount = t === heavyTurn ? 40 : t % 3 === 0 ? 2 : t % 3 === 1 ? 1 : 0;
    const calls = Array.from({ length: callCount }, (_unused, i) => ({ type: "toolCall" as const, id: `call-${t}-${i + 1}`,
      name: pick(LATIN), arguments: { path: `src/${pick(LATIN)}.ts`, note: words(120) } }));
    push({ role: "assistant", content: [{ type: "text", text: words(400) }, ...calls], api: "openai-completions",
      provider: "fake", model: "test", stopReason: calls.length ? "toolUse" : "stop", timestamp: t });
    for (const call of calls) {
      const content = [{ type: "text", text: words(resultChars) }];
      push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError: false, timestamp: t });
      // Several native occurrences of one tool call: a second persisted result entry for the same call id.
      if (call.id.endsWith("-1") && t % 23 === 0) push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content, isError: false, timestamp: t });
    }
    if (entries.length >= targetEntries) break;
  }
  return entries;
}

/** Count the whole-knowledge-graph resolutions a read performs (ticket 22c, hotspot family 5): the
 * commit DAG walk that decides which revisions apply to a path and which of them are current. One
 * per query is the contract; a count that grows with the hit count is the per-hit resolution coming
 * back. Test-only, and named for both sides of the change: `currentSet` before 22c, the
 * `commitGraph` it was extracted into after. */
export function countGraphResolutions(): { resolutions: () => number; reset: () => void; restore: () => void } {
  const prototype = Store.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const name = "commitGraph" in prototype ? "commitGraph" : "currentSet";
  const original = prototype[name]!;
  let count = 0;
  prototype[name] = function (this: Store, ...args: unknown[]) { count++; return original.apply(this, args); };
  return { resolutions: () => count, reset: () => { count = 0; }, restore: () => { prototype[name] = original; } };
}

export interface SearchCorpus { query: string; revisions: number; historical: number; divergent: number; knowledge: number }

/** Knowledge for the search workload (ticket 22c): `revisions` commits that all match one literal
 * query, on top of an existing long-history fixture, so applicability is decided against real facts
 * and Turns. Every fifth commit opens a new knowledge; the rest are updates, so most hits are
 * historical (superseded on this path). Every tenth knowledge ends in two updates written from two
 * sibling Turns of the head instead of one: two tips of the same base that no single path carries
 * together — the divergent revisions, which read as "another branch" from main. */
export function searchCorpus(dbPath: string, options: { revisions: number; sessionId: number; branch: string; headTurnId: number }): SearchCorpus {
  const query = "SEARCHNEEDLE";
  const time = "2026-01-01T03:00:00Z";
  const store = new Store(dbPath);
  try {
    return store.transaction(() => {
      const { sessionId, branch, headTurnId } = options;
      const path = { sessionId, branch, headTurnId };
      const supports = store.listBranchFacts(sessionId, branch, headTurnId).slice(0, 2).map(f => f.id);
      if (supports.length < 2) throw new Error("the search corpus needs at least two facts on the path");
      // Two sibling Turns of the head, each with a fact of its own: evidence that only that sibling's
      // path carries, so a commit citing it applies there and nowhere else.
      const fork = (name: string) => {
        const turn = store.appendTurn({ sessionId, parentTurnId: headTurnId, kind: "turn", userPrompt: `corpus ${name}`, startedAt: time });
        const noted = store.commitNotingRun({ run: { kind: "noting", sessionId, branch: name, createdAt: time },
          facts: [{ turnId: turn.id, category: "observation", actor: "user", text: `${name} evidence`, source: [`T${turn.id}#user`], createdAt: time }] });
        if (!noted.ok) throw new Error(noted.problems.join("; "));
        return { path: { sessionId, branch: name, headTurnId: turn.id }, factId: noted.facts[0]!.id };
      };
      const forks = [fork("corpusC"), fork("corpusD")];
      const commit = (on: typeof path, operation: Parameters<Store["commitConsolidationRun"]>[0]["operations"][number]) => {
        const done = store.commitConsolidationRun({ path: on, run: { kind: "consolidation", sessionId, branch: on.branch, createdAt: time }, operations: [operation] });
        if (!done.ok) throw new Error(done.problems.join("; "));
        return done.committed[0]!;
      };
      let made = 0, historical = 0, divergent = 0, knowledge = 0;
      for (let i = 0; made < options.revisions; i++) {
        const created = commit(path, { op: "create", handle: `corpus-${i}`, author: "perf", text: `${query} conclusion ${i}`,
          category: "mechanism", scope: "session", supports, reason: "search corpus", topics: [i % 3 ? "corpus" : query], createdAt: time });
        let base = created.commit;
        made++; knowledge++;
        for (let j = 0; j < 4 && made < options.revisions; j++) {
          if (i % 10 === 9 && j === 3) {
            for (const branchPoint of forks) {
              commit(branchPoint.path, { op: "update", knowledgeId: created.knowledgeId, baseCommit: base, text: `${query} conclusion ${i} on ${branchPoint.path.branch}`,
                category: "mechanism", scope: "session", supports: [...supports, branchPoint.factId], reason: "search corpus divergence", topics: ["corpus"], createdAt: time });
              made++; divergent++;
            }
          } else {
            base = commit(path, { op: "update", knowledgeId: created.knowledgeId, baseCommit: base, text: `${query} conclusion ${i} revision ${j + 1}`,
              category: "mechanism", scope: "session", supports, reason: "search corpus revision", topics: ["corpus"], createdAt: time }).commit;
            made++; historical++;
          }
        }
      }
      return { query, revisions: made, historical, divergent, knowledge };
    });
  } finally { store.close(); }
}

/** Count the audit-body characters a read pulls into JavaScript (ticket 22d, hotspot family 7): the
 * `request` and `response` columns of every run row a caller materializes. Test-only, in the shape
 * `countSourceReads` established — the public methods are replaced on the prototype and restored
 * afterwards; production carries no hook. Spend that projects usage in SQL loads none of them. */
export function countRunBodies(): { chars: () => number; reset: () => void; restore: () => void } {
  const prototype = Store.prototype as { listRuns: Store["listRuns"]; getRun: Store["getRun"] };
  const list = prototype.listRuns, one = prototype.getRun;
  let count = 0;
  const charge = <T extends { request?: string | null; response?: string | null } | undefined | null>(run: T): T => {
    if (run) count += (run.request?.length ?? 0) + (run.response?.length ?? 0);
    return run;
  };
  prototype.listRuns = function (this: Store, sessionId: number) { return list.call(this, sessionId).map(charge); };
  prototype.getRun = function (this: Store, id: number) { return charge(one.call(this, id)); };
  return { chars: () => count, reset: () => { count = 0; }, restore: () => { prototype.listRuns = list; prototype.getRun = one; } };
}

/** The spend workload (ticket 22d): about 200 runs whose audit bodies are large and whose usage
 * records are small, written onto an existing fixture's session. Deterministic: the bodies come from
 * the seeded word pools, the usage counters from a fixed arithmetic sequence. Three shapes share the
 * table, because spend must keep them apart — an observed usage, a cancelled run whose usage is
 * unknown (`usage: null`, never a zero observation), and a failure whose response is not JSON. */
export function runAudit(dbPath: string, options: { sessionId: number; branch: string; runs?: number; requestChars?: number; responseChars?: number; seed?: number }): RunAudit {
  const total = options.runs ?? 200;
  const requestChars = options.requestChars ?? 256 * 1024;
  const responseChars = options.responseChars ?? 64 * 1024;
  const rnd = random(options.seed ?? 0x5be4d);
  const pick = <T>(values: T[]) => values[Math.floor(rnd() * values.length)]!;
  const words = (chars: number): string => {
    let out = "";
    while (out.length < chars) out += `${pick(LATIN)} ${pick(CJK)} `;
    return out.slice(0, chars);
  };
  const store = new Store(dbPath);
  const totals: RunAudit = { runs: total, observed: 0, unknown: 0, malformed: 0, chars: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  try {
    store.transaction(() => {
      for (let i = 0; i < total; i++) {
        const kind = i % 3 === 0 ? "consolidation" : i % 7 === 0 ? "manual" : "noting";
        const request = JSON.stringify({ messages: [{ role: "user", content: words(requestChars) }] });
        const shape = i % 17 === 5 ? "unknown" : i % 23 === 7 ? "malformed" : "observed";
        const usage = { input: 1_000 + i * 13, output: 100 + i, cacheRead: 5_000 + i * 7, cacheWrite: i * 3, cost: { total: (i + 1) / 10_000 } };
        const response = shape === "malformed" ? `provider refused: ${words(responseChars)}`
          : JSON.stringify({ output: words(responseChars), usage: shape === "unknown" ? null : usage,
            ...(shape === "unknown" ? { usageStatus: "unknown" } : {}), problems: [] });
        if (shape === "observed") {
          totals.observed++; totals.input += usage.input; totals.output += usage.output;
          totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite; totals.cost += usage.cost.total;
        } else totals[shape]++;
        totals.chars += request.length + response.length;
        store.recordRun({ kind, sessionId: options.sessionId, branch: options.branch, request, response,
          outcome: shape === "observed" ? "success" : shape === "unknown" ? "cancelled" : "failure", createdAt: "2026-01-01T04:00:00Z" });
      }
    });
  } finally { store.close(); }
  return totals;
}

export interface RunAudit { runs: number; observed: number; unknown: number; malformed: number; chars: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
