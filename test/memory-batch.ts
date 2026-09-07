// Migrate historical fixture vocabulary at the test boundary; production accepts only memory batches.
export function memoryBatch(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value) || "operations" in value) return value;
  return { operations: [
    ...(value.new ?? []).map(({ handle, ...op }: any) => ({ op: "create", ...op, because: op.because ?? op.supports, ...(handle && !/^\$e[1-9]\d*$/.test(handle) ? { handle } : {}) })),
    ...(value.edit ?? []).map((op: any) => ({ op: "update", ...op })),
    ...(value.merge ?? []).map(({ into, id: _id, ...op }: any) => ({ op: "merge", id: into, ...op })),
    ...(value.delete ?? []).map((op: any) => ({ op: "archive", ...op })),
  ], skipped: (value.not_admitted ?? []).map(({ id, ...rest }: any) => ({ fact: id, ...rest })) };
}
