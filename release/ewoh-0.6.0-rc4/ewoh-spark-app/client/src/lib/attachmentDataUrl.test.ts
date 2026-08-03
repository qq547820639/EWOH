import { dataUrlToBlob, dataUrlToFile } from './attachmentDataUrl';

describe('attachment data URL helpers', () => {
  it('decodes base64 data URLs back to the original bytes', async () => {
    const blob = dataUrlToBlob('data:text/plain;base64,aGVsbG8=');
    expect(blob.type).toBe('text/plain');
    await expect(blob.text()).resolves.toBe('hello');
  });

  it('restores a File with the provided name and content type', () => {
    const file = dataUrlToFile(
      'data:image/jpeg;base64,aGVsbG8=',
      'scratch.jpg',
      'image/jpeg',
    );
    expect(file.name).toBe('scratch.jpg');
    expect(file.type).toBe('image/jpeg');
  });
});
