import { DEFAULT_CONFIG } from "../../src/core/api/index.ts";
import { renderEntry, renderFact, renderFactGroups, tokens } from "../../src/core/render/index.ts";
import type { Store, TaskTarget, ProjectDeclarationContext } from "../../src/core/store/index.ts";

/** Store-only fixtures have no TraceMemory facade. Supply the same selected-path N/C/D thresholds
 * that the facade passes into Store.declareProject, rather than claiming backlog is never due. */
export function declarationContext(store: Store, path: TaskTarget): ProjectDeclarationContext {
  return { path, atTrigger: phase => {
    if (phase === "dreaming") return store.duePools(path, DEFAULT_CONFIG.dreaming.triggerTokens).length > 0;
    if (phase === "noting") {
      const pending = store.pendingEntries(path.sessionId, path.branch, path.headTurnId!);
      return tokens(pending.map(meta => renderEntry(store.getSourceEntry(meta.id)!, DEFAULT_CONFIG.render).content).join("\n\n"))
        >= DEFAULT_CONFIG.noting.triggerTokens;
    }
    const facts = store.consolidationBatch(path.sessionId, path.branch, path.headTurnId!);
    const snapshot = store.pathSnapshot(path);
    const relations = store.listFactRelationsOnPathOf(facts.map(fact => fact.id), path, snapshot);
    return tokens(renderFactGroups(facts, fact => renderFact(fact, relations.get(fact.id) ?? []), store.factTurnTimes(facts)).join("\n"))
      >= DEFAULT_CONFIG.consolidation.triggerTokens;
  } };
}
