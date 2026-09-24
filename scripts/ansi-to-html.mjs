#!/usr/bin/env node
// Ticket 82: a small, dependency-free ANSI-to-HTML converter for the rendered /trace menu samples
// (`tmux capture-pane -e` output), so each capture can be screenshotted to PNG for the maintainer's
// layout review. Only what the captures use: SGR reset/bold/dim, 24-bit and 256-color foregrounds.
import { readFileSync, writeFileSync } from "node:fs";

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Standard xterm 256-color palette: 0-15 basic, 16-231 a 6x6x6 cube, 232-255 a grayscale ramp.
const BASIC_16 = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
];
const cube = (n) => n === 0 ? 0 : 55 + n * 40;
function ansi256(n) {
  if (n < 16) return BASIC_16[n];
  if (n < 232) { const i = n - 16; const r = cube(Math.floor(i / 36)), g = cube(Math.floor((i / 6) % 6)), b = cube(i % 6); return `#${[r, g, b].map(c => c.toString(16).padStart(2, "0")).join("")}`; }
  const gray = 8 + (n - 232) * 10; return `#${gray.toString(16).padStart(2, "0").repeat(3)}`;
}

function renderLine(line) {
  let out = "", fg = null, bg = null, bold = false, dim = false, reverse = false;
  const openSpan = () => {
    const [f, b] = reverse ? [bg ?? "#0d1117", fg ?? "#d0d4dc"] : [fg, bg];
    const styles = [];
    if (f) styles.push(`color:${f}`);
    if (b) styles.push(`background:${b}`);
    if (bold) styles.push("font-weight:bold");
    if (dim) styles.push("opacity:0.6");
    return styles.length ? `<span style="${styles.join(";")}">` : "<span>";
  };
  let spanOpen = false;
  const flushText = (text) => {
    if (!text) return;
    if (!spanOpen) { out += openSpan(); spanOpen = true; }
    out += escapeHtml(text);
  };
  const closeSpan = () => { if (spanOpen) { out += "</span>"; spanOpen = false; } };

  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  while ((m = re.exec(line))) {
    flushText(line.slice(last, m.index));
    closeSpan();
    const params = m[1] ? m[1].split(";").map(Number) : [0];
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) { fg = null; bg = null; bold = false; dim = false; reverse = false; }
      else if (p === 1) bold = true;
      else if (p === 2) dim = true;
      else if (p === 7) reverse = true;
      else if (p === 22) { bold = false; dim = false; }
      else if (p === 27) reverse = false;
      else if (p === 39) fg = null;
      else if (p === 49) bg = null;
      else if (p === 38 && params[i + 1] === 2) { fg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`; i += 4; }
      else if (p === 38 && params[i + 1] === 5) { fg = ansi256(params[i + 2]); i += 2; }
      else if (p === 48 && params[i + 1] === 2) { bg = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`; i += 4; }
      else if (p === 48 && params[i + 1] === 5) { bg = ansi256(params[i + 2]); i += 2; }
      else if (p >= 30 && p <= 37) fg = BASIC_16[p - 30];
      else if (p >= 90 && p <= 97) fg = BASIC_16[p - 90 + 8];
      else if (p >= 40 && p <= 47) bg = BASIC_16[p - 40];
      else if (p >= 100 && p <= 107) bg = BASIC_16[p - 100 + 8];
    }
    last = re.lastIndex;
  }
  flushText(line.slice(last));
  closeSpan();
  return out || "&nbsp;";
}

function convert(ansiText, title) {
  const lines = ansiText.replace(/\r\n/g, "\n").split("\n");
  const body = lines.map(renderLine).map(l => `<div>${l}</div>`).join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  html,body { margin:0; padding:0; background:#0d1117; }
  pre.term { margin:0; padding:16px; background:#0d1117; color:#d0d4dc;
    font-family: "SF Mono", "Menlo", "Cascadia Code", monospace; font-size:14px; line-height:1.35;
    white-space:pre; display:inline-block; }
</style></head>
<body><pre class="term">
${body}
</pre></body></html>`;
}

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) { console.error("usage: ansi-to-html.mjs <in.ans> <out.html>"); process.exit(1); }
writeFileSync(outFile, convert(readFileSync(inFile, "utf8"), inFile));
console.log(`Wrote ${outFile}`);
