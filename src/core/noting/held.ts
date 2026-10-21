import { prepareMemory } from "../knowledge-write/prepare.ts";
import { KnowledgeVersionProblem, type FactCommitInput, type KnowledgeOperationInput, type KnowledgePath, type RunInput, type Store } from "../store/index.ts";
import { renderKnowledgeDiff } from "../render/index.ts";
import { canonicalToolNames, type ToolNames } from "../prompts/tool-names.ts";

/** Private to a single N binding. Tombstones preserve handle identity; invalid replacements
 * deliberately remove the old accepted value. No database IDs exist before publication.
 * 127: an `immediate` writer (D) commits each legal item at once, so only a refused item takes
 * a number and keeps its row until a legal resubmission under its slot or a drop; `{}` is malformed. */
export class Slots<T> {
  readonly rows = new Map<number, { raw: unknown; value?: T; error?: string }>();
  private next = 1;
  used = false;
  error?: string;
  readonly prefix: "$" | "M";
  private readonly names: ToolNames;
  private readonly fields: ReadonlySet<string>;
  private readonly immediate: boolean;
  constructor(prefix: "$" | "M", names: ToolNames, fields: readonly string[], immediate = false) {
    this.prefix = prefix; this.names = names; this.fields = new Set(fields); this.immediate = immediate;
  }
  id(value: unknown): number {
    const match = typeof value === "string" && (this.prefix === "$" ? /^\$([1-9]\d*)$/ : /^M([1-9]\d*)$/).exec(value);
    if (!match || !this.rows.has(Number(match[1]))) throw new Error(`unknown ${this.prefix} slot ${String(value)}`);
    return Number(match[1]);
  }
  call(raw: unknown, validate: (raw: unknown, id: number) => T,
    droppable: (id: number) => void, rejection?: string): string {
    const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const tool = this.names[this.prefix === "$" ? "note" : "memory"];
    const unexpected = input ? Object.keys(input).filter(key => !this.fields.has(key)) : [];
    const invalid = !input || unexpected.length > 0 || (this.immediate && !Object.keys(input).length) ||
      ("drop" in input && (Object.keys(input).length !== 1 || typeof input.drop !== "string")) ||
      ("slot" in input && (typeof input.slot !== "string" || Object.keys(input).length === 1));
    if (invalid) {
      this.error = rejection ?? `${tool} expects one item, one scalar drop${this.immediate ? "" : ", or {}"}${unexpected.length ? `; ${unexpected.map(key => `${key}: unexpected field`).join("; ")}` : ""}`;
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
    } else if (Object.keys(input).length) {
      let id: number | undefined;
      // 0: an immediate writer's fresh item, numbered only if refused.
      try { id = input.slot !== undefined ? this.id(input.slot) : this.immediate ? 0 : this.next++; }
      catch (error) { this.error = error instanceof Error ? error.message : String(error); results.push(`rejected: ${this.error}`); }
      if (id !== undefined) {
        const { slot: _slot, ...content } = input;
        const row: { raw: unknown; value?: T; error?: string } = { raw: structuredClone(content) };
        if (id) this.rows.set(id, row);
        try { if (rejection) throw new Error(rejection); row.value = validate(content, id);
          if (!this.immediate) results.push(`held: ${this.prefix}${id}`);
          else { this.rows.delete(id); results.push("ok"); receipt = row.value as object; } }
        catch (error) { row.error = error instanceof Error ? error.message : String(error);
          if (!id) this.rows.set(id = this.next++, row);
          results.push(`rejected: ${this.prefix}${id}: ${row.error}`); }
      }
    }
    if (rejection && !Object.keys(input).length) this.error = rejection;
    const rejected = Object.fromEntries([...this.rows].filter(([, row]) => row.error).map(([id, row]) => [`${this.prefix}${id}`, row.error]));
    return JSON.stringify(this.immediate ? { results, ...receipt, ...Object.keys(rejected).length ? { rejected } : {} }
      : { results, held: [...this.rows].filter(([, row]) => row.value !== undefined).map(([id]) => `${this.prefix}${id}`), rejected });
  }
  problems(): string[] {
    return [...(this.error ? [this.error] : []), ...[...this.rows].flatMap(([id, row]) => row.error ? [`${this.prefix}${id}: ${row.error}`] : [])];
  }
}

export function holdNoting(store: Store, run: RunInput, path: KnowledgePath,
  validateFact: (raw: unknown, slot: number, earlier: (slot: number) => boolean) => FactCommitInput,
  fields: Readonly<Record<"note" | "memory", readonly string[]>>, names: ToolNames = canonicalToolNames) {
  const facts = new Slots<FactCommitInput>("$", names, fields.note), operations = new Slots<KnowledgeOperationInput>("M", names, fields.memory);
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
  const memory = (raw: unknown) => operations.call(raw, (value, id) => {
    const accepted = prepare(value);
    const target = (value as { id?: string }).id;
    if (target && [...operations.rows].some(([other, row]) => other !== id && row.value !== undefined && (row.raw as { id?: string }).id === target))
      throw new Error("duplicate operation target; replace its existing M slot instead");
    return accepted;
  }, () => {});
  const note = (raw: unknown) => facts.call(raw, fact, id => {
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
  const blockers = (toolProblems: ReadonlyMap<string, string>): string[] => {
    const blockers: string[] = [];
    for (const [name, slots] of [["note", facts], ["memory", operations]] as const) {
      const exposed = names[name];
      if (!slots.used) blockers.push(`${exposed} not called; call ${exposed}({})`);
      if (slots.error) blockers.push(`${exposed} call error: ${slots.error}; make a structurally valid ${exposed} call to clear it`);
      for (const [id, row] of slots.rows) if (row.error) {
        const address = `${slots.prefix}${id}`;
        blockers.push(`${address}: ${row.error}; resubmit with slot: "${address}" or drop: "${address}" (drop may be refused if referenced)`);
      }
      // A wrapper failure can block publication even when the held layer has no error.
      if (toolProblems.has(name) && !slots.problems().length)
        blockers.push(`${exposed} call error: ${toolProblems.get(name)}; make a structurally valid ${exposed} call to clear it`);
    }
    return blockers;
  };
  const status = (toolProblems: ReadonlyMap<string, string>): string => {
    const problems = blockers(toolProblems);
    return problems.length
      ? `Not publishable: ${problems.join("; ")}. Ending now publishes nothing.`
      : "Publishable: current submission requirements are met; ending normally attempts to publish facts and knowledge together (not a commit guarantee).";
  };
  const passEnd = (toolProblems: ReadonlyMap<string, string>): string => {
    const changes = [...operations.rows].flatMap(([slot, row]) => {
      if (row.value === undefined) return [];
      const operation = row.value;
      if (operation.op === "create") return [`M${slot} (create):\n${operation.title ?? ""}\n${operation.text}`];
      if (operation.op !== "update" && operation.op !== "archive") throw new Error(`Noter cannot hold ${operation.op}`);
      const address = `K${operation.knowledgeId}#${store.versionTag(operation.knowledgeId, operation.baseCommit)}`;
      if (operation.op === "archive") return [`M${slot} ${address} (archive: ${operation.kind}):\n${operation.text ?? "No archive text."}`];
      const parent = store.getKnowledgeRevision(operation.knowledgeId, operation.baseCommit)!;
      return [`M${slot} ${address} (update):\n${renderKnowledgeDiff(parent,
        { ...parent, title: operation.title ?? parent.title, text: operation.text, category: operation.category, scope: operation.scope, topics: operation.topics },
        [], Infinity, new Set(["text", "status", "topics"]), undefined, address)}`];
    });
    return `Before publication, review this run once.\n\nBlockers:\n${blockers(toolProblems).join("\n") || "None."}\n\nKnowledge changes held in this run:\n${changes.join("\n\n") || "None."}\n\nCheck each knowledge change against your Principles. Correct a change that violates them with a complete replacement under its slot, or drop it. Resolve every blocker. Leave compliant changes as they are. Then end; ending with a blocker left publishes nothing.`;
  };
  const validate = () => {
    if (incomplete()) throw new Error(`incomplete Noting: explicitly call both ${names.note} and ${names.memory}, including empty {} calls`);
    if (problems().length) throw new Error(problems().join("; "));
    // Recheck the final sources/content, including facts cited before a later correction.
    for (const [id, row] of facts.rows) row.value = fact(row.raw, id);
  };
  return { note, memory, problems, incomplete, status, passEnd, validate,
    reject: (name: "note" | "memory", raw: unknown, reason: string) => name === "note"
      ? facts.call(raw, fact, () => {}, reason)
      : operations.call(raw, value => value as KnowledgeOperationInput, () => {}, reason),
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
