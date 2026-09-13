/* 前后端共享契约 —— 改进行动项（Improvement Action，NO-55a，§10 Level 7 + §12 反馈腿）。
 *
 * 补的缺口（`docs/architecture/capability-alignment.md` §3 原 #1 的剩余部分）：
 * 复盘已经能产出**结构化经验条目**（`RetrospectiveLesson`）与**缺口清单**（`gaps`），
 * 但条目落进复盘记录之后就**没有人负责、没有期限、没有完成证据**——"运行记忆 → 经验"
 * 有，"经验 → 行动"是断的。
 *
 * 为什么**不**把经验条目塞进阈值提案（`shared/learning-proposal.ts`）：
 *   · 阈值提案的语义是"改一个可激活的参数"，激活即生效；而绝大多数经验是
 *     **做法/培训/工具/维护**类改进，没有可激活的参数，塞进去只能靠编造映射；
 *   · 决策原则 9：不为了保持改动最小而保留明显不合理的旧设计——这里反过来，
 *     不为了"少建一张表"把两类语义混在一个状态机里。
 *   因此：**改进行动项**与**阈值提案**并列，二者可互相引用：
 *   `kind='threshold_review'` 的行动项表示"这条经验需要人去提案面板改参数"，
 *   由人在提案面板给出目标值（平台不替现场决定数值）。
 *
 * 三条硬边界（与服务层、DB CHECK 一致）：
 *   1. **完成必须有证据**：`completed` 必须带完成人/时间/结果说明；
 *   2. **接受必须有人与期限与判据**：`accepted` 必须带 owner + dueAt + acceptanceCriteria
 *      （"做完了"要能被别人判断，否则只是自我声明）；
 *   3. **拒绝/放弃必须给理由**（§33 不静默作废），且终态不可再改。
 */

export const IMPROVEMENT_ACTION_KINDS = [
  'process_change',
  'training',
  'tooling',
  'maintenance',
  'threshold_review',
] as const;
export type ImprovementActionKind = (typeof IMPROVEMENT_ACTION_KINDS)[number];

export const IMPROVEMENT_ACTION_STATUSES = [
  'proposed',
  'accepted',
  'rejected',
  'completed',
  'dropped',
] as const;
export type ImprovementActionStatus = (typeof IMPROVEMENT_ACTION_STATUSES)[number];

export const IMPROVEMENT_ACTION_SOURCES = [
  /** 复盘结构化经验条目（severity = warning|critical 才建行动项）。 */
  'retrospective_lesson',
  /** 复盘缺口（证据缺失 → 默认按数据/工具类改进处理，需人确认）。 */
  'retrospective_gap',
] as const;
export type ImprovementActionSource = (typeof IMPROVEMENT_ACTION_SOURCES)[number];

export const IMPROVEMENT_PRIORITIES = ['low', 'medium', 'high'] as const;

/** 对象类型（封闭词表；与 DB CHECK 一致）。 */
export const IMPROVEMENT_SUBJECT_TYPES = ['device', 'person', 'station'] as const;
export type ImprovementSubjectType = (typeof IMPROVEMENT_SUBJECT_TYPES)[number];
const SUBJECT_TYPE_SET: ReadonlySet<string> = new Set(IMPROVEMENT_SUBJECT_TYPES);

/**
 * 从复盘的 scope/targetId 派生对象归属（纯函数；不猜）。
 *
 * · `incident`：`targetId` 就是受影响对象——`person:` 前缀 → person，否则按设备处理；
 * · `plan` / `shift`：没有单一对象 → 两者都为 null（复发不可度量）。
 */
export function deriveActionSubject(
  scope: string,
  targetId: string,
): { subjectType: ImprovementSubjectType; subjectId: string } | null {
  const id = String(targetId ?? '').trim();
  if (id === '') return null;
  const normalizedScope = String(scope ?? '').trim().toLowerCase();
  if (normalizedScope !== 'incident') return null;
  if (id.startsWith('person:')) return { subjectType: 'person', subjectId: id };
  if (id.startsWith('station:') || id.startsWith('workstation:')) {
    return { subjectType: 'station', subjectId: id.replace(/^workstation:/, 'station:') };
  }
  return { subjectType: 'device', subjectId: id };
}
export type ImprovementPriority = (typeof IMPROVEMENT_PRIORITIES)[number];

/**
 * 对象归属 id → **执行事实表里的键**（NO-58a 复发度量的关键一步）。
 *
 * 为什么需要：复盘 `target_id` 用的是**规范身份引用**（`person:<uuid>` / `station:<id>`），
 * 而执行事实表 `ewoh_scheduling_execution.person_id` / `station_id` 存的是**裸 id**
 * （`ewoh_personnel.id` / 工位号）。直接用带前缀的归属去 count 会**永远查到 0 行**——
 * "有偏差却显示 0 次"正是本仓库最忌讳的静默错误（原则 7）。这里做一次显式归一：
 * 只剥掉确定含义的前缀，其余原样返回（不猜、不做模糊匹配）。
 */
export function executionSubjectKey(subjectType: string, subjectId: string): string {
  const id = String(subjectId ?? '').trim();
  if (id === '') return '';
  const normalizedType = String(subjectType ?? '').trim().toLowerCase();
  if (normalizedType === 'person') return id.replace(/^(person|worker):/i, '').trim();
  if (normalizedType === 'station') return id.replace(/^(station|workstation):/i, '').trim();
  return id;
}

/** 状态机（与 service/DB CHECK 同源）：终态不可再转移。 */
const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  proposed: ['accepted', 'rejected'],
  accepted: ['completed', 'dropped'],
  rejected: [],
  completed: [],
  dropped: [],
};

export function improvementTransitionAllowed(from: string, to: string): boolean {
  return (TRANSITIONS[String(from ?? '')] ?? []).includes(String(to ?? ''));
}

const KIND_SET: ReadonlySet<string> = new Set(IMPROVEMENT_ACTION_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(IMPROVEMENT_ACTION_STATUSES);
const SOURCE_SET: ReadonlySet<string> = new Set(IMPROVEMENT_ACTION_SOURCES);
const PRIORITY_SET: ReadonlySet<string> = new Set(IMPROVEMENT_PRIORITIES);

export interface ImprovementEvidenceRef {
  type: 'retrospective' | 'lesson' | 'gap' | 'event' | 'plan' | 'execution' | 'annotation';
  id: string;
  at: string | null;
  detail?: Record<string, unknown>;
}

export interface ImprovementActionRecord {
  actionId: string;
  sourceType: ImprovementActionSource;
  /** 来源对象（复盘号 / 缺口所属复盘号）。 */
  sourceRef: string;
  /**
   * **对象归属**（NO-58a）：这条经验说的是哪台设备/哪个人/哪个工位。
   * 由复盘 `scope=incident` 的 `targetId` 派生；plan/shift 复盘没有单一对象 → null。
   * null = 未绑定对象 → "复发是否下降"**不可度量**（页面必须显式说明，不许看起来像"没有复发"）。
   */
  subjectType?: ImprovementSubjectType | null;
  subjectId?: string | null;
  title: string;
  detail: string;
  kind: ImprovementActionKind;
  /** `suggested` = 平台建议（人接受时应确认）；`human` = 人明确选择。 */
  kindSource: 'suggested' | 'human';
  priority: ImprovementPriority;
  status: ImprovementActionStatus;
  evidenceRefs: ImprovementEvidenceRef[];
  /** 接受时必填：负责人（人或角色）与期限与验收判据。 */
  owner?: string | null;
  dueAt?: string | null;
  acceptanceCriteria?: string | null;
  acceptedBy?: string | null;
  acceptedAt?: string | null;
  completedBy?: string | null;
  completedAt?: string | null;
  /** 完成结果说明（必须能让人判断"按判据做完了没有"）。 */
  outcomeNote?: string | null;
  /**
   * 完成时**回流**成的可复用产物（NO-57c）：
   * 知识条目号 + 类型（当前仅 `knowledge_entry`）。NULL = 未回流（页面必须显式显示，
   * 不许看起来像"已完成且已归档"）。
   */
  outcomeRef?: string | null;
  outcomeKind?: 'knowledge_entry' | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  /** 拒绝/放弃理由（必填）。 */
  decidedReason?: string | null;
  detectedAt: string;
}

function isNonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isIso(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

/** 标题的码点稳定摘要（base36；不用随机数、不用时间，保证"同一标题 → 同一号"）。 */
function titleHash(text: string): string {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)!) % 0xffffffff;
  return hash.toString(36);
}

/**
 * 标题 → 稳定 slug（用于确定性行动项号：同一复盘同一条目 → 同一行）。
 *
 * **必须把整串标题的摘要拼进去**：只保留 ASCII 前缀会让"E2E abc 甲""E2E abc 乙"
 * 这类标题塌成同一个 slug，两条不同经验被静默合并成一条待办（2026-09-12 实测踩到：
 * 中文标题前带同一个英文前缀时，dedup 把 warning 级经验吞掉了）。
 */
export function improvementSlug(title: string): string {
  const text = String(title ?? '').trim();
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const digest = titleHash(text);
  return ascii === '' ? `zh${digest}` : `${ascii}-${digest}`;
}

/** 确定性行动项号：`ACT-<lesson|gap>-<来源对象>-<slug>`。 */
export function improvementActionId(
  sourceType: ImprovementActionSource,
  sourceRef: string,
  title: string,
): string {
  const source = sourceType === 'retrospective_gap' ? 'gap' : 'lesson';
  const ref = String(sourceRef ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 60) || 'unknown';
  return `ACT-${source}-${ref}-${improvementSlug(title)}`.slice(0, 180);
}

/** 校验行动项记录；返回错误码列表（空 = 合法）。fail-closed。 */
export function validateImprovementAction(record: unknown): string[] {
  if (record == null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record_must_be_object'];
  }
  const r = record as Record<string, unknown>;
  for (const field of ['actionId', 'sourceType', 'sourceRef', 'title', 'detail', 'kind', 'kindSource', 'priority', 'status', 'evidenceRefs', 'detectedAt']) {
    if (!(field in r)) return [`missing_field:${field}`];
  }
  if (!isNonEmpty(r.actionId)) return ['bad_action_id'];
  if (!SOURCE_SET.has(String(r.sourceType))) return ['unknown_source_type'];
  if (!isNonEmpty(r.sourceRef)) return ['bad_source_ref'];
  if (!isNonEmpty(r.title)) return ['bad_title'];
  if (!isNonEmpty(r.detail)) return ['bad_detail'];
  if (!KIND_SET.has(String(r.kind))) return ['unknown_kind'];
  if (r.kindSource !== 'suggested' && r.kindSource !== 'human') return ['bad_kind_source'];
  if (!PRIORITY_SET.has(String(r.priority))) return ['unknown_priority'];
  if (!STATUS_SET.has(String(r.status))) return ['unknown_status'];
  if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.length === 0) return ['missing_evidence'];
  if ((r.evidenceRefs as unknown[]).some((e) => !isNonEmpty((e as { id?: unknown })?.id))) {
    return ['bad_evidence'];
  }
  if (!isIso(r.detectedAt)) return ['bad_detected_at'];

  const status = String(r.status);
  if (status === 'accepted' || status === 'completed') {
    if (!isNonEmpty(r.owner)) return ['accepted_requires_owner'];
    if (!isIso(r.dueAt)) return ['accepted_requires_due_at'];
    if (!isNonEmpty(r.acceptanceCriteria)) return ['accepted_requires_criteria'];
    if (!isNonEmpty(r.acceptedBy) || !isIso(r.acceptedAt)) return ['accepted_requires_acceptor'];
  }
  if (status === 'completed') {
    if (!isNonEmpty(r.completedBy) || !isIso(r.completedAt)) return ['completed_requires_completer'];
    if (!isNonEmpty(r.outcomeNote)) return ['completed_requires_outcome'];
  }
  if (status === 'rejected' || status === 'dropped') {
    if (!isNonEmpty(r.decidedBy) || !isIso(r.decidedAt)) return ['decision_requires_actor'];
    if (!isNonEmpty(r.decidedReason)) return ['decision_requires_reason'];
  }
  if (status === 'proposed' && isNonEmpty(r.completedAt)) {
    return ['proposed_must_not_be_completed'];
  }
  // 回流引用：要么都有，要么都没有；且只有完成态才能带（半成品/假装归档都不许落库）。
  const outcomeRef = isNonEmpty(r.outcomeRef) ? String(r.outcomeRef).trim() : null;
  const outcomeKind = r.outcomeKind == null || r.outcomeKind === '' ? null : String(r.outcomeKind);
  if ((outcomeRef === null) !== (outcomeKind === null)) return ['outcome_ref_and_kind_must_pair'];
  if (outcomeKind !== null && outcomeKind !== 'knowledge_entry') return ['unknown_outcome_kind'];
  if (outcomeRef !== null && status !== 'completed') return ['outcome_ref_requires_completed'];
  // 对象归属：要么都有，要么都没有；类型必须在封闭词表内（半成品/未知类型不许落库）。
  const subjectType = r.subjectType == null || r.subjectType === '' ? null : String(r.subjectType);
  const subjectId = isNonEmpty(r.subjectId) ? String(r.subjectId).trim() : null;
  if ((subjectType === null) !== (subjectId === null)) return ['subject_pair_must_match'];
  if (subjectType !== null && !SUBJECT_TYPE_SET.has(subjectType)) return ['unknown_subject_type'];
  return [];
}

/* ── 纯规则：复盘运行记忆 → 行动项候选 ──────────────────────────────────── */

export interface ImprovementMemoryRetrospective {
  retrospectiveId: string;
  /** 对象归属（由服务层用 `deriveActionSubject` 派生；缺省 = 不可度量）。 */
  subject?: { subjectType: ImprovementSubjectType; subjectId: string } | null;
  scope: string;
  targetId: string;
  title: string;
  publishedAt: string | null;
  lessons: Array<{ title: string; detail: string; severity: string; evidenceIds: string[] }>;
  gaps: string[];
}

export interface ImprovementMemoryInput {
  orgId: string;
  detectedAt: string;
  retrospectives: ImprovementMemoryRetrospective[];
  /** 单次扫描最多派生多少条（按优先级 + 号排序取前 N，默认 10）。 */
  maxActions?: number;
}

/** info 级经验只作记忆保留，不建行动项（否则"每条总结都变成待办"，没人会看）。 */
export const IMPROVEMENT_LESSON_MIN_SEVERITY = 'warning' as const;
export const IMPROVEMENT_DEFAULT_MAX_ACTIONS = 10;

function priorityForLessonSeverity(severity: string): ImprovementPriority {
  return severity === 'critical' ? 'high' : 'medium';
}

function priorityRank(priority: ImprovementPriority): number {
  return priority === 'high' ? 3 : priority === 'medium' ? 2 : 1;
}

/** 复盘（已发布）→ 行动项候选（确定性；同一输入必得同一批行动项号）。 */
export function deriveImprovementActions(input: ImprovementMemoryInput): ImprovementActionRecord[] {
  const max = Number.isFinite(input.maxActions)
    ? Math.max(1, Math.trunc(Number(input.maxActions)))
    : IMPROVEMENT_DEFAULT_MAX_ACTIONS;
  const actions: ImprovementActionRecord[] = [];
  for (const retrospective of input.retrospectives) {
    const baseEvidence: ImprovementEvidenceRef[] = [
      { type: 'retrospective', id: retrospective.retrospectiveId, at: retrospective.publishedAt },
    ];
    // 对象归属：调用方给了就用（服务层从 DB 读到的），没给就按 scope/targetId 现场派生。
    // 派生失败 = null：后续"复发是否下降"必须显示为**不可度量**，不许当 0。
    const subject = retrospective.subject ?? deriveActionSubject(retrospective.scope, retrospective.targetId);
    for (const lesson of retrospective.lessons ?? []) {
      if (lesson.severity !== 'critical' && lesson.severity !== IMPROVEMENT_LESSON_MIN_SEVERITY) continue;
      if (!isNonEmpty(lesson.title) || !isNonEmpty(lesson.detail)) continue;
      actions.push({
        actionId: improvementActionId('retrospective_lesson', retrospective.retrospectiveId, lesson.title),
        sourceType: 'retrospective_lesson',
        sourceRef: retrospective.retrospectiveId,
        subjectType: subject?.subjectType ?? null,
        subjectId: subject?.subjectId ?? null,
        title: lesson.title.trim(),
        detail: lesson.detail.trim(),
        // 平台只给"建议类型"，人接受时确认（不靠关键词猜业务分类）。
        kind: 'process_change',
        kindSource: 'suggested',
        priority: priorityForLessonSeverity(lesson.severity),
        status: 'proposed',
        evidenceRefs: [
          ...baseEvidence,
          {
            type: 'lesson',
            id: `${retrospective.retrospectiveId}#${lesson.title.trim()}`,
            at: retrospective.publishedAt,
            detail: { severity: lesson.severity, evidenceIds: (lesson.evidenceIds ?? []).slice(0, 5) },
          },
        ],
        detectedAt: input.detectedAt,
      });
    }
    for (const gap of retrospective.gaps ?? []) {
      const text = String(gap ?? '').trim();
      if (text === '') continue;
      actions.push({
        actionId: improvementActionId('retrospective_gap', retrospective.retrospectiveId, text),
        sourceType: 'retrospective_gap',
        sourceRef: retrospective.retrospectiveId,
        subjectType: subject?.subjectType ?? null,
        subjectId: subject?.subjectId ?? null,
        title: `补齐缺口：${text}`.slice(0, 180),
        detail: `复盘 ${retrospective.retrospectiveId}（${retrospective.title}）显式记录了缺口："${text}"。缺口意味着这条闭环的证据链是断的，补齐后才能复盘与学习。`,
        kind: 'tooling',
        kindSource: 'suggested',
        priority: 'medium',
        status: 'proposed',
        evidenceRefs: [
          ...baseEvidence,
          { type: 'gap', id: `${retrospective.retrospectiveId}#${text}`.slice(0, 180), at: retrospective.publishedAt },
        ],
        detectedAt: input.detectedAt,
      });
    }
  }
  // 去重（同一复盘同一条目重复出现）+ 稳定排序（优先级 desc → 号 asc）。
  const byId = new Map<string, ImprovementActionRecord>();
  for (const action of actions) if (!byId.has(action.actionId)) byId.set(action.actionId, action);
  return [...byId.values()]
    .sort((a, b) => {
      const byPriority = priorityRank(b.priority) - priorityRank(a.priority);
      return byPriority !== 0 ? byPriority : a.actionId.localeCompare(b.actionId);
    })
    .slice(0, max);
}

/** 人接受时的输入校验（与服务层同源；返回错误码，空 = 合法）。 */
export function validateAcceptanceInput(input: {
  owner?: string | null;
  dueAt?: string | null;
  acceptanceCriteria?: string | null;
  kind?: string | null;
}): string[] {
  const errors: string[] = [];
  if (!isNonEmpty(input.owner)) errors.push('owner_required');
  if (!isIso(input.dueAt)) errors.push('due_at_required');
  if (!isNonEmpty(input.acceptanceCriteria)) errors.push('acceptance_criteria_required');
  if (input.kind != null && input.kind !== '' && !KIND_SET.has(String(input.kind))) {
    errors.push('unknown_kind');
  }
  return errors;
}
