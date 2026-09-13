/**
 * plan-freshness.mjs — "过期 → 诊断 → 重排 → 审批"共享助手（NO-62c）。
 *
 * 为什么需要它（不是"顺手抽个工具函数"）：
 * 本开发库常年有数千待排任务 + 后台扫描，**设备遥测新鲜度 60s 而单次求解要数分钟**，
 * 方案到达时快照常常已失效 → `approve` 被 `assertFreshForApprove` **正确**拒绝（409 PLAN_STALE）。
 * 第 61 轮的处置是"记 SKIP 并写明原因"——诚实，但等于"这条腿没验证"。
 * 第 62 轮起产品有了可处置路径（差异诊断 + 一键重排，且 409 带 `planStaleness` 明细），
 * 于是场景可以做**真实处置**：诊断 → 按最新状态重排 → 审批新方案（仍走完整审批链）。
 *
 * 助手只做"重复调用既有 API"，不绕过任何闸门：重排产出的是**新快照上的新方案**，
 * 仍需独立审批人确认；重试有界（`maxRounds`），失败如实返回原因而不是无限重试。
 */

/** 从统一错误信封里取过期诊断（`{ error: { code, message, planStaleness } }`）。 */
export function planStalenessOf(body) {
  const envelope = body?.error ?? body ?? {};
  const report = envelope.planStaleness ?? body?.staleness ?? null;
  return report && typeof report === 'object' ? report : null;
}

/** 是否过期错误（409 + PLAN_STALE；兼容裸状态码与结构化信封两种形状）。 */
export function isPlanStale(status, body) {
  const envelope = body?.error ?? body ?? {};
  const message = String(envelope.message ?? body?.message ?? '');
  return status === 409 && message.includes('PLAN_STALE');
}

/**
 * 审批一个方案；过期则诊断 + 重排 + 审批新方案（有界重试）。
 *
 * @param {{post: Function, get: Function}} http 场景内的 HTTP 助手（签名：post(url, body, token)）
 * @param {object} input
 *   - planId / version / snapshotVersion：初始方案（来自 run 或方案详情）
 *   - operatorToken：发起重排的身份（**必须与审批人不同**：creator ≠ approver）
 *   - approverToken：审批身份
 *   - reason：审批意见
 *   - maxRounds：最多几轮（缺省 3；每轮 = 诊断 + 重排 + 审批一次）
 *   - onDiagnosis：可选回调（把诊断写进场景记录，便于排障）
 *   - beforeReplan：可选回调（重排前补齐现场心跳等前置条件）
 * @returns {Promise<{ok: boolean, status: number, planId: string, version?: number,
 *   snapshotVersion?: string, body: object|null, diagnosis: object|null,
 *   replans: Array<{planId: string, status: number}>, attempts: string[]}>}
 */
export async function approveWithReplan(http, input) {
  const { post, get } = http;
  const maxRounds = Number(input.maxRounds ?? 3);
  const attempts = [];
  const replans = [];
  let planId = String(input.planId ?? '');
  let version = input.version;
  let snapshotVersion = input.snapshotVersion;
  let lastBody = null;
  let lastStatus = 0;
  let diagnosis = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    lastStatus = 0;
    lastBody = null;
    // 审批**不传 `operator`**：确认人以服务端认证主体（ctx.userId）落库，
    // 这是"独立审批"闸门（回执授权）的输入。自报操作者只会出现在审计声明里，
    // 传错还会污染审计可读性（NO-64b）。
    const res = await post(
      `/api/scheduler/plans/${encodeURIComponent(planId)}/approve`,
      {
        version,
        snapshotVersion,
        reason: input.reason ?? 'e2e：审批（含过期处置）',
      },
      input.approverToken,
    );
    lastStatus = res.status;
    lastBody = res.body;
    attempts.push(`r${round}:${planId}:${res.status}`
      + `${isPlanStale(res.status, res.body) ? '(PLAN_STALE)' : ''}`);
    if (res.status === 200 || res.status === 201) {
      return {
        ok: true,
        status: res.status,
        planId,
        version,
        snapshotVersion,
        body: res.body,
        diagnosis,
        replans,
        attempts,
      };
    }
    if (!isPlanStale(res.status, res.body)) {
      // 非过期原因（权限/自批/安全锁定…）：**不重排**，如实返回（重排解决不了这些）
      return {
        ok: false,
        status: res.status,
        planId,
        version,
        snapshotVersion,
        body: res.body,
        diagnosis,
        replans,
        attempts,
      };
    }
    diagnosis = planStalenessOf(res.body) ?? diagnosis;
    if (typeof input.onDiagnosis === 'function' && diagnosis) {
      input.onDiagnosis({ round, planId, diagnosis });
    }
    if (round === maxRounds) break;

    // 重排前的前置条件钩子：现场若需要先把设备/人员心跳补齐（快照要包含新鲜状态），
    // 由调用方在这里做——重排是对**当前世界**重新求解，"让证据先到位"是现场事实，
    // 不是绕过闸门（重排后仍需独立审批）。
    if (typeof input.beforeReplan === 'function') {
      await input.beforeReplan({ round, planId });
    }
    // 一键重排：产出新快照上的新方案（不绕过审批，重排后仍需审批）
    const replanned = await post(
      `/api/scheduler/plans/${encodeURIComponent(planId)}/replan`,
      { operator: input.operator ?? 'e2e-operator', reason: 'e2e：按最新状态重排后重新审批' },
      input.operatorToken ?? input.approverToken,
    );
    const nextPlanId = replanned.body?.planId ?? replanned.body?.plan?.planId ?? null;
    replans.push({ planId: nextPlanId, status: replanned.status });
    attempts.push(`r${round}:replan:${replanned.status}${nextPlanId ? '' : `(${replanned.body?.error?.message ?? ''})`}`);
    if ((replanned.status !== 200 && replanned.status !== 201) || !nextPlanId) break;
    const detail = await get(`/api/scheduler/plans/${encodeURIComponent(nextPlanId)}`, input.operatorToken);
    if (detail.status !== 200 || !detail.body) break;
    planId = nextPlanId;
    version = detail.body.version;
    snapshotVersion = detail.body.snapshotVersion;
  }

  return {
    ok: false,
    status: lastStatus,
    planId,
    version,
    snapshotVersion,
    body: lastBody,
    diagnosis,
    replans,
    attempts,
  };
}

/** 诊断摘要（写进场景记录的一行人话）。 */
export function stalenessSummary(diagnosis) {
  if (!diagnosis) return '（无诊断明细）';
  const changes = Array.isArray(diagnosis.changes) ? diagnosis.changes : [];
  const external = changes.filter((c) => !c.selfInflicted).length;
  const self = changes.filter((c) => c.selfInflicted).length;
  return `${diagnosis.summary ?? ''}（外部 ${external} / 自身 ${self}；snapshotFound=${diagnosis.snapshotFound}）`;
}
