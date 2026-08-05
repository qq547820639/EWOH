import {
  decryptString,
  encryptString,
  exportCryptoKey,
  generateCryptoKey,
  importCryptoKey,
  SensitiveCipher,
  supportsWebCrypto,
} from './offlineCrypto';

describe('offlineCrypto (real AES-GCM encryption)', () => {
  beforeAll(() => {
    // Node 22 exposes globalThis.crypto.subtle; skip if genuinely unavailable.
    if (!supportsWebCrypto()) {
      throw new Error(
        'WebCrypto unavailable in this environment — offlineCrypto tests cannot run here',
      );
    }
  });

  it('encrypts and decrypts a string round-trip', async () => {
    const key = await generateCryptoKey();
    const ciphertext = await encryptString(key, 'exception: scratch on frame 3');
    const plaintext = await decryptString(key, ciphertext);
    expect(plaintext).toBe('exception: scratch on frame 3');
  });

  it('produces a fresh IV so identical plaintexts never encrypt the same', async () => {
    const key = await generateCryptoKey();
    const a = await encryptString(key, 'same');
    const b = await encryptString(key, 'same');
    expect(a).not.toBe(b);
    // Both still decrypt to the same value.
    expect(await decryptString(key, a)).toBe(await decryptString(key, b));
  });

  it('export/import round-trips a usable key', async () => {
    const key = await generateCryptoKey();
    const exported = await exportCryptoKey(key);
    const imported = await importCryptoKey(exported);
    const ciphertext = await encryptString(imported, 'device-transfer');
    expect(await decryptString(key, ciphertext)).toBe('device-transfer');
  });

  it('rotate re-encrypts blobs under a fresh key', async () => {
    const cipher = new SensitiveCipher();
    const blobA = await cipher.encrypt('alpha');
    const blobB = await cipher.encrypt('beta');
    const { newKeyExport, reencrypted } = await cipher.rotate([
      { ref: 'a', ciphertext: blobA },
      { ref: 'b', ciphertext: blobB },
    ]);
    expect(newKeyExport).toBeTruthy();
    expect(reencrypted).toHaveLength(2);
    const rotated = new SensitiveCipher(newKeyExport);
    const a = reencrypted.find((b) => b.ref === 'a')!;
    const b = reencrypted.find((b) => b.ref === 'b')!;
    expect(await rotated.decrypt(a.ciphertext)).toBe('alpha');
    expect(await rotated.decrypt(b.ciphertext)).toBe('beta');
  });

  it('destroy drops the in-memory key (logout/device-loss) so ciphertext is unreadable', async () => {
    const cipher = new SensitiveCipher();
    const ciphertext = await cipher.encrypt('secret');
    expect(cipher.hasKey()).toBe(true);
    cipher.destroy();
    expect(cipher.hasKey()).toBe(false);
    // A fresh cipher with no key export cannot decipher the old blob.
    const fresh = new SensitiveCipher();
    await expect(fresh.decrypt(ciphertext)).rejects.toThrow();
  });
});