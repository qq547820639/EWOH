import { Link, useNavigate } from 'react-router-dom';
import { LogOut, ShieldX } from 'lucide-react';
import { getAuthUser, revokeSession } from '../../lib/auth';

const Forbidden = (): React.ReactElement => {
  const navigate = useNavigate();
  const user = getAuthUser();

  const handleLogout = async () => {
    await revokeSession();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[hsl(220_14%_96%)] p-6">
      <div className="w-full max-w-md rounded-lg border border-[hsl(220_14%_89%)] bg-white p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
          <ShieldX className="h-6 w-6 text-red-600" />
        </div>
        <h1 className="mt-4 text-2xl font-bold text-[hsl(220_14%_14%)]">403 无权限</h1>
        <p className="mt-2 text-sm text-[hsl(218_10%_42%)]">
          当前账号（{user?.username ?? '未知'}）无权访问该中心，请联系管理员调整角色。
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Link
            to="/command-center"
            className="rounded-lg bg-[hsl(221_83%_53%)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            返回指挥中心
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex items-center gap-2 rounded-lg border border-[hsl(220_14%_89%)] px-3 py-2 text-sm font-medium hover:bg-[hsl(220_14%_96%)]"
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
