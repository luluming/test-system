import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Form, Input, Modal, message } from "antd";
import { useTheme } from "../theme/ThemeProvider";
import { clearToken, getUser, setToken } from "../store/auth";
import { changePassword } from "../api/auth";
import "./appshell.css";

const SWATCHES = [
  { k: "dark", s: "#0a0a0c" },
  { k: "soft", s: "#16162a" },
  { k: "light", s: "#f4f6f9" },
];

// 新密码规则：至少 8 位，同时包含字母和数字
const PWD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

// 极简单页外壳：标题栏(36px) + 内容区 + 状态栏(28px)，无侧边栏
// 进入 /projects/:id/ops|yaml 工作台时为沉浸模式：隐藏全局外壳，由工作台展示自身完整外壳
export default function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const user = getUser();
  const isAdmin = user?.role === "admin";

  // 修改密码弹窗
  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  const [pwdForm] = Form.useForm();

  const immersive = /^\/projects\/\d+\/(ops|yaml)/.test(location.pathname);
  if (immersive) return <Outlet />;

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
          <span className="sh-brand">Nginx 配置管理系统</span>
        </div>
        <div className="sh-mid">行业管理</div>
        <div className="sh-right">
          {/* 当前用户：admin 角色加管理员标识 */}
          {user && (
            <span className="sh-user">
              {user.username}
              {isAdmin && <span className="tag2 pub" style={{ marginLeft: 6 }}>管理员</span>}
            </span>
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
