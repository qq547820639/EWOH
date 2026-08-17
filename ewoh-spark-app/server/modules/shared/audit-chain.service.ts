import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * 创世 prevHash（NEST-519 修复，2026-08-17）：与 DB 侧统一为 64 个 '0'
 * （standalone_001 的 ewoh_audit_log.prev_hash DEFAULT repeat('0', 64) 与
 * ewoh_append_audit_log 内 coalesce(v_prev_hash, repeat('0', 64))）。原内存链
 * 用 'GENESIS' 字面量，与 DB 链的初始值不一致，无法跨实现拼接验证。
 */
export const AUDIT_CHAIN_GENESIS = '0'.repeat(64);

/**
 * 内存审计链（NEST-506 文档化，2026-08-17）：chains 为进程内 Map，重启即丢——
 * 本服务仅供测试与运行时辅助校验使用；持久化审计链的单一事实源是
 * ewoh_audit_log（经 ewoh_append_audit_log 哈希链落库），不要依赖本服务做
 * 跨进程/跨重启的审计事实。
 */
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
    const prevHash = chain.length > 0 ? chain[chain.length - 1].hash : AUDIT_CHAIN_GENESIS;
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
    let prevHash = AUDIT_CHAIN_GENESIS;
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
