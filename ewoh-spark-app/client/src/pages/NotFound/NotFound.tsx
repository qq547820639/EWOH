import { Link } from 'react-router-dom';

const NotFound = () => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[hsl(220_14%_96%)] p-6">
      <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-8 text-center">
        <p className="text-4xl font-bold text-[hsl(220_14%_14%)]">404</p>
        <p className="mt-2 text-sm text-[hsl(218_10%_42%)]">页面不存在或已被移动。</p>
        <Link
          to="/command-center"
          className="mt-4 inline-flex rounded-lg bg-[hsl(221_83%_53%)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          返回指挥中心
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
