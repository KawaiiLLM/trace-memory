/** Unicode character bigrams retain CJK text; punctuation and whitespace are ignored. */
export function characterBigrams(text: string): Set<string> {
  const chars = [...text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")];
  return new Set(chars.slice(1).map((c, i) => chars[i]! + c));
}

export function jaccardBigrams(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection++;
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}

/** Shared lexical similarity for Consolidation and Noting. */
export function similarity(a: string, b: string): number {
  return jaccardBigrams(characterBigrams(a), characterBigrams(b));
}
