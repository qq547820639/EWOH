import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import QueryState from '../../components/QueryState';
import { queryKeys } from '../../hooks/queryKeys';
import { QUERY_STALE_TIME_MS } from '../../hooks/queryConfig';
import { getWorkEvidenceContent, listWorkEvidence, type EvidenceContentPreview, type WorkEvidence } from '../../api/work';
import {
  hasMoreItems,
  nextProgressiveLimit,
  progressiveSlice,
  PROGRESSIVE_STEP,
} from '../../lib/progressiveList';
import { EvidenceRow, useUrlParam } from './shared';

const EvidencePanel = (): React.ReactElement => {
  const [kind, setKind] = useUrlParam('evidenceKind');
  const [result, setResult] = useUrlParam('evidenceResult');
  const [preview, setPreview] = useState<EvidenceContentPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(PROGRESSIVE_STEP);

  const evidenceQuery = useQuery({
    queryKey: queryKeys.workEvidence(),
    queryFn: () => listWorkEvidence(),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const evidence = evidenceQuery.data ?? [];
  const filtered = useMemo(
    () =>
      evidence.filter((entry) => {
        if (kind && entry.kind !== kind) return false;
        if (result && entry.result !== result) return false;
        return true;
      }),
    [evidence, kind, result],
  );

  // 筛选条件变化时重置渐进式加载的分页步长。
  useEffect(() => {
    setVisibleLimit(PROGRESSIVE_STEP);
  }, [kind, result]);

  const visibleItems = progressiveSlice(filtered, visibleLimit);
  const hasMore = hasMoreItems(filtered, visibleLimit);

  const loadPreview = async (entry: WorkEvidence) => {
    setPreviewLoading(true);
    setPreviewError('');
    try {
      setPreview(await getWorkEvidenceContent(entry.evidenceId, 200));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : '证据预览失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <QueryState
      isLoading={evidenceQuery.isLoading}
      isFetching={evidenceQuery.isFetching}
      isError={evidenceQuery.isError}
      isStale={evidenceQuery.isStale}
      isEmpty={!evidenceQuery.data}
      onRefresh={() => evidenceQuery.refetch()}
      errorMessage={evidenceQuery.error instanceof Error ? evidenceQuery.error.message : '证据加载失败'}
      loadingMessage="正在读取证据抽屉"
      updatedAt={evidenceQuery.dataUpdatedAt}
    >
      <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-4">
          <CheckCircle2 className="h-4 w-4 text-violet-600" />
          <h2 className="font-semibold text-[hsl(220_14%_14%)]">证据抽屉</h2>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              aria-label="按证据类型筛选"
              className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
            >
              <option value="">全部类型</option>
              <option value="test">test</option>
              <option value="review">review</option>
              <option value="evidence">evidence</option>
            </select>
            <select
              value={result}
              onChange={(event) => setResult(event.target.value)}
              aria-label="按证据结果筛选"
              className="h-9 rounded-lg border border-[hsl(220_14%_89%)] px-2 text-xs outline-none focus:border-blue-500"
            >
              <option value="">全部结果</option>
              <option value="passed">passed</option>
              <option value="failed">failed</option>
              <option value="unknown">unknown</option>
            </select>
            <span className="text-xs text-[hsl(218_10%_42%)]">
              {filtered.length} / {evidence.length} 条
            </span>
          </div>
        </div>
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleItems.length === 0 ? (
            <p className="col-span-full text-sm text-[hsl(218_10%_42%)]">
              暂无匹配证据记录。
            </p>
          ) : (
            visibleItems.map((entry) => (
              <EvidenceRow key={entry.evidenceId} entry={entry} onPreview={loadPreview} />
            ))
          )}
        </div>
        {hasMore && (
          <div className="flex justify-center border-t border-[hsl(220_14%_89%)] px-5 py-3">
            <button
              type="button"
              onClick={() => setVisibleLimit(nextProgressiveLimit(visibleLimit))}
              className="rounded-lg border border-[hsl(220_14%_89%)] bg-white px-4 py-2 text-sm font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
            >
              加载更多（已显示 {visibleItems.length} / {filtered.length}）
            </button>
          </div>
        )}
        {(preview || previewLoading || previewError) && (
          <div className="border-t border-[hsl(220_14%_89%)] px-5 py-4">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-[hsl(220_14%_14%)]">证据预览</h3>
              {preview && (
                <span className="text-xs text-[hsl(218_10%_42%)]">
                  {preview.path} · {preview.lines} 行
                  {preview.truncated ? ' · 已截断' : ''}
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setPreview(null);
                  setPreviewError('');
                }}
                className="ml-auto rounded-md border border-[hsl(220_14%_89%)] bg-white px-3 py-1.5 text-xs font-medium text-[hsl(220_14%_14%)]"
              >
                关闭
              </button>
            </div>
            {previewLoading && (
              <p className="mt-3 text-sm text-[hsl(218_10%_42%)]">正在读取证据内容...</p>
            )}
            {previewError && (
              <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {previewError}
              </p>
            )}
            {preview && (
              <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)] p-3 text-xs leading-5 text-[hsl(220_14%_14%)]">
                {preview.content}
              </pre>
            )}
          </div>
        )}
      </section>
    </QueryState>
  );
};

export default EvidencePanel;