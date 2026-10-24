import type { DatabaseSync } from "node:sqlite";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
type Corpus = "fact" | "knowledge";

export function wordFrequencies(text: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const part of segmenter.segment(text.toLowerCase()))
    if (part.isWordLike) terms.set(part.segment, (terms.get(part.segment) ?? 0) + 1);
  return terms;
}

/** Database-backed postings; corpus statistics include every document, not just visible candidates. */
export class WordSimilarity {
  private readonly removeFrequencies;
  private readonly removePostings;
  private readonly removeEmptyTerms;
  private readonly putDocument;
  private readonly putFrequency;
  private readonly putPosting;
  private readonly updateNorm;
  private readonly ranked;

  constructor(db: DatabaseSync, corpus: Corpus) {
    const documents = `${corpus}_word_documents`, terms = `${corpus}_word_terms`, postings = `${corpus}_word_postings`;
    this.removeFrequencies = db.prepare(`UPDATE ${terms} SET df=df-1 WHERE term IN (SELECT term FROM ${postings} WHERE document_id=?)`);
    this.removeEmptyTerms = db.prepare(`DELETE FROM ${terms} WHERE df=0 AND term IN (SELECT term FROM ${postings} WHERE document_id=?)`);
    this.removePostings = db.prepare(`DELETE FROM ${postings} WHERE document_id=?`);
    this.putDocument = db.prepare(`INSERT INTO ${documents}(document_id,norm) VALUES (?,1) ON CONFLICT(document_id) DO UPDATE SET norm=1`);
    this.putFrequency = db.prepare(`INSERT INTO ${terms}(term,df) VALUES (?,1) ON CONFLICT(term) DO UPDATE SET df=df+1`);
    this.putPosting = db.prepare(`INSERT INTO ${postings}(term,document_id,tf) VALUES (?,?,?)`);
    this.updateNorm = db.prepare(`UPDATE ${documents} SET norm=coalesce((
      SELECT nullif(sqrt(sum(weight*weight)),0) FROM (
        SELECT (1+ln(p.tf))*max(ln((n.total-t.df+0.5)/(t.df+0.5)),0) AS weight
        FROM ${postings} p JOIN ${terms} t ON t.term=p.term
        CROSS JOIN (SELECT count(*) AS total FROM ${documents}) n WHERE p.document_id=?
      )),1) WHERE document_id=?`);
    // Unary + keeps SQLite on term ranges, not one primary-key seek per (query term, candidate).
    this.ranked = db.prepare(`WITH query AS MATERIALIZED (
      SELECT j.key AS term,(1+ln(j.value))*pow(ln((n.total-t.df+0.5)/(t.df+0.5)),2) AS weight
      FROM json_each(?) j JOIN ${terms} t ON t.term=j.key
      CROSS JOIN (SELECT count(*) AS total FROM ${documents}) n WHERE 2*t.df<n.total
    ) SELECT p.document_id AS id,sum(q.weight*(1+ln(p.tf)))/d.norm AS score
      FROM query q CROSS JOIN ${postings} p ON p.term=q.term
      JOIN ${documents} d ON d.document_id=p.document_id
      WHERE +p.document_id IN (SELECT value FROM json_each(?))
      GROUP BY p.document_id ORDER BY score DESC,p.document_id LIMIT ?`);
  }

  /** Called under the owning write transaction; replacement also supports imported legacy fixtures. */
  write(id: number, title: string | null, text: string): void {
    this.removeFrequencies.run(id);
    this.removeEmptyTerms.run(id);
    this.removePostings.run(id);
    this.putDocument.run(id);
    for (const [term, tf] of wordFrequencies(`${title ?? ""} ${text}`)) {
      this.putFrequency.run(term);
      this.putPosting.run(term, id, tf);
    }
    // shortcut: freeze each norm at write-time statistics; revisit if corpus drift degrades recall.
    this.updateNorm.run(id, id);
  }

  similar(text: string, candidates: readonly number[], limit: number): number[] {
    if (!candidates.length || limit <= 0) return [];
    const query = wordFrequencies(text);
    if (!query.size) return [];
    return this.ranked.all(JSON.stringify(Object.fromEntries(query)), JSON.stringify(candidates), limit)
      .map(row => Number(row.id));
  }
}
