import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ResetPassword from "./pages/ResetPassword";
import IndustryDashboard from "./pages/IndustryDashboard";
import IndustryDetail from "./pages/IndustryDetail";
import YamlConfigPage from "./pages/yaml/YamlConfigPage";
import AppShell from "./components/AppShell";
import { clearToken, getToken } from "./store/auth";

// 需要登录才能访问的布局：统一 IDE 外壳（标题栏/内容区/状态栏）
// 进入 /ops/:industryId 工作台时，AppShell 自动切换沉浸模式隐藏全局外壳
function ProtectedLayout() {
  const location = useLocation();

  // 未登录时重定向到登录页
  if (!getToken()) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <AppShell />;
}

// 应用路由配置：行业管理为唯一全局入口，行业工作台沉浸式
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      {/* 重置密码：公开路由，无需登录 */}
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<IndustryDashboard />} />
        <Route path="/ops/:industryId" element={<IndustryDetail />} />
        <Route path="/ops/:industryId/yaml" element={<YamlConfigPage />} />
      </Route>
      {/* 兜底：未匹配路径重定向到行业管理首页 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
