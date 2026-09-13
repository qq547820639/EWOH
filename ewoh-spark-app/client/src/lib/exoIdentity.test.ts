/* 外骨骼会话身份的客户端规范化（2026-09-11 浏览器门禁实测缺陷的回归）。
 *
 * 缺陷：`/exo` 页面用裸业务 id（设备 `EXO-1`、人员 uuid）调 `startExoSession`，
 * 而 ADR-006/ADR-032 要求 **规范身份**（`device:` / `person:`），服务端 fail-closed →
 * 页面点"开始会话"必然 400 `bad_exo_identity`。此前只测了结束/中止，没点过开始。
 */
/// <reference types="jest" />
import { canonicalExoIdentity } from './exoIdentity';

describe('canonicalExoIdentity', () => {
  it('裸业务设备号 / 裸人员 uuid → 补上 kind 前缀', () => {
    expect(canonicalExoIdentity('device', 'EXO-1')).toBe('device:EXO-1');
    expect(canonicalExoIdentity('person', '63000000-0000-4000-8000-000000000001')).toBe(
      'person:63000000-0000-4000-8000-000000000001',
    );
    expect(canonicalExoIdentity('device', '  EXO-2  ')).toBe('device:EXO-2');
  });

  it('已是规范身份 → 原样保留（幂等）', () => {
    expect(canonicalExoIdentity('device', 'device:EXO-1')).toBe('device:EXO-1');
    expect(canonicalExoIdentity('person', 'person:p-1')).toBe('person:p-1');
  });

  it('前缀 kind 不对 → 不悄悄改写（交给服务端 fail-closed 拒绝）', () => {
    expect(canonicalExoIdentity('person', 'device:EXO-1')).toBe('device:EXO-1');
    expect(canonicalExoIdentity('device', 'person:p-1')).toBe('person:p-1');
  });

  it('空值原样返回（必填校验不在这一层）', () => {
    expect(canonicalExoIdentity('device', '')).toBe('');
    expect(canonicalExoIdentity('person', '   ')).toBe('');
    expect(canonicalExoIdentity('device', undefined as never)).toBe('');
  });
});
