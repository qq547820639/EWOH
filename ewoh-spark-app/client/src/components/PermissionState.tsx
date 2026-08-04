import { ArrowLeft, ShieldX } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@client/src/components/ui/button';
import { EWOH_ROLE_LABELS, type EwohRole } from '@client/src/types/ewoh';

interface PermissionStateProps {
  /** 需要的角色数组，用于展示 */
  roles: EwohRole[];
  /** 可选标题，默认「权限不足」 */
  title?: string;
  /** 可选描述，默认根据 roles 生成角色提示 */
  description?: string;
  /** 返回安全状态回调（优先于 backHref） */
  onBack?: () => void;
  /** 返回安全状态目标路由，如 /command-center */
  backHref?: string;
  backLabel?: string;
}

const roleLabelsOf = (roles: EwohRole[]): string =>
  roles.map((role) => EWOH_ROLE_LABELS[role]).join('、');

const PermissionState = ({
  roles,
  title = '权限不足',
  description,
  onBack,
  backHref,
  backLabel = '返回安全状态',
}: PermissionStateProps): React.ReactElement => {
  const navigate = useNavigate();

  const roleLabels = roleLabelsOf(roles);
  const resolvedDescription =
    description ??
    (roleLabels
      ? `此功能仅对以下角色可见：${roleLabels}。`
      : '当前账号缺少访问该功能所需的角色权限。');

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (backHref) navigate(backHref);
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm"
    >
      <div className="flex items-start gap-2">
        <ShieldX className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div className="min-w-0">
          <p className="font-semibold text-[hsl(220_14%_14%)]">{title}</p>
          <p className="mt-0.5 text-[hsl(220_14%_14%)]">{resolvedDescription}</p>
        </div>
      </div>

      {(onBack || backHref) && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={handleBack}>
            <ArrowLeft className="size-3.5" />
            {backLabel}
          </Button>
        </div>
      )}
    </div>
  );
};

export default PermissionState;