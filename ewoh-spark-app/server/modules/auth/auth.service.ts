import { Inject, Injectable, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { sign, verify, type JwtPayload } from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../shared/redis.service';

export interface AuthUser {
  userId: string;
  username: string;
  passwordHash: string;
  roles: string[];
  orgId: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: { userId: string; username: string; roles: string[]; orgId: string };
}

export interface AuthJwtPayload extends JwtPayload {
  sub: string;
  type: 'access';
  jti: string;
  username: string;
  roles: string[];
  orgId: string;
}

interface RefreshJwtPayload extends JwtPayload {
  sub: string;
  type: 'refresh';
  jti: string;
}

interface StoredRefreshToken {
  userId: string;
  type: 'refresh';
}

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in standalone mode');
  }
  return value;
}

function refreshTokenTtlSeconds(): number {
  const raw = process.env.REFRESH_TOKEN_EXPIRES_IN || '30d';
  const match = /^(\d+)([smhd])$/.exec(raw.trim());
  if (!match) {
    return 30 * 24 * 60 * 60;
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
  };
  return value * multipliers[unit];
}

/** CLI-501/701：refresh token 经 httpOnly cookie 下发，cookie Max-Age 与签发 TTL 对齐。 */
export const REFRESH_TOKEN_COOKIE = 'ewoh_refresh_token';

/**
 * NEST-419：JWT_EXPIRES_IN 解析为「数字秒」（jsonwebtoken 的
 * SignOptions.expiresIn 接受 number，彻底移除 `as never` 强转）。
 * 畸形值回退默认 8h（与旧行为一致，配置错误可观测于启动日志）。
 */
function accessTokenTtlSeconds(): number {
  const raw = process.env.JWT_EXPIRES_IN || '8h';
  const match = /^(\d+)([smhd])$/.exec(raw.trim());
  if (!match) {
    return 8 * 60 * 60;
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
  };
  return value * multipliers[unit];
}

/**
 * NEST-417：用户不存在路径的伪哈希（登录恒定时间——无论用户是否存在都执行
 * 一次 bcrypt.compare，消除按响应时序枚举有效用户名）。
 */
const DUMMY_BCRYPT_HASH =
  '$2a$10$C6UzMDM.H6dfI/f/IKcEeO7ZBpUvHzGE9zSnzWn0mUeEW7dGkFlIm';

@Injectable()
export class AuthService {
  private readonly redis: RedisService;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: any,
    @Optional() redis?: RedisService,
  ) {
    this.redis = redis ?? new RedisService();
  }

  /** CLI-501/701：refresh cookie 的 Max-Age（与签发 TTL 对齐，供 controller 使用）。 */
  refreshTokenCookieMaxAge(): number {
    return refreshTokenTtlSeconds();
  }

  async login(username: string, password: string): Promise<AuthTokens> {
    const user = await this.findUser(username);
    if (!user) {
      // NEST-417：恒定时间登录——用户不存在也执行一次 bcrypt 比较，
      // 消除“立即返回 vs 走哈希比较”的时序差（用户名枚举面）。
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH).catch(() => false);
      throw new UnauthorizedException('Invalid username or password');
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid username or password');
    }
    return this.issue(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: RefreshJwtPayload;
    try {
      payload = verify(refreshToken, secret(), { algorithms: ['HS256'] }) as RefreshJwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (
      payload.type !== 'refresh' ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.jti !== 'string' ||
      !payload.jti
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const stored = (await this.redis.get(`auth:refresh:${payload.jti}`)) as
      | StoredRefreshToken
      | null
      | undefined;
    if (!stored || stored.type !== 'refresh' || stored.userId !== payload.sub) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    // Rotate: the presented jti may never be reused.
    await this.redis.del(`auth:refresh:${payload.jti}`);
    const user = await this.findUser(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Refresh token subject not found');
    }
    return this.issue(user);
  }

  async logout(refreshToken: string, accessToken?: string): Promise<void> {
    let payload: RefreshJwtPayload;
    try {
      payload = verify(refreshToken, secret(), { algorithms: ['HS256'] }) as RefreshJwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (
      payload.type !== 'refresh' ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.jti !== 'string' ||
      !payload.jti
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const stored = (await this.redis.get(`auth:refresh:${payload.jti}`)) as
      | StoredRefreshToken
      | null
      | undefined;
    if (!stored || stored.type !== 'refresh' || stored.userId !== payload.sub) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    await this.redis.del(`auth:refresh:${payload.jti}`);
    // NEST-418：logout 同时吊销请求携带的 access token（jti 黑名单）。
    if (accessToken?.trim()) {
      await this.revokeAccessToken(accessToken).catch(() => undefined);
    }
  }

  /**
   * NEST-418：吊销一个 access token（jti 进黑名单，TTL=access 剩余寿命）。
   * 无效 token 静默忽略（吊销面 best-effort，verifyToken 仍会拒绝无效签名）。
   */
  async revokeAccessToken(accessToken: string): Promise<void> {
    try {
      const payload = verify(
        accessToken,
        secret(),
        { algorithms: ['HS256'] },
      ) as AuthJwtPayload;
      if (payload?.type !== 'access' || typeof payload.jti !== 'string' || !payload.jti) {
        return;
      }
      const remaining = typeof payload.exp === 'number'
        ? Math.max(1, payload.exp - Math.floor(Date.now() / 1000))
        : accessTokenTtlSeconds();
      await this.redis.set(
        `auth:access:revoked:${payload.jti}`,
        { revoked: true },
        remaining,
      );
    } catch {
      // 无效 token 无需入黑名单（验签本就拒绝）。
    }
  }

  /**
   * NEST-418：验签 + jti 吊销检查（async——黑名单经 RedisService，
   * 多实例共享；Redis 不可用回退进程内存，单实例仍有效）。
   */
  async verifyToken(token: string): Promise<AuthJwtPayload> {
    let payload: AuthJwtPayload;
    try {
      payload = verify(token, secret(), { algorithms: ['HS256'] }) as AuthJwtPayload;
      if (
        payload.type !== 'access' ||
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        typeof payload.username !== 'string' ||
        typeof payload.orgId !== 'string' ||
        !Array.isArray(payload.roles) ||
        payload.roles.some((role) => typeof role !== 'string')
      ) {
        throw new UnauthorizedException('Invalid access token type');
      }
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
    if (typeof payload.jti === 'string' && payload.jti) {
      const revoked = await this.redis.get(`auth:access:revoked:${payload.jti}`);
      if (revoked) {
        throw new UnauthorizedException('Access token has been revoked');
      }
    }
    return payload;
  }

  private async issue(user: AuthUser): Promise<AuthTokens> {
    // NEST-418/419：access token 携带 jti（吊销黑名单键）；expiresIn 用
    // 数字秒（类型安全，移除 as never）。
    const accessJti = randomUUID();
    const accessTtl = accessTokenTtlSeconds();
    const accessToken = sign(
      {
        sub: user.userId,
        type: 'access',
        jti: accessJti,
        username: user.username,
        roles: user.roles,
        orgId: user.orgId,
      },
      secret(),
      { algorithm: 'HS256', expiresIn: accessTtl },
    );
    const refreshJti = randomUUID();
    const refreshTtl = refreshTokenTtlSeconds();
    const refreshToken = sign(
      { sub: user.userId, type: 'refresh', jti: refreshJti },
      secret(),
      { algorithm: 'HS256', expiresIn: refreshTtl },
    );
    await this.redis.set(
      `auth:refresh:${refreshJti}`,
      { userId: user.userId, type: 'refresh' } satisfies StoredRefreshToken,
      refreshTtl,
    );
    return {
      accessToken,
      refreshToken,
      user: {
        userId: user.userId,
        username: user.username,
        roles: user.roles,
        orgId: user.orgId,
      },
    };
  }

  private async findUser(username: string): Promise<AuthUser | null> {
    try {
      const rows = await (this.db as {
        execute: (query: unknown) => Promise<Array<Record<string, unknown>>>;
      }).execute(
        sql`select username, password_hash, org_id::text, roles, is_global_admin from ewoh_find_active_user(${username})`,
      );
      const row = rows[0];
      if (!row) {
        return null;
      }
      const roles = Array.isArray(row.roles) ? row.roles.map(String) : [];
      if (row.is_global_admin === true && !roles.includes('global_admin')) {
        roles.push('global_admin');
      }
      return {
        userId: String(row.username),
        username: String(row.username),
        passwordHash: String(row.password_hash),
        roles,
        orgId: String(row.org_id),
      };
    } catch {
      throw new ServiceUnavailableException('Authentication store is unavailable');
    }
  }
}
