import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "../theme/ThemeProvider";
import { clearToken } from "../store/auth";
import "./appshell.css";

const SWATCHES = [
  { k: "dark", s: "#0a0a0c" },
  { k: "soft", s: "#16162a" },
  { k: "light", s: "#f4f6f9" },
];

// 极简单页外壳：标题栏(36px) + 内容区 + 状态栏(28px)，无侧边栏
// 进入 /ops/:industryId 工作台时为沉浸模式：隐藏全局外壳，由工作台展示自身完整外壳
export default function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  const immersive = /^\/ops\/\d+/.test(location.pathname);
  if (immersive) return <Outlet />;

  const handleLogout = () => {
    clearToken();
    navigate("/login");
  };

  return (
    <div className="shell-root">
      {/* === 标题栏 36px === */}
      <header className="sh-titlebar">
        <div className="sh-left">
          <span className="sh-dot" />
          <span className="sh-brand">Nginx 配置管理系统</span>
        </div>
        <div className="sh-mid">行业管理</div>
        <div className="sh-right">
          <div className="ctl">
            {SWATCHES.map((sw) => (
              <button
                key={sw.k}
                title={sw.k === "dark" ? "深色" : sw.k === "soft" ? "暗紫" : "浅色"}
                className={"swatch" + (theme === sw.k ? " active" : "")}
                style={{ background: sw.s }}
                onClick={() => setTheme(sw.k)}
              />
            ))}
          </div>
          <button className="btn title-exit" title="退出登录" onClick={handleLogout}>
            ⏻ 退出
          </button>
          <div className="win-dots">
            <i className="r" /><i className="y" /><i className="g" />
          </div>
        </div>
      </header>

      <div className="sh-body">
        {/* === 内容区 === */}
        <main className="sh-main">
          <div className="sh-content">
            <Outlet />
          </div>
          <div className="foot-glow" />
        </main>
      </div>

      {/* === 状态栏 28px === */}
      <footer className="sh-statusbar">
        <span className="mono">main</span>
        <span className="status-dot ok" />
        <span>clean</span>
        <span className="err">0 错误</span>
        <span className="warn">0 警告</span>
        <span className="mono" style={{ marginLeft: "auto" }}>Ln 1 · Col 1 · UTF-8</span>
      </footer>
    </div>
  );
}
