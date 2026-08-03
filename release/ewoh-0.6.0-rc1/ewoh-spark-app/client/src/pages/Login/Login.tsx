import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { login } from '../../api/auth';
import { isAuthenticated, setSession } from '../../lib/auth';

const Login = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/command-center', { replace: true });
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
      navigate(from ?? '/command-center', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[hsl(220_14%_96%)] p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-[hsl(220_14%_89%)] bg-white p-6"
      >
        <h1 className="text-2xl font-bold text-[hsl(220_14%_14%)]">EWOH</h1>
        <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">具身工厂操作系统</p>
        <label className="mt-6 block text-sm font-medium text-[hsl(220_14%_14%)]" htmlFor="username">
          用户名
        </label>
        <input
          id="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="mt-1 w-full rounded-lg border border-[hsl(220_14%_89%)] px-3 py-2 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
        />
        <label className="mt-4 block text-sm font-medium text-[hsl(220_14%_14%)]" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-lg border border-[hsl(220_14%_89%)] px-3 py-2 text-sm outline-none focus:border-[hsl(221_83%_53%)]"
        />
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[hsl(221_83%_53%)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {loading && <Loader2 className="size-4 animate-spin" />}
          登录
        </button>
      </form>
    </div>
  );
};

export default Login;
