import { uploadFile } from './files';
import { axiosForBackend } from '../lib/http';

jest.mock('../lib/http', () => ({
  axiosForBackend: jest.fn(),
}));

const mockAxios = axiosForBackend as jest.Mock;

function fileOf(name: string, type: string, size = 100): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe('api/files upload entry (uploadGuard wiring)', () => {
  beforeEach(() => {
    mockAxios.mockReset();
  });

  it('passes a valid file through to the backend with a requestId header', async () => {
    mockAxios.mockResolvedValue({
      data: { id: 'abc', requestId: undefined },
    });
    const file = fileOf('photo.png', 'image/png');
    const result = await uploadFile(file, 'note');
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockAxios).toHaveBeenCalledTimes(1);
    const config = mockAxios.mock.calls[0][0];
    expect(config.url).toBe('/api/files');
    expect(config.method).toBe('POST');
    expect(config.headers['X-Request-Id']).toBe(result.requestId);
    expect(config.data).toBeInstanceOf(FormData);
  });

  it('rejects an unsupported MIME locally without hitting the network', async () => {
    await expect(uploadFile(fileOf('app.exe', 'application/x-msdownload'))).rejects.toThrow(
      'unsupported MIME type',
    );
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('rejects an unsafe extension locally without hitting the network', async () => {
    await expect(uploadFile(fileOf('evil.exe', 'application/octet-stream'))).rejects.toThrow(
      'unsupported extension',
    );
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('rejects an oversized file locally without hitting the network', async () => {
    await expect(
      uploadFile(fileOf('big.bin', 'application/octet-stream', 21 * 1024 * 1024)),
    ).rejects.toThrow(/byte limit/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('attaches a requestId to a rejected upload error for diagnostics', async () => {
    try {
      await uploadFile(fileOf('app.exe', 'application/x-msdownload'));
      throw new Error('should not reach');
    } catch (error) {
      const err = error as { requestId?: string };
      expect(err.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('attaches a requestId to a network failure error', async () => {
    mockAxios.mockRejectedValue(new Error('network down'));
    try {
      await uploadFile(fileOf('photo.png', 'image/png'));
      throw new Error('should not reach');
    } catch (error) {
      const err = error as Error & { requestId?: string };
      expect(err.message).toBe('network down');
      expect(err.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});