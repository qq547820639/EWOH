import { Injectable, Optional } from '@nestjs/common';

export interface TraceRecord {
  traceId: string;
  spanId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

@Injectable()
export class TracingService {
  private readonly records: TraceRecord[] = [];
  private readonly maxRecords: number;

  constructor(@Optional() maxRecords?: number) {
    this.maxRecords = maxRecords ?? 500;
  }

  record(entry: TraceRecord): TraceRecord {
    this.records.push(entry);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    return entry;
  }

  list(limit = 100): TraceRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return [...this.records].reverse().slice(0, safeLimit);
  }

  clear(): void {
    this.records.length = 0;
  }
}
