import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { AiController } from '../ai.controller';
import { AiService } from '../ai.service';
import { ArkService } from '../ark.service';
import { RequestDatabaseContext } from '../../../database/request-database-context';
import { ROLES_KEY } from '../../shared/roles.decorator';

describe('AiController tenant and model-governance boundary', () => {
  function makeController() {
    return new AiController(
      {} as unknown as AiService,
      {} as unknown as ArkService,
      {} as unknown as RequestDatabaseContext,
    );
  }

  it('keeps global AI configuration restricted to global_admin', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AiController.prototype.saveConfig)).toEqual([
      'global_admin',
    ]);
  });

  it('rejects non-tenant suggestion creation instead of writing an unattributed fact', async () => {
    const controller = makeController();
    const request = { userContext: { userId: 'admin', isGlobalAdmin: true } } as never;
    expect(() =>
      controller.suggestion(
        {
          triggeredBy: 'admin',
          problem: 'p',
          snapshot: { version: 1, from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z', records: 1 },
        },
        request,
      ),
    ).toThrow(UnauthorizedException);
  });

  it('rejects non-tenant streaming suggestion creation', async () => {
    const controller = makeController();
    const res = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    } as never;
    await expect(
      controller.suggestionStream(
        {
          triggeredBy: 'admin',
          problem: 'p',
          snapshot: { version: 1, from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z', records: 1 },
        },
        res,
        { userContext: { userId: 'admin', isGlobalAdmin: true }, on: jest.fn() } as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
