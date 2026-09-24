#!/usr/bin/env node
// Ticket 82: renders Pi's `/trace` menu samples for the maintainer's layout review, from the shared
// fixture (`src/hosts/trace-menu.ts`) through Pi's renderer (`src/hosts/pi/trace-menu-view.ts`). Not
// wired into the live panel; this is the checkpoint deliverable ("rendered sample on each host").
import { writeFileSync, mkdirSync } from "node:fs";
import { CONTEXT_PALETTE, type PaletteColor } from "../src/hosts/pi/session-status.ts";
import { renderTraceMenu, renderTraceSettings, type Paint } from "../src/hosts/pi/trace-menu-view.ts";
import {
  TRACE_MENU_FIXTURE, TRACE_MENU_FIXTURE_WITH_NOTICE, TRACE_SETTINGS_FIXTURE,
} from "../src/hosts/trace-menu.ts";

const OTHER_ROLES: Record<string, string> = { accent: "#5fb3f0", dim: "#63707b", muted: "#8a8f98" };
const hexToRgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const paint: Paint = (color, text) => {
  const hex = (CONTEXT_PALETTE as Record<string, string>)[color] ?? OTHER_ROLES[color] ?? "#d0d4dc";
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
};

const outDir = "/tmp/cc82-samples";
mkdirSync(outDir, { recursive: true });
const write = (name: string, lines: string[]) => writeFileSync(`${outDir}/${name}`, `${lines.join("\n")}\n`);

write("pi-main.ans", renderTraceMenu(TRACE_MENU_FIXTURE, 120, paint));
write("pi-main-notice.ans", renderTraceMenu(TRACE_MENU_FIXTURE_WITH_NOTICE, 120, paint));
write("pi-settings.ans", renderTraceSettings(TRACE_SETTINGS_FIXTURE, 120, paint));
write("pi-narrow.ans", renderTraceMenu(TRACE_MENU_FIXTURE, 18, paint));
console.log(`Wrote pi-main.ans, pi-main-notice.ans, pi-settings.ans, pi-narrow.ans under ${outDir}`);
