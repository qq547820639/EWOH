import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export interface SlowQueryRecord {
  id: string;
  requestId?: string;
  label: string;
  durationMs: number;
  thresholdMs: number;
  occurredAt: string;
}

@Injectable()
export class SlowQueryService {
  private readonly records: SlowQueryRecord[] = [];
  private readonly maxRecords: number;

  constructor(@Optional() maxRecords?: number) {
    this.maxRecords = maxRecords ?? 200;
  }

  record(entry: Omit<SlowQueryRecord, 'id'>): SlowQueryRecord {
    const record: SlowQueryRecord = {
      ...entry,
      id: `SLOW-${randomUUID().slice(0, 8)}`,
    };
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    return record;
  }

  list(limit = 100): SlowQueryRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return [...this.records].reverse().slice(0, safeLimit);
  }

  clear(): void {
    this.records.length = 0;
  }

  count(): number {
    return this.records.length;
  }
}
