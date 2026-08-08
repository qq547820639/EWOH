/* v0.7 B1：ingest 设备故障/离线转换 → DEVICE_OFFLINE 重排触发逻辑测试
 * 覆盖纯函数 IngestService.isFaultTransition：
 *   - 正常 → 携带故障码：转换发生（触发重排）
 *   - 已有故障码：不重复触发
 *   - 离线状态恢复（无故障码）：不触发
 *   - 首次接入（无既有行）：不触发
 */
/// <reference types="jest" />
import { IngestService } from '../ingest.service';

describe('v0.7 B1: isFaultTransition（设备离线转换判定）', () => {
  it('此前正常（无故障码且在线）+ 新帧带故障码 → 转换发生', () => {
    expect(IngestService.isFaultTransition(null, true, 'E1001')).toBe(true);
    expect(IngestService.isFaultTransition('', 1, 'E1001')).toBe(true);
  });

  it('此前已有故障码 + 新帧带故障码 → 不重复触发', () => {
    expect(IngestService.isFaultTransition('E1001', true, 'E1001')).toBe(false);
    expect(IngestService.isFaultTransition('E1001', false, 'E1002')).toBe(false);
  });

  it('此前在线但新帧无故障码 → 不触发', () => {
    expect(IngestService.isFaultTransition(null, true, null)).toBe(false);
    expect(IngestService.isFaultTransition(null, true, '')).toBe(false);
  });

  it('此前离线（online=false）→ 即使新帧带故障码也不视为"转换"（已离线）', () => {
    expect(IngestService.isFaultTransition(null, false, 'E1001')).toBe(false);
    expect(IngestService.isFaultTransition('', 0, 'E1001')).toBe(false);
  });

  it('首次接入（无既有行 → faultCode undefined / online undefined）→ 不触发', () => {
    expect(IngestService.isFaultTransition(undefined, undefined, 'E1001')).toBe(false);
  });
});
