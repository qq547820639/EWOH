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

@Injectable()
export class AuthService {
  private readonly redis: RedisService;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: any,
    @Optional() redis?: RedisService,
  ) {
    this.redis = redis ?? new RedisService();
  }

  async login(username: string, password: string): Promise<AuthTokens> {
    const user = await this.findUser(username);
    if (!user) {
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

  async logout(refreshToken: string): Promise<void> {
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
  }

  verifyToken(token: string): AuthJwtPayload {
    try {
      const payload = verify(token, secret(), { algorithms: ['HS256'] }) as AuthJwtPayload;
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
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
  }

  private async issue(user: AuthUser): Promise<AuthTokens> {
    const accessToken = sign(
      {
        sub: user.userId,
        type: 'access',
        username: user.username,
        roles: user.roles,
        orgId: user.orgId,
      },
      secret(),
      { algorithm: 'HS256', expiresIn: (process.env.JWT_EXPIRES_IN || '8h') as never },
    );
    const refreshJti = randomUUID();
    const refreshToken = sign(
      { sub: user.userId, type: 'refresh', jti: refreshJti },
      secret(),
      { algorithm: 'HS256', expiresIn: (process.env.REFRESH_TOKEN_EXPIRES_IN || '30d') as never },
    );
    await this.redis.set(
      `auth:refresh:${refreshJti}`,
      { userId: user.userId, type: 'refresh' } satisfies StoredRefreshToken,
      refreshTokenTtlSeconds(),
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
