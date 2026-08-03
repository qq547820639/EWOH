export interface QueryStateSnapshot {
  key: string;
  label: string;
  isError: boolean;
  dataUpdatedAt: number;
  refetch: () => void;
}

export function collectQueryErrors(
  queries: QueryStateSnapshot[],
): QueryStateSnapshot[] {
  return queries.filter((query) => query.isError);
}

export function isStaleSince(
  updatedAt: number,
  now: number,
  maxAgeMs: number,
): boolean {
  return updatedAt > 0 && now - updatedAt > maxAgeMs;
}

export function retryAll(queries: QueryStateSnapshot[]): void {
  for (const query of queries) {
    query.refetch();
  }
}
