import type { ToolNames } from "../prompts/tool-names.ts";

/** The Dreamer's numbered refusals (127): a legal item commits at once and takes no number; a refused one takes `Mn`, keeps its
 * row, and blocks the run until a legal resubmission under its slot or a drop. `{}` is malformed. Private to one binding.
 * (The Noter no longer holds anything: it writes files, ticket 144.) */
export class Slots<T> {
  readonly rows = new Map<number, { raw: unknown; value?: T; error?: string }>();
  private next = 1;
  used = false;
  error?: string;
  private readonly names: ToolNames;
  private readonly fields: ReadonlySet<string>;
  constructor(names: ToolNames, fields: readonly string[]) {
    this.names = names; this.fields = new Set(fields);
  }
  id(value: unknown): number {
    const match = typeof value === "string" && /^M([1-9]\d*)$/.exec(value);
    if (!match || !this.rows.has(Number(match[1]))) throw new Error(`unknown M slot ${String(value)}`);
    return Number(match[1]);
  }
  call(raw: unknown, validate: (raw: unknown, id: number) => T,
    droppable: (id: number) => void, rejection?: string): string {
    const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const tool = this.names.memory;
    const unexpected = input ? Object.keys(input).filter(key => !this.fields.has(key)) : [];
    const invalid = !input || unexpected.length > 0 || !Object.keys(input).length ||
      ("drop" in input && (Object.keys(input).length !== 1 || typeof input.drop !== "string")) ||
      ("slot" in input && (typeof input.slot !== "string" || Object.keys(input).length === 1));
    if (invalid) {
      this.error = rejection ?? `${tool} expects one item, one scalar drop${unexpected.length ? `; ${unexpected.map(key => `${key}: unexpected field`).join("; ")}` : ""}`;
      if (input && "slot" in input) {
        try { const id = this.id(input.slot); const { slot: _slot, ...content } = input;
          this.rows.set(id, { raw: structuredClone(content), error: this.error }); }
        catch { /* Unknown handles cannot invalidate an accepted slot. */ }
      }
      return `rejected: ${this.error}`;
    }
    this.used = true;
    this.error = undefined;
    const results: string[] = [];
    let receipt: object = {};
    if ("drop" in input) {
      try { const id = this.id(input.drop); if (rejection) throw new Error(rejection);
        droppable(id); this.rows.delete(id); results.push(`dropped: ${input.drop}`); }
      catch (error) { this.error = error instanceof Error ? error.message : String(error); results.push(`rejected: ${input.drop}: ${this.error}`); }
    } else {
      // 0: a fresh item is numbered only if refused.
      let id: number | undefined;
      try { id = input.slot !== undefined ? this.id(input.slot) : 0; }
      catch (error) { this.error = error instanceof Error ? error.message : String(error); results.push(`rejected: ${this.error}`); }
      if (id !== undefined) {
        const { slot: _slot, ...content } = input;
        const row: { raw: unknown; value?: T; error?: string } = { raw: structuredClone(content) };
        if (id) this.rows.set(id, row);
        try { if (rejection) throw new Error(rejection); row.value = validate(content, id);
          this.rows.delete(id); results.push("ok"); receipt = row.value as object; }
        catch (error) { row.error = error instanceof Error ? error.message : String(error);
          if (!id) this.rows.set(id = this.next++, row);
          results.push(`rejected: M${id}: ${row.error}`); }
      }
    }
    const rejected = Object.fromEntries([...this.rows].filter(([, row]) => row.error).map(([id, row]) => [`M${id}`, row.error]));
    return JSON.stringify({ results, ...receipt, ...Object.keys(rejected).length ? { rejected } : {} });
  }
  problems(): string[] {
    return [...(this.error ? [this.error] : []), ...[...this.rows].flatMap(([id, row]) => row.error ? [`M${id}: ${row.error}`] : [])];
  }
}
