import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DatabaseAuditSink } from './database-audit-sink';

export interface AuditLogEntry {
  actorId: string;
  orgId: string;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
  requestId?: string;
  risk?: boolean;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}

export interface AuditLogSink {
  append(entry: AuditLogEntry): Promise<void> | void;
}

export class InMemoryAuditSink implements AuditLogSink {
  readonly entries: AuditLogEntry[] = [];

  append(entry: AuditLogEntry): void {
    this.entries.push(entry);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

const SENSITIVE_KEY_NAMES = new Set([
  'key',
  'keys',
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'credential',
  'credentials',
  'authorization',
  'authtoken',
  'authconfig',
  'apikey',
  'accesskey',
  'privatekey',
  'secretkey',
  'healthtoken',
  'healthcredential',
  'controltoken',
  'controlcredential',
  'controlkey',
  'datasourcecredential',
  'connectionstring',
]);

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|credential|privatekey|apikey|accesskey|secretkey|authconfig|healthcredential|controlcredential|controltoken|healthtoken|controlkey)/;

const CREDENTIAL_STRING_PATTERNS = [
  /(password|passwd|pwd|token|secret|api[_-]?key|authorization|credential)=[^&\s]+/i,
  /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^@\s]+@/i,
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_NAMES.has(normalized) || SENSITIVE_KEY_PATTERN.test(normalized);
}

function looksLikeCredentialString(value: string): boolean {
  return CREDENTIAL_STRING_PATTERNS.some((pattern) => pattern.test(value));
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  private readonly sink: AuditLogSink;

  constructor(@Optional() @Inject(DatabaseAuditSink) sink?: AuditLogSink) {
    this.sink = sink ?? new InMemoryAuditSink();
  }

  /**
   * Persists a redacted audit entry. The production implementation will call the
   * SECURITY DEFINER audit writer; for now the entry goes to the configured sink
   * (in-memory by default) and is logged as structured text.
   */
  async appendAuditLog(entry: AuditLogEntry): Promise<void> {
    const record: AuditLogEntry = {
      ...entry,
      before: this.redact(entry.before),
      after: this.redact(entry.after),
      metadata: entry.metadata ? (this.redact(entry.metadata) as Record<string, unknown>) : undefined,
      occurredAt: entry.occurredAt ?? new Date().toISOString(),
    };

    await this.sink.append(record);
    this.logger.log(`AUDIT ${JSON.stringify(record)}`);
  }

  /**
   * Deep-redacts passwords, keys, auth config, and health/control credentials.
   * The source value is not mutated.
   */
  redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (value === null || typeof value !== 'object') {
      return typeof value === 'string' && looksLikeCredentialString(value) ? '[REDACTED]' : value;
    }

    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);

    if (value instanceof Date || value instanceof RegExp || value instanceof Buffer) {
      return value;
    }

    if (Array.isArray(value)) {
      const result = value.map((item) => this.redact(item, seen));
      seen.delete(value);
      return result;
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        const isObject =
          item !== null &&
          typeof item === 'object' &&
          !(item instanceof Date) &&
          !(item instanceof RegExp) &&
          !(item instanceof Buffer);
        result[key] = isObject ? this.redact(item, seen) : '[REDACTED]';
      } else {
        result[key] = this.redact(item, seen);
      }
    }
    seen.delete(value);
    return result;
  }
}
