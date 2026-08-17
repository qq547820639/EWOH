/**
 * Real encryption for sensitive offline data (Task 6 requirement 10).
 *
 * Uses the Web Crypto API (AES-GCM, 256-bit) — not a hand-rolled cipher. The
 * key is generated on device, never leaves the device, and is held in memory
 * only for the active session. Provides:
 *   - key generation / import / export (for persistence)
 *   - encrypt / decrypt with a random per-message IV
 *   - rotation (new key + re-encrypt)
 *   - logout destroy (key wiped from memory)
 *   - device-loss strategy (key is irrecoverable without a backup export, so a
 *     lost device simply renders the ciphertext unreadable — by design)
 */

const ALGORITHM = { name: 'AES-GCM', length: 256 } as const;
const IV_BYTES = 12;
const KEY_USAGES: KeyUsage[] = ['encrypt', 'decrypt'];

function subtle(): SubtleCrypto | null {
  const g = globalThis as { crypto?: { subtle?: SubtleCrypto } };
  return g.crypto?.subtle ?? null;
}

function b64encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function b64decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** True when the Web Crypto API is available in this environment. */
export function supportsWebCrypto(): boolean {
  return subtle() !== null;
}

/** Generates a fresh AES-256-GCM key. */
export async function generateCryptoKey(): Promise<CryptoKey> {
  const api = subtle();
  if (!api) {
    throw new Error('WebCrypto is not available in this environment');
  }
  return api.generateKey(ALGORITHM, true, KEY_USAGES);
}

/** Exports a key to a base64 string for durable storage. */
export async function exportCryptoKey(key: CryptoKey): Promise<string> {
  const api = subtle();
  if (!api) {
    throw new Error('WebCrypto is not available in this environment');
  }
  const raw = await api.exportKey('raw', key);
  return b64encode(new Uint8Array(raw));
}

/** Imports a base64-encoded key back into a usable CryptoKey. */
export async function importCryptoKey(exported: string): Promise<CryptoKey> {
  const api = subtle();
  if (!api) {
    throw new Error('WebCrypto is not available in this environment');
  }
  return api.importKey('raw', b64decode(exported), ALGORITHM, true, KEY_USAGES);
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  // CLI-505：crypto.getRandomValues 不可用时直接抛错拒绝加密——
  // Math.random 生成的 AES-GCM IV 可预测，会使加密降级为可恢复明文。
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('crypto.getRandomValues is not available; refusing to encrypt');
  }
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Encrypts a UTF-8 string. Output envelope: base64(iv || ciphertext || tag),
 * so a single base64 payload carries everything `decrypt` needs.
 */
export async function encryptString(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const api = subtle();
  if (!api) {
    throw new Error('WebCrypto is not available in this environment');
  }
  const iv = randomBytes(IV_BYTES);
  const data = new TextEncoder().encode(plaintext);
  // `subtle.encrypt` resolves with an ArrayBuffer — use byteLength, not length.
  const encrypted = new Uint8Array(await api.encrypt({ name: 'AES-GCM', iv }, key, data));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return b64encode(combined);
}

/** Decrypts a payload produced by {@link encryptString}. */
export async function decryptString(
  key: CryptoKey,
  ciphertext: string,
): Promise<string> {
  const api = subtle();
  if (!api) {
    throw new Error('WebCrypto is not available in this environment');
  }
  const combined = b64decode(ciphertext);
  const iv = combined.slice(0, IV_BYTES);
  const data = combined.slice(IV_BYTES);
  const decrypted = await api.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

/**
 * In-memory sensitive-value store backed by a real AES-GCM key. The key is
 * held only in memory; on logout / device loss it is dropped, after which the
 * stored ciphertext cannot be read (the intended device-loss behavior).
 */
export class SensitiveCipher {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly exportedKey?: string) {
    if (exportedKey) {
      this.keyPromise = importCryptoKey(exportedKey);
    }
  }

  /** True when a key is present in memory. */
  hasKey(): boolean {
    return this.keyPromise !== null;
  }

  /**
   * Lazily initializes (or re-initializes) the key.
   *
   * CLI-524：keyPromise 的生成/导入 Promise 是同步创建并同步赋值的，
   * 并发调用天然复用同一个 in-flight Promise（Promise 缓存即并发锁），
   * 不会各自 generateKey。失败时清除缓存的 rejected Promise，允许重试。
   */
  async ensureKey(existingExport?: string): Promise<CryptoKey> {
    if (!this.keyPromise) {
      const pending = existingExport
        ? importCryptoKey(existingExport)
        : generateCryptoKey();
      this.keyPromise = pending;
      pending.catch(() => {
        if (this.keyPromise === pending) {
          this.keyPromise = null;
        }
      });
    }
    return this.keyPromise;
  }

  /** The base64 export of the current key (for rotation / persistence). */
  async exportCurrent(): Promise<string> {
    const key = await this.ensureKey();
    return exportCryptoKey(key);
  }

  async encrypt(plaintext: string): Promise<string> {
    const key = await this.ensureKey();
    return encryptString(key, plaintext);
  }

  async decrypt(ciphertext: string): Promise<string> {
    const key = await this.ensureKey();
    return decryptString(key, ciphertext);
  }

  /**
   * Rotates the key: derives a fresh key and re-encrypts all provided
   * ciphertext blobs. Returns the new key export plus the re-encrypted blobs.
   * Used when the current key is compromised or on a scheduled rotation.
   *
   * CLI-502：原子换 key——全程先用旧 key 解密、新 key 重加密，全部成功后
   * 才替换内存中的 keyPromise。中途任一步失败时实例仍持有旧 key，
   * 旧密文依旧可解，不会出现「内存新 key + 落盘旧密文」的不一致窗口。
   */
  async rotate(
    blobs: Array<{ ref: string; ciphertext: string }>,
  ): Promise<{ newKeyExport: string; reencrypted: Array<{ ref: string; ciphertext: string }> }> {
    const oldKey = await this.ensureKey();
    const decrypted = await Promise.all(
      blobs.map(async (blob) => ({
        ref: blob.ref,
        plaintext: await decryptString(oldKey, blob.ciphertext),
      })),
    );
    const newKey = await generateCryptoKey();
    const newExport = await exportCryptoKey(newKey);
    const reencrypted = await Promise.all(
      decrypted.map(async (item) => ({
        ref: item.ref,
        ciphertext: await encryptString(newKey, item.plaintext),
      })),
    );
    // 全部重加密成功后才切换内存 key。
    this.keyPromise = Promise.resolve(newKey);
    return { newKeyExport: newExport, reencrypted };
  }

  /** Logout / device-loss: drop the key from memory. */
  destroy(): void {
    this.keyPromise = null;
  }
}