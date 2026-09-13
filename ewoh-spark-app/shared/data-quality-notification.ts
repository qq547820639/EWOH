/**
 * data-quality-notification.ts — 数据质量"待核实"提醒的契约（NO-53a，纯函数）。
 *
 * 补的缺口（对齐表 §3 第 1 项，感知层最大缺口）：
 *   摄入侧早就会自动分级数据质量（good/degraded/invalid）并对可疑数据开
 *   `DataQualityAlert`，人工也能在班次工作台确认/质疑——但**没有人被主动叫到**：
 *   告警只是安静地躺在事件表里，直到有人恰好打开页面。于是"数据不可信"这一事实
 *   既没有时效、也没有责任人，闭环的第②步（系统确认数据质量）是断的。
 *
 * 本模块只做判定与身份（可单测、无 IO）：
 *   · 通知号前缀/桶（确定性、可幂等、可被治理度量分类）；
 *   · 告警码 → 中文文案（封闭词表；未登记码原样透出，不猜）；
 *   · 按严重度决定"该叫哪些角色"（责任人由 NO-49a 的班次路由另行解析）。
 */

/** 数据质量提醒的通知号前缀（处置侧据此把范围钉死到"这条告警的提醒"）。 */
export function dataQualityNotificationPrefix(alertEventId: string): string {
  return `NTF-DQ-${String(alertEventId ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)}-`;
}

/**
 * 提醒桶（封闭词表）：
 *   · `quality_alert` 告警刚产生（请核实这批数据能不能用于决策）；
 *   · `quality_aging` 长时间没人核实 → **再催一次**（NO-56b 起真实写入方：
 *     `DataQualityNotificationService.sweep` 对超过 `DATA_QUALITY_AGING_THRESHOLD_MS`
 *     仍未了结的告警补发 aging 桶提醒；两个桶同时存在时是"催了但还没人处理"的事实）。
 */
export const DATA_QUALITY_NOTIFICATION_BUCKETS = ['quality_alert', 'quality_aging'] as const;
/** 超过该时长仍未了结 → 补发 `quality_aging`（默认 24h；"催一次"而不是每小时刷屏）。 */
export const DATA_QUALITY_AGING_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export type DataQualityNotificationBucket = (typeof DATA_QUALITY_NOTIFICATION_BUCKETS)[number];

/** 已知告警码的中文文案（封闭词表）。 */
const ALERT_CODE_LABELS: Record<string, string> = {
  ENTITY_NOT_FOUND: '上报的实体未登记（无法确定数据属于哪台设备/工位）',
  CLOCK_DRIFT: '设备时钟漂移（时间戳不可信）',
  BATTERY_OUT_OF_RANGE: '电量读数越界（超出物理可能范围）',
  QUALITY_DEGRADED: '数据质量降级（不满足决策口径）',
  DUPLICATE_RECORD: '重复记录（同一记录被多次上报）',
};

/** 告警码 → 人话；未登记码原样透出（不把未知翻译成已知结论）。 */
export function dataQualityAlertLabel(code: string | null | undefined): string {
  const key = String(code ?? '').trim();
  if (key === '') return '数据质量告警（未记录告警码）';
  return ALERT_CODE_LABELS[key] ?? key;
}

/** 该告警是否必须叫人核实（低风险计数类只落账、不打扰）。 */
export function requiresHumanVerification(code: string | null | undefined): boolean {
  const key = String(code ?? '').trim();
  if (key === '') return true; // 码缺失 = 不知道严重性 → 宁可叫一次
  // 已知码全部需要人核实；未来若加入纯计数类码，在这里显式排除。
  return true;
}

/**
 * 按严重度决定角色收件人（责任人由班次路由另行加入）。
 *
 * `critical/high` → 安全员 + 班组长（数据不可信会直接影响安全判定与派工）；
 * `medium/low/unknown` → 班组长（现场先看，必要时升级）。
 */
export function dataQualityRoleRecipients(severity: string | null | undefined): string[] {
  const key = String(severity ?? '').trim().toLowerCase();
  if (key === 'critical' || key === 'high') return ['safety_admin', 'workshop_lead'];
  return ['workshop_lead'];
}

/** 提醒文案（含"该做什么"与影响面，避免只报事实不给出路）。 */
export function dataQualityAlertText(params: {
  code: string | null;
  deviceId: string | null;
  title: string | null;
  severity: string | null;
  firedAt: string | null;
}): { title: string; body: string } {
  const label = dataQualityAlertLabel(params.code);
  const scope = params.deviceId ? `设备 ${params.deviceId}` : '未关联设备';
  return {
    title: `数据质量待核实：${label}`,
    body:
      `${scope} 的数据质量告警需要人核实（${label}）`
      + `｜告警码 ${String(params.code ?? '未记录')}｜严重度 ${String(params.severity ?? '未记录')}`
      + `｜触发时间 ${String(params.firedAt ?? '未记录')}`
      + (params.title ? `｜原始描述 ${params.title}` : '')
      + '｜请在工作台确认"可信（可用于决策）"或标记"不可信（相关决策需复核）"——'
      + '判定前这批数据不会被当作确定事实，也不会自动消失。',
  };
}
