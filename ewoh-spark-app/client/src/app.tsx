import React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { getAuthUser, isAuthenticated } from './lib/auth';
import { getAllowedRoles, hasRoleAccess } from './lib/navigation';

const CommandCenter = React.lazy(() => import('./pages/CommandCenter/CommandCenter'));
const DigitalWorld = React.lazy(() => import('./pages/DigitalWorld/DigitalWorld'));
const Scheduling = React.lazy(() => import('./pages/Scheduling/Scheduling'));
const AiDecision = React.lazy(() => import('./pages/AiDecision/AiDecision'));
const Devices = React.lazy(() => import('./pages/Devices/Devices'));
const Personnel = React.lazy(() => import('./pages/Personnel/Personnel'));
const Alerts = React.lazy(() => import('./pages/Alerts/Alerts'));
const Organization = React.lazy(() => import('./pages/Organization/Organization'));
const ModelManagement = React.lazy(() => import('./pages/ModelManagement/ModelManagement'));
const DataAssets = React.lazy(() => import('./pages/DataAssets/DataAssets'));
const System = React.lazy(() => import('./pages/System/System'));
const CommandMap = React.lazy(() => import('./pages/CommandMap/CommandMap'));
const MobileWorkbench = React.lazy(() => import('./pages/MobileWorkbench/MobileWorkbench'));
const Scale = React.lazy(() => import('./pages/Scale/Scale'));
const Operations = React.lazy(() => import('./pages/Operations/Operations'));
const WorkOrchestration = React.lazy(() => import('./pages/WorkOrchestration/WorkOrchestration'));
const NotFound = React.lazy(() => import('./pages/NotFound/NotFound'));
const Login = React.lazy(() => import('./pages/Login/Login'));
const Forbidden = React.lazy(() => import('./pages/Forbidden/Forbidden'));

const RequireAuth = ({ children }: { children: React.ReactElement }) => {
  const location = useLocation();
  if (!isAuthenticated()) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  return children;
};

const RequireRole = ({ path, children }: { path: string; children: React.ReactElement }) => {
  const user = getAuthUser();
  const allowedRoles = getAllowedRoles(path);
  if (!hasRoleAccess(user?.roles, allowedRoles)) {
    return <Forbidden />;
  }
  return children;
};

const PageFallback = () => (
  <div className="flex min-h-screen items-center justify-center text-sm text-[hsl(218_10%_42%)]">
    加载中...
  </div>
);

const RoutesComponent = () => {
  return (
    <React.Suspense fallback={<PageFallback />}>
      <Routes>
        {/* 指挥地图：全屏 iframe，不使用 Layout 侧边栏 */}
        <Route
          path="command-map"
          element={
            <RequireAuth>
              <RequireRole path="/command-map">
                <CommandMap />
              </RequireRole>
            </RequireAuth>
          }
        />
        <Route path="login" element={<Login />} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Navigate to="/command-center" replace />} />
          <Route path="command-center" element={<RequireRole path="/command-center"><CommandCenter /></RequireRole>} />
          <Route path="digital-world" element={<RequireRole path="/digital-world"><DigitalWorld /></RequireRole>} />
          <Route path="scheduling" element={<RequireRole path="/scheduling"><Scheduling /></RequireRole>} />
          <Route path="ai-decision" element={<RequireRole path="/ai-decision"><AiDecision /></RequireRole>} />
          <Route path="devices" element={<RequireRole path="/devices"><Devices /></RequireRole>} />
          <Route path="personnel" element={<RequireRole path="/personnel"><Personnel /></RequireRole>} />
          <Route path="alerts" element={<RequireRole path="/alerts"><Alerts /></RequireRole>} />
          <Route path="organization" element={<RequireRole path="/organization"><Organization /></RequireRole>} />
          <Route path="model-management" element={<RequireRole path="/model-management"><ModelManagement /></RequireRole>} />
          <Route path="data-assets" element={<RequireRole path="/data-assets"><DataAssets /></RequireRole>} />
          <Route path="system" element={<RequireRole path="/system"><System /></RequireRole>} />
          <Route path="mobile-workbench" element={<RequireRole path="/mobile-workbench"><MobileWorkbench /></RequireRole>} />
          <Route path="scale" element={<RequireRole path="/scale"><Scale /></RequireRole>} />
          <Route path="operations" element={<RequireRole path="/operations"><Operations /></RequireRole>} />
          <Route path="work-orchestration" element={<RequireRole path="/work-orchestration"><WorkOrchestration /></RequireRole>} />
          {/* 旧路由保留为跳转别名 */}
          <Route path="events" element={<Navigate to="/alerts" replace />} />
          <Route path="workers" element={<Navigate to="/personnel" replace />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </React.Suspense>
  );
};

export default RoutesComponent;
