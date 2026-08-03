import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export interface AuditChainEntry {
  orgId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  risk?: boolean;
  ts: string;
  prevHash: string;
  hash: string;
}

function digest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

@Injectable()
export class AuditChainService {
  private readonly chains = new Map<string, AuditChainEntry[]>();

  append(input: Omit<AuditChainEntry, 'prevHash' | 'hash'>): AuditChainEntry {
    const chain = this.chains.get(input.orgId) ?? [];
    const prevHash = chain.length > 0 ? chain[chain.length - 1].hash : 'GENESIS';
    const payload = JSON.stringify({
      prevHash,
      orgId: input.orgId,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before,
      after: input.after,
      reason: input.reason,
      risk: input.risk,
      ts: input.ts,
    });
    const entry: AuditChainEntry = {
      ...input,
      prevHash,
      hash: digest(payload),
    };
    chain.push(entry);
    this.chains.set(input.orgId, chain);
    return entry;
  }

  verifyChain(orgId: string): { valid: boolean; entries: number; brokenAt?: number } {
    const chain = this.chains.get(orgId) ?? [];
    let prevHash = 'GENESIS';
    for (let index = 0; index < chain.length; index += 1) {
      const entry = chain[index];
      const payload = JSON.stringify({
        prevHash,
        orgId: entry.orgId,
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before,
        after: entry.after,
        reason: entry.reason,
        risk: entry.risk,
        ts: entry.ts,
      });
      if (entry.prevHash !== prevHash || entry.hash !== digest(payload)) {
        return { valid: false, entries: chain.length, brokenAt: index };
      }
      prevHash = entry.hash;
    }
    return { valid: true, entries: chain.length };
  }
}
