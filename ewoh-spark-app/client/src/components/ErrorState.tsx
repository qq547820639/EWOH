import { useMemo } from 'react';
import {
  ArrowLeft,
  CircleAlert,
  Copy,
  RefreshCw,
  Save,
  ServerCrash,
  ShieldX,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import { sanitizeUserText } from '@client/src/components/AppErrorState';
import {
  parseError,
  type ErrorKind,
  type ParsedError,
} from '@client/src/lib/errorContract';

interface ErrorStateProps {
  /** 原始错误对象（axios 错误 / Error / 任意值），会经 parseError 解析 */
  error?: unknown;
  /** 无 error 时的纯文本兜底信息 */
  errorMessage?: string;
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

const KIND_PRESENTATION: Record<
  ErrorKind,
  { icon: LucideIcon; title: string; containerClass: string; iconClass: string }
> = {
  permission: {
    icon: ShieldX,
    title: '权限不足',
    containerClass: 'border-risk-degraded-border bg-risk-degraded-soft',
    iconClass: 'text-risk-degraded-foreground',
  },
  validation: {
    icon: CircleAlert,
    title: '操作未通过校验',
    containerClass: 'border-risk-degraded-border bg-risk-degraded-soft',
    iconClass: 'text-risk-degraded-foreground',
  },
  connection: {
    icon: WifiOff,
    title: '网络连接失败',
    containerClass: 'border-risk-offline-border bg-risk-offline-soft',
    iconClass: 'text-risk-offline-foreground',
  },
  server: {
    icon: ServerCrash,
    title: '服务器暂时不可用',
    containerClass: 'border-risk-blocked-border bg-risk-blocked-soft',
    iconClass: 'text-risk-blocked-foreground',
  },
  unknown: {
    icon: TriangleAlert,
    title: '操作失败',
    containerClass: 'border-risk-blocked-border bg-risk-blocked-soft',
    iconClass: 'text-risk-blocked-foreground',
  },
};

/**
 * 仅使用 Clipboard API 复制文本；不可用或失败时返回 false（CLI-311：移除已
 * 废弃的 document.execCommand('copy') 回退路径，由调用方提示手动复制）。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 忽略并交由调用方提示手动复制
  }
  return false;
}

const ErrorState = ({
  error,
  errorMessage = '操作失败，请稍后重试。',
  onRetry,
  onBack,
  onSaveDraft,
  backHref,
  backLabel = '返回安全状态',
  saveDraftLabel = '保存草稿',
}: ErrorStateProps): React.ReactElement => {
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

  // CLI-305：message / recommendedAction 可能携带原始堆栈 / JSON 片段，
  // 展示前必须经 sanitizeUserText 清洗（复用 AppErrorState 的实现）。
  const messageText = sanitizeUserText(parsed.message) || '操作失败，请稍后重试。';
  const recommendedText = sanitizeUserText(parsed.recommendedAction);

  const presentation = KIND_PRESENTATION[parsed.kind];
  const Icon = presentation.icon;

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (backHref) navigate(backHref);
  };

  const handleCopy = async () => {
    const text =
      `错误码：${parsed.code || '未知'}\n` +
      `请求ID：${parsed.requestId || '未知'}\n` +
      `错误信息：${messageText}\n` +
      `推荐操作：${recommendedText || '无'}`;
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
      className={`flex flex-col gap-3 rounded-lg border p-4 text-sm ${presentation.containerClass}`}
    >
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 size-5 shrink-0 ${presentation.iconClass}`} />
        <div className="min-w-0">
          <p className="font-semibold text-foreground">
            {presentation.title}
          </p>
          <p className="mt-0.5 text-foreground">{messageText}</p>
          {recommendedText && (
            <p className="mt-1 text-muted-foreground">
              <span className="font-medium">推荐操作：</span>
              {recommendedText}
            </p>
          )}
          <span
            className={`mt-2 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${
              parsed.retryable
                ? 'border-risk-normal-border bg-risk-normal-soft text-risk-normal-foreground'
                : 'border-border bg-muted text-muted-foreground'
            }`}
          >
            {parsed.retryable ? '可安全重试' : '不可重试'}
          </span>
        </div>
      </div>

      {(parsed.code || parsed.requestId) && (
        /* R2-CC2-002：诊断块表面 bg-card/60→bg-muted/60 令牌（dark 主题下可读）。 */
        <div className="grid gap-0.5 rounded bg-muted/60 p-2 font-mono text-xs text-muted-foreground">
          {parsed.code && (
            <div>
              <span className="font-medium">错误码：</span>
              <span>{parsed.code}</span>
            </div>
          )}
          {parsed.requestId && (
            <div>
              <span className="font-medium">请求ID：</span>
              <span>{parsed.requestId}</span>
            </div>
          )}
        </div>
      )}

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

export default ErrorState;
