import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { sign } from 'jsonwebtoken';
import { AuthService } from '../../../server/modules/auth/auth.service';

const JWT_SECRET = 'unit-test-secret-that-is-at-least-32-characters';

describe('standalone JWT auth', () => {
  let passwordHash: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    passwordHash = await bcrypt.hash('correct-password', 4);
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  function createService(overrides?: { rows?: Array<Record<string, unknown>>; error?: Error }) {
    const rows = overrides?.rows ?? [
      {
        username: 'admin',
        password_hash: passwordHash,
        org_id: 'f3bdfae3-88d0-49f7-9088-fd7b8df80b8c',
        roles: ['operator'],
        is_global_admin: true,
      },
    ];
    const execute = overrides?.error
      ? jest.fn().mockRejectedValue(overrides.error)
      : jest.fn().mockResolvedValue(rows);
    return { service: new AuthService({ execute } as never), execute };
  }

  it('accepts a bcrypt password and rejects an incorrect password', async () => {
    const { service } = createService();

    await expect(service.login('admin', 'wrong-password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const tokens = await service.login('admin', 'correct-password');

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.user.roles).toEqual(['operator', 'global_admin']);
  });

  it('rejects an unknown user', async () => {
    const { service } = createService({ rows: [] });

    await expect(service.login('missing', 'correct-password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('fails closed when the authentication store is unavailable', async () => {
    const { service } = createService({ error: new Error('database offline') });

    await expect(service.login('admin', 'correct-password')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('refreshes with a refresh token', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    const refreshed = await service.refresh(tokens.refreshToken);

    expect(service.verifyToken(refreshed.accessToken).sub).toBe('admin');
  });

  it('rotates refresh tokens and invalidates the previous jti', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    const refreshed = await service.refresh(tokens.refreshToken);
    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);

    await expect(service.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const second = await service.refresh(refreshed.refreshToken);
    expect(service.verifyToken(second.accessToken).sub).toBe('admin');
  });

  it('logout revokes the current refresh token', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    await service.logout(tokens.refreshToken);
    await expect(service.refresh(tokens.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('does not accept an access token as a refresh token', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    await expect(service.refresh(tokens.accessToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('does not accept a refresh token as an access token', async () => {
    const { service } = createService();
    const tokens = await service.login('admin', 'correct-password');

    expect(() => service.verifyToken(tokens.refreshToken)).toThrow(UnauthorizedException);
  });

  it('rejects a signed access token with an incomplete payload', () => {
    const { service } = createService();
    const malformed = sign({ sub: 'admin', type: 'access' }, JWT_SECRET, {
      algorithm: 'HS256',
    });

    expect(() => service.verifyToken(malformed)).toThrow(UnauthorizedException);
  });
});
