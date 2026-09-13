import { createHmac } from 'node:crypto';
import {
  ACTUATOR_COMMAND_KEYS,
  authorizationFingerprint,
  authorizationFingerprintV2,
  isSignedAuthorizationFingerprint,
  type AuthorizationScopeInput,
} from '@shared/actuator';

/**
 * NO-65a：命令授权指纹的**签发与复核**（服务端唯一实现）。
 *
 * 方案选择（显式，不隐式降级）：
 * - 配置了 `EWOH_CONTROL_FINGERPRINT_SECRET` → 用 **v2（HMAC-SHA256，截断 128 位）**；
 * - 未配置 → 用 v1（FNV-1a 一致性指纹），并在启动日志里**如实告警**：
 *   v1 只能发现偶然漂移，任何持有 ingest key 的一方能算出"看起来对"的指纹。
 * - 复核时**按已存指纹的方案**重算（前缀判断），两侧必须同方案：
 *   v2 行缺密钥 → 显式失败（`FINGERPRINT_SECRET_MISSING`），**绝不**退回 v1 假装验过。
 */

export const FINGERPRINT_ALGO_V1 = 'fnv1a64:v1';

export interface CommandAuthorizationScope extends AuthorizationScopeInput {}

/**
 * 复核结论（**单一形状**，不用可辨识联合）。
 *
 * 为什么：server 侧 `tsconfig.node.json` 是 `strict:false`（`strictNullChecks` 关闭），
 * TS 会把 `ok: true | false` 归一成 `boolean` → 联合不可辨识、`if (!v.ok)` 收窄失效
 * （NO-62a 已踩过一次，见 `DeliveryAuthorizationVerdict`）。
 */
export interface FingerprintVerdict {
  ok: boolean;
  /** 通过时的期望指纹（存量行补写用）。 */
  expected: string;
  reason: 'fingerprint_mismatch' | 'fingerprint_key_missing' | null;
  detail: string | null;
}

export interface FingerprintSigner {
  /** 当前签发方案（v1/v2），用于日志与可观测性。 */
  readonly scheme: typeof FINGERPRINT_ALGO_V1 | 'hmac-sha256:v2';
  /** 按当前方案签发。 */
  sign(scope: CommandAuthorizationScope): string;
  /** 按**已存指纹的方案**复核；`stored` 为空表示存量行（允许补写）。 */
  verify(stored: string | null | undefined, scope: CommandAuthorizationScope): FingerprintVerdict;
}

/**
 * NO-66b：**密钥轮换窗口**。
 *
 * 轮换期间的现实约束：平台已经用旧密钥签发的命令（在飞/排队中）必须仍能被复核通过，
 * 否则一次轮换就会把现场正在执行的命令判成"签名不符"并撤回。因此复核接受
 * `[当前密钥, 上一个密钥]`，而**签发只用当前密钥**。
 *
 * 诚实边界：`previous` 与 `current` 相同（或为空）时不得放宽——脚本/配置错误不能被
 * "当成轮换中"静默吸收；轮换窗口应当**有期限**（见 runbook：切完并在飞命令清零后
 * 立即移除 `_PREVIOUS`）。
 */
export function createFingerprintSigner(
  secret: string | null | undefined,
  previousSecret?: string | null,
): FingerprintSigner {
  const key = String(secret ?? '').trim();
  const previousKey = String(previousSecret ?? '').trim();
  const rotationKeys = key !== '' && previousKey !== '' && previousKey !== key ? [previousKey] : [];
  const signV2 = (scope: CommandAuthorizationScope) =>
    authorizationFingerprintV2(scope, key, (k, material) =>
      createHmac('sha256', k).update(material).digest('hex'),
    );
  return {
    scheme: key === '' ? FINGERPRINT_ALGO_V1 : 'hmac-sha256:v2',
    sign(scope) {
      return key === '' ? authorizationFingerprint(scope) : signV2(scope);
    },
    verify(stored, scope) {
      const value = String(stored ?? '').trim();
      const matchesRotation = (expected: string) => {
        if (expected === value) return true;
        if (rotationKeys.length === 0) return false;
        return rotationKeys.some((oldKey) =>
          authorizationFingerprintV2(scope, oldKey, (k, material) =>
            createHmac('sha256', k).update(material).digest('hex'),
          ) === value,
        );
      };
      if (value === '') {
        // 存量行：复核通过即补写（迁移语义），由调用方负责落库。
        return {
          ok: true,
          expected: key === '' ? authorizationFingerprint(scope) : signV2(scope),
          reason: null,
          detail: null,
        };
      }
      if (isSignedAuthorizationFingerprint(value)) {
        if (key === '') {
          return {
            ok: false,
            expected: '',
            reason: 'fingerprint_key_missing',
            detail:
              '命令带有签名指纹（hmac-sha256:v2），但本实例未配置 EWOH_CONTROL_FINGERPRINT_SECRET：'
              + '无法验证签名，拒绝投递（fail-closed，不退回无密钥的一致性校验）',
          };
        }
        const expected = signV2(scope);
        if (matchesRotation(expected)) {
          return { ok: true, expected, reason: null, detail: null };
        }
        return {
          ok: false,
          expected,
          reason: 'fingerprint_mismatch',
          detail: `签名指纹不符（存 ${value.slice(-16)}；算 ${expected.slice(-16)}）`,
        };
      }
      // v1 存量行：按 v1 复核（同方案比较）。
      const expected = authorizationFingerprint(scope);
      return expected === value
        ? { ok: true, expected, reason: null, detail: null }
        : {
            ok: false,
            expected,
            reason: 'fingerprint_mismatch',
            detail: `一致性指纹不符（存 ${value.slice(0, 16)}；算 ${expected.slice(0, 16)}）`,
          };
    },
  };
}

/** 命令键词表导出（供需要与边缘对账的调用方复用同一来源）。 */
export { ACTUATOR_COMMAND_KEYS };
