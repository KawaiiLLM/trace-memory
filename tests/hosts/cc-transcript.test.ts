import { afterEach, expect, test } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcTranscriptCursor, CcTranscriptScan, readCompleteTranscript, readTranscriptCreatedAt,
  readTranscriptTail, transcriptHead, type CcNativeRecord } from "../../src/hosts/cc/transcript.ts";
import { toSpecRecords } from "../fixtures/cc-ticket-52.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function transcript() {
  const dir = mkdtempSync(join(tmpdir(), "tm-cc-transcript-")); dirs.push(dir);
  return join(dir, "native.jsonl");
}

// Put a multibyte character across a byte-chunk boundary, then continue the line across more chunks.
function longRecord(): CcNativeRecord {
  const record = { ...toSpecRecords[0]!, message: { role: "user", content: "" } };
  const prefix = JSON.stringify(record).indexOf('"content":"') + '"content":"'.length;
  record.message.content = "x".repeat((1 << 20) - prefix - 1) + "界🙂" + "y".repeat(2 << 20);
  return record;
}

test("scan and tail preserve oversized UTF-8 records, byte offsets and an appended incomplete line", () => {
  const path = transcript(), first = longRecord(), second = toSpecRecords[1]!;
  const firstLine = JSON.stringify(first) + "\r\n", secondLine = JSON.stringify(second) + "\n";
  const partial = JSON.stringify({ ...first, uuid: "appended", parentUuid: second.uuid }).slice(0, -1);
  writeFileSync(path, "\n" + firstLine + secondLine + partial);
  const completeBytes = Buffer.byteLength("\n" + firstLine + secondLine);
  const cursor = new CcTranscriptCursor(), visited: string[] = [];
  const scan = cursor.scan(path, record => { visited.push(record.uuid!); }, true);
  expect(scan).toBeInstanceOf(CcTranscriptScan);
  if (!(scan instanceof CcTranscriptScan)) throw new Error("expected a scan");
  expect(scan.snapshot.records).toEqual([first, second]);
  expect(scan.problems).toEqual([]);
  expect(scan.lineCount).toBe(3);
  expect(scan.completeOffset).toBe(completeBytes);
  expect(scan.selectedLeafOffset).toBe(completeBytes);
  expect(scan.snapshot.incompleteBytes).toBe(Buffer.byteLength(partial));
  expect(visited).toEqual([first.uuid, second.uuid]);
  expect(readTranscriptTail(path, 0)).toEqual([first, second]);
  expect(readTranscriptTail(path, Buffer.byteLength("\n" + firstLine))).toEqual([second]);
  expect(transcriptHead(path, completeBytes).find(first.uuid!)).toEqual(first);
  expect(transcriptHead(path, completeBytes).last()).toEqual(second);
  expect(readTranscriptCreatedAt(path)).toBe(first.timestamp);
  cursor.commit(scan);
  appendFileSync(path, "}\n");
  const appended = cursor.scan(path, () => {}, true);
  expect(appended).toBeInstanceOf(CcTranscriptScan);
  if (!(appended instanceof CcTranscriptScan)) throw new Error("expected an appended scan");
  expect(appended.reset).toBe(false);
  expect(appended.snapshot.records).toEqual([{ ...first, uuid: "appended", parentUuid: second.uuid }]);
  expect(appended.completeOffset).toBe(completeBytes + Buffer.byteLength(partial) + 2);
  expect(appended.snapshot.incompleteBytes).toBe(0);
});

test("a boundary resolves a missing logical parent across chunks without changing the selected path", () => {
  const path = transcript(), first = longRecord(), second = toSpecRecords[1]!;
  const boundary = { uuid: "boundary", parentUuid: null, logicalParentUuid: "unwritten", type: "system", subtype: "compact_boundary" };
  writeFileSync(path, [first, second, boundary].map(record => JSON.stringify(record) + "\n").join(""));
  const scan = new CcTranscriptCursor().scan(path, () => {});
  expect(scan).toBeInstanceOf(CcTranscriptScan);
  if (!(scan instanceof CcTranscriptScan)) throw new Error("expected a scan");
  expect(scan.problems).toEqual([]);
  expect(scan.node("boundary")?.parentUuid).toBe(second.uuid);
  expect(scan.node("boundary")?.missingParent).toBe("unwritten");
});

test("completed invalid records keep their physical line number during the lazy boundary lookup", () => {
  const path = transcript();
  const boundary = { uuid: "boundary", parentUuid: null, logicalParentUuid: "unwritten", type: "system", subtype: "compact_boundary" };
  writeFileSync(path, "\n" + JSON.stringify(longRecord()) + "\n" + JSON.stringify(boundary) + "\n\n[]\n");
  expect(readCompleteTranscript(path).problem).toBe("invalid completed transcript record at line 5: expected an object");
  expect(() => readTranscriptTail(path, 0)).toThrow("invalid completed transcript record in the tail: expected an object");
});

test("reverse lookup parses only as far as requested and reports unreadable completed records", () => {
  const path = transcript(), record = longRecord(), line = JSON.stringify(record) + "\n";
  writeFileSync(path, "invalid\n" + line);
  const head = transcriptHead(path, Buffer.byteLength("invalid\n" + line));
  expect(head.last()).toEqual(record);
  expect(head.find(record.uuid!)).toEqual(record);
  expect(() => head.find("absent")).toThrow("invalid completed transcript record before the tail");
  expect(readTranscriptTail(path, Buffer.byteLength("invalid\n" + line) + 1)).toBeNull();
});
