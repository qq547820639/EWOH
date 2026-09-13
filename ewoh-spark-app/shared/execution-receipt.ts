import type { SchedulingExecution, ExecutionUpdateRequest, RecordActualsRequest } from './scheduler';

export type ExecutionReceiptSource = 'real' | 'simulated' | 'unknown';

export interface ExecutionReceiptProvenance {
  policy: 'receipt-provenance-v1';
  source: ExecutionReceiptSource;
  productionTrainingEligible: boolean;
  reason: string;
  evidence: Record<string, unknown>;
}

export interface ExecutionReceiptSummary {
  matchedRows: number;
  advancedAssignments: number;
  advancedTaskSteps: number;
  skips: string[];
}

export type ExecutionReceiptResult = SchedulingExecution & {
  receipt: ExecutionReceiptSummary & ExecutionReceiptProvenance;
};

export type ReportedReceiptSource = 'manual_report' | 'simulated';
export type ExecutionReceiptRequest = ExecutionUpdateRequest & { reportedSource?: ReportedReceiptSource };
export type FeedbackActualsReceiptRequest = RecordActualsRequest & { reportedSource?: ReportedReceiptSource };
