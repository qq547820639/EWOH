/* 执行机构（AGV/PLC）契约（NO-59b）——平台侧口径。
 *
 * 与边缘侧唯一事实源逐项一致：
 *   `src/edge_platform/edge/adapters/actuator/protocol.py`
 * （状态词表 / 命令词表 / 高危命令 / 授权号前缀）。跨语言一致性由
 * `shared/actuator.spec.ts` 直接读该文件比对，改一侧不改另一侧立刻失败。
 *
 * 为什么需要平台侧契约：执行层此前只有"能力声明 + 控制命令台账"，没有执行机构
 * 自身的状态/位置进入世界模型；边缘适配器上行后，平台必须用**同一套**状态词表
 * 解析，否则页面会把 `moving` 显示成未知、把 `fault` 当成在线。
 */

export const ACTUATOR_STATES = ['idle', 'moving', 'arrived', 'paused', 'fault', 'offline'] as const;
export type ActuatorState = (typeof ACTUATOR_STATES)[number];

export const ACTUATOR_COMMAND_KEYS = [
  'dispatch_task',
  'pause',
  'resume',
  'return_to_dock',
  'stop',
  'clear_fault',
] as const;

/** 高危命令：会让人机共享空间里的设备动起来 / 解除安全停机 → 必须有平台授权号。 */
export const ACTUATOR_HIGH_RISK_COMMANDS = ['dispatch_task', 'resume', 'clear_fault'] as const;

/** 安全命令：`stop` 永远不要求授权号（安全停机不被审批链卡住）。 */
export const ACTUATOR_SAFETY_COMMANDS = ['stop'] as const;

/** 授权号前缀白名单（规范身份引用：控制请求 / 审批 / 方案 / 任务）。 */
export const AUTHORIZATION_REF_PREFIXES = ['control:', 'approval:', 'plan:', 'task:'] as const;

/**
 * 下行投递优先级（NO-62b）：**数字越小越先投递给网关**。
 *
 * 为什么需要：平台 `GET /api/control/commands/pending` 此前一律 `sentAt ASC` +
 * `limit`——一条排队中的 `stop`（安全停机）会被前面几十条 `dispatch_task`
 * 挤到窗口之外，现场按下急停却要等前面的搬运命令投完才生效。安全动作必须
 * **插队**，这不是体验优化而是安全语义（原则 4/8）。
 *
 * 排序依据（从"减少能量/运动"到"发起运动"）：
 *   0 stop            安全停机——永远第一，且不需要授权号；
 *   1 pause           就地暂停（降低运动风险，非高危）；
 *   2 return_to_dock  空载回库（不承接新任务，风险可控）；
 *   3 clear_fault     解除安全停机状态（高危，但优先于"让它动起来"）；
 *   4 resume          恢复被暂停的运动（高危）；
 *   5 dispatch_task   发起新的搬运（高危，风险面最大 → 最后）。
 *
 * 未登记的命令键返回 {@link UNKNOWN_COMMAND_PRIORITY}（排在已登记命令之后，
 * 且**不静默当作普通优先级**——调用方必须能看出"这条命令没有优先级定义"）。
 */
export const ACTUATOR_COMMAND_PRIORITY: Readonly<Record<string, number>> = {
  stop: 0,
  pause: 1,
  return_to_dock: 2,
  clear_fault: 3,
  resume: 4,
  dispatch_task: 5,
};

/** 未登记命令键的优先级（大数 = 最后投递；不是 0，不能靠"未知"插队）。 */
export const UNKNOWN_COMMAND_PRIORITY = 99;

/** 优先级 → 现场可读标签（页面/日志同源）。 */
export const ACTUATOR_COMMAND_PRIORITY_LABELS: Readonly<Record<number, string>> = {
  0: '安全优先',
  1: '降险优先',
  2: '回库',
  3: '解除停机',
  4: '恢复运动',
  5: '发起搬运',
  99: '未定义优先级',
};

/** 取命令键的投递优先级（未知键 → {@link UNKNOWN_COMMAND_PRIORITY}）。 */
export function actuatorCommandPriority(commandKey: unknown): number {
  const key = String(commandKey ?? '').trim();
  return ACTUATOR_COMMAND_PRIORITY[key] ?? UNKNOWN_COMMAND_PRIORITY;
}

export function actuatorCommandPriorityLabel(commandKey: unknown): string {
  return (
    ACTUATOR_COMMAND_PRIORITY_LABELS[actuatorCommandPriority(commandKey)] ??
    ACTUATOR_COMMAND_PRIORITY_LABELS[UNKNOWN_COMMAND_PRIORITY]
  );
}

/**
 * 授权范围指纹（NO-62a）——把"这条命令到底被授权做了什么"固化成一个短串。
 *
 * 覆盖范围（缺一不可）：协议版本 / 控制请求号 / 目标设备 / 命令键 /
 * 审批实例号 / 命令参数。任意一项在审批之后被改写（换设备、换工位、换命令、
 * 换审批），指纹就对不上 → 投递与回执两侧都 fail-closed。
 *
 * 诚实边界：这是**一致性指纹（FNV-1a 64 位）**，用于发现"授权范围被改写/漂移"，
 * 不是防伪签名——持有平台 ingest key 的网关理论上可以自算一个指纹。真实产线
 * 应把它升级为每设备密钥的 HMAC（`authorizationFingerprintV2` 预留），
 * 本函数保持纯函数、无依赖，便于平台与边缘 Python 两侧逐位一致。
 */
export const AUTHORIZATION_FINGERPRINT_ALGO = 'fnv1a64:v1';

/** 规范化 JSON：对象键递归排序、无空白、UTF-8 原样（与 Python json.dumps(sort_keys=True) 一致）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return 'null';
}

/**
 * NO-65a：**签名的授权范围指纹（v2）**——把"一致性校验"升级为"防伪凭证"。
 *
 * v1（`fnv1a64`）只能发现**偶然**的范围漂移；任何持有边缘 ingest key 的一方都能自己
 * 算出一个"看起来对"的指纹（算法公开、无密钥）。真实产线上这就是一条伪造通道：
 * 谁能给网关送一条命令，谁就能让它通过指纹复核。
 *
 * v2 用**平台侧密钥**做 HMAC-SHA256（截断 128 位十六进制），材料与 v1 同构但域分隔：
 *   `hmac-sha256:v2:<hex32>`，材料 = `sha256|requestId|deviceId|commandKey|approvalInstanceId|canonicalJson(payload)`
 * 边缘**持有同一密钥**（部署配置）即可**验证**签名——验不过就不碰设备（fail-closed）。
 * 密钥缺失时的行为见 `verifyAuthorizationFingerprint`（绝不假装验过）。
 */
export const AUTHORIZATION_FINGERPRINT_ALGO_V2 = 'hmac-sha256:v2';
/** v2 指纹前缀（判断一条已存指纹用的是哪套方案）。 */
export const AUTHORIZATION_FINGERPRINT_V2_PREFIX = `${AUTHORIZATION_FINGERPRINT_ALGO_V2}:`;

/** v2 签名的规范材料（与 v1 不同域，避免跨方案混淆）。 */
export function authorizationFingerprintMaterial(scope: AuthorizationScopeInput): string {
  return [
    'sha256',
    String(scope.requestId ?? ''),
    String(scope.deviceId ?? ''),
    String(scope.commandKey ?? ''),
    String(scope.approvalInstanceId ?? ''),
    canonicalJson(scope.payload ?? null),
  ].join('|');
}

/**
 * 计算 v2 签名指纹（HMAC-SHA256，截断 128 位）。
 *
 * 依赖注入 `hmac` 而非直接 import node:crypto：本文件同时被**客户端**打包
 * （方案卡片/执行态势展示指纹），客户端没有也不该有密钥——签名只发生在服务端与边缘，
 * 客户端只做"显示/比对前缀"这类无密钥操作。
 */
export function authorizationFingerprintV2(
  scope: AuthorizationScopeInput,
  secret: string,
  hmac: (secret: string, material: string) => string,
): string {
  const key = String(secret ?? '');
  if (key.trim() === '') {
    throw new Error('authorizationFingerprintV2: 密钥为空（不得用空密钥签名）');
  }
  const digest = hmac(key, authorizationFingerprintMaterial(scope));
  return `${AUTHORIZATION_FINGERPRINT_V2_PREFIX}${String(digest).toLowerCase().slice(0, 32)}`;
}

/** 是否为 v2（签名）指纹。 */
export function isSignedAuthorizationFingerprint(value: unknown): boolean {
  return String(value ?? '').startsWith(AUTHORIZATION_FINGERPRINT_V2_PREFIX);
}

/** FNV-1a 64 位（十六进制小写，16 字符）；平台与边缘两侧同一实现。 */
export function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export interface AuthorizationScopeInput {
  requestId: unknown;
  deviceId: unknown;
  commandKey: unknown;
  approvalInstanceId?: unknown;
  payload?: unknown;
}

/** 计算授权范围指纹（输入缺项按空串/null 参与，**不抛异常**——判定由调用方做）。 */
export function authorizationFingerprint(scope: AuthorizationScopeInput): string {
  const material = [
    AUTHORIZATION_FINGERPRINT_ALGO,
    String(scope.requestId ?? ''),
    String(scope.deviceId ?? ''),
    String(scope.commandKey ?? ''),
    String(scope.approvalInstanceId ?? ''),
    canonicalJson(scope.payload ?? null),
  ].join('|');
  return fnv1a64Hex(material);
}

const STATE_SET: ReadonlySet<string> = new Set(ACTUATOR_STATES);
const COMMAND_SET: ReadonlySet<string> = new Set(ACTUATOR_COMMAND_KEYS);

/** 是否为词表内状态（未知状态必须被调用方显式处理，不许当成 idle）。 */
export function isActuatorState(value: unknown): value is ActuatorState {
  return typeof value === 'string' && STATE_SET.has(value);
}

export function isActuatorCommandKey(value: unknown): boolean {
  return typeof value === 'string' && COMMAND_SET.has(value);
}

export function requiresAuthorization(commandKey: unknown): boolean {
  return (ACTUATOR_HIGH_RISK_COMMANDS as readonly string[]).includes(String(commandKey ?? ''));
}

export function isSafetyCommand(commandKey: unknown): boolean {
  return (ACTUATOR_SAFETY_COMMANDS as readonly string[]).includes(String(commandKey ?? ''));
}

/** 授权号形状校验（前缀白名单；存在性由平台控制请求台账负责）。 */
export function authorizationRefValid(ref: unknown): boolean {
  const value = String(ref ?? '').trim();
  if (value === '') return false;
  return AUTHORIZATION_REF_PREFIXES.some((prefix) => value.toLowerCase().startsWith(prefix));
}

/** 中文展示名（页面/日志同源；未知状态原样透出，不猜）。 */
export const ACTUATOR_STATE_LABELS: Readonly<Record<string, string>> = {
  idle: '空闲',
  moving: '移动中',
  arrived: '已到达',
  paused: '已暂停',
  fault: '故障',
  offline: '离线',
};

export function actuatorStateLabel(value: unknown): string {
  const key = String(value ?? '').trim();
  if (key === '') return '未知状态';
  return ACTUATOR_STATE_LABELS[key] ?? key;
}
