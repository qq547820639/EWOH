import { Link } from 'react-router-dom';

const NotFound = () => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-6">
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="text-4xl font-bold text-foreground">404</p>
        <p className="mt-2 text-sm text-muted-foreground">页面不存在或已被移动。</p>
        <Link
          to="/factory-operations"
          className="mt-4 inline-flex rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          返回工厂运行台
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
