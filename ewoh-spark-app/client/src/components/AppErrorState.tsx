import { useMemo } from 'react';
import {
  ArrowLeft,
  CircleAlert,
  Copy,
  RefreshCw,
  Save,
  ShieldX,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import {
  parseError,
  authzGuidance,
  type ParsedError,
} from '@client/src/lib/errorContract';
import { extractRequestIds } from '@client/src/lib/requestCorrelation';

/** 数据是否已保存：true=已保存 / false=未保存 / 'unknown'=未知 */
export type DataSavedState = boolean | 'unknown';

export interface AppErrorStateProps {
  /** 原始错误对象（axios 错误 / Error / 任意值），会经 parseError 解析 */
  error?: unknown;
  /** 无 error 时的纯文本兜底信息 */
  errorMessage?: string;
  /** 现象描述（用户可理解；默认取自 parseError.message，并做安全清洗） */
  phenomenon?: string;
  /** 可能影响（可选） */
  impact?: string;
  /** 数据是否已保存 */
  saved?: DataSavedState;
  /** 后续操作（可选；默认取自 parseError.recommendedAction / authzGuidance） */
  nextStep?: string;
  /** 重试按钮回调 */
  onRetry?: () => void;
  /** 返回安全状态回调（优先于 backHref） */
  onBack?: () => void;
  /** 保存草稿按钮回调（可选） */
  onSaveDraft?: () => void;
  /** 返回安全状态目标路由，如 /command-center */
  backHref?: string;
  backLabel?: string;
  saveDraftLabel?: string;
}

const MAX_TEXT_LENGTH = 160;

/**
 * 安全清洗展示文本：剥离堆栈帧、内联 JSON、超长 dev 文本。
 * 绝不把原始异常堆栈 / JSON / 开发者内部文本暴露给普通用户。
 */
export function sanitizeUserText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let text = raw;
  if (!text.trim()) return '';
  // 换行 → 分隔符
  text = text.replace(/\r?\n+/g, ' · ');
  // 剥离 "at 方法 (file:line)" 形式的堆栈帧
  text = text.replace(/\s*at\s+[\w.$<>/-]+\s*\([^)]*\)\s*/g, '');
  // 剥离剩余的 "at 路径" 尾部堆栈行
  text = text.replace(/\s*at\s+.+$/g, '');
  // 剥离内联 JSON 对象片段
  text = text.replace(/\{[^{}]*\}/g, '');
  // 剥离异常类型前缀（TypeError: / Error: / Exception: 等开发内部文本）
  text = text.replace(/^[A-Za-z]*(?:Error|Exception|AssertionError):\s*/, '');
  // 剥离 axios 类内部描述尾注
  text = text.replace(/\s*Request failed with status code \d+\s*$/g, '');
  // 折叠空白与多余分隔符
  text = text.replace(/[ \t]+/g, ' ').trim();
  text = text.replace(/(?: · )+/g, ' · ').replace(/^ · | · $/g, '').trim();
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH) + '…';
  }
  return text;
}

const KIND_TITLE: Record<ParsedError['kind'], string> = {
  permission: '权限不足',
  validation: '操作未通过校验',
  connection: '网络连接失败',
  server: '服务器暂时不可用',
  unknown: '操作失败',
};

function savedLabel(saved: DataSavedState): string {
  if (saved === true) return '已保存';
  if (saved === false) return '未保存';
  return '未知';
}

function kindIcon(kind: ParsedError['kind']): LucideIcon {
  if (kind === 'permission') return ShieldX;
  if (kind === 'connection') return RefreshCw;
  if (kind === 'validation') return CircleAlert;
  return TriangleAlert;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走回退方案
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

const AppErrorState = ({
  error,
  errorMessage = '操作失败，请稍后重试。',
  phenomenon,
  impact,
  saved = 'unknown',
  nextStep,
  onRetry,
  onBack,
  onSaveDraft,
  backHref,
  backLabel = '返回安全状态',
  saveDraftLabel = '保存草稿',
}: AppErrorStateProps): React.ReactElement => {
  const navigate = useNavigate();

  const parsed = useMemo<ParsedError>(() => {
    if (error !== undefined) {
      return parseError(error);
    }
    return {
      kind: 'unknown',
      code: '',
      requestId: '',
      recommendedAction: '',
      message: errorMessage,
      retryable: true,
    };
  }, [error, errorMessage]);

  // 复用 requestCorrelation 解析请求/追踪 ID
  const trace = useMemo(() => extractRequestIds(error), [error]);
  const requestId = trace.requestId || trace.traceId || parsed.requestId;

  const authz = authzGuidance(parsed.status);

  // 所有展示文本都必须经过清洗，且优先使用页面提供的、可被用户理解的字面量
  const title =
    authz?.title ?? KIND_TITLE[parsed.kind] ?? '操作失败';
  const phenomenonText =
    sanitizeUserText(phenomenon) ||
    sanitizeUserText(parsed.message) ||
    '操作失败，请稍后重试。';
  const impactText = sanitizeUserText(impact) || sanitizeUserText(authz?.impact);
  const nextStepText =
    sanitizeUserText(nextStep) ||
    sanitizeUserText(authz?.nextStep) ||
    sanitizeUserText(parsed.recommendedAction) ||
    '请稍后重试。';

  const Icon = kindIcon(parsed.kind);

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (backHref) navigate(backHref);
  };

  const handleCopy = async () => {
    const text =
      `现象：${phenomenonText}\n` +
      `可能影响：${impactText || '未知'}\n` +
      `数据是否已保存：${savedLabel(saved)}\n` +
      `后续操作：${nextStepText}\n` +
      `请求ID：${requestId || '未知'}`;
    const ok = await copyText(text);
    if (ok) {
      toast.success('已复制诊断信息');
    } else {
      toast.error('复制失败，请手动复制');
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm"
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-5 shrink-0 text-red-600" />
        <div className="min-w-0">
          <p className="font-semibold text-[hsl(220_14%_14%)]">{title}</p>
          <p className="mt-0.5 text-[hsl(220_14%_14%)]">{phenomenonText}</p>
        </div>
      </div>

      <dl className="grid gap-1 rounded bg-white/60 p-2 text-xs text-[hsl(218_10%_42%)] sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="font-medium text-[hsl(220_14%_14%)]">现象</dt>
          <dd className="break-words">{phenomenonText}</dd>
        </div>
        {impactText && (
          <div className="min-w-0">
            <dt className="font-medium text-[hsl(220_14%_14%)]">可能影响</dt>
            <dd className="break-words">{impactText}</dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className="font-medium text-[hsl(220_14%_14%)]">数据是否已保存</dt>
          <dd>{savedLabel(saved)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-medium text-[hsl(220_14%_14%)]">后续操作</dt>
          <dd className="break-words">{nextStepText}</dd>
        </div>
        {requestId && (
          <div className="min-w-0 sm:col-span-2">
            <dt className="font-medium text-[hsl(220_14%_14%)]">请求ID（可复制）</dt>
            <dd className="break-all font-mono">{requestId}</dd>
          </div>
        )}
      </dl>

      <div className="flex flex-wrap gap-2">
        {onRetry && parsed.retryable && (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            重试
          </Button>
        )}
        {(onBack || backHref) && (
          <Button type="button" size="sm" variant="outline" onClick={handleBack}>
            <ArrowLeft className="size-3.5" />
            {backLabel}
          </Button>
        )}
        {onSaveDraft && (
          <Button type="button" size="sm" variant="outline" onClick={onSaveDraft}>
            <Save className="size-3.5" />
            {saveDraftLabel}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={handleCopy}>
          <Copy className="size-3.5" />
          复制诊断信息
        </Button>
      </div>
    </div>
  );
};

export default AppErrorState;