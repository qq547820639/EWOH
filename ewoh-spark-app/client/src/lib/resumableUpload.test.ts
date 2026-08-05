import {
  createChunks,
  createUploadId,
  DEFAULT_CHUNK_SIZE_BYTES,
  runResumableUpload,
  type UploadMeta,
} from './resumableUpload';

describe('resumableUpload', () => {
  it('slices a blob into fixed-size chunks', () => {
    const blob = new Blob([new Uint8Array(2.5 * DEFAULT_CHUNK_SIZE_BYTES)]);
    const chunks = createChunks(blob, DEFAULT_CHUNK_SIZE_BYTES);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chunks[0].blob.size).toBe(DEFAULT_CHUNK_SIZE_BYTES);
  });

  it('yields a single chunk for an empty blob', () => {
    const chunks = createChunks(new Blob([]), DEFAULT_CHUNK_SIZE_BYTES);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].blob.size).toBe(0);
  });

  it('produces a stable upload id from idempotency key + file identity', () => {
    expect(createUploadId('ik-1', 'photo.jpg:123')).toBe('ik-1::photo.jpg:123');
    expect(createUploadId('ik-1', 'photo.jpg:123')).toBe(
      createUploadId('ik-1', 'photo.jpg:123'),
    );
  });

  it('uploads every chunk in order and finalizes once', async () => {
    const blob = new Blob([new Uint8Array(2.5 * DEFAULT_CHUNK_SIZE_BYTES)]);
    const uploaded: string[] = [];
    const finalResults: UploadMeta[] = [];
    const result = await runResumableUpload(blob, {
      idempotencyKey: 'ik-1',
      fileIdentifier: 'a.bin',
      uploadChunk: (chunk, meta) => {
        uploaded.push(meta.chunkId);
        return Promise.resolve({ ok: true as const, chunkId: meta.chunkId });
      },
      finalize: (results, meta) => {
        finalResults.push(meta);
        return Promise.resolve();
      },
    });

    expect(uploaded).toHaveLength(3);
    expect(result.totalChunks).toBe(3);
    expect(result.uploadedChunks).toBe(3);
    expect(result.resumed).toBe(false);
    expect(result.bytesUploaded).toBe(blob.size);
    expect(finalResults).toHaveLength(1);
  });

  it('resumes and dedupes chunks already recorded as completed', async () => {
    const blob = new Blob([new Uint8Array(2.5 * DEFAULT_CHUNK_SIZE_BYTES)]);
    const uploaded: string[] = [];
    const completed = [0]; // chunk 0 done in a prior interrupted run

    const result = await runResumableUpload(blob, {
      idempotencyKey: 'ik-1',
      fileIdentifier: 'a.bin',
      resumeState: async () => completed,
      saveProgress: async (_id, indexes) => {
        completed.splice(0, completed.length, ...indexes);
      },
      uploadChunk: (chunk, meta) => {
        uploaded.push(meta.chunkId);
        return Promise.resolve({ ok: true as const, chunkId: meta.chunkId });
      },
    });

    expect(result.resumed).toBe(true);
    expect(uploaded).toHaveLength(2); // chunk 0 skipped
    expect(result.uploadedChunks).toBe(3);
    expect(result.totalChunks).toBe(3);
    expect(result.bytesUploaded).toBe(blob.size);
  });

  it('interrupted upload resumes from saved progress on the next attempt', async () => {
    const blob = new Blob([new Uint8Array(3 * DEFAULT_CHUNK_SIZE_BYTES)]);
    const persisted: number[] = [];
    const uploadedOn: Record<number, number> = {};

    // Attempt 1: fails mid-way on chunk 1 (network interruption).
    await expect(
      runResumableUpload(blob, {
        idempotencyKey: 'ik-2',
        fileIdentifier: 'photo.jpg',
        saveProgress: async (_id, indexes) => {
          persisted.splice(0, persisted.length, ...indexes);
        },
        resumeState: async () => [...persisted],
        uploadChunk: (chunk) => {
          uploadedOn[chunk.index] = (uploadedOn[chunk.index] ?? 0) + 1;
          if (chunk.index === 1 && (uploadedOn[chunk.index] ?? 0) === 1) {
            return Promise.reject(new Error('network interrupted'));
          }
          return Promise.resolve({ ok: true as const, chunkId: `c${chunk.index}` });
        },
      }),
    ).rejects.toThrow('network interrupted');

    // Chunk 0 completed and was persisted.
    expect(persisted).toEqual([0]);

    // Attempt 2: resumes, chunk 0 skipped, chunks 1..2 uploaded.
    const second = await runResumableUpload(blob, {
      idempotencyKey: 'ik-2',
      fileIdentifier: 'photo.jpg',
      saveProgress: async (_id, indexes) => {
        persisted.splice(0, persisted.length, ...indexes);
      },
      resumeState: async () => [...persisted],
      uploadChunk: (chunk) => {
        uploadedOn[chunk.index] = (uploadedOn[chunk.index] ?? 0) + 1;
        return Promise.resolve({ ok: true as const, chunkId: `c${chunk.index}` });
      },
    });

    expect(second.resumed).toBe(true);
    expect(second.uploadedChunks).toBe(3);
    expect(uploadedOn[0]).toBe(1); // exactly once across both attempts
    expect(uploadedOn[1]).toBe(2); // failed attempt + resumed attempt
    expect(uploadedOn[2]).toBe(1);
    expect(persisted).toEqual([0, 1, 2]);
  });

  it('finalize receives only chunks uploaded in this run', async () => {
    const blob = new Blob([new Uint8Array(DEFAULT_CHUNK_SIZE_BYTES * 2)]);
    const results: string[] = [];
    await runResumableUpload(blob, {
      idempotencyKey: 'ik-3',
      fileIdentifier: 'a.bin',
      resumeState: async () => [0],
      uploadChunk: (chunk) =>
        Promise.resolve({ ok: true as const, chunkId: `c${chunk.index}` }),
      finalize: (res) => {
        results.push(...res.map((r) => (r as { chunkId: string }).chunkId));
        return Promise.resolve();
      },
    });
    expect(results).toEqual(['c1']);
  });
});