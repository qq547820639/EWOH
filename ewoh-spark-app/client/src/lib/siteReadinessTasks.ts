import type { SiteReadinessStageId } from './siteReadinessFlow';

/**
 * UX-005 缺失证据、责任人、截止时间与审批/签署（本地存储）。
 *
 * 所有内容仅保存在浏览器 localStorage，作为本地记录；正式签署/批准需现场操作。
 */

export const TASKS_STORAGE_KEY = 'ewoh.siteReadiness.tasks.v1';
export const APPROVAL_STORAGE_KEY = 'ewoh.siteReadiness.approval.v1';

export interface SiteReadinessTask {
  id: string;
  stageId: SiteReadinessStageId;
  /** 关联的证据检查项 id。 */
  evidenceId: string;
  label: string;
  owner: string;
  deadline: string;
  status: 'open' | 'done';
  updatedAt: string;
}

export interface SiteReadinessApproval {
  trainingComplete: boolean;
  productionApproved: boolean;
  businessSigner: string;
  signedAt: string | null;
  updatedAt: string;
}

function readStorage<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略写入失败。
  }
}

export function loadTasks(): SiteReadinessTask[] {
  return readStorage<SiteReadinessTask[]>(TASKS_STORAGE_KEY, []);
}

export function saveTasks(tasks: SiteReadinessTask[]): void {
  writeStorage(TASKS_STORAGE_KEY, tasks);
}

export function nextTaskId(existing: SiteReadinessTask[]): string {
  const max = existing.reduce((acc, task) => {
    const num = Number(task.id.replace(/\D/g, ''));
    return Number.isFinite(num) && num > acc ? num : acc;
  }, 0);
  return `task-${max + 1}`;
}

/** 登记一个缺失证据任务；按 stageId+evidenceId 幂等，已存在则返回原列表。 */
export function registerTask(
  tasks: SiteReadinessTask[],
  input: Omit<SiteReadinessTask, 'id' | 'updatedAt'>,
): SiteReadinessTask[] {
  const exists = tasks.some(
    (task) => task.stageId === input.stageId && task.evidenceId === input.evidenceId,
  );
  if (exists) return tasks;
  const task: SiteReadinessTask = {
    ...input,
    id: nextTaskId(tasks),
    updatedAt: new Date().toISOString(),
  };
  return [...tasks, task];
}

export function updateTask(
  tasks: SiteReadinessTask[],
  id: string,
  patch: Partial<Pick<SiteReadinessTask, 'owner' | 'deadline' | 'status'>>,
): SiteReadinessTask[] {
  return tasks.map((task) =>
    task.id === id
      ? { ...task, ...patch, updatedAt: new Date().toISOString() }
      : task,
  );
}

export function openTasks(tasks: SiteReadinessTask[]): SiteReadinessTask[] {
  return tasks.filter((task) => task.status === 'open');
}

export function tasksForStage(
  tasks: SiteReadinessTask[],
  stageId: SiteReadinessStageId,
): SiteReadinessTask[] {
  return tasks.filter((task) => task.stageId === stageId);
}

/* ------------------------------------------------------------------ */
/* 审批 / 签署                                                         */
/* ------------------------------------------------------------------ */

export const EMPTY_APPROVAL: SiteReadinessApproval = {
  trainingComplete: false,
  productionApproved: false,
  businessSigner: '',
  signedAt: null,
  updatedAt: '',
};

export function loadApproval(): SiteReadinessApproval {
  return readStorage<SiteReadinessApproval>(APPROVAL_STORAGE_KEY, EMPTY_APPROVAL);
}

export function saveApproval(approval: SiteReadinessApproval): void {
  writeStorage(APPROVAL_STORAGE_KEY, approval);
}

/** 提交业务签署（签名输入），记录本地签署时间。 */
export function signBusiness(approval: SiteReadinessApproval, signer: string): SiteReadinessApproval {
  return {
    ...approval,
    businessSigner: signer,
    signedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}