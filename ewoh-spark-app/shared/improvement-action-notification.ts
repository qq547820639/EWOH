/* 前后端共享契约 —— 改进行动项"逾期待办"提醒（NO-56b）。
 *
 * 为什么需要：行动项在 `accepted` 之后如果没人跟进，**只会静默堆积**——
 * 页面上的逾期视图要人主动去看，而"到期未完成"恰恰是最该主动叫人的一类事实。
 * 本契约把它接进统一的提醒/处置体系（与安灯升级、数据质量待核实同一纪律）：
 *   · 通知号确定性：`NTF-ACT-<行动项号>-<桶>-<角色|人>-<收件人>-<渠道>`（重复扫描只累加 duplicates）；
 *   · 收件人 = **负责人账号**（经受控函数从 person 反查）+ 班组长角色兜底；
 *   · 负责人没绑定账号 → 如实进 `unresolvedOwners`，不假装"已经叫到了"；
 *   · 完成/放弃/拒绝时按前缀把提醒落到终态（`action_completed` / `action_dropped`），
 *     与主事实变更**同一事务**——分开提交会出现"事已办完提醒还挂着"。
 */

export const IMPROVEMENT_ACTION_NOTIFICATION_BUCKETS = ['action_overdue'] as const;

/** 提醒标题前缀（页面/治理度量按它识别"这是行动项提醒"）。 */
export const IMPROVEMENT_ACTION_REMINDER_TITLE = '改进行动项逾期未完成';

/** 通知号前缀（含行动项号）：`NTF-ACT-<actionId>-`。 */
export function improvementActionNotificationPrefix(actionId: string): string {
  return `NTF-ACT-${String(actionId ?? '').trim().replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80)}-`;
}

/** 逾期提醒角色兜底：班组长（与其它到期类提醒一致）。 */
export const IMPROVEMENT_ACTION_REMINDER_ROLES = ['workshop_lead'] as const;

export interface ImprovementActionOverdueFacts {
  actionId: string;
  title: string;
  owner: string | null;
  dueAt: string | null;
  acceptanceCriteria: string | null;
  /** 逾期时长（毫秒；无法计算时为 null，不猜）。 */
  overdueMs: number | null;
}

/** 逾期提醒正文：谁负责、判据是什么、逾期多久——"催办"必须带这三件事。 */
export function improvementActionOverdueText(facts: ImprovementActionOverdueFacts): { title: string; body: string } {
  const overdue = facts.overdueMs === null
    ? '逾期时长未知（期限缺失或时间无法解析）'
    : `已逾期 ${Math.max(1, Math.floor(facts.overdueMs / 86_400_000))} 天`;
  const criteria = facts.acceptanceCriteria?.trim() || '未填写验收判据';
  return {
    title: `${IMPROVEMENT_ACTION_REMINDER_TITLE}：${facts.title}`.slice(0, 180),
    body:
      `行动项 ${facts.actionId}（负责人 ${facts.owner?.trim() || '未指派'}）${overdue}。`
      + `验收判据：${criteria}。`
      + '请负责人按判据完成并填写结果说明；若不再需要，请由班组长注明理由后放弃。',
  };
}
