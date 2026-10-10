// 136 review SPEC2: a Raw hit's text, its matching and its line numbers are those of an exact Read of its
// address, whichever host registered the memory. The hosts' result extractors unwrap their tool-result
// envelopes (Claude Code's `{content, toolUseResult}`, Pi's `{content, details}`); an exact Read shows the stored
// envelope uncut, so a search that used an extractor would match and number a different text.
import { afterEach, expect, test } from "vitest";
import { sourceSeededMemory, memoryFiles, type TraceMemory } from "../source-fixture.ts";
import { ccResultText } from "../../src/hosts/cc/transcript.ts";
import { piResultText } from "../../src/hosts/pi/index.ts";
import type { ResultExtractor } from "../../src/core/api/index.ts";

let memory: TraceMemory;
afterEach(() => memory.close());

const BODY = "first line\nsecond line\nNEEDLE-LINE";
const envelopes = {
  cc: JSON.stringify({ content: BODY, toolUseResult: { note: "RAW-ONLY-MARKER" } }),
  pi: JSON.stringify({ content: [{ type: "text", text: BODY }], details: { note: "RAW-ONLY-MARKER" } }),
};

function corpus(resultText: ResultExtractor, envelope: string) {
  memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model calls"); }, undefined, resultText);
  const store = memory.store, project = store.createProject({ name: "raw-read", declaredBy: "mark" });
  const session = store.createSession({ enrollmentChoice: true, host: "fake", projectId: project.id, startedAt: "2026-10-01T00:00:00Z", firstReplyAt: "2026-10-01T00:00:01Z" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "read the file", assistantText: "done", startedAt: "2026-10-01T00:01:00Z" });
  store.appendToolCall({ turnId: turn.id, name: "Read", input: JSON.stringify({ file_path: "a.txt" }), result: envelope, status: "success" });
  return { session, path: { sessionId: session.id, branch: "main", headTurnId: turn.id } };
}

/** Every hit's text and matchLines for `query`, as a script reads them. */
async function hitsFor(path: { sessionId: number; branch: string; headTurnId: number }, query: string | undefined) {
  const out = await memory.search(query, "raw", { ...path, code: "return JSON.stringify(hits.map(h => ({ address: h.address, text: h.text, matchLines: h.matchLines })))" });
  return JSON.parse(/Output:\n(.*)$/s.exec(out)![1]!) as { address: string; text: string; matchLines: number[] }[];
}

test.each([["Claude Code", ccResultText, envelopes.cc], ["Pi", piResultText, envelopes.pi]] as const)(
  "%s: a Raw hit's text equals the exact Read of its address, and each matchLines entry is a matching line of that Read", async (_host, resultText, envelope) => {
    const { path } = corpus(resultText, envelope);
    const files = memoryFiles(memory, path);
    for (const query of [undefined, "NEEDLE-LINE", "RAW-ONLY-MARKER", "second line"]) {
      const hits = await hitsFor(path, query);
      expect(hits.length, String(query)).toBeGreaterThan(0);
      for (const hit of hits) {
        const read = files.read(hit.address).content;
        expect(hit.text, `${query} ${hit.address}`).toBe(read);
        const lines = read.split("\n");
        if (query === undefined) { expect(hit.matchLines).toEqual([]); continue; }
        expect(hit.matchLines.length).toBeGreaterThan(0);
        expect(hit.matchLines).toEqual(lines.flatMap((line, i) => line.toLowerCase().includes(query.toLowerCase()) ? [i + 1] : []));
      }
    }
    // The envelope is one line of the Read, so its matches are line 1 though the unwrapped text has three lines.
    const [needle] = await hitsFor(path, "NEEDLE-LINE");
    expect(needle!.matchLines).toEqual([1]);
    // A text only the stored envelope holds is found, not reported as no hit.
    const marker = await hitsFor(path, "RAW-ONLY-MARKER");
    expect(marker).toHaveLength(1);
    expect(marker[0]!.text).toContain("RAW-ONLY-MARKER");
    expect(await memory.search("RAW-ONLY-MARKER", "raw", path)).toMatch(/^\[S\d+\/T\d+#E\d@observation\] /);
  });

// 138: the `trace://` grep renders Raw the way an exact Read does, so the `path:line:` it reports numbers the lines
// a Read of that path shows, whichever host's extractor the memory was built with.
test.each([["Claude Code", ccResultText, envelopes.cc], ["Pi", piResultText, envelopes.pi]] as const)(
  "%s: grep's lines and matching line numbers are those of an exact Read of the same path", (_host, resultText, envelope) => {
    const { path, session } = corpus(resultText, envelope);
    const files = memoryFiles(memory, path);
    for (const pattern of ["NEEDLE-LINE", "RAW-ONLY-MARKER", "second line"]) {
      const found = [...files.grep(pattern, `trace://raw/S${session.id}`, { literal: true })];
      expect(found.length, pattern).toBeGreaterThan(0);
      for (const file of found) {
        const read = files.read(file.path).content.split("\n");
        expect(file.lines, `${pattern} ${file.path}`).toEqual(read);
        expect(file.hits.map(index => index + 1), `${pattern} ${file.path}`)
          .toEqual(read.flatMap((line, i) => line.includes(pattern) ? [i + 1] : []));
      }
    }
    // Pi's envelope wraps the text in a content array, Claude Code's in a `content` string: either way one line.
    expect([...files.grep("NEEDLE-LINE", `trace://raw/S${session.id}`, { literal: true })].flatMap(file => file.hits.map(index => index + 1))).toEqual([1]);
  });
