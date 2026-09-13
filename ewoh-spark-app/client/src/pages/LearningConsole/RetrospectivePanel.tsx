import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenText, Loader2, Sparkles } from 'lucide-react';
import {
  assembleRetrospectiveFromPlan,
  listRetrospectives,
  publishRetrospective,
} from '../../api/retrospective';
import type { RetrospectiveRecord } from '@shared/retrospective';
import { queryKeys } from '../../hooks/queryKeys';
import { QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { parseError } from '../../lib/errorContract';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  superseded: '已被替代',
};

/**
 * 复盘/运行记忆面板（DR-3，standalone_075）。
 *
 * 把"感知→数据质量→决策→授权→执行→反馈"六段组装成可读的运行记忆：
 *  - 从任一调度方案组装（缺失环节显式进 gaps，不伪造）；
 *  - AI 总结（llm | rule_fallback 双路留痕——绝不把模板输出冒充模型产出）；
 *  - 经验条目随复盘落账（学习闭环第⑩步的可追溯产物）。
 */
export function RetrospectivePanel(): React.ReactElement {
  const client = useQueryClient();
  const [planId, setPlanId] = useState('');

  const listQuery = useQuery<RetrospectiveRecord[]>({
    queryKey: queryKeys.retrospectives(),
    queryFn: () => listRetrospectives({ limit: 20 }),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const assemble = useMutation({
    mutationFn: () => assembleRetrospectiveFromPlan(planId.trim()),
    onSuccess: () => {
      setPlanId('');
      void client.invalidateQueries({ queryKey: queryKeys.retrospectives() });
    },
  });
  const publish = useMutation({
    mutationFn: (retrospectiveId: string) => publishRetrospective(retrospectiveId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.retrospectives() });
    },
  });

  const records = listQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <BookOpenText className="size-4" /> 复盘 · 运行记忆
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          从调度方案组装六段闭环（感知/数据质量/决策/授权/执行/反馈）——只引用既有台账证据，
          缺失环节显式列出；AI 总结标注真实来源（llm 或规则模板），不冒充。
        </p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (planId.trim()) assemble.mutate();
          }}
        >
          <input
            className="min-w-64 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            placeholder="方案 ID（planId，可在排产调度页复制）"
            // 无障碍（2026-09-11 浏览器门禁实测）：只有 placeholder 不构成可访问名称
            // （屏幕阅读器与 `collectA11yIssues` 都读不到），必须给显式标签名。
            aria-label="方案 ID（planId，可在排产调度页复制）"
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={assemble.isPending || !planId.trim()}>
            {assemble.isPending ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
            组装复盘
          </Button>
        </form>
        {assemble.isError && (
          <p className="text-xs text-risk-blocked-foreground" role="alert">
            组装失败：{parseError(assemble.error).message}
          </p>
        )}
        {listQuery.isError && (
          <p className="text-xs text-risk-degraded-foreground" role="alert">
            复盘列表获取失败：{parseError(listQuery.error).message}
          </p>
        )}
        {!listQuery.isLoading && records.length === 0 && (
          <p className="text-sm text-muted-foreground">
            暂无复盘记录。对一个已派工/已完成的方案组装第一条运行记忆。
          </p>
        )}
        <div className="space-y-3">
          {records.map((record) => (
            <article
              key={record.retrospectiveId}
              className="rounded-lg border border-border p-3"
              data-testid={`retrospective-${record.retrospectiveId}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{record.title}</h3>
                <Badge variant="outline">{STATUS_LABEL[record.status] ?? record.status}</Badge>
                {record.narrativeSource && (
                  <Badge variant={record.narrativeSource === 'llm' ? 'default' : 'secondary'}>
                    {record.narrativeSource === 'llm' ? 'AI 总结' : '规则模板'}
                  </Badge>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {new Date(record.createdAt).toLocaleString('zh-CN')}
                </span>
              </div>
              {record.narrative && (
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
                  {record.narrative}
                </p>
              )}
              <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                <div>
                  <dt className="inline">回执：完成 {record.assembled.execution.receiptSummary.completed} · 失败{' '}
                    {record.assembled.execution.receiptSummary.failed} · 未知{' '}
                    {record.assembled.execution.receiptSummary.unknown}
                  </dt>
                </div>
                <div>
                  <dt className="inline">{record.assembled.feedback.plannedVsActualSummary}</dt>
                </div>
                <div>
                  <dt className="inline">数据缺口 {record.assembled.gaps.length} 项</dt>
                </div>
              </dl>
              {record.assembled.gaps.length > 0 && (
                <details className="mt-1 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">缺口清单（没有数据就说没有）</summary>
                  <ul className="mt-1 list-disc pl-4">
                    {record.assembled.gaps.slice(0, 6).map((gap) => (
                      <li key={gap}>{gap}</li>
                    ))}
                  </ul>
                </details>
              )}
              {record.assembled.feedback.lessons.length > 0 && (
                <div className="mt-2 space-y-1">
                  {record.assembled.feedback.lessons.slice(0, 3).map((lesson) => (
                    <p
                      key={lesson.title}
                      className={`rounded border px-2 py-1 text-xs ${
                        lesson.severity === 'warning'
                          ? 'border-risk-degraded-border bg-risk-degraded-soft text-risk-degraded-foreground'
                          : lesson.severity === 'critical'
                            ? 'border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground'
                            : 'border-border bg-muted text-foreground'
                      }`}
                    >
                      经验 · {lesson.title}
                    </p>
                  ))}
                </div>
              )}
              {record.status === 'draft' && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={publish.isPending}
                  onClick={() => publish.mutate(record.retrospectiveId)}
                >
                  {publish.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
                  发布为运行记忆
                </Button>
              )}
            </article>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
