/* 设备能力 ↔ 权威契约 ↔ 边缘帧字段 对账测试（2026-09-10，NO-14e）。
 *
 * 为什么需要：能力台账一旦和"权威契约"或"边缘实际产出的帧字段"漂移，就会变成
 * 一套漂亮但不可信的自述——世界模型据此推导的结论会静默失真（决策原则 7）。
 * 本测试把三条腿钉在一起：
 *
 *  1. **词汇登记**：`shared/device-capability.ts` 登记的能力名必须全部出现在
 *     权威契约 `contracts/capability/capability.schema.json` 的 `knownValues`
 *     （未登记 = 平台"没听说过"的能力名，属于静默漂移）；
 *  2. **三运行时一致**：schema.knownValues === shared/capability.ts
 *     KNOWN_CAPABILITY_VALUES（Python 侧由 audit-domain-contracts 精确比对，
 *     本测试补上 TS 这条腿）；
 *  3. **帧字段对账**：每条能力声明的 `fields` 必须与契约里的
 *     `deviceObservationFields` 完全一致，且这些字段必须真实存在于**平台摄入
 *     DTO**（shared/api.interface.ts）——帧字段改名/删除会立刻让本测试失败。
 */
/// <reference types="jest" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEVICE_CAPABILITY_NAMES,
  capabilityRiskLevel,
  isHighRiskCapability,
  DEVICE_CAPABILITY_SPECS,
  CAPABILITIES_BY_CATEGORY,
  capabilityIdFor,
  capabilitySubject,
} from './device-capability';
import { KNOWN_CAPABILITY_VALUES } from './capability';

const ROOT = resolve(__dirname, '../..'); // ewoh-spark-app/shared → 仓库根
const schema = JSON.parse(
  readFileSync(resolve(ROOT, 'contracts/capability/capability.schema.json'), 'utf8'),
) as {
  knownValues: string[];
  capabilityKinds: string[];
  providerTypes: string[];
  deviceObservationFields: Record<string, string[]>;
  capabilityRiskLevels: string[];
  capabilityRisk: Record<string, string>;
};

describe('设备能力 ↔ Canonical Capability Model 对账', () => {
  it('登记的能力名全部在权威 knownValues 中（未登记即漂移）', () => {
    const missing = DEVICE_CAPABILITY_NAMES.filter((name) => !schema.knownValues.includes(name));
    expect(missing).toEqual([]);
  });

  it('knownValues 三运行时一致（TS 侧；Python 侧由 audit-domain-contracts 仲裁）', () => {
    expect([...KNOWN_CAPABILITY_VALUES].sort()).toEqual([...schema.knownValues].sort());
  });

  it('每条能力的 kind/providerType 都在权威枚举内，且与类别一致', () => {
    for (const [name, spec] of Object.entries(DEVICE_CAPABILITY_SPECS)) {
      expect(schema.capabilityKinds).toContain(spec.kind);
      expect(schema.providerTypes).toContain(spec.providerType);
      const expectedKind = spec.providerType === 'exo' ? 'exo_capability' : 'device_capability';
      expect({ name, kind: spec.kind }).toEqual({ name, kind: expectedKind });
    }
  });

  it('能力声明的 fields 与契约 deviceObservationFields 完全一致', () => {
    for (const name of DEVICE_CAPABILITY_NAMES) {
      expect({ name, fields: [...DEVICE_CAPABILITY_SPECS[name].fields] }).toEqual({
        name,
        fields: schema.deviceObservationFields[name],
      });
    }
    // 反向：契约里登记了但没有实现的能力名 = 契约领先于代码（显式失败而非忽略）
    const orphan = Object.keys(schema.deviceObservationFields).filter(
      (name) => !DEVICE_CAPABILITY_NAMES.includes(name),
    );
    expect(orphan).toEqual([]);
  });

  /* NO-19a：安全等级必须与权威契约逐项一致——放宽高风险能力要求的建议要能识别风险，
   * 靠的就是这张映射（错一项就会把"吊装"当"温度观测"处理）。 */
  it('每条能力的安全等级与契约 capabilityRisk 逐项一致，且无未登记等级', () => {
    for (const name of DEVICE_CAPABILITY_NAMES) {
      expect({ name, risk: DEVICE_CAPABILITY_SPECS[name].risk }).toEqual({
        name,
        risk: schema.capabilityRisk[name],
      });
      expect(schema.capabilityRiskLevels).toContain(DEVICE_CAPABILITY_SPECS[name].risk);
    }
  });

  it('高风险能力与契约一致（exo-lift / interact.assist / crane 为 high）', () => {
    for (const name of ['exo-lift', 'interact.assist', 'crane']) {
      expect(isHighRiskCapability(name)).toBe(true);
      expect(capabilityRiskLevel(name)).toBe('high');
    }
    expect(isHighRiskCapability('observe.temperature')).toBe(false);
    // 未登记能力名 → null（不猜风险；调用方必须显式处理未知）
    expect(capabilityRiskLevel('custom.magic_lift')).toBeNull();
  });

  it('能力字段真实存在于平台摄入 DTO（帧字段改名立刻失败）', () => {
    const dtoSource = readFileSync(resolve(ROOT, 'ewoh-spark-app/shared/api.interface.ts'), 'utf8');
    // 环境传感器 DTO 的字段名（能力 fields 讲边缘统一帧口径 → 平台 DTO 口径映射）
    const envDto = dtoSource.slice(
      dtoSource.indexOf('export interface EnvironmentFrameDto'),
      dtoSource.indexOf('export interface CameraFrameDto'),
    );
    expect(envDto).toContain('temperature?:');
    expect(envDto).toContain('vibration?:');
    expect(envDto).toContain('noise?:');
    expect(envDto).toContain('air_quality?:');
    // 摄像头 DTO 的 detections 子字段
    const camDto = dtoSource.slice(
      dtoSource.indexOf('export interface CameraFrameDto'),
      dtoSource.indexOf('export interface MesOrderDto'),
    );
    expect(camDto).toContain('track_id?:');
    expect(camDto).toContain('confidence:');
    expect(camDto).toContain('skeleton?:');
    expect(camDto).toContain('action?:');
    // 定位 DTO 的坐标字段
    const locDto = dtoSource.slice(
      dtoSource.indexOf('export interface LocationFrameDto'),
      dtoSource.indexOf('export interface LocationFrameDto') + 1200,
    );
    expect(locDto).toContain('x: number');
    expect(locDto).toContain('y: number');
    expect(locDto).toContain('confidence:');
  });

  it('subject 保留设备号大小写（身份不被归一化改写），前缀小写满足契约 pattern', () => {
    const subject = capabilitySubject('ENV-SIM-AbC', 'environment_sensor');
    expect(subject).toBe('device:ENV-SIM-AbC');
    expect(/^[a-z0-9_]+:.+$/.test(subject)).toBe(true);
    expect(capabilitySubject('EXO-9', 'exoskeleton')).toBe('exo:EXO-9');
    expect(capabilityIdFor('ENV-SIM-AbC', 'environment_sensor', 'observe.temperature'))
      .toBe('cap:device:ENV-SIM-AbC:observe.temperature');
  });

  it('每个设备类别的能力集合都由已登记能力组成（不出现"类别指向未登记能力"）', () => {
    for (const [category, names] of Object.entries(CAPABILITIES_BY_CATEGORY)) {
      for (const name of names) {
        expect({ category, name, known: DEVICE_CAPABILITY_NAMES.includes(name) }).toEqual({
          category,
          name,
          known: true,
        });
      }
    }
    // unknown 类别显式无能力（宁可能力为空，也不猜它能看什么）
    expect(CAPABILITIES_BY_CATEGORY.unknown).toEqual([]);
  });
});
