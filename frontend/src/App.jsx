import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import Login from "./pages/Login";
import ResetPassword from "./pages/ResetPassword";
import ForbiddenPage from "./pages/ForbiddenPage";
import IndustryDashboard from "./pages/IndustryDashboard";
import ProjectListPage from "./pages/ProjectListPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import AccountsPage from "./pages/AccountsPage";
import IndustryDetail from "./pages/IndustryDetail";
import YamlConfigPage from "./pages/yaml/YamlConfigPage";
import AppShell from "./components/AppShell";
import { getToken, getUser } from "./store/auth";

// 需要登录才能访问的布局：统一 IDE 外壳（标题栏/内容区/状态栏）
// 进入 /projects/:id/ops|yaml 工作台时，AppShell 自动切换沉浸模式隐藏全局外壳
function ProtectedLayout() {
  const location = useLocation();

  // 未登录时重定向到登录页
  if (!getToken()) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <AppShell />;
}

// 仅系统管理员可访问：其余角色跳 403 页
function AdminPage({ children }) {
  if (getUser()?.role !== "admin") {
    return <Navigate to="/403" replace />;
  }
  return children;
}

// 应用路由配置：行业 → 项目 → 配置（nginx/yaml）三级结构
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* 重置密码：公开路由，无需登录 */}
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<IndustryDashboard />} />
        <Route path="/industries/:industryId/projects" element={<ProjectListPage />} />
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="/projects/:projectId/ops" element={<IndustryDetail />} />
        <Route path="/projects/:projectId/yaml" element={<YamlConfigPage />} />
        <Route path="/accounts" element={<AdminPage><AccountsPage /></AdminPage>} />
        <Route path="/403" element={<ForbiddenPage />} />
      </Route>
      {/* 兜底：未匹配路径重定向到行业管理首页 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
