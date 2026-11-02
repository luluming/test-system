import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Form, Input, Modal, message } from "antd";
import { useTheme } from "../theme/ThemeProvider";
import { clearToken, getUser, setToken } from "../store/auth";
import { changePassword } from "../api/auth";
import { decideAccessRequest, listPendingAccessRequests } from "../api/projects";
import IndustrySidebar from "./IndustrySidebar";
import "./appshell.css";

const SWATCHES = [
  { k: "dark", s: "#0a0a0c" },
  { k: "soft", s: "#16162a" },
  { k: "light", s: "#f4f6f9" },
];

// 新密码规则：至少 8 位，同时包含字母和数字
const PWD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

// 统一外壳：标题栏(36px) + 左侧行业导航 + 内容区 + 状态栏(28px)
// 进入 /projects/:id/nginx|yaml 工作台时保留行业导航（维持行业/项目上下文），
// 内容区切换为紧凑模式（无内边距、工作台自适应高度），并隐藏底部状态栏。
export default function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const user = getUser();
  const isAdmin = user?.role === "admin";

  // 访问申请：待我审批（项目负责人/管理员）
  const [pendingReqs, setPendingReqs] = useState([]);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [decidingId, setDecidingId] = useState(null);

  // 修改密码弹窗
  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  const [pwdForm] = Form.useForm();

  // 工作台（Nginx / YAML）：保留外壳与左侧导航，仅内容区改为紧凑布局
  const path = location.pathname;
  const immersive = /^\/projects\/\d+\/(nginx|yaml|ops)/.test(path);
  // 账号管理与无权限页不展示行业导航
  const hideSidebar = path.startsWith("/accounts") || path === "/403";

  // 标题栏中段：随当前层级显示所处位置
  const section = path === "/"
    ? "行业管理"
    : path.startsWith("/industries/")
      ? "行业 / 项目列表"
      : path.endsWith("/nginx")
        ? "项目工作区 · Nginx 配置"
        : path.endsWith("/yaml")
          ? "项目工作区 · YML 配置"
          : path.endsWith("/config")
            ? "项目工作区 · 配置管理"
            : path.startsWith("/projects/")
              ? "项目工作区"
              : path.startsWith("/accounts")
                ? "账号管理"
                : path === "/403"
                  ? "无权限访问"
                  : "";

  // 路由变化时刷新待审批数量（登录后 / 进入页面即可看到入口）
  useEffect(() => {
    let alive = true;
    listPendingAccessRequests()
      .then((res) => { if (alive) setPendingReqs(res.data || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [location.pathname]);

  // 同意 / 拒绝访问申请
  const decideRequest = async (req, action) => {
    setDecidingId(req.id);
    try {
      await decideAccessRequest(req.project_id, req.id, action);
      message.success(
        action === "approve"
          ? `已同意 ${req.requester_name} 访问「${req.project_name}」（对方刷新后可见）`
          : "已拒绝该访问申请"
      );
      const res = await listPendingAccessRequests();
      setPendingReqs(res.data || []);
      window.dispatchEvent(new Event("industries:changed"));
    } catch (err) {
      const detail = err.response?.data?.detail;
      message.error(typeof detail === "string" ? detail : "操作失败");
    } finally {
      setDecidingId(null);
    }
  };

  const handleLogout = () => {
    clearToken();
    navigate("/login");
  };

  // 提交修改密码：成功后用返回的新 token 替换，保持会话不中断
  const submitPwd = async () => {
    const values = await pwdForm.validateFields();
    setPwdLoading(true);
    try {
      const res = await changePassword({
        old_password: values.old_password,
        new_password: values.new_password,
      });
      if (res.data?.access_token) setToken(res.data.access_token);
      message.success("密码已修改");
      setPwdOpen(false);
      pwdForm.resetFields();
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (detail) message.error(detail);
    } finally {
      setPwdLoading(false);
    }
  };

  return (
    <div className="shell-root">
      {/* === 标题栏 36px === */}
      <header className="sh-titlebar">
        <div className="sh-left">
          <span className="sh-dot" />
          <button className="sh-brand" title="返回行业管理首页" onClick={() => navigate("/")}>
            Nginx 配置管理系统
          </button>
        </div>
        <div className="sh-mid">{section}</div>
        <div className="sh-right">
          {/* 无左侧导航的页面（账号管理 / 403）保留显式返回入口 */}
          {hideSidebar && (
            <button className="btn title-back" onClick={() => navigate("/")}>
              ← 返回首页
            </button>
          )}
          {/* 当前用户：admin 角色加管理员标识 */}
          {user && (
            <span className="sh-user">
              {user.username}
              {isAdmin && <span className="tag2 pub" style={{ marginLeft: 6 }}>管理员</span>}
            </span>
          )}
          {pendingReqs.length > 0 && (
            <button className="btn" onClick={() => setInboxOpen(true)}>
              访问申请 <span className="tag2 warn">{pendingReqs.length}</span>
            </button>
          )}
          {isAdmin && (
            <button className="btn" onClick={() => navigate("/accounts")}>
              账号管理
            </button>
          )}
          <button className="btn" onClick={() => setPwdOpen(true)}>
            修改密码
          </button>
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
        {/* === 左侧行业导航（账号管理/403 隐藏）=== */}
        {!hideSidebar && <IndustrySidebar />}

        {/* === 内容区 === */}
        <main className="sh-main">
          <div className={`sh-content${immersive ? " tight" : ""}`}>
            <Outlet />
          </div>
          {!immersive && <div className="foot-glow" />}
        </main>
      </div>

      {/* === 状态栏 28px（工作台沉浸布局下隐藏，留给编辑器更多高度）=== */}
      {!immersive && (
        <footer className="sh-statusbar">
          <span className="mono">main</span>
          <span className="status-dot ok" />
          <span>clean</span>
          <span className="err">0 错误</span>
          <span className="warn">0 警告</span>
          <span className="mono" style={{ marginLeft: "auto" }}>Ln 1 · Col 1 · UTF-8</span>
        </footer>
      )}

      {/* 访问申请审批弹窗 */}
      <Modal
        title={`访问申请 · 待审批 ${pendingReqs.length}`}
        open={inboxOpen}
        onCancel={() => setInboxOpen(false)}
        footer={null}
        width={560}
        destroyOnClose
      >
        {pendingReqs.length === 0 ? (
          <p className="meta">暂无待审批的访问申请</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 420, overflowY: "auto" }}>
            {pendingReqs.map((r) => (
              <div
                key={r.id}
                style={{
                  border: "1px solid var(--border-soft)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  background: "var(--bg-surface2)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <b>{r.project_name}</b>
                  <span className="tag2 bare">{r.industry_name}</span>
                  <span className="meta" style={{ marginLeft: "auto" }}>
                    {r.created_at ? r.created_at.replace("T", " ").slice(0, 16) : ""}
                  </span>
                </div>
                <p className="meta" style={{ margin: "6px 0 8px" }}>
                  {r.requester_name}（{r.requester_email || "无邮箱"}）申请查看
                  {r.message ? ` · ${r.message}` : ""}
                </p>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    className="btn mini"
                    disabled={decidingId === r.id}
                    onClick={() => decideRequest(r, "reject")}
                  >
                    拒绝
                  </button>
                  <button
                    className="btn mini primary"
                    disabled={decidingId === r.id}
                    onClick={() => decideRequest(r, "approve")}
                  >
                    {decidingId === r.id ? "处理中…" : "同意"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* 修改密码弹窗 */}
      <Modal
        title="修改密码"
        open={pwdOpen}
        onOk={submitPwd}
        onCancel={() => { setPwdOpen(false); pwdForm.resetFields(); }}
        confirmLoading={pwdLoading}
        okText="确认修改"
        cancelText="取消"
        width={420}
        destroyOnClose
      >
        <Form form={pwdForm} layout="vertical" preserve={false}>
          <Form.Item
            name="old_password"
            label="原密码"
            rules={[{ required: true, message: "请输入原密码" }]}
          >
            <Input.Password placeholder="请输入原密码" autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="new_password"
            label="新密码"
            rules={[
              { required: true, message: "请输入新密码" },
              { pattern: PWD_RE, message: "至少 8 位，需同时包含字母和数字" },
            ]}
          >
            <Input.Password placeholder="至少 8 位，包含字母和数字" autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm_password"
            label="确认新密码"
            dependencies={["new_password"]}
            rules={[
              { required: true, message: "请再次输入新密码" },
              ({ getFieldValue }) => ({
                validator: (_, v) =>
                  !v || v === getFieldValue("new_password")
                    ? Promise.resolve()
                    : Promise.reject(new Error("两次输入的密码不一致")),
              }),
            ]}
          >
            <Input.Password placeholder="再次输入新密码" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
