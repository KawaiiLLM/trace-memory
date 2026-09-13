import { Theme, type ExtensionContext, type KeybindingsManager, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { CONTEXT_PALETTE, type Paint, type PaletteColor } from "./session-status.ts";

const paletteToken: Record<PaletteColor, ThemeColor> = {
  system: "syntaxKeyword", tools: "syntaxFunction", skills: "syntaxString",
  knowledge: "syntaxVariable", facts: "syntaxNumber", raw: "syntaxOperator",
  conversation: "syntaxType", other: "syntaxComment", free: "dim",
};
const fallback = CONTEXT_PALETTE.free;
const paletteForegrounds = {
  accent: fallback, border: fallback, borderAccent: fallback, borderMuted: fallback,
  success: fallback, error: fallback, warning: fallback, muted: fallback, dim: CONTEXT_PALETTE.free,
  text: fallback, thinkingText: fallback, scrollbarTrack: fallback, scrollbarThumb: fallback,
  searchMatchText: fallback, userMessageText: fallback, customMessageText: fallback,
  customMessageLabel: fallback, toolTitle: fallback, toolOutput: fallback,
  mdHeading: fallback, mdLink: fallback, mdLinkUrl: fallback, mdCode: fallback,
  mdCodeBlock: fallback, mdCodeBlockBorder: fallback, mdQuote: fallback, mdQuoteBorder: fallback,
  mdHr: fallback, mdListBullet: fallback, toolDiffAdded: fallback, toolDiffRemoved: fallback,
  toolDiffContext: fallback, syntaxComment: CONTEXT_PALETTE.other,
  syntaxKeyword: CONTEXT_PALETTE.system, syntaxFunction: CONTEXT_PALETTE.tools,
  syntaxVariable: CONTEXT_PALETTE.knowledge, syntaxString: CONTEXT_PALETTE.skills,
  syntaxNumber: CONTEXT_PALETTE.facts, syntaxType: CONTEXT_PALETTE.conversation,
  syntaxOperator: CONTEXT_PALETTE.raw, syntaxPunctuation: fallback,
  thinkingOff: fallback, thinkingMinimal: fallback, thinkingLow: fallback,
  thinkingMedium: fallback, thinkingHigh: fallback, thinkingXhigh: fallback,
  thinkingMax: fallback, bashMode: fallback,
} satisfies ConstructorParameters<typeof Theme>[0];
const paletteBackgrounds = {
  selectedBg: "", searchMatchBg: "", userMessageBg: "", customMessageBg: "",
  toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "",
} satisfies ConstructorParameters<typeof Theme>[1];
const isPaletteColor = (color: Parameters<Paint>[0]): color is PaletteColor => color in CONTEXT_PALETTE;

/** Use Pi's public Theme encoder so the fixed data palette follows host truecolor/256-color mode. */
export function createSessionPaint(theme: Pick<Theme, "fg" | "getFgAnsi" | "getColorMode">): Paint {
  const palette = new Theme(paletteForegrounds, paletteBackgrounds, theme.getColorMode());
  return (color, text) => isPaletteColor(color)
    ? `${palette.getFgAnsi(paletteToken[color])}${text}${theme.getFgAnsi("dim")}`
    : theme.fg(color, text);
}

/** One read-only snapshot. Reflow and paging never go back to the database. */
export type SessionBody = (width: number, paint?: Paint) => string;

/** Only this panel uses a screen-sized overlay: editor-dock height is not terminal height.
 * Pi composites this overlay after fullscreen's dock layout (and after regular scrollback).
 * With zero margins and 100% maxHeight, its exact available height is terminal.rows.
 */
export function showSessionPanel(ctx: ExtensionContext, body: SessionBody, actions: string[]) {
  return ctx.ui.custom<string | undefined>((tui, theme, kb, done) =>
    new SessionPanel(body, actions, () => tui.terminal.rows, theme, kb, done, () => tui.requestRender()),
  { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "top-left" } });
}

export class SessionPanel implements Component {
  private selected = 0;
  private offset = 0;
  private pageSize = 1;
  private maxOffset = 0;
  private list: SelectList;
  private body: SessionBody;
  private actions: string[];
  private height: () => number;
  private theme: Pick<Theme, "fg" | "getFgAnsi" | "getColorMode">;
  private kb: KeybindingsManager;
  private done: (value: string | undefined) => void;
  private refresh: () => void;
  constructor(body: SessionBody, actions: string[], height: () => number,
    theme: Pick<Theme, "fg" | "getFgAnsi" | "getColorMode">, kb: KeybindingsManager,
    done: (value: string | undefined) => void, refresh: () => void) {
    this.body = body; this.actions = actions; this.height = height; this.theme = theme;
    this.kb = kb; this.done = done; this.refresh = refresh;
    const accent = (s: string) => this.theme.fg("accent", s);
    this.list = new SelectList(actions.map(value => ({ value, label: value })), actions.length, {
      selectedPrefix: accent, selectedText: accent, description: s => this.theme.fg("muted", s),
      scrollInfo: s => this.theme.fg("dim", s), noMatch: s => this.theme.fg("warning", s),
    });
  }
  handleInput(data: string) {
    const is = (key: Parameters<KeybindingsManager["matches"]>[1]) => this.kb.matches(data, key);
    if (is("tui.select.cancel")) { this.done(undefined); return; }
    if (this.height() < 3) return; // Even before a resize redraw, do not accept hidden actions.
    if (is("tui.select.up") || data === "k") this.selected = Math.max(0, this.selected - 1);
    else if (is("tui.select.down") || data === "j") this.selected = Math.min(this.actions.length - 1, this.selected + 1);
    else if (is("tui.select.confirm")) { this.done(this.actions[this.selected]); return; }
    else if (is("tui.select.pageUp")) this.offset = Math.max(0, this.offset - this.pageSize);
    else if (is("tui.select.pageDown")) this.offset = Math.min(this.maxOffset, this.offset + this.pageSize);
    this.list.setSelectedIndex(this.selected);
    this.refresh();
  }
  render(width: number): string[] {
    const height = Math.max(1, Math.floor(this.height()));
    const hint = (key: Parameters<KeybindingsManager["getKeys"]>[0]) => this.kb.getKeys(key).join("/") || "disabled";
    if (height < 3) {
      const lines = wrapTextWithAnsi(`Resize (3+ rows); ${hint("tui.select.cancel")} cancel`, width).slice(0, height);
      return [...lines, ...Array(height - lines.length).fill("")];
    }
    const help = wrapTextWithAnsi(`${hint("tui.select.up")}/${hint("tui.select.down")} Select | ${hint("tui.select.confirm")} Open | ${hint("tui.select.cancel")} Back`, width);
    const lines = this.body(width, createSessionPaint(this.theme)).split("\n");
    if (height >= 10 && lines.length > height - 1 - help.length - this.actions.length)
      help.push(...wrapTextWithAnsi(`${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} Scroll`, width));
    // Keep a body row and the selected action even in very short terminals. At 24 rows
    // all original actions and help fit; the remaining rows belong to the scrollable body.
    const chrome = height >= 10 ? [this.theme.fg("accent", "Current session"), ...help.slice(0, 3).map(s => this.theme.fg("dim", s))] : [this.theme.fg("dim", `${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} · ${hint("tui.select.cancel")} cancel`)];
    const actionRows = Math.min(this.actions.length, Math.max(1, height - chrome.length - 5));
    this.pageSize = Math.max(1, height - chrome.length - actionRows);
    this.maxOffset = Math.max(0, lines.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maxOffset);
    const first = Math.min(this.selected, this.actions.length - actionRows);
    const menu = this.list.render(width).slice(first, first + actionRows);
    const rendered = [...chrome, ...lines.slice(this.offset, this.offset + this.pageSize), ...menu]
      .map(line => truncateToWidth(line, width, ""));
    // The public compositor already pads each rendered row to the overlay width.
    // Supply every viewport row so no base content remains vertically exposed.
    return [...rendered, ...Array(height - rendered.length).fill("")];
  }
  invalidate() { this.list.invalidate(); }
}
