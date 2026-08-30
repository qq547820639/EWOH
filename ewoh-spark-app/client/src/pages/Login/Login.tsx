import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { login } from '../../api/auth';
import { getAuthUser, isAuthenticated, setSession } from '../../lib/auth';
import { defaultLandingPath } from '../../lib/navigation';

const Login = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false); // AUDIT-009

  useEffect(() => {
    if (isAuthenticated()) {
      // UX-IA-2026-08：按角色任务域分流默认落地页（redirect 现场仍在 from 中）。
      navigate(defaultLandingPath(getAuthUser()?.roles), { replace: true });
    }
  }, [navigate]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const tokens = await login(username, password);
      setSession(tokens);
      const from = (location.state as { from?: string } | null)?.from;
      const roles = getAuthUser()?.roles;
      navigate(from ?? defaultLandingPath(roles), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6"
      >
        <h1 className="text-2xl font-bold text-foreground">EWOH</h1>
        <p className="mt-1 text-sm text-muted-foreground">具身工厂操作系统</p>
        <label className="mt-6 block text-sm font-medium text-foreground" htmlFor="username">
          用户名
        </label>
        <input
          id="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary"
          autoComplete="username" // AUDIT-008
        />
        <label className="mt-4 block text-sm font-medium text-foreground" htmlFor="password">
          密码
        </label>
        <div className="relative">
          <input
            id="password"
            type={showPassword ? 'text' : 'password'} // AUDIT-009
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border px-3 py-2 pr-10 text-sm outline-none focus:border-primary"
            autoComplete="current-password" // AUDIT-008
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
            aria-label={showPassword ? '隐藏密码' : '显示密码'}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {loading && <Loader2 className="size-4 animate-spin" />}
          登录
        </button>
      </form>
    </div>
  );
};

export default Login;
