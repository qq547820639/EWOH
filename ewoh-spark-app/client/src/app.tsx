import React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import CommandCenter from './pages/CommandCenter/CommandCenter';
import DigitalWorld from './pages/DigitalWorld/DigitalWorld';
import Scheduling from './pages/Scheduling/Scheduling';
import AiDecision from './pages/AiDecision/AiDecision';
import Devices from './pages/Devices/Devices';
import Personnel from './pages/Personnel/Personnel';
import Alerts from './pages/Alerts/Alerts';
import Organization from './pages/Organization/Organization';
import ModelManagement from './pages/ModelManagement/ModelManagement';
import DataAssets from './pages/DataAssets/DataAssets';
import System from './pages/System/System';
import CommandMap from './pages/CommandMap/CommandMap';
import NotFound from './pages/NotFound/NotFound';
import Login from './pages/Login/Login';
import Forbidden from './pages/Forbidden/Forbidden';
import { getAuthUser, isAuthenticated } from './lib/auth';
import { getAllowedRoles, hasRoleAccess } from './lib/navigation';

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

const RoutesComponent = () => {
  return (
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
        {/* 旧路由保留为跳转别名 */}
        <Route path="events" element={<Navigate to="/alerts" replace />} />
        <Route path="workers" element={<Navigate to="/personnel" replace />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default RoutesComponent;
