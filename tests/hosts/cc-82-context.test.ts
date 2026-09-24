import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokens } from "../../src/core/render/tokens.ts";
import { compactText } from "../../src/core/render/material.ts";
import { ccContextEvidence, type CcContextSnapshot } from "../../src/hosts/cc/menu-context.ts";
import { databaseIdentity, encodeCcInjection } from "../../src/hosts/cc/injection.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const wrap = (text: string) => `<system-reminder>\nSessionStart hook additional context: ${text}\n</system-reminder>`;
function fixture(body: string, preview = false) {
  const dir = mkdtempSync(join(tmpdir(), "tm-82-context-")); dirs.push(dir);
  const db = join(dir, "db"); writeFileSync(db, "db");
  const binding = { nativeSessionId: "native-A", coreSessionId: 7 };
  const identity = { db: databaseIdentity(db), nativeSession: "native-A", coreSession: 7 };
  const original = encodeCcInjection(identity, { text: body, knowledgeCommitIds: [1] });
  const file = join(dir, "additionalContext.txt");
  writeFileSync(file, original);
  const retained = preview ? original.slice(0, original.indexOf(body) + Math.min(80, body.length)) : original;
  const payload = preview ? `<persisted-output>\nOutput too large. Full output saved to: ${file}\n\nPreview (first 2KB):\n${retained}\n...\n</persisted-output>` : original;
  const rendered = wrap(payload);
  const snapshot: CcContextSnapshot = { session: "native-A", model: "claude-opus-5-5[1m]",
    messages: [{ role: "user", content: [{ type: "text", text: rendered }] }] };
  return { binding, db, identity, original, retained, rendered, snapshot, file };
}
const memoryTotal = (result: ReturnType<typeof ccContextEvidence>) => Object.values(result.memory!).reduce((a, b) => a + b, 0);
const body = `<knowledge>\n${"Durable knowledge. ".repeat(20)}\n</knowledge>\n<episodic>\nRecent facts (by Turn):\nF1 test\n\nRaw:\n[T1#E1] user: hello\n</episodic>`;

test.each([false, true])("full/preview carrier authenticates directly from current Messages (preview=%s)", preview => {
  const f = fixture(body, preview);
  const result = ccContextEvidence(f.binding, f.db, f.snapshot);
  expect(result.presence).toBe("confirmed");
  expect(result.estimatedMessagesTokens).toBe(tokens(f.rendered));
  expect(memoryTotal(result)).toBe(tokens(f.rendered));
  const offset = f.rendered.indexOf(f.retained), start = offset + f.retained.indexOf("<knowledge>");
  const close = f.retained.indexOf("\n</knowledge>");
  const end = offset + (close < 0 ? f.retained.length : close + "\n</knowledge>".length);
  expect(result.memory!.knowledge).toBe(tokens(f.rendered.slice(0, end)) - tokens(f.rendered.slice(0, start)));
  if (!preview) { expect(result.memory!.facts).toBeGreaterThan(0); expect(result.memory!.raw).toBeGreaterThan(0); }
});

test("deleted preview file uses verified header identity and the same retained-prefix classification", () => {
  const f = fixture(body, true);
  const before = ccContextEvidence(f.binding, f.db, f.snapshot);
  rmSync(f.file);
  expect(ccContextEvidence(f.binding, f.db, f.snapshot)).toEqual(before);
  expect(before.memory!.knowledge).toBeGreaterThan(0);
  // A directory at the advertised path is an I/O error, not permission to use identity-only mode.
  const invalidPath = f.rendered.replace(f.file, join(f.file, ".."));
  f.snapshot.messages[0]!.content[0]!.text = invalidPath;
  expect(ccContextEvidence(f.binding, f.db, f.snapshot).presence).toBe("unavailable");
});

test("readable original must verify digest and actual prefix, but omitted markers never affect classification", () => {
  const f = fixture(body, true);
  writeFileSync(f.file, f.original.replace("Durable", "altered"));
  expect(ccContextEvidence(f.binding, f.db, f.snapshot).presence).toBe("unavailable");
  writeFileSync(f.file, encodeCcInjection(f.identity, { text: "different", knowledgeCommitIds: [1] }));
  expect(ccContextEvidence(f.binding, f.db, f.snapshot).presence).toBe("unavailable");
  const ambiguousSuffix = fixture(`<knowledge>\n${"prefix ".repeat(200)}\n<knowledge>\nnot retained\n</knowledge>`, true);
  expect(ccContextEvidence(ambiguousSuffix.binding, ambiguousSuffix.db, ambiguousSuffix.snapshot).memory!.knowledge).toBeGreaterThan(0);
});

test.each([false, true])("renderer compact Raw is classified with facts=%s, including a Raw-only first section", withFacts => {
  const f = fixture(compactText({ facts: withFacts ? ["[F1] A fact"] : [],
    entries: [{ id: 1, view: "[T1#E1] user: retained Raw ".repeat(20) }], receipts: [] }));
  const result = ccContextEvidence(f.binding, f.db, f.snapshot);
  const start = f.rendered.indexOf("Raw:\n"), end = f.rendered.indexOf("\n</episodic>", start);
  expect(result.memory!.raw).toBe(tokens(f.rendered.slice(0, end)) - tokens(f.rendered.slice(0, start)));
  expect(result.memory!.raw).toBeGreaterThan(0);
  expect(result.memory!.facts > 0).toBe(withFacts);
});

test.each(["facts", "raw"] as const)("an unclosed preview %s section counts only its retained bytes", kind => {
  const material = kind === "facts" ? { facts: ["[F1] fact ".repeat(100)], receipts: [] }
    : { entries: [{ id: 1, view: "[T1#E1] user: Raw ".repeat(100) }], receipts: [] };
  const f = fixture(compactText(material), true);
  const result = ccContextEvidence(f.binding, f.db, f.snapshot);
  expect(result.presence).toBe("confirmed");
  expect(result.memory![kind]).toBeGreaterThan(0);
  expect(memoryTotal(result)).toBe(tokens(f.rendered));
});

test.each([false, true])("one native trailing newline is measured; additional suffix text is rejected (preview=%s)", preview => {
  const f = fixture(body, preview), baseline = ccContextEvidence(f.binding, f.db, f.snapshot);
  f.snapshot.messages[0]!.content[0]!.text = `${f.rendered}\n`;
  const result = ccContextEvidence(f.binding, f.db, f.snapshot);
  expect(result.memory!.knowledge).toBe(baseline.memory!.knowledge);
  expect(result.estimatedMessagesTokens).toBe(tokens(`${f.rendered}\n`));
  expect(memoryTotal(result)).toBe(tokens(`${f.rendered}\n`));
  f.snapshot.messages[0]!.content[0]!.text = `${f.rendered}\n\n`;
  expect(ccContextEvidence(f.binding, f.db, f.snapshot).presence).toBe("unavailable");
});

test("conversation, tool input/results, thinking and quoted lookalikes are counted but not classified as carriers", () => {
  const f = fixture(body);
  const quote = `User quoted ${f.rendered}`;
  f.snapshot.messages.push({ role: "assistant", content: [
    { type: "thinking", thinking: "careful" }, { type: "tool_use", id: "call", name: "read", input: { path: "a" } },
    { type: "text", text: f.rendered },
  ] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: f.rendered }] },
    { type: "text", text: quote }, { type: "text", text: f.original }] });
  const result = ccContextEvidence(f.binding, f.db, f.snapshot);
  expect(result.estimatedMessagesTokens).toBe(3 * tokens(f.rendered) + tokens("careful") + tokens("read" + JSON.stringify({ path: "a" })) + tokens(quote) + tokens(f.original));
  expect(memoryTotal(result)).toBe(tokens(f.rendered));
});

test.each([false, true])("database, current native identity, core identity and digest must verify (preview=%s)", preview => {
  const f = fixture(body, preview);
  for (const [before, after] of [[f.identity.db, "another-db"], ['"n":"native-A"', '"n":"native-old"'], ['"s":7', '"s":99']]) {
    const changed = structuredClone(f.snapshot);
    changed.messages[0]!.content[0]!.text = f.rendered.replace(before!, after!);
    expect(ccContextEvidence(f.binding, f.db, changed).presence).toBe("unavailable");
  }
  const changed = structuredClone(f.snapshot);
  changed.messages[0]!.content[0]!.text = f.rendered.replace("Durable", "changed");
  expect(ccContextEvidence(f.binding, f.db, changed).presence).toBe("unavailable");
});

test("every occurrence of a carrier occupies context and counts, repeats included", () => {
  // A resumed session keeps its earlier SessionStart carrier and receives a new one; unchanged
  // knowledge makes the two byte-identical, and both are in the context.
  for (const preview of [false, true]) {
    const f = fixture(body, preview);
    const once = ccContextEvidence(f.binding, f.db, f.snapshot);
    f.snapshot.messages.push({ role: "user", content: [{ type: "text", text: `${f.rendered}\n` }] });
    const twice = ccContextEvidence(f.binding, f.db, f.snapshot);
    expect(twice.presence).toBe("confirmed");
    expect(twice.memory!.knowledge).toBe(2 * once.memory!.knowledge);
    expect(memoryTotal(twice)).toBe(twice.estimatedMessagesTokens);
  }
});

test("source-free startup and replaced current context require no transcript evidence", () => {
  const f = fixture(body);
  expect(ccContextEvidence(f.binding, f.db, f.snapshot).memory!.knowledge).toBeGreaterThan(0);
  expect(ccContextEvidence(f.binding, f.db, { session: "native-A", messages: [{ role: "user", content: [{ type: "text", text: "Native compact summary" }] }] }).memory)
    .toEqual({ knowledge: 0, facts: 0, raw: 0, unclassified: 0 });
  expect(ccContextEvidence(f.binding, f.db, { ...f.snapshot, session: "native-B" }).presence).toBe("unavailable");
  expect(ccContextEvidence(f.binding, f.db, { ...f.snapshot, messages: Array(4096).fill(f.snapshot.messages[0]) }).presence).toBe("unavailable");
});

const image = (name: string, mime: string) => ({ type: "image", source: { type: "base64", media_type: mime,
  data: readFileSync(new URL(`./fixtures/cc82/${name}`, import.meta.url)).toString("base64") } });
for (const [name, mime, expected] of [["scan-1075x1520.png", "image/png", 2145], ["screenshot-3840x2160.jpg", "image/jpeg", 4784]] as const) {
  test.each([false, true])(`${mime} in user/tool-result content joins the denominator without changing memory (tool=%s)`, tool => {
    const f = fixture(body), block = image(name, mime);
    f.snapshot.messages[0]!.content.push(tool ? { type: "tool_result", tool_use_id: "call", content: [block] } : block);
    const result = ccContextEvidence(f.binding, f.db, f.snapshot);
    expect(result.presence).toBe("confirmed");
    expect(result.estimatedMessagesTokens).toBe(tokens(f.rendered) + expected);
    expect(memoryTotal(result)).toBe(tokens(f.rendered));
  });
}

test.each([false, true])("unreadable image or document in user/tool-result content remains unavailable (tool=%s)", tool => {
  const f = fixture(body);
  for (const block of [{ type: "image", source: { type: "base64", media_type: "image/png", data: "not-image" } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }]) {
    const snapshot = structuredClone(f.snapshot);
    snapshot.messages[0]!.content.push(tool ? { type: "tool_result", tool_use_id: "call", content: [block] } : block);
    expect(ccContextEvidence(f.binding, f.db, snapshot).presence).toBe("unavailable");
  }
});
