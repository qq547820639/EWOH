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
    containerClass: 'border-amber-200 bg-amber-50',
    iconClass: 'text-amber-600',
  },
  validation: {
    icon: CircleAlert,
    title: '操作未通过校验',
    containerClass: 'border-yellow-200 bg-yellow-50',
    iconClass: 'text-yellow-600',
  },
  connection: {
    icon: WifiOff,
    title: '网络连接失败',
    containerClass: 'border-sky-200 bg-sky-50',
    iconClass: 'text-sky-600',
  },
  server: {
    icon: ServerCrash,
    title: '服务器暂时不可用',
    containerClass: 'border-red-200 bg-red-50',
    iconClass: 'text-red-600',
  },
  unknown: {
    icon: TriangleAlert,
    title: '操作失败',
    containerClass: 'border-red-200 bg-red-50',
    iconClass: 'text-red-600',
  },
};

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
    };
  }, [error, errorMessage]);

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
      `错误信息：${parsed.message}\n` +
      `推荐操作：${parsed.recommendedAction || '无'}`;
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
          <p className="font-semibold text-[hsl(220_14%_14%)]">
            {presentation.title}
          </p>
          <p className="mt-0.5 text-[hsl(220_14%_14%)]">{parsed.message}</p>
          {parsed.recommendedAction && (
            <p className="mt-1 text-[hsl(218_10%_42%)]">
              <span className="font-medium">推荐操作：</span>
              {parsed.recommendedAction}
            </p>
          )}
        </div>
      </div>

      {(parsed.code || parsed.requestId) && (
        <div className="grid gap-0.5 rounded bg-white/60 p-2 font-mono text-xs text-[hsl(218_10%_42%)]">
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
        {onRetry && (
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