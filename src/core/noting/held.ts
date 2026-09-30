import { prepareMemory } from "../knowledge-write/prepare.ts";
import { KnowledgeVersionProblem, type FactCommitInput, type KnowledgePath, type RunInput, type Store } from "../store/index.ts";
import { canonicalToolNames, type ToolNames } from "../prompts/tool-names.ts";

/** Private to a single N binding. Tombstones preserve handle identity; invalid replacements
 * deliberately remove the old accepted value. No database IDs exist before publication. */
class Slots<T> {
  readonly rows = new Map<number, { raw: unknown; value?: T; error?: string }>();
  private next = 1;
  used = false;
  error?: string;
  readonly prefix: "$" | "M";
  private readonly names: ToolNames;
  constructor(prefix: "$" | "M", names: ToolNames) { this.prefix = prefix; this.names = names; }
  id(value: unknown): number {
    const match = typeof value === "string" && (this.prefix === "$" ? /^\$([1-9]\d*)$/ : /^M([1-9]\d*)$/).exec(value);
    if (!match || !this.rows.has(Number(match[1]))) throw new Error(`unknown ${this.prefix} slot ${String(value)}`);
    return Number(match[1]);
  }
  call(raw: unknown, field: "facts" | "operations", validate: (raw: unknown, id: number) => T,
    droppable: (id: number) => void, rejection?: string): string {
    const input = raw as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input[field]) ||
        Object.keys(input).some(key => ![field, "drop", ...(field === "operations" ? ["skipped"] : [])].includes(key)) ||
        (input.drop !== undefined && (!Array.isArray(input.drop) || input.drop.some(id => typeof id !== "string"))) ||
        (field === "operations" && (!Array.isArray(input.skipped) || input.skipped.length))) {
      this.error = `${this.names[field === "facts" ? "note" : "memory"]} expects ${field}, optional drop${field === "operations" ? ", and skipped: []" : ""}`;
      // A refused envelope still withdraws explicitly named replacement values. Do not
      // allocate append slots or apply drops from a call whose structure was refused.
      for (const item of Array.isArray(input?.[field]) ? input[field] as unknown[] : []) {
        if (!item || typeof item !== "object" || Array.isArray(item) || !("slot" in item)) continue;
        let id: number;
        try { id = this.id(item.slot); }
        catch { continue; } // Unknown handles have no accepted value to invalidate.
        const { slot: _slot, ...content } = item;
        this.rows.set(id, { raw: structuredClone(content), error: this.error });
      }
      return `rejected: ${this.error}`;
    }
    // Only a structurally valid call clears a top-level error. It cannot clear slot errors.
    this.used = true; this.error = undefined;
    const results: string[] = [];
    for (const address of rejection ? [] : input.drop as string[] ?? []) {
      try { const id = this.id(address); droppable(id); this.rows.delete(id); results.push(`dropped: ${address}`); }
      catch (error) { this.error = String(error); results.push(`rejected: ${address}: ${this.error}`); }
    }
    for (const raw of input[field] as unknown[]) {
      const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
      let id: number;
      try { id = item?.slot === undefined ? this.next++ : this.id(item.slot); }
      catch (error) { this.error = String(error); results.push(`rejected: ${this.error}`); continue; }
      const { slot: _slot, ...content } = item ?? {};
      const row: { raw: unknown; value?: T; error?: string } = { raw: structuredClone(content) };
      this.rows.set(id, row);
      try { if (rejection) throw new Error(rejection); row.value = validate(content, id); results.push(`held: ${this.prefix}${id}`); }
      catch (error) { row.error = error instanceof Error ? error.message : String(error); results.push(`rejected: ${this.prefix}${id}: ${row.error}`); }
    }
    if (rejection && !(input[field] as unknown[]).length) this.error = rejection;
    return JSON.stringify({ results, held: [...this.rows].filter(([, row]) => row.value !== undefined).map(([id]) => `${this.prefix}${id}`),
      rejected: Object.fromEntries([...this.rows].filter(([, row]) => row.error).map(([id, row]) => [`${this.prefix}${id}`, row.error])) });
  }
  problems(): string[] {
    return [...(this.error ? [this.error] : []), ...[...this.rows].flatMap(([id, row]) => row.error ? [`${this.prefix}${id}: ${row.error}`] : [])];
  }
}

export function holdNoting(store: Store, run: RunInput, path: KnowledgePath,
  validateFact: (raw: unknown, slot: number, earlier: (slot: number) => boolean) => FactCommitInput,
  names: ToolNames = canonicalToolNames) {
  const facts = new Slots<FactCommitInput>("$", names), operations = new Slots<unknown>("M", names);
  const fact = (raw: unknown, id: number) => validateFact(raw, id,
    target => target < id && facts.rows.get(target)?.value !== undefined);
  const prepare = (raw: unknown, mapping?: ReadonlyMap<number, number>) => {
    const value = structuredClone(raw) as Record<string, unknown>;
    if (mapping && Array.isArray(value.supports)) value.supports = value.supports.map(ref => {
      if (typeof ref !== "string" || !/^\$[1-9]\d*$/.test(ref)) return ref;
      const id = mapping.get(Number(ref.slice(1)));
      if (!id) throw new Error(`unavailable local fact ${ref}`);
      return `F${id}`;
    });
    const locals = new Map([...facts.rows].flatMap(([id, row]) => row.value ? [[id, row.value] as const] : []));
    const result = prepareMemory(store, path.sessionId, { operations: [value], skipped: [] }, run,
      path, undefined, undefined, mapping ? undefined : locals, names);
    const errors = result.results.filter(line => line.startsWith("rejected:"));
    if (errors.length) throw new Error(errors.join("; "));
    const requested = result.operations[0]!;
    try {
      // At publication Store classifies under the same transaction immediately before applying.
      // Staging needs that classification now, but cannot freeze its result for later use.
      if (!mapping) store.normalizeNotingOperation(requested, path);
      return requested;
    } catch (error) {
      if (error instanceof KnowledgeVersionProblem) throw new Error(error.describe(id => `K${id}`));
      throw error;
    }
  };
  const memory = (raw: unknown) => operations.call(raw, "operations", (value, id) => {
    prepare(value);
    const target = (value as { id?: string }).id;
    if (target && [...operations.rows].some(([other, row]) => other !== id && row.value !== undefined && (row.value as { id?: string }).id === target))
      throw new Error("duplicate operation target; replace its existing M slot instead");
    return value;
  }, () => {});
  const note = (raw: unknown) => facts.call(raw, "facts", fact, id => {
    const address = `$${id}`;
    if ([...facts.rows].some(([other, row]) => other !== id && row.value &&
        [...row.value.support ?? [], ...row.value.negate ?? []].some(rel => rel.target === address)) ||
        [...operations.rows.values()].some(row => {
          const supports = (row.raw as { supports?: unknown }).supports;
          return Array.isArray(supports) && supports.includes(address);
        })) throw new Error(`cannot drop referenced fact ${address}`);
  });
  const problems = () => [...facts.problems(), ...operations.problems()];
  const incomplete = () => !facts.used || !operations.used;
  const status = (toolProblems: ReadonlyMap<string, string>): string => {
    const blockers: string[] = [];
    for (const [name, slots] of [["note", facts], ["memory", operations]] as const) {
      const exposed = names[name];
      if (!slots.used) blockers.push(`${exposed} not called; call ${exposed}${name === "note" ? "({facts: []})" : "({operations: [], skipped: []})"}`);
      if (slots.error) blockers.push(`${exposed} call error: ${slots.error}; make a structurally valid ${exposed} call to clear it`);
      for (const [id, row] of slots.rows) if (row.error) {
        const address = `${slots.prefix}${id}`;
        blockers.push(`${address}: ${row.error}; resubmit with slot: "${address}" or drop: ["${address}"] (drop may be refused if referenced)`);
      }
      // A wrapper failure can block publication even when the held layer has no error.
      if (toolProblems.has(name) && !slots.problems().length)
        blockers.push(`${exposed} call error: ${toolProblems.get(name)}; make a structurally valid ${exposed} call to clear it`);
    }
    return blockers.length
      ? `Not publishable: ${blockers.join("; ")}. Ending now publishes nothing.`
      : "Publishable: current submission requirements are met; ending normally attempts to publish facts and knowledge together (not a commit guarantee).";
  };
  const validate = () => {
    if (incomplete()) throw new Error(`incomplete Noting: explicitly call both ${names.note} and ${names.memory}, including empty arrays`);
    if (problems().length) throw new Error(problems().join("; "));
    // Recheck the final sources/content, including facts cited before a later correction.
    for (const [id, row] of facts.rows) row.value = fact(row.raw, id);
  };
  return { note, memory, problems, incomplete, status, validate,
    reject: (name: "note" | "memory", raw: unknown, reason: string) => name === "note"
      ? facts.call(raw, "facts", fact, () => {}, reason)
      : operations.call(raw, "operations", value => value, () => {}, reason),
    facts: () => [...facts.rows.values()].map(row => row.value!),
    slots: () => [...facts.rows.keys()],
    knowledge: (mapping: ReadonlyMap<number, number>) => {
      const result = [...operations.rows.values()].map(row => prepare(row.raw, mapping));
      const touched = new Set<number>();
      for (const operation of result) if (operation.op !== "create" && "baseCommit" in operation) {
        if (touched.has(operation.baseCommit)) throw new Error("duplicate operation target");
        touched.add(operation.baseCommit);
      }
      return result;
    },
    audit: (mapping: ReadonlyMap<number, number>) => ({
      factMapping: Object.fromEntries([...mapping].map(([slot, id]) => [`$${slot}`, `F${id}`])),
      operations: [...operations.rows].map(([slot, row]) => ({ slot: `M${slot}`, original: row.raw })),
    }),
  };
}
