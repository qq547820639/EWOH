import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { resolveBreadcrumb } from '@/lib/appContext';

/**
 * 面包屑：基于 navigation.ts 的 navGroups 反向映射当前路由层级。
 */
const AppBreadcrumb = ({ pathname }: { pathname: string }) => {
  const crumbs = resolveBreadcrumb(pathname);
  return (
    <Breadcrumb aria-label="面包屑导航" className="hidden md:block">
      <BreadcrumbList>
        {crumbs.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${index}`}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {crumb.to ? (
                <BreadcrumbLink asChild>
                  <Link
                    to={crumb.to}
                    className="text-[hsl(218_10%_42%)] hover:text-[hsl(220_14%_14%)]"
                  >
                    {crumb.label}
                  </Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage className="text-[hsl(220_14%_14%)]">
                  {crumb.label}
                </BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
};

export default AppBreadcrumb;