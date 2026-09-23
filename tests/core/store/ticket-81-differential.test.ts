import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";

// Ticket 81: a differential test over the exact battery the ticket's Constraints name -- ASCII, mixed
// case, non-ASCII case pairs, CJK words of two/three/more characters, LIKE metacharacters, FTS5 syntax
// characters, and a very long query -- run against both the old full scan and the new trigram-indexed
// search, asserting byte-identical hits. `originalRawLikeScan` is a frozen copy of the pre-81
// `searchAddresses` raw() query (Store.rawLikeScan today, unchanged): a second, independent
// implementation to compare against, not a call into the code under test.
function originalRawLikeScan(store: Store, query: string, sessionIds?: readonly number[]): string[] {
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const owners = JSON.stringify(sessionIds ?? []), restricted = sessionIds !== undefined;
  return (store.db.prepare(`SELECT t.id FROM turns t WHERE
      (? = 0 OR t.session_id IN (SELECT value FROM json_each(?))) AND
      (t.user_prompt LIKE ? ESCAPE '\\' OR t.assistant_text LIKE ? ESCAPE '\\' OR EXISTS
      (SELECT 1 FROM tool_calls c WHERE c.turn_id = t.id AND
      (c.name LIKE ? ESCAPE '\\' OR c.input LIKE ? ESCAPE '\\' OR c.result LIKE ? ESCAPE '\\'))) ORDER BY t.id`)
      .all(Number(restricted), owners, pattern, pattern, pattern, pattern, pattern) as { id: number }[]).map(r => `T${r.id}`);
}

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-81-differential-")); dirs.push(dir);
  const path = join(dir, "test.sqlite"), store = new Store(path); stores.push(store);
  const project = store.createProject({ name: "ticket-81-diff", declaredBy: "mark" });
  const sessionA = store.createSession({ projectId: project.id, host: "test", startedAt: "time", firstReplyAt: "time", enrollmentChoice: true });
  const otherProject = store.createProject({ name: "ticket-81-diff-other", declaredBy: "mark" });
  const sessionB = store.createSession({ projectId: otherProject.id, host: "test", startedAt: "time", firstReplyAt: "time", enrollmentChoice: true });
  return { store, sessionA, sessionB };
}

test("81: differential -- ASCII, mixed case, non-ASCII case pairs, CJK, metacharacters, FTS5 syntax and a very long query all agree between the old scan and the new index", () => {
  const f = fixture();
  const s = f.store;
  s.appendTurn({ sessionId: f.sessionA.id, kind: "turn", startedAt: "time", userPrompt: "ABC ascii ABCDEF", assistantText: "abc lowercase too" }); // ascii + mixed case
  s.appendTurn({ sessionId: f.sessionA.id, kind: "turn", startedAt: "time", assistantText: "École de Paris" }); // non-ASCII case pair (éco/École)
  const t3 = s.appendTurn({ sessionId: f.sessionA.id, kind: "turn", startedAt: "time" });
  s.appendToolCall({ turnId: t3.id, name: "Bash", input: "progress 100% done", status: "success" }); // % metacharacter
  s.appendToolCall({ turnId: t3.id, name: "Bash", result: "use snake_case naming", status: "success" }); // _ metacharacter
  s.appendToolCall({ turnId: t3.id, name: "Bash", input: "path core\\api\\read.ts", status: "success" }); // \ metacharacter
  s.appendTurn({ sessionId: f.sessionB.id, kind: "turn", startedAt: "time", assistantText: "御坂美琴的电击" }); // CJK: 2/3/4-char words
  s.appendTurn({ sessionId: f.sessionB.id, kind: "turn", startedAt: "time", assistantText: `he said "hi" * : ( NEAR AND together` }); // FTS5 syntax chars
  s.appendTurn({ sessionId: f.sessionB.id, kind: "turn", startedAt: "time", assistantText: `${"a".repeat(4000)}findableneedle${"b".repeat(4000)}` }); // very long

  const queries = [
    "ABC", "abc", "ABCDEF", "éco", "École", "100%", "snake_case", "core\\api",
    "美琴", "美琴的", "御坂美琴", `"hi"`, "*", ":", "(", "NEAR", "AND", "findableneedle",
    "a".repeat(4000) + "findableneedle", "x", "御", // 1-char cases too
  ];
  for (const query of queries) {
    expect(s.searchAddresses(query, "raw"), `unrestricted: ${JSON.stringify(query)}`).toEqual(originalRawLikeScan(s, query));
    expect(s.searchAddresses(query, "raw", [f.sessionA.id]), `restricted to A: ${JSON.stringify(query)}`).toEqual(originalRawLikeScan(s, query, [f.sessionA.id]));
    expect(s.searchAddresses(query, "raw", [f.sessionB.id]), `restricted to B: ${JSON.stringify(query)}`).toEqual(originalRawLikeScan(s, query, [f.sessionB.id]));
  }
});
