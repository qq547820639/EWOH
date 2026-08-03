import { HttpStatus } from '@nestjs/common';
import { WorldCursorController } from '../../../server/modules/world-cursor/world-cursor.controller';
import { CursorExpiredError } from '../../../server/modules/world-cursor/world-cursor.service';

describe('WorldCursorController', () => {
  it('maps CURSOR_EXPIRED to HTTP 410', async () => {
    const service = {
      getDelta: jest.fn().mockRejectedValue(new CursorExpiredError()),
      getSnapshot: jest.fn(),
    };
    const controller = new WorldCursorController(service as never);

    await expect(controller.delta('expired-cursor')).rejects.toMatchObject({
      status: HttpStatus.GONE,
      response: { code: 'CURSOR_EXPIRED' },
    });
  });
});
