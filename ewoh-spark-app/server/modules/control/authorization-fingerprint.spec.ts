import { createHmac } from 'node:crypto';
import { authorizationFingerprint } from '@shared/actuator';
import { createFingerprintSigner } from './authorization-fingerprint';

/**
 * NO-65a：授权指纹签发/复核（服务端唯一实现）。
 *
 * 这一层的意义：命令投递前的复核必须以**平台密钥**为依据，而不是"算法公开的一致性格式"。
 * 这里锁定三件事：① 配了密钥就用 v2 签发；② 复核按**已存指纹的方案**进行（不跨方案比较）；
 * ③ v2 行缺密钥 → 显式拒绝（`fingerprint_key_missing`），绝不退回无密钥校验。
 */
const SCOPE = {
  requestId: 'CR-1',
  deviceId: 'AGV-01',
  commandKey: 'dispatch_task',
  approvalInstanceId: 'AP-9',
  payload: { targetStationId: 'ST-2' },
};

describe('createFingerprintSigner（NO-65a）', () => {
  it('配了密钥 → v2 签发（与跨语言固定向量一致）', () => {
    const signer = createFingerprintSigner('test-secret');
    expect(signer.scheme).toBe('hmac-sha256:v2');
    expect(signer.sign(SCOPE)).toBe('hmac-sha256:v2:906de7f6e09dbd1adb6b5ae99d038876');
  });

  it('没配密钥 → v1 签发（一致性指纹；不假装是签名）', () => {
    const signer = createFingerprintSigner(undefined);
    expect(signer.scheme).toBe('fnv1a64:v1');
    expect(signer.sign(SCOPE)).toBe(authorizationFingerprint(SCOPE));
  });

  it('复核 v2：内容一致通过；任一维度变化即拒（fingerprint_mismatch）', () => {
    const signer = createFingerprintSigner('test-secret');
    const stored = signer.sign(SCOPE);
    expect(signer.verify(stored, SCOPE)).toMatchObject({ ok: true, reason: null });
    const verdict = signer.verify(stored, { ...SCOPE, payload: { targetStationId: 'ST-9' } });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('fingerprint_mismatch');
  });

  it('换密钥后旧签名必须失效（这是"防伪"与"一致性"的分界）', () => {
    const stored = createFingerprintSigner('test-secret').sign(SCOPE);
    const other = createFingerprintSigner('other-secret');
    expect(other.verify(stored, SCOPE)).toMatchObject({
      ok: false,
      reason: 'fingerprint_mismatch',
    });
  });

  it('v2 行 + 本实例无密钥 → 显式拒绝（fingerprint_key_missing，不退回 v1）', () => {
    const stored = createFingerprintSigner('test-secret').sign(SCOPE);
    const keyless = createFingerprintSigner('');
    expect(keyless.verify(stored, SCOPE)).toMatchObject({
      ok: false,
      reason: 'fingerprint_key_missing',
    });
  });

  it('v1 存量行：仍按 v1 复核（同方案比较，不因升级密钥而误拒历史命令）', () => {
    const legacy = authorizationFingerprint(SCOPE);
    const signer = createFingerprintSigner('test-secret');
    expect(signer.verify(legacy, SCOPE)).toMatchObject({ ok: true, reason: null });
    expect(signer.verify(legacy, { ...SCOPE, commandKey: 'stop' }).ok).toBe(false);
  });

  it('存量空指纹：返回期望值供补写（迁移语义）', () => {
    const signer = createFingerprintSigner('test-secret');
    const verdict = signer.verify(null, SCOPE);
    expect(verdict.ok).toBe(true);
    expect(verdict.expected).toBe(signer.sign(SCOPE));
  });
});

describe('createFingerprintSigner 密钥轮换窗口（NO-66b）', () => {
  const scope = SCOPE;

  it('轮换窗口内：旧密钥签发的命令仍能复核通过（不让在飞命令被误撤回）', () => {
    const oldSigner = createFingerprintSigner('old-secret');
    const rotated = createFingerprintSigner('new-secret', 'old-secret');
    const storedWithOld = oldSigner.sign(scope);
    expect(rotated.scheme).toBe('hmac-sha256:v2');
    expect(rotated.verify(storedWithOld, scope)).toMatchObject({ ok: true, reason: null });
    // 但**签发**只用新密钥（回传的期望值是新密钥的签名）
    expect(rotated.sign(scope)).not.toBe(storedWithOld);
  });

  it('轮换窗口内：新密钥签发的命令同样通过（两侧都能用）', () => {
    const rotated = createFingerprintSigner('new-secret', 'old-secret');
    const storedWithNew = rotated.sign(scope);
    expect(rotated.verify(storedWithNew, scope)).toMatchObject({ ok: true, reason: null });
  });

  it('窗口外（未配 previous）：旧密钥签名必须失效', () => {
    const storedWithOld = createFingerprintSigner('old-secret').sign(scope);
    const current = createFingerprintSigner('new-secret');
    expect(current.verify(storedWithOld, scope)).toMatchObject({
      ok: false,
      reason: 'fingerprint_mismatch',
    });
  });

  it('previous 与 current 相同 → 不放宽（配置错误不得被"当成轮换中"吸收）', () => {
    const stored = createFingerprintSigner('same-secret').sign(scope);
    const signer = createFingerprintSigner('same-secret', 'same-secret');
    expect(signer.verify(stored, scope)).toMatchObject({ ok: true, reason: null });
    // 换一个真正不同的旧密钥才有效：相同值不构成"额外的接受面"
    const other = createFingerprintSigner('other-secret', 'other-secret');
    expect(other.verify(stored, scope).ok).toBe(false);
  });

  it('轮换窗口内仍拒绝被改写的范围（窗口只放宽密钥，不放宽内容）', () => {
    const storedWithOld = createFingerprintSigner('old-secret').sign(scope);
    const rotated = createFingerprintSigner('new-secret', 'old-secret');
    expect(rotated.verify(storedWithOld, { ...scope, commandKey: 'resume' }).ok).toBe(false);
  });
});
