import { appendFileSync, statSync } from 'node:fs';
const [, , log, slot] = process.argv;
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { transcript_path, source, session_id } = JSON.parse(input);
let stat;
try { const s = statSync(transcript_path); stat = { size: s.size, mtimeMs: s.mtimeMs }; }
catch (e) { if (e.code !== 'ENOENT') throw e; stat = null; }
appendFileSync(log, `${JSON.stringify({ slot, source, session_id, transcript_path, stat, at: Date.now() })}\n`);
