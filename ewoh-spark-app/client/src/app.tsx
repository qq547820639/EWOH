import React, { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import PageSkeleton from './components/app-shell/PageSkeleton';
import { getAuthUser, isAuthenticated } from './lib/auth';
import { defaultLandingPath, getAllowedRoles, hasRoleAccess } from './lib/navigation';
import { ingestTelemetry } from './api/telemetry';
import { installBatchedTelemetrySink, track } from './lib/telemetry';

const CommandCenter = React.lazy(() => import('./pages/CommandCenter/CommandCenter'));
const FactoryOperations = React.lazy(() => import('./pages/FactoryOperations/FactoryOperations'));
const ShiftWorkbench = React.lazy(() => import('./pages/ShiftWorkbench/ShiftWorkbench'));
const DigitalWorld = React.lazy(() => import('./pages/DigitalWorld/DigitalWorld'));
const Scheduling = React.lazy(() => import('./pages/Scheduling/Scheduling'));
const AiDecision = React.lazy(() => import('./pages/AiDecision/AiDecision'));
const SimulationConsole = React.lazy(() => import('./pages/Simulation/SimulationConsole'));
const ApprovalConsole = React.lazy(() => import('./pages/ApprovalConsole/ApprovalConsole'));
const ReasoningConsole = React.lazy(() => import('./pages/Reasoning/ReasoningConsole'));
const Materials = React.lazy(() => import('./pages/Materials/Materials'));
const ExoWorkbench = React.lazy(() => import('./pages/Exo/ExoWorkbench'));
const DecisionHistoryConsole = React.lazy(() => import('./pages/DecisionHistory/DecisionHistoryConsole'));
const Devices = React.lazy(() => import('./pages/Devices/Devices'));
const Personnel = React.lazy(() => import('./pages/Personnel/Personnel'));
const Alerts = React.lazy(() => import('./pages/Alerts/Alerts'));
const Organization = React.lazy(() => import('./pages/Organization/Organization'));
const ModelManagement = React.lazy(() => import('./pages/ModelManagement/ModelManagement'));
const DataAssets = React.lazy(() => import('./pages/DataAssets/DataAssets'));
const System = React.lazy(() => import('./pages/System/System'));
const CommandMap = React.lazy(() => import('./pages/CommandMap/CommandMap'));
const MobileWorkbench = React.lazy(() => import('./pages/MobileWorkbench/MobileWorkbench'));
const FieldOperations = React.lazy(() => import('./pages/FieldOperations/FieldOperations'));
const LearningConsole = React.lazy(() => import('./pages/LearningConsole/LearningConsole'));
const Scale = React.lazy(() => import('./pages/Scale/Scale'));
const Operations = React.lazy(() => import('./pages/Operations/Operations'));
const RoleWorkbench = React.lazy(() => import('./pages/RoleWorkbench/RoleWorkbench'));
const WorkOrchestration = React.lazy(() => import('./pages/WorkOrchestration/WorkOrchestration'));
const NotFound = React.lazy(() => import('./pages/NotFound/NotFound'));
const Login = React.lazy(() => import('./pages/Login/Login'));
const Forbidden = React.lazy(() => import('./pages/Forbidden/Forbidden'));
const ObjectWorkbench = React.lazy(() => import('./pages/ObjectWorkbench/ObjectWorkbench'));

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
  <div className="min-h-screen">
    <PageSkeleton />
  </div>
);

const DefaultLandingRedirect = (): React.ReactElement => (
  <Navigate to={defaultLandingPath(getAuthUser()?.roles)} replace />
);

const RoutesComponent = () => {
  const location = useLocation();
  // 埋点批量上报：挂载时安装一次，返回清理函数以便卸载时冲刷剩余事件。
  // 上报失败由 sink 内部静默吞掉，不影响任何业务路径。
  useEffect(() => installBatchedTelemetrySink(ingestTelemetry), []);

  // 页面 PV 采集（路线图 A1 / D2 驾驶舱决策的数据基础）：
  // 路由变化即记一条 nav_source（事件名已在后端白名单，零后端改动）。
  // 登录页/禁止页跳转也计入——它们反映真实到达路径。
  useEffect(() => {
    const to = location.pathname;
    if (!to || to === '/login') return;
    track('nav_source', { to });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  return (
    <React.Suspense fallback={<PageFallback />}>
      <Routes>
        {/* 指挥地图：应用内全屏路由（React 版），不使用 Layout 侧边栏；
            历史静态原型保留在仓库根 ui/command_map（UX 参考，非生产事实源） */}
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
          <Route index element={<DefaultLandingRedirect />} />
          <Route path="factory-operations" element={<RequireRole path="/factory-operations"><FactoryOperations /></RequireRole>} />
          {/* DR-2 班次工作台（standalone_074）：以"班"为第一视角组织当班事实。 */}
          <Route path="shift-workbench" element={<RequireRole path="/shift-workbench"><ShiftWorkbench /></RequireRole>} />
          <Route path="command-center" element={<RequireRole path="/command-center"><CommandCenter /></RequireRole>} />
          <Route path="digital-world" element={<RequireRole path="/digital-world"><DigitalWorld /></RequireRole>} />
          <Route path="scheduling" element={<RequireRole path="/scheduling"><Scheduling /></RequireRole>} />
          {/* OD-2 对象工作台：深链入口（不进侧边栏导航，故不套 RequireRole——
              未注册路径会 fail-closed 拒绝所有人）。租户隔离由后端
              getPlanDetail（ADR-071/073，跨租户 404）保证。 */}
          <Route path="o/:objectType/:objectId" element={<ObjectWorkbench />} />
          <Route path="ai-decision" element={<RequireRole path="/ai-decision"><AiDecision /></RequireRole>} />
          <Route path="simulation" element={<RequireRole path="/simulation"><SimulationConsole /></RequireRole>} />
          <Route path="approval-console" element={<RequireRole path="/approval-console"><ApprovalConsole /></RequireRole>} />
          <Route path="reasoning" element={<RequireRole path="/reasoning"><ReasoningConsole /></RequireRole>} />
          <Route path="materials" element={<RequireRole path="/materials"><Materials /></RequireRole>} />
          <Route path="exo" element={<RequireRole path="/exo"><ExoWorkbench /></RequireRole>} />
          <Route path="decision-history" element={<RequireRole path="/decision-history"><DecisionHistoryConsole /></RequireRole>} />
          <Route path="devices" element={<RequireRole path="/devices"><Devices /></RequireRole>} />
          <Route path="personnel" element={<RequireRole path="/personnel"><Personnel /></RequireRole>} />
          <Route path="alerts" element={<RequireRole path="/alerts"><Alerts /></RequireRole>} />
          <Route path="organization" element={<RequireRole path="/organization"><Organization /></RequireRole>} />
          <Route path="model-management" element={<RequireRole path="/model-management"><ModelManagement /></RequireRole>} />
          <Route path="data-assets" element={<RequireRole path="/data-assets"><DataAssets /></RequireRole>} />
          <Route path="system" element={<RequireRole path="/system"><System /></RequireRole>} />
          <Route path="mobile-workbench" element={<RequireRole path="/mobile-workbench"><MobileWorkbench /></RequireRole>} />
          <Route path="field-operations" element={<RequireRole path="/field-operations"><FieldOperations /></RequireRole>} />
          <Route path="learning-console" element={<RequireRole path="/learning-console"><LearningConsole /></RequireRole>} />
          <Route path="scale" element={<RequireRole path="/scale"><Scale /></RequireRole>} />
          <Route path="operations" element={<RequireRole path="/operations"><Operations /></RequireRole>} />
          <Route path="role-workbench" element={<RequireRole path="/role-workbench"><RoleWorkbench /></RequireRole>} />
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
