import { Link, useNavigate } from 'react-router-dom';
import { LogOut, ShieldX } from 'lucide-react';
import { toast } from 'sonner';
import { getAuthUser, revokeSession } from '../../lib/auth';
import { errorDescription } from '../../lib/errorContract';

const Forbidden = (): React.ReactElement => {
  const navigate = useNavigate();
  const user = getAuthUser();

  const handleLogout = async () => {
    try {
      await revokeSession();
    } catch (error) {
      // CLI-111：revoke 失败仍允许本地登出（服务端会话由后端过期兜底）。
      toast.error('退出登录请求失败，已本地登出', {
        description: errorDescription(error),
      });
    }
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
          <ShieldX className="h-6 w-6 text-red-600" />
        </div>
        <h1 className="mt-4 text-2xl font-bold text-foreground">403 无权限</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          当前账号（{user?.username ?? '未知'}）无权访问该中心，请联系管理员调整角色。
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Link
            to="/command-center"
            className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            返回指挥中心
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </div>
      </div>
    </div>
  );
};

export default Forbidden;
