// Historical audit shapes only. Ticket 92 removes live lexical review and resubmission.
export interface NotingNearNeighbour { factId: number; score: number }
export interface NotingNearShown {
  handle: string;
  text: string;
  neighbours: NotingNearNeighbour[];
}
export interface NotingNearAudit {
  threshold: number;
  firstSubmission: { facts: unknown[] };
  shown: NotingNearShown[];
}
export interface NotingUnansweredNearPair {
  fact: string;
  neighbour: string;
  score: number;
}
export type NotingDiagnostic = { kind: "unanswered_near"; pairs: NotingUnansweredNearPair[] };
