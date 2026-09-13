import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import {
  acceptImprovementAction,
  completeImprovementAction,
  decideImprovementAction,
  getImprovementActionEffect,
  listImprovementActions,
  scanImprovementActions,
  type ImprovementActionDto,
  type ImprovementActionKind,
} from '../../api/learning';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { parseError } from '../../lib/errorContract';
import {
  buildImprovementActionView,
  buildRecurrenceView,
  improvementScanLabel,
  validateAcceptance,
} from './learningConsoleLogic';

const KIND_OPTIONS: ImprovementActionKind[] = [
  'process_change',
  'training',
  'tooling',
  'maintenance',
  'threshold_review',
];

/**
 * 改进行动项卡片（NO-55a：复盘经验 → 有人负责的行动）。
 *
 * 复盘已经能产出结构化经验条目与缺口清单，但条目落进复盘记录后就**没有人负责、
 * 没有期限、没有完成证据**。这张卡片把它变成行动项：
 *  - 平台只给**候选**与建议类型，接受必须由人给负责人 + 期限 + 验收判据；
 *  - 完成必须写结果说明（对着判据），否则"做完了"只是自我声明；
 *  - 拒绝/放弃必须给理由；扫描幂等且**不覆盖**这些人的决定。
 */
export function ImprovementActionsCard(): React.ReactElement {
  const client = useQueryClient();
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 草案字段名必须与契约/校验器一致（`acceptanceCriteria`）：此前用 `criteria` 导致
  // validateAcceptance 永远读到空判据、接受按钮永远不可用（由浏览器用例先失败发现）。
  const [draft, setDraft] = useState<Record<string, { owner: string; dueAt: string; acceptanceCriteria: string; kind: ImprovementActionKind }>>({});
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});

  const actionsQuery = useQuery({
    queryKey: ['learning', 'actions'],
    queryFn: () => listImprovementActions({ limit: 50 }),
    staleTime: 15_000,
  });

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['learning', 'actions'] });
  };

  const scan = useMutation({
    mutationFn: scanImprovementActions,
    onSuccess: (result) => {
      setScanNote(improvementScanLabel(result));
      setError(null);
      invalidate();
    },
    onError: (err) => setError(parseError(err).message),
  });

  const accept = useMutation({
    mutationFn: (input: { actionId: string; owner: string; dueAt: string; acceptanceCriteria: string; kind: ImprovementActionKind }) =>
      acceptImprovementAction(input.actionId, input),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (err) => setError(parseError(err).message),
  });

  const complete = useMutation({
    mutationFn: (input: { actionId: string; outcomeNote: string }) =>
      completeImprovementAction(input.actionId, input.outcomeNote),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (err) => setError(parseError(err).message),
  });

  const decide = useMutation({
    mutationFn: (input: { actionId: string; decision: 'rejected' | 'dropped'; reason: string }) =>
      decideImprovementAction(input.actionId, input.decision, input.reason),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (err) => setError(parseError(err).message),
  });

  // 复发度量（NO-58a）：只在人点了"看复发"后取一次（不预取全部行动项的计数）。
  const [effectFor, setEffectFor] = useState<string | null>(null);
  const effectQuery = useQuery({
    queryKey: ['learning', 'action-effect', effectFor],
    queryFn: () => getImprovementActionEffect(effectFor as string),
    enabled: effectFor !== null,
    staleTime: 30_000,
    retry: false,
  });

  const actions: ImprovementActionDto[] = actionsQuery.data ?? [];
  const views = useMemo(
    () => actions.map((action) => ({ action, view: buildImprovementActionView(action) })),
    [actions],
  );
  const openViews = views.filter(({ view }) => view.canAccept || view.canComplete);
  const overdueCount = views.filter(({ view }) => view.overdue).length;

  return (
    <section
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
      aria-labelledby="improvement-actions-title"
      data-testid="improvement-actions"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="improvement-actions-title" className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck className="size-4" /> 改进行动项（复盘经验 → 行动）
        </h2>
        <div className="flex items-center gap-2">
          <Badge variant={openViews.length > 0 ? 'destructive' : 'outline'}>未闭环 {openViews.length}</Badge>
          {overdueCount > 0 && (
            <Badge variant="destructive" data-testid="improvement-actions-overdue">
              逾期 {overdueCount}
            </Badge>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={scan.isPending}
            onClick={() => scan.mutate()}
            data-testid="improvement-actions-scan"
          >
            <RefreshCw className="size-3" />扫描复盘
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        扫描**已发布复盘**的结构化经验条目与缺口，生成候选行动项。平台只给建议类型；
        **接受必须由人给负责人、期限与验收判据**，完成必须写结果说明——否则"做完了"没法被别人判断。
        需要改参数的经验（阈值复核）请到上方提案面板由人给出目标值。
      </p>

      {scanNote && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="improvement-actions-scan-note">{scanNote}</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-risk-blocked-foreground" role="alert" data-testid="improvement-actions-error">{error}</p>
      )}
      {actionsQuery.isError && (
        <p className="mt-2 text-xs text-risk-degraded-foreground" role="alert">
          行动项读取失败：{parseError(actionsQuery.error).message}——这里不会显示成"没有待办"。
        </p>
      )}

      {!actionsQuery.isLoading && !actionsQuery.isError && views.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="improvement-actions-empty">
          暂无行动项（未扫描，或复盘里没有 warning 及以上的经验/缺口）
        </p>
      )}

      <ul className="mt-3 space-y-3">
        {views.map(({ action, view }) => {
          const current = draft[action.actionId] ?? {
            owner: action.owner ?? '',
            dueAt: action.dueAt ? action.dueAt.slice(0, 10) : '',
            acceptanceCriteria: action.acceptanceCriteria ?? '',
            kind: action.kind,
          };
          const acceptance = validateAcceptance(current);
          return (
            <li key={action.actionId} className="rounded-lg border border-border p-3" data-testid="improvement-action-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant={view.priorityTone === 'critical' ? 'destructive' : 'outline'}>
                    {view.priorityLabel}
                  </Badge>
                  <span className="truncate text-sm font-medium">{view.title}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={view.overdue ? 'destructive' : 'secondary'} data-testid="improvement-action-status">
                    {view.statusLabel}
                  </Badge>
                  <Badge variant="outline">{view.kindLabel}{view.kindSuggested ? '（建议）' : ''}</Badge>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="improvement-action-source">
                {view.sourceLabel} · {view.evidenceLabel} · {view.ownerLabel} · {view.dueLabel}
              </p>
              <p
                className="mt-1 text-xs text-muted-foreground"
                data-testid="improvement-action-subject"
                data-measurable={view.measurable ? 'yes' : 'no'}
              >
                {view.subjectLabel}
              </p>
              <p className="mt-2 text-xs">{view.detail}</p>
              {view.acceptanceLabel && <p className="mt-1 text-xs text-muted-foreground">{view.acceptanceLabel}</p>}
              {view.outcomeLabel && <p className="mt-1 text-xs text-muted-foreground">{view.outcomeLabel}</p>}
              {view.decisionLabel && <p className="mt-1 text-xs text-muted-foreground">{view.decisionLabel}</p>}

              <div className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setEffectFor(effectFor === action.actionId ? null : action.actionId)}
                  data-testid="improvement-action-effect-toggle"
                >
                  {effectFor === action.actionId ? '收起复发度量' : '看复发（完成前后计数）'}
                </Button>
              </div>

              {effectFor === action.actionId && (
                <div className="mt-1 rounded-md border border-border bg-muted p-2 text-xs" data-testid="improvement-action-effect">
                  {effectQuery.isLoading && <p className="text-muted-foreground">读取复发计数…</p>}
                  {effectQuery.isError && (
                    <p className="text-risk-degraded-foreground" role="alert">
                      复发度量读取失败：{parseError(effectQuery.error).message}——这里不会显示成"没有复发"。
                    </p>
                  )}
                  {effectQuery.data && (() => {
                    const recurrence = buildRecurrenceView(effectQuery.data);
                    return (
                      <div className="space-y-1">
                        <p className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant={recurrence.tone === 'warning' ? 'destructive' : 'outline'}
                            data-testid="improvement-action-effect-conclusion"
                          >
                            {recurrence.conclusion}
                          </Badge>
                          <span className="text-muted-foreground">{recurrence.windowLabel}</span>
                          {!recurrence.measurable && <span className="text-risk-degraded-foreground">不可度量</span>}
                        </p>
                        <p className="text-muted-foreground" data-testid="improvement-action-effect-counts">
                          {recurrence.beforeLabel} · {recurrence.afterLabel}
                        </p>
                        <p>{recurrence.reason}</p>
                        {recurrence.noteLabel && (
                          <p className="text-muted-foreground" data-testid="improvement-action-effect-note">
                            {recurrence.noteLabel}
                          </p>
                        )}
                        {recurrence.disclaimer && (
                          <p className="text-risk-degraded-foreground" data-testid="improvement-action-effect-disclaimer">
                            {recurrence.disclaimer}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {view.canAccept && (
                <div className="mt-2 rounded-md border border-border bg-muted p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="w-40 rounded-md border border-border bg-background px-2 py-1 text-xs"
                      placeholder="负责人（人或角色）"
                      value={current.owner}
                      onChange={(e) => setDraft((prev) => ({ ...prev, [action.actionId]: { ...current, owner: e.target.value } }))}
                      aria-label={`${action.actionId} 负责人`}
                    />
                    <input
                      className="w-36 rounded-md border border-border bg-background px-2 py-1 text-xs"
                      type="date"
                      value={current.dueAt}
                      onChange={(e) => setDraft((prev) => ({ ...prev, [action.actionId]: { ...current, dueAt: e.target.value } }))}
                      aria-label={`${action.actionId} 期限`}
                    />
                    <select
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      value={current.kind}
                      onChange={(e) => setDraft((prev) => ({ ...prev, [action.actionId]: { ...current, kind: e.target.value as ImprovementActionKind } }))}
                      aria-label={`${action.actionId} 类型`}
                    >
                      {KIND_OPTIONS.map((kind) => (
                        <option key={kind} value={kind}>{kind}</option>
                      ))}
                    </select>
                  </div>
                  <input
                    className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                    placeholder="验收判据（别人据此判断做完了没有）"
                    value={current.acceptanceCriteria}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [action.actionId]: { ...current, acceptanceCriteria: e.target.value } }))}
                    aria-label={`${action.actionId} 验收判据`}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!acceptance.ok || accept.isPending}
                      onClick={() => accept.mutate({
                        actionId: action.actionId,
                        owner: current.owner.trim(),
                        dueAt: current.dueAt,
                        acceptanceCriteria: current.acceptanceCriteria.trim(),
                        kind: current.kind,
                      })}
                      data-testid="improvement-action-accept"
                    >
                      接受（指派负责人）
                    </Button>
                    {!acceptance.ok && <span className="text-xs text-risk-degraded-foreground">{acceptance.reason}</span>}
                  </div>
                </div>
              )}

              {view.canComplete && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="min-w-[16rem] flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                    placeholder="完成结果（对着验收判据说清楚做了什么）"
                    value={outcome[action.actionId] ?? ''}
                    onChange={(e) => setOutcome((prev) => ({ ...prev, [action.actionId]: e.target.value }))}
                    aria-label={`${action.actionId} 完成结果`}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={(outcome[action.actionId] ?? '').trim() === '' || complete.isPending}
                    onClick={() => complete.mutate({ actionId: action.actionId, outcomeNote: (outcome[action.actionId] ?? '').trim() })}
                    data-testid="improvement-action-complete"
                  >
                    标记完成
                  </Button>
                </div>
              )}

              {view.canDecide && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    className="min-w-[14rem] flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                    placeholder="拒绝/放弃理由（必填）"
                    value={reason[action.actionId] ?? ''}
                    onChange={(e) => setReason((prev) => ({ ...prev, [action.actionId]: e.target.value }))}
                    aria-label={`${action.actionId} 决定理由`}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={(reason[action.actionId] ?? '').trim() === '' || decide.isPending}
                    onClick={() => decide.mutate({
                      actionId: action.actionId,
                      decision: view.canAccept ? 'rejected' : 'dropped',
                      reason: (reason[action.actionId] ?? '').trim(),
                    })}
                    data-testid="improvement-action-decide"
                  >
                    {view.canAccept ? '拒绝' : '放弃'}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default ImprovementActionsCard;
