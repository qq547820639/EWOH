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
  // CLI-729：仅重试失败查询——「全部重试」入口的语义是恢复错误项，
  // 对健康查询发起 refetch 会浪费请求并打断其 loading 态。
  for (const query of collectQueryErrors(queries)) {
    query.refetch();
  }
}
