import { Layout, Menu } from "antd";
import { DashboardOutlined, LogoutOutlined } from "@ant-design/icons";
import { Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import Login from "./pages/Login";
import Register from "./pages/Register";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import { clearToken, getToken } from "./store/auth";

// 需要登录才能访问的布局：左侧菜单 + 内容区
function ProtectedLayout() {
  const navigate = useNavigate();

  // 未登录时重定向到登录页
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }

  // 退出登录：清除 token 并跳转登录页
  const handleLogout = () => {
    clearToken();
    navigate("/login");
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Sider width={200}>
        <Menu
          theme="dark"
          mode="inline"
          defaultSelectedKeys={["dashboard"]}
          style={{ height: "100%", borderRight: 0 }}
          items={[
            {
              key: "dashboard",
              icon: <DashboardOutlined />,
              label: "仪表盘",
              onClick: () => navigate("/"),
            },
            {
              key: "logout",
              icon: <LogoutOutlined />,
              label: "退出登录",
              onClick: handleLogout,
            },
          ]}
        />
      </Layout.Sider>
      <Layout.Content style={{ padding: 24 }}>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}

// 应用路由配置
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      {/* 重置密码：公开路由，无需登录 */}
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<Dashboard />} />
      </Route>
      {/* 兜底：未匹配路径重定向到首页 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
