/* 执行机构契约 ↔ 边缘实现 跨语言对账（NO-59b）。
 *
 * 为什么这样测：状态/命令词表是**跨运行时**的（平台解析边缘上行的帧），
 * 两侧各写一份必然漂移。这里直接读边缘的唯一事实源（Python 文件）文本比对，
 * 改一侧不改另一侧立刻失败——与 `shared/reject-reason.spec.ts` 读源码同款做法。
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACTUATOR_COMMAND_KEYS,
  ACTUATOR_COMMAND_PRIORITY,
  ACTUATOR_HIGH_RISK_COMMANDS,
  ACTUATOR_SAFETY_COMMANDS,
  ACTUATOR_STATES,
  AUTHORIZATION_FINGERPRINT_ALGO,
  AUTHORIZATION_REF_PREFIXES,
  UNKNOWN_COMMAND_PRIORITY,
  actuatorCommandPriority,
  actuatorCommandPriorityLabel,
  actuatorStateLabel,
  authorizationFingerprint,
  authorizationFingerprintMaterial,
  authorizationFingerprintV2,
  authorizationRefValid,
  isSignedAuthorizationFingerprint,
  canonicalJson,
  fnv1a64Hex,
  isActuatorState,
  isSafetyCommand,
  requiresAuthorization,
} from './actuator';

const REPO_ROOT = resolve(__dirname, '..', '..');
const PY = readFileSync(
  resolve(REPO_ROOT, 'src', 'edge_platform', 'edge', 'adapters', 'actuator', 'protocol.py'),
  'utf8',
);

function pyTuple(name: string): string[] {
  const match = new RegExp(`${name}\\s*=\\s*\\(([^)]*)\\)`, 's').exec(PY);
  if (!match) throw new Error(`未在边缘实现里找到 ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('执行机构契约 ↔ 边缘实现', () => {
  it('状态词表逐项一致', () => {
    expect([...ACTUATOR_STATES]).toEqual(pyTuple('ACTUATOR_STATES'));
  });

  it('命令词表逐项一致', () => {
    expect([...ACTUATOR_COMMAND_KEYS]).toEqual(pyTuple('ACTUATOR_COMMANDS'));
  });

  it('高危命令与安全命令逐项一致', () => {
    expect([...ACTUATOR_HIGH_RISK_COMMANDS]).toEqual(pyTuple('ACTUATOR_HIGH_RISK_COMMANDS'));
    expect([...ACTUATOR_SAFETY_COMMANDS]).toEqual(pyTuple('ACTUATOR_SAFETY_COMMANDS'));
  });

  it('授权号前缀白名单一致', () => {
    expect([...AUTHORIZATION_REF_PREFIXES]).toEqual(pyTuple('AUTHORIZATION_REF_PREFIXES'));
  });

  it('高危命令必须有授权、stop 是安全命令（两侧同一判定）', () => {
    for (const key of ACTUATOR_HIGH_RISK_COMMANDS) {
      expect(requiresAuthorization(key)).toBe(true);
      expect(isSafetyCommand(key)).toBe(false);
    }
    expect(requiresAuthorization('stop')).toBe(false);
    expect(isSafetyCommand('stop')).toBe(true);
    expect(requiresAuthorization('pause')).toBe(false);
  });

  it('状态判定与展示：未知状态原样透出（不猜成 idle）', () => {
    expect(isActuatorState('moving')).toBe(true);
    expect(isActuatorState('MOVING')).toBe(false);
    expect(isActuatorState('teleporting')).toBe(false);
    expect(actuatorStateLabel('arrived')).toBe('已到达');
    expect(actuatorStateLabel('teleporting')).toBe('teleporting');
    expect(actuatorStateLabel('')).toBe('未知状态');
  });

  it('授权号形状：白名单前缀 + 非空', () => {
    for (const good of ['control:CR-1', 'approval:AP-1', 'plan:PLAN-1', 'task:TASK-1']) {
      expect(authorizationRefValid(good)).toBe(true);
    }
    for (const bad of ['', '  ', 'CR-1', 'ControlX:1']) {
      expect(authorizationRefValid(bad)).toBe(false);
    }
  });
});

/** 从 Python 源码里解析字面量字典（`NAME = { "k": 1, ... }`）。 */
function pyDict(name: string): Array<[string, number]> {
  const match = new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`, 's').exec(PY);
  if (!match) throw new Error(`未在边缘实现里找到 ${name}`);
  return [...match[1].matchAll(/"([^"]+)"\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]);
}

function pyStringConst(name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(PY);
  if (!match) throw new Error(`未在边缘实现里找到 ${name}`);
  return match[1];
}

describe('执行机构下行优先级与授权指纹 ↔ 边缘实现（NO-62a/b）', () => {
  it('优先级表逐项一致，且覆盖全部命令词表', () => {
    expect(pyDict('ACTUATOR_COMMAND_PRIORITY')).toEqual(Object.entries(ACTUATOR_COMMAND_PRIORITY));
    for (const key of ACTUATOR_COMMAND_KEYS) {
      expect(typeof ACTUATOR_COMMAND_PRIORITY[key]).toBe('number');
    }
    const raw = /UNKNOWN_COMMAND_PRIORITY\s*=\s*(\d+)/.exec(PY);
    expect(raw).not.toBeNull();
    expect(Number(raw?.[1])).toBe(UNKNOWN_COMMAND_PRIORITY);
  });

  it('安全命令必须最先投递，发起运动类命令最后（排序即安全语义）', () => {
    expect(actuatorCommandPriority('stop')).toBe(0);
    expect(actuatorCommandPriority('stop')).toBeLessThan(actuatorCommandPriority('dispatch_task'));
    expect(actuatorCommandPriority('pause')).toBeLessThan(actuatorCommandPriority('resume'));
    expect(actuatorCommandPriority('clear_fault')).toBeLessThan(actuatorCommandPriority('resume'));
    // 未登记命令键排最后，且不静默当成普通优先级
    expect(actuatorCommandPriority('teleport')).toBe(UNKNOWN_COMMAND_PRIORITY);
    expect(actuatorCommandPriority(null)).toBe(UNKNOWN_COMMAND_PRIORITY);
    expect(actuatorCommandPriorityLabel('stop')).toBe('安全优先');
    expect(actuatorCommandPriorityLabel('teleport')).toBe('未定义优先级');
  });

  it('规范化 JSON：键排序 + 中文原样 + null 保留（与 Python json.dumps(sort_keys) 一致）', () => {
    expect(canonicalJson({ b: 1, a: [1, 2, { z: null, y: '中' }], n: null })).toBe(
      '{"a":[1,2,{"y":"中","z":null}],"b":1,"n":null}',
    );
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(7)).toBe('7');
    expect(canonicalJson(1.5)).toBe('1.5');
  });

  it('FNV-1a 64 位：空串基准向量 + 稳定输出', () => {
    // FNV-1a 64 位偏移基准（空输入）
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('a')).toBe(fnv1a64Hex('a'));
    expect(fnv1a64Hex('a')).toHaveLength(16);
  });

  it('授权指纹：与 Python 侧逐位一致（跨语言固定向量）', () => {
    const same = { targetStationId: 'ST-2', taskId: 'T-1' };
    expect(AUTHORIZATION_FINGERPRINT_ALGO).toBe(pyStringConst('AUTHORIZATION_FINGERPRINT_ALGO'));
    expect(
      authorizationFingerprint({
        requestId: 'CR-1',
        deviceId: 'AGV-01',
        commandKey: 'dispatch_task',
        approvalInstanceId: 'AP-9',
        payload: same,
      }),
    ).toBe('3fee66ed288edc16');
    expect(
      authorizationFingerprint({ requestId: 'CR-1', deviceId: 'AGV-01', commandKey: 'stop' }),
    ).toBe('25ed1d2d56bd2bd8');
  });

  it('NO-65a：v2 签名指纹跨语言固定向量（与 Python 侧同一断言）', () => {
    const hmac = (key: string, material: string) =>
      createHmac('sha256', key).update(material).digest('hex');
    const scope = {
      requestId: 'CR-1',
      deviceId: 'AGV-01',
      commandKey: 'dispatch_task',
      approvalInstanceId: 'AP-9',
      payload: { targetStationId: 'ST-2' },
    };
    expect(authorizationFingerprintMaterial(scope)).toBe(
      'sha256|CR-1|AGV-01|dispatch_task|AP-9|{"targetStationId":"ST-2"}',
    );
    expect(authorizationFingerprintV2(scope, 'test-secret', hmac)).toBe(
      'hmac-sha256:v2:906de7f6e09dbd1adb6b5ae99d038876',
    );
    // 篡改任一维度 → 指纹变化（内容不可漂移）
    expect(
      authorizationFingerprintV2(
        { ...scope, payload: { targetStationId: 'ST-3' } },
        'test-secret',
        hmac,
      ),
    ).not.toBe('hmac-sha256:v2:906de7f6e09dbd1adb6b5ae99d038876');
    // 换密钥 → 指纹变化（无密钥无法伪造）
    expect(authorizationFingerprintV2(scope, 'other-secret', hmac)).not.toBe(
      authorizationFingerprintV2(scope, 'test-secret', hmac),
    );
    // 空密钥必须抛错（不得用空密钥签名）
    expect(() => authorizationFingerprintV2(scope, '  ', hmac)).toThrow();
    expect(isSignedAuthorizationFingerprint('hmac-sha256:v2:abcd')).toBe(true);
    expect(isSignedAuthorizationFingerprint('3fee66ed288edc16')).toBe(false);
  });

  it('授权指纹：请求/设备/命令/审批/参数任一变化都必须变（授权范围不可漂移）', () => {
    const base: {
      requestId: string;
      deviceId: string;
      commandKey: string;
      approvalInstanceId?: string;
      payload?: Record<string, unknown>;
    } = {
      requestId: 'CR-1',
      deviceId: 'AGV-01',
      commandKey: 'dispatch_task',
      approvalInstanceId: 'AP-9',
      payload: { targetStationId: 'ST-2', taskId: 'T-1' },
    };
    const fingerprint = authorizationFingerprint(base);
    const mutations: Array<Partial<typeof base>> = [
      { requestId: 'CR-2' },
      { deviceId: 'AGV-02' },
      { commandKey: 'resume' },
      { approvalInstanceId: 'AP-10' },
      { approvalInstanceId: undefined },
      { payload: { targetStationId: 'ST-3', taskId: 'T-1' } },
      { payload: { targetStationId: 'ST-2', taskId: 'T-2' } },
      { payload: {} },
    ];
    for (const mutation of mutations) {
      expect(authorizationFingerprint({ ...base, ...mutation })).not.toBe(fingerprint);
    }
    // 键序不同不算变化（规范化 JSON 保证）
    expect(
      authorizationFingerprint({ ...base, payload: { taskId: 'T-1', targetStationId: 'ST-2' } }),
    ).toBe(fingerprint);
  });
});
