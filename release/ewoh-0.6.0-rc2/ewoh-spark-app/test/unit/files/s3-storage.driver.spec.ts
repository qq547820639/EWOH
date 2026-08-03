import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3StorageDriver } from '../../../server/modules/files/storage/s3-storage.driver';
import type { FileRecord } from '../../../server/modules/files/storage/storage-driver';

const FILE_ID = 'f3bdfae3-88d0-49f7-9088-fd7b8df80b8c';

describe('S3 storage driver', () => {
  it('saves, lists, downloads, and removes objects', async () => {
    const store = new Map<string, Buffer>();
    const send = jest.fn(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        store.set(command.input.Key ?? '', Buffer.from(command.input.Body as Buffer));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const body = store.get(command.input.Key ?? '');
        if (!body) {
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        }
        return {
          Body: {
            transformToString: async () => body.toString('utf8'),
            transformToByteArray: async () => new Uint8Array(body),
          },
        };
      }
      if (command instanceof DeleteObjectCommand) {
        store.delete(command.input.Key ?? '');
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? '';
        return {
          Contents: [...store.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((Key) => ({ Key })),
        };
      }
      return {};
    });
    const driver = new S3StorageDriver(
      { bucket: 'ewoh-files', prefix: 'files' },
      { send } as unknown as S3Client,
    );

    const record: FileRecord = {
      id: FILE_ID,
      orgId: 'org-a',
      uploadedBy: 'user-a',
      filename: 'scan.ply',
      contentType: 'application/octet-stream',
      size: 4,
      createdAt: '2026-08-03T00:00:00.000Z',
    };
    await driver.save(record.id, Buffer.from('data'), record);

    expect(store.has(`files/${FILE_ID}`)).toBe(true);
    expect(store.has(`files/${FILE_ID}.meta.json`)).toBe(true);
    expect((await driver.readMeta(record.id)).filename).toBe('scan.ply');
    expect((await driver.readContent(record.id)).toString()).toBe('data');
    expect((await driver.list())[0].id).toBe(record.id);

    await driver.remove(record.id);
    await expect(driver.readMeta(record.id)).rejects.toThrow();
  });

  it('returns not found for missing objects', async () => {
    const send = jest.fn(async () => {
      throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    });
    const driver = new S3StorageDriver(
      { bucket: 'ewoh-files' },
      { send } as unknown as S3Client,
    );
    await expect(driver.readMeta(FILE_ID)).rejects.toThrow();
    await expect(driver.readContent(FILE_ID)).rejects.toThrow();
  });
});
