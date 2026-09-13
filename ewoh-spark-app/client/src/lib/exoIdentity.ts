/**
 * 外骨骼会话身份的客户端规范化（ADR-006 / ADR-032 规范身份）。
 *
 * 为什么单独一个纯模块（而不是塞在 `api/exo.ts` 里）：`api/exo.ts` 依赖
 * `lib/http`（内含 `import.meta.env`，只能在 Vite/浏览器下加载），把它拖进单元测试
 * 会因 `import.meta` 解析失败而连测试都跑不起来。纯函数放这里，可被单测覆盖，
 * 也便于别处（移动端/表单）复用同一口径。
 */

/** 规范身份前缀探测：已带任意 `kind:` 前缀的一律原样保留（不猜、不改写调用方声明）。 */
const IDENTITY_PREFIX = /^[a-z][a-z0-9_]*:/;

/**
 * 把页面上的裸 id 规范成契约身份（`device:` / `person:`）。
 *
 * 为什么必须有这一步（2026-09-11 浏览器门禁实测的真实缺陷）：
 * `/exo` 页面的设备下拉用 `ewoh_device.device_id`（如 `EXO-1`）、人员下拉用裸 uuid，
 * 而契约要求会话写入必须是**规范身份**（`device:<id>` / `person:<uuid>`），服务端对
 * 非规范身份 fail-closed → 页面点"开始会话"必然 400 `bad_exo_identity`。
 * 之前没有用例点过这个按钮（只测了结束/中止），所以一直没暴露。
 *
 * 规则：空值原样返回（必填校验在页面与服务端）；已带任意 `kind:` 前缀的原样保留
 * （哪怕前缀不是期望的 kind——那是调用方的声明错误，交给服务端 fail-closed 拒绝，
 * 不在客户端悄悄改写）；裸 id 才补上期望前缀。
 */
export function canonicalExoIdentity(kind: 'device' | 'person', value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return trimmed;
  if (IDENTITY_PREFIX.test(trimmed)) return trimmed;
  return `${kind}:${trimmed}`;
}
