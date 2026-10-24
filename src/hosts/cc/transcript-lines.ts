import { readSync } from "node:fs";

const CHUNK_BYTES = 1 << 20;

/** Positional reads let a lazy second pass share the descriptor without moving another reader. */
export function* transcriptChunks(descriptor: number, start: number, end = Infinity, strict = false): Generator<Buffer> {
  while (start < end) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - start));
    let read = 0;
    while (read < chunk.length) {
      const amount = readSync(descriptor, chunk, read, chunk.length - read, start + read);
      if (!amount) {
        if (strict) throw new Error("native transcript changed while it was being read");
        if (read) yield chunk.subarray(0, read);
        return;
      }
      read += amount;
    }
    start += read;
    yield chunk;
  }
}

/** Decode only individual lines, joining byte fragments once when a line crosses chunks. */
export function* transcriptLines(chunks: Iterable<Buffer>, includeIncomplete = false): Generator<{ raw: string; bytes: number }> {
  let fragments: Buffer[] = [], pendingBytes = 0;
  for (const chunk of chunks) {
    let start = 0, newline: number;
    while ((newline = chunk.indexOf(0x0a, start)) >= 0) {
      const fragment = chunk.subarray(start, newline);
      const bytes = pendingBytes + fragment.length;
      const raw = fragments.length ? Buffer.concat([...fragments, fragment], bytes).toString("utf8") : fragment.toString("utf8");
      fragments = []; pendingBytes = 0;
      yield { raw, bytes: bytes + 1 };
      start = newline + 1;
    }
    if (start < chunk.length) {
      const fragment = chunk.subarray(start);
      fragments.push(fragment); pendingBytes += fragment.length;
    }
  }
  if (includeIncomplete && pendingBytes) yield { raw: Buffer.concat(fragments, pendingBytes).toString("utf8"), bytes: pendingBytes };
}
