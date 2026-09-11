import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Paint } from "./session-status.ts";

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
  private theme: Pick<Theme, "fg">;
  private kb: KeybindingsManager;
  private done: (value: string | undefined) => void;
  private refresh: () => void;
  constructor(body: SessionBody, actions: string[], height: () => number,
    theme: Pick<Theme, "fg">, kb: KeybindingsManager,
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
    else if (is("tui.select.confirm") || data === "\n") { this.done(this.actions[this.selected]); return; }
    else if (is("tui.select.pageUp")) this.offset = Math.max(0, this.offset - this.pageSize);
    else if (is("tui.select.pageDown")) this.offset = Math.min(this.maxOffset, this.offset + this.pageSize);
    this.list.setSelectedIndex(this.selected);
    this.refresh();
  }
  render(width: number): string[] {
    const height = Math.max(1, Math.floor(this.height()));
    const hint = (key: Parameters<KeybindingsManager["getKeys"]>[0]) => this.kb.getKeys(key).join("/");
    if (height < 3) return wrapTextWithAnsi(`Resize (3+ rows); ${hint("tui.select.cancel")} cancel`, width).slice(0, height);
    const help = wrapTextWithAnsi(`${hint("tui.select.up")}/${hint("tui.select.down")} navigate · ${hint("tui.select.confirm")} select · ${hint("tui.select.cancel")} cancel\n${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} scroll status`, width);
    // Keep a body row and the selected action even in very short terminals. At 24 rows
    // all original actions and help fit; the remaining rows belong to the scrollable body.
    const chrome = height >= 10 ? [this.theme.fg("accent", "Current session"), ...help.slice(0, 3).map(s => this.theme.fg("dim", s))] : [this.theme.fg("dim", `${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} · ${hint("tui.select.cancel")} cancel`)];
    const actionRows = Math.min(this.actions.length, Math.max(1, height - chrome.length - 5));
    this.pageSize = Math.max(1, height - chrome.length - actionRows);
    const lines = this.body(width, (color, text) => this.theme.fg(color, text)).split("\n");
    this.maxOffset = Math.max(0, lines.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maxOffset);
    const first = Math.min(this.selected, this.actions.length - actionRows);
    const menu = this.list.render(width).slice(first, first + actionRows);
    return [...chrome, ...lines.slice(this.offset, this.offset + this.pageSize), ...menu]
      .map(line => truncateToWidth(line, width, ""));
  }
  invalidate() { this.list.invalidate(); }
}
