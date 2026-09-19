/* 任务就绪推进（契约状态机）—— 方案派工前的现场动作。
 *
 * 为什么需要它（2026-09-13 实测发现）：
 * 契约 `contracts/state-machines/task.yaml` 规定
 *   draft --creator/required_fields_complete--> pending_confirm
 *   pending_confirm --dispatcher/no_approval_required--> pending_dispatch
 *   pending_approval --approver/approved_or_bypassed--> pending_dispatch
 * 必须由 creator / dispatcher / approver **逐步**推进，每一步带自己的条件闸门。
 *
 * 求解器允许把这类任务排进方案（它们确实"可调度"——`TASK_SCHEDULABLE_STATUSES`
 * 含 draft/pending_confirm/pending_approval），于是"方案已审批、任务还没就绪"
 * 是**正常可达状态**：此时 `POST /plans/:id/dispatch` 返回 409
 * `PLAN_TASK_NOT_DISPATCHABLE`，整波不下发（无半成品方案）。这是产品**正确**的
 * fail-closed，**不是**缺陷——派工不得代 creator/approver 越过闸门。
 *
 * 真实调度员遇到这个 409 会去把任务推到待派工再重派。E2E 照做，于是
 * "整波因一条未就绪任务被拒"从环境噪音变成**被验证的工作流**；若产品哪天真的
 * 放开了闸门（不再拒绝），这层推进就会以"无需推进即派工成功"显形——所以它不是
 * 把断言写松，而是把断言写到**正确的层**上。
 *
 * 注意：推进任务会写任务事实 → 世界版本随之推进 → 紧随其后的重派可能返回
 * `PLAN_STALE`。那是另外的状态（由调用方的 PLAN_STALE 处置路径负责），
 * 不应被误判为失败。
 */

/** 契约动作链：无审批要求的任务走 skip_approval，需要审批的走审批人 approve。 */
const ACTION_BY_STATUS = {
  draft: 'submit',
  pending_confirm: 'skip_approval',
  pending_approval: 'approve',
};

/**
 * @param {(method: string, path: string, body: unknown, token?: string) => Promise<{status:number, body?:any}>} request
 * @param {Array<{taskId?: string}>} assignments 方案的 assignment 列表
 * @param {{ operatorToken: string, approverToken?: string|null, maxSteps?: number }} options
 * @returns {Promise<string[]>} 每个**确实发生了状态变化**的任务的说明（未变的不进结果，避免噪音）
 */
export async function advanceTasksToPendingDispatch(request, assignments, options) {
  const { operatorToken, approverToken, maxSteps = 4 } = options;
  const notes = [];

  const readStatus = async (taskId) => {
    const res = await request('GET', `/api/tasks/${taskId}`, null, operatorToken);
    return res.body?.status ?? res.body?.task?.status ?? null;
  };

  for (const assignment of assignments) {
    const taskId = assignment?.taskId;
    if (!taskId) continue;
    let status = await readStatus(taskId);
    const start = status;
    let steps = 0;
    while (status && ACTION_BY_STATUS[status] && steps < maxSteps) {
      const action = ACTION_BY_STATUS[status];
      // 审批步必须是**审批人**身份（生成人回避：提交人不得批准自己的任务）。
      const actor = action === 'approve' ? (approverToken || operatorToken) : operatorToken;
      const res = await request('POST', `/api/tasks/${taskId}/state?action=${action}`, null, actor);
      if (res.status !== 200 && res.status !== 201) {
        notes.push(`${taskId}: ${status} -${action}-> 失败 status=${res.status}`);
        status = null;
        break;
      }
      status = await readStatus(taskId);
      steps += 1;
    }
    if (status && status !== start) notes.push(`${taskId}: ${start} → ${status}`);
  }

  return notes;
}

/** 是否为"任务未就绪"的派工拒绝（调用方据此决定是否走本推进流程）。 */
export function isTaskNotDispatchable(status, message) {
  return status === 409 && /PLAN_TASK_NOT_DISPATCHABLE/.test(String(message ?? ''));
}

/** 是否为"方案已过期"（世界版本被并发推进）——正确行为，交调用方处置。 */
export function isPlanStale(status, message) {
  return status === 409 && /PLAN_STALE/.test(String(message ?? ''));
}


/** 是否存在阶段四产品内嵌恢复动作（409 响应体 error.recovery.actions）。 */
export function recoveryActionsOf(body) {
  const actions = body?.error?.recovery?.actions ?? body?.recovery?.actions ?? [];
  return Array.isArray(actions) ? actions : [];
}

/**
 * 阶段四：直接执行 409 响应内嵌的结构化恢复动作（endpoint/action 由产品给出）。
 * 与 advanceTasksToPendingDispatch 的差别：动作清单来自**产品响应**而非脚本推断——
 * 验证的是「响应体可被消费方直接执行」这一产品契约本身。
 */
export async function executeRecoveryActions(request, actions, options) {
  const notes = [];
  for (const a of actions) {
    if (!a?.endpoint || !a?.action) continue;
    const actor = a.action === 'approve'
      ? (options.approverToken || options.operatorToken)
      : options.operatorToken;
    const res = await request(a.method || 'POST', a.endpoint, null, actor);
    notes.push(`${a.taskId}:${a.currentStatus}-${a.action}->${res.status}`);
  }
  return notes;
}
