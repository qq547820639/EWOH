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

  it('finds a record by idempotency key within an organization', async () => {
    const send = jest.fn(async () => ({ Contents: [] }));
    const driver = new S3StorageDriver(
      { bucket: 'ewoh-files' },
      { send } as unknown as S3Client,
    );
    // list() returns nothing, so no record exists yet.
    await expect(driver.findByIdempotencyKey('ik-1', 'org-a')).resolves.toBeNull();
  });

  it('finds a record by idempotency key across stored metadata', async () => {
    const store = new Map<string, Buffer>();
    const send = jest.fn(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        store.set(command.input.Key as string, Buffer.from(command.input.Body as Buffer));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const body = store.get(command.input.Key as string);
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
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [...store.keys()]
            .filter((key) => key.startsWith('files/'))
            .map((Key) => ({ Key })),
        };
      }
      return {};
    });
    const driver = new S3StorageDriver(
      { bucket: 'ewoh-files' },
      { send } as unknown as S3Client,
    );
    const record: FileRecord = {
      id: FILE_ID,
      orgId: 'org-a',
      uploadedBy: 'user-a',
      filename: 'a.png',
      contentType: 'image/png',
      size: 1,
      createdAt: '2026-08-03T00:00:00.000Z',
      idempotencyKey: 'ik-dup',
    };
    await driver.save(FILE_ID, Buffer.from('x'), record);
    await expect(driver.findByIdempotencyKey('ik-dup', 'org-a')).resolves.toMatchObject({ id: FILE_ID });
    // Same key under a different org must not match.
    await expect(driver.findByIdempotencyKey('ik-dup', 'org-b')).resolves.toBeNull();
  });

  it('generates a presigned GET URL with clamped lifetime and immutable object key', async () => {
    const signer = jest.fn(async (command: GetObjectCommand, options: { expiresIn?: number }) => {
      return `https://ewoh-files.s3.example/${command.input.Key}?expires=${options.expiresIn}&type=${command.input.ResponseContentType ?? 'none'}`;
    });
    const driver = new S3StorageDriver(
      { bucket: 'ewoh-files', prefix: 'files' },
      undefined as unknown as S3Client,
      signer,
    );

    const result = await driver.createPresignedUrl(FILE_ID, 'org-a', {
      expiresInSeconds: 999999, // exceeds the 24h cap -> clamped
      contentType: 'image/png',
    });

    // Object key is the immutable UUID under the fixed prefix (no traversal / no
    // user-controlled path components).
    expect(result.key).toBe(`files/${FILE_ID}`);
    expect(result.url).toContain(`files/${FILE_ID}`);
    expect(result.url).toContain('type=image/png');
    // Lifetime is clamped to the max (24h), not the requested ~11 days.
    expect(result.url).toContain('expires=86400');
    const delta = Date.parse(result.expiresAt) - Date.now();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  it('defaults and floors the presigned URL lifetime', async () => {
    const signer = jest.fn(async (_command: GetObjectCommand, options: { expiresIn?: number }) => {
      return `expires=${options.expiresIn}`;
    });
    const driver = new S3StorageDriver(
      { bucket: 'ewoh-files' },
      undefined as unknown as S3Client,
      signer,
    );
    const capped = await driver.createPresignedUrl(FILE_ID, 'org-a', { expiresInSeconds: 0 });
    expect(capped.url).toBe('expires=1');
    const floored = await driver.createPresignedUrl(FILE_ID, 'org-a', { expiresInSeconds: 1.9 });
    expect(floored.url).toBe('expires=1');
  });
});
