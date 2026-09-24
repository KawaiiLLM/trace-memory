import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokens } from "../../src/core/render/tokens.ts";
import { compactText } from "../../src/core/render/material.ts";
import { ccContextEvidence, type CcContextSnapshot } from "../../src/hosts/cc/menu-context.ts";
import { databaseIdentity, encodeCcInjection } from "../../src/hosts/cc/injection.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";
import type { CcSessionBinding } from "../../src/hosts/cc/binding.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function fixture(body: string, preview = false, warned = false) {
  const dir = mkdtempSync(join(tmpdir(), "tm-82-context-")); dirs.push(dir);
  const db = join(dir, "db"); writeFileSync(db, "db");
  const binding = { nativeSessionId: "native-A", coreSessionId: 7 } as CcSessionBinding;
  const original = encodeCcInjection({ db: databaseIdentity(db), nativeSession: "native-A", coreSession: 7 },
    { text: body, knowledgeCommitIds: [1] });
  const captured = preview ? original.slice(0, 250) : original;
  const nativePreview = preview ? `<persisted-output>\nOutput too large. Full output saved to: /not/read\n\nPreview (first 2KB):\n${captured}\n...\n</persisted-output>` : original;
  const rendered = `<system-reminder>\nSessionStart hook additional context: ${nativePreview}\n</system-reminder>`;
  const records: CcNativeRecord[] = [
    { type: "attachment", uuid: "success", parentUuid: null, attachment: { type: "hook_success", hookEvent: "SessionStart",
      stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: original } }) } },
    ...(warned ? [{ type: "attachment", uuid: "warning", parentUuid: "success", attachment: { type: "hook_system_message", hookEvent: "SessionStart" } }] : []),
    { type: "attachment", uuid: "carrier", parentUuid: warned ? "warning" : "success", attachment: {
      type: "hook_additional_context", hookEvent: "SessionStart", content: [nativePreview],
    }, rendered: [{ content: rendered }] },
    { type: "user", uuid: "user", parentUuid: "carrier", promptSource: "typed", message: { role: "user", content: "hello" } },
    { type: "assistant", uuid: "answer", parentUuid: "user", message: { role: "assistant", content: [{ type: "text", text: "yes" }] } },
  ];
  const snapshot: CcContextSnapshot = { session: "native-A", messages: [{ role: "user", content: [{ type: "text", text: rendered }] }] };
  return { records, binding, db, original, rendered, snapshot };
}

test.each([[false, false], [true, true]])("authenticates retained %s preview with warning=%s and conserves its measured Messages", (preview, warned) => {
  const f = fixture(`<knowledge>\nSome durable knowledge.\n</knowledge>\n<episodic>\nRecent facts (by Turn):\nF1 test\n\nRaw:\n[T1#E1] user: hello\n</episodic>`, preview, warned);
  const result = ccContextEvidence(f.records, f.binding, f.db, f.snapshot);
  expect(result.presence).toBe("confirmed");
  expect(result.estimatedMessagesTokens).toBe(tokens(f.rendered));
  expect(Object.values(result.memory!).reduce((a, b) => a + b, 0)).toBe(tokens(f.rendered));
  const start = f.rendered.indexOf(f.original.slice(0, preview ? 250 : f.original.length));
  const knowledgeAt = start + f.original.indexOf("<knowledge>");
  const knowledgeEnd = start + f.original.indexOf("\n</knowledge>") + "\n</knowledge>".length;
  const retainedEnd = preview ? start + 250 : f.rendered.length;
  const expectedKnowledge = tokens(f.rendered.slice(0, Math.min(knowledgeEnd, retainedEnd))) - tokens(f.rendered.slice(0, knowledgeAt));
  expect(result.memory!.knowledge).toBe(expectedKnowledge);
  if (!preview) { expect(result.memory!.facts).toBeGreaterThan(0); expect(result.memory!.raw).toBeGreaterThan(0); }
});

test.each([false, true])("renderer-produced compact Raw is measured with facts=%s, including a Raw-only first section", withFacts => {
  const body = compactText({ facts: withFacts ? ["[F1] A fact"] : [],
    entries: [{ id: 1, view: "[T1#E1] user: retained Raw ".repeat(20) }], receipts: [] });
  const f = fixture(body);
  const result = ccContextEvidence(f.records, f.binding, f.db, f.snapshot);
  expect(result.presence).toBe("confirmed");
  const start = f.rendered.indexOf("Raw:\n"), end = f.rendered.indexOf("\n</episodic>", start);
  expect(result.memory!.raw).toBe(tokens(f.rendered.slice(0, end)) - tokens(f.rendered.slice(0, start)));
  expect(result.memory!.raw).toBeGreaterThan(0);
  expect(result.memory!.facts > 0).toBe(withFacts);
});

test.each([false, true])("native Messages may append one newline to a recorded carrier (preview=%s)", preview => {
  const f = fixture(`<knowledge>\n${"真实记忆".repeat(100)}\n</knowledge>`, preview);
  const baseline = ccContextEvidence(f.records, f.binding, f.db, f.snapshot);
  const actual = `${f.rendered}\n`;
  const snapshot: CcContextSnapshot = { session: "native-A", messages: [{ role: "user", content: [{ type: "text", text: actual }] }] };
  const result = ccContextEvidence(f.records, f.binding, f.db, snapshot);
  expect(result.presence).toBe("confirmed");
  expect(result.memory!.knowledge).toBe(baseline.memory!.knowledge);
  expect(result.estimatedMessagesTokens).toBe(tokens(actual));
  expect(Object.values(result.memory!).reduce((a, b) => a + b, 0)).toBe(tokens(actual));
  snapshot.messages[0]!.content[0]!.text = `${actual}\n`;
  expect(ccContextEvidence(f.records, f.binding, f.db, snapshot).presence).toBe("unavailable");
});

test("ordinary conversation, tool input/results and thinking use existing text estimator; quoted lookalikes are not memory", () => {
  const f = fixture("<knowledge>\nactual\n</knowledge>");
  const quotation = `User quoted ${f.rendered}`;
  f.snapshot.messages.push({ role: "assistant", content: [
    { type: "thinking", thinking: "careful" }, { type: "tool_use", id: "call", name: "read", input: { path: "a" } },
  ] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: "result" }] },
    { type: "text", text: quotation }] });
  const result = ccContextEvidence(f.records, f.binding, f.db, f.snapshot);
  expect(result.estimatedMessagesTokens).toBe(tokens(f.rendered) + tokens("careful") + tokens("read" + JSON.stringify({ path: "a" })) + tokens("result") + tokens(quotation));
  expect(Object.values(result.memory!).reduce((a, b) => a + b, 0)).toBe(tokens(f.rendered));
});

test("a fresh native hook before any source reply still identifies its authenticated carrier", () => {
  const f = fixture("<knowledge>\nFresh source-free memory\n</knowledge>");
  expect(ccContextEvidence(f.records.slice(0, 2), f.binding, f.db, f.snapshot).memory!.knowledge).toBeGreaterThan(0);
});

test("native compaction replaces old carriers using preservation metadata, not physical transcript history", () => {
  const f = fixture("<knowledge>\nOld memory removed by native compact\n</knowledge>");
  const original = encodeCcInjection({ db: databaseIdentity(f.db), nativeSession: "native-A", coreSession: 7 },
    { text: "<knowledge>\nOnly the new compact carrier remains\n</knowledge>", knowledgeCommitIds: [2] });
  const rendered = `<system-reminder>\nSessionStart hook additional context: ${original}\n</system-reminder>`;
  f.records.push(
    { type: "system", subtype: "compact_boundary", uuid: "boundary", parentUuid: null, logicalParentUuid: "answer",
      compactMetadata: { preservedSegment: { headUuid: "user", anchorUuid: "summary", tailUuid: "answer" },
        preservedMessages: { anchorUuid: "summary", uuids: ["user", "answer"] } } },
    { type: "user", uuid: "summary", parentUuid: "boundary", isCompactSummary: true,
      message: { role: "user", content: "Native summary" } },
    { type: "attachment", uuid: "new-success", parentUuid: "summary", attachment: { type: "hook_success",
      hookEvent: "SessionStart", stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: original } }) } },
    { type: "attachment", uuid: "new-carrier", parentUuid: "new-success", attachment: { type: "hook_additional_context",
      hookEvent: "SessionStart", content: [original] }, rendered: [{ content: rendered }] },
    { type: "user", uuid: "next", parentUuid: "new-carrier", promptSource: "typed", message: { role: "user", content: "continue" } },
  );
  const snapshot: CcContextSnapshot = { session: "native-A", messages: [{ role: "user", content: [
    { type: "text", text: "Native summary" }, { type: "text", text: rendered },
  ] }] };
  const result = ccContextEvidence(f.records, f.binding, f.db, snapshot);
  expect(result.presence).toBe("confirmed");
  expect(Object.values(result.memory!).reduce((a, b) => a + b, 0)).toBe(tokens(rendered));
  expect(result.estimatedMessagesTokens).toBe(tokens(rendered) + tokens("Native summary"));
  // An old physical-file attachment has no retained occurrence authority.
  expect(ccContextEvidence(f.records, f.binding, f.db, f.snapshot).presence).toBe("unavailable");
  const broken = structuredClone(f.records);
  (broken.find(row => row.uuid === "boundary")!.compactMetadata as { preservedMessages: { uuids: string[] } }).preservedMessages.uuids.push("missing");
  expect(ccContextEvidence(broken, f.binding, f.db, snapshot).presence).toBe("unavailable");
});

test("a retained native carrier absent from the current snapshot is excluded; foreign, duplicated, unsupported or capped snapshots never claim a split", () => {
  const f = fixture("<knowledge>\nactual\n</knowledge>");
  expect(ccContextEvidence(f.records, f.binding, f.db, { session: "native-A", messages: [{ role: "user", content: [{ type: "text", text: "ordinary conversation without the carrier" }] }] }).memory)
    .toEqual({ knowledge: 0, facts: 0, raw: 0, unclassified: 0 });
  expect(ccContextEvidence(f.records, f.binding, f.db, { ...f.snapshot, session: "native-B" }).presence).toBe("unavailable");
  expect(ccContextEvidence(f.records, f.binding, f.db, { session: "native-A", messages: Array(4096).fill(f.snapshot.messages[0]) }).presence).toBe("unavailable");
  expect(ccContextEvidence(f.records, f.binding, f.db, { session: "native-A", messages: [...f.snapshot.messages, ...f.snapshot.messages] }).presence).toBe("unavailable");
  expect(ccContextEvidence(f.records, f.binding, f.db, { session: "native-A", messages: [{ role: "user", content: [{ type: "image", source: { data: "base64" } }] }] }).presence).toBe("unavailable");
  const tampered = structuredClone(f.records);
  (tampered[0]!.attachment as { stdout: string }).stdout = (tampered[0]!.attachment as { stdout: string }).stdout.replace("actual", "tampered");
  expect(ccContextEvidence(tampered, f.binding, f.db, f.snapshot).presence).toBe("unavailable");
});
