/* 设备能力推导（SSOT helper，Phase 1 / P1-T2）。
 *
 * 背景（docs/scheduler-commandmap-upgrade/01-current-state-review.md §4.1）：
 * world-state 与 resource-projection 两处此前各自按 deviceModel 白名单派生设备能力，
 * 语义不一致。本 helper 收敛唯一的派生兜底逻辑：
 *   - ewoh_device.capabilities 列有值时，两服务一律读列（真实能力）；
 *   - 列无值（旧行/未回填）时，才按型号白名单派生并带 derived 标记。
 */

/** 从设备型号白名单派生能力集合（仅作无列值时的兜底，绝不替代真实列）。
 * 未命中返回空数组（视为无能力声明，不误判）。 */
export function deriveDeviceCapabilities(deviceModel: string | null): string[] {
  const m = (deviceModel ?? '').toLowerCase();
  if (!m) return [];
  const caps: string[] = [];
  if (m.includes('exo') || m.includes('pro') || m.includes('外骨骼')) {
    caps.push('exo-lift');
  }
  if (m.includes('lite')) caps.push('exo-lite');
  if (m.includes('vacuum') || m.includes('吸')) caps.push('vacuum');
  if (m.includes('crane') || m.includes('吊')) caps.push('crane');
  return caps;
}
