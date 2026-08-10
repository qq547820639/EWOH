import { Injectable, Logger, Optional } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis | null;
  private readonly memory = new Map<string, { value: unknown; expiresAt: number }>();
  /** rate_limit_redis_fallback_total：Redis 不可用回退内存存储的累计次数（可观测降级信号）。 */
  private memoryFallbackTotal = 0;

  constructor(@Optional() url?: string) {
    const redisUrl = url || process.env.REDIS_URL;
    if (redisUrl) {
      this.client = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      this.client.on('error', (error) => {
        this.logger.warn(`Redis unavailable, using memory fallback: ${error.message}`);
      });
    } else {
      this.client = null;
    }
  }

  /** 记录一次 Redis→内存回退（metric + 结构化日志；降级绝不 silent）。 */
  private recordMemoryFallback(op: string, reason: unknown): void {
    this.memoryFallbackTotal += 1;
    this.logger.warn(
      `rate_limit_redis_fallback_total: redis.${op} unavailable, using memory fallback: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  }

  /** 当前 Redis→内存回退累计次数（rate_limit_redis_fallback_total 数据源；测试/指标消费）。 */
  memoryFallbackCount(): number {
    return this.memoryFallbackTotal;
  }

  async get(key: string): Promise<unknown | null> {
    if (this.client) {
      try {
        const value = await this.client.get(key);
        return value === null ? null : JSON.parse(value);
      } catch (err) {
        this.recordMemoryFallback('get', err);
        return this.memoryGet(key);
      }
    }
    return this.memoryGet(key);
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (this.client) {
      try {
        await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds ?? 60);
        return;
      } catch (err) {
        this.recordMemoryFallback('set', err);
        // fall through to memory
      }
    }
    this.memory.set(key, {
      value,
      expiresAt: Date.now() + (ttlSeconds ?? 60) * 1000,
    });
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    if (this.client) {
      try {
        const count = await this.client.incr(key);
        if (count === 1 && ttlSeconds) {
          await this.client.expire(key, ttlSeconds);
        }
        return count;
      } catch (err) {
        this.recordMemoryFallback('incr', err);
        // fall through to memory
      }
    }
    const existing = this.memory.get(key);
    const now = Date.now();
    if (!existing || existing.expiresAt <= now) {
      this.memory.set(key, { value: 1, expiresAt: now + (ttlSeconds ?? 60) * 1000 });
      return 1;
    }
    const next = Number(existing.value) + 1;
    existing.value = next;
    return next;
  }

  async del(key: string): Promise<void> {
    if (this.client) {
      try {
        await this.client.del(key);
        return;
      } catch (err) {
        this.recordMemoryFallback('del', err);
        // fall through to memory
      }
    }
    this.memory.delete(key);
  }

  async ping(): Promise<boolean> {
    if (this.client) {
      try {
        return (await this.client.ping()) === 'PONG';
      } catch {
        return false;
      }
    }
    return true;
  }

  private memoryGet(key: string): unknown | null {
    const entry = this.memory.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }
}
