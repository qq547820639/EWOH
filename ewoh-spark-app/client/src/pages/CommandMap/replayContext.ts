export interface ReplayContextSummary {
  beforeTs: string | null;
  duringTs: string | null;
  afterTs: string | null;
  timelineCount: number;
}

export function summarizeReplayContext(
  context: Record<string, unknown>,
): ReplayContextSummary {
  const before = context.before as { ts?: string } | null | undefined;
  const during = context.during as { ts?: string } | null | undefined;
  const after = context.after as { ts?: string } | null | undefined;
  return {
    beforeTs: before?.ts ?? null,
    duringTs: during?.ts ?? null,
    afterTs: after?.ts ?? null,
    timelineCount: Number(context.timelineCount ?? 0),
  };
}
