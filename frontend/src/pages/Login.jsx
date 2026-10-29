import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Form, Input, message } from "antd";
import { LockOutlined, SafetyOutlined, UserOutlined } from "@ant-design/icons";
import { fetchCaptcha, login } from "../api/auth";
import { setToken } from "../store/auth";
import { useTheme } from "../theme/ThemeProvider";
import "./auth.css";

const SWATCHES = [
  { k: "dark", s: "#0a0a0c" },
  { k: "soft", s: "#16162a" },
  { k: "light", s: "#f4f6f9" },
];

// 登录页：IDE 风格（左侧品牌区 + 右侧表单卡片），与统一外壳同一套主题令牌
export default function Login() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [form] = Form.useForm();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [captcha, setCaptcha] = useState(null); // { captcha_id, captcha_image }
  const captchaLoadingRef = useRef(false); // 防止验证码重复请求

  // 会话过期跳转过来时给出提示
  useEffect(() => {
    if (searchParams.get("reason") === "expired") {
      message.warning("会话已过期，请重新登录");
    }
  }, [searchParams]);

  // 拉取图形验证码：进入页面自动加载，点击图片可刷新
  const loadCaptcha = useCallback(async () => {
    if (captchaLoadingRef.current) return;
    captchaLoadingRef.current = true;
    try {
      const res = await fetchCaptcha();
      setCaptcha(res.data);
    } catch {
      message.warning("验证码加载失败，请点击验证码重试");
    } finally {
      captchaLoadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    loadCaptcha();
  }, [loadCaptcha]);

  // 提交登录表单
  const onFinish = async (values) => {
    // 验证码尚未加载成功时先补齐验证码再提交
    if (!captcha?.captcha_id) {
      message.warning("验证码尚未加载，请稍候");
      loadCaptcha();
      return;
    }
    setLoading(true);
    try {
      // 携带用户名、密码与验证码信息登录，成功后保存 token 并跳转主页
      const res = await login({
        username: values.username,
        password: values.password,
        captcha_id: captcha.captcha_id,
        captcha_code: values.captcha,
      });
      const token = res.data?.access_token || res.data?.token;
      setToken(token);
      message.success("登录成功");
      navigate("/");
    } catch (err) {
      const detail = err.response?.data?.detail;
      // 验证码错误或过期：提示并自动刷新验证码、清空验证码输入
      if (typeof detail === "string" && detail.includes("验证码")) {
        message.error(detail);
        form.setFieldValue("captcha", "");
        loadCaptcha();
      } else {
        message.error(detail || "登录失败，请重试");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      {/* 主题切换（右上角，IDE 风格） */}
      <div className="auth-theme">
        {SWATCHES.map((sw) => (
          <button
            key={sw.k}
            title={sw.k}
            className={"swatch" + (theme === sw.k ? " active" : "")}
            style={{ background: sw.s }}
            onClick={() => setTheme(sw.k)}
          />
        ))}
      </div>

      {/* 左侧品牌区：产品名 + 标语（窄屏时隐藏） */}
      <aside className="auth-brand">
        <div className="auth-brand-inner">
          <span className="auth-logo-dot" />
          <h1>Nginx 配置管理系统</h1>
          <p>行业隔离 · 块级配置 · 拓扑预览，一站式 nginx / stream 运维工作台</p>
          <div className="auth-brand-meta">
            <span className="tag2 ok">conf</span>
            <span className="tag2 def">block</span>
            <span className="tag2 pub">topology</span>
          </div>
        </div>
      </aside>

      {/* 右侧表单区：登录表单卡片 */}
      <main className="auth-panel">
        <div className="auth-card">
          <h2 className="auth-title">欢迎回来</h2>
          <p className="auth-subtitle">请输入账号信息登录系统</p>
          <Form form={form} name="login" onFinish={onFinish} size="large">
            <Form.Item name="username" rules={[{ required: true, message: "请输入用户名" }]}>
              <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
            </Form.Item>
            <Form.Item name="captcha" rules={[{ required: true, message: "请输入验证码" }]}>
              <Input
                prefix={<SafetyOutlined />}
                placeholder="验证码"
                maxLength={6}
                suffix={
                  captcha ? (
                    <span className="captcha-box" title="点击刷新验证码" onClick={loadCaptcha}>
                      <img
                        className="captcha-img"
                        src={captcha.captcha_image}
                        key={captcha.captcha_id}
                        alt="验证码"
                      />
                    </span>
                  ) : (
                    <span className="captcha-loading" onClick={loadCaptcha}>
                      点击加载验证码
                    </span>
                  )
                }
              />
            </Form.Item>
            <Form.Item style={{ marginBottom: 12 }}>
              <Button type="primary" htmlType="submit" block loading={loading}>
                登录
              </Button>
            </Form.Item>
            <div className="auth-actions">
              <Link to="/reset-password">忘记密码？</Link>
              <Link to="/register">还没有账号？立即注册</Link>
            </div>
          </Form>
        </div>
      </main>
    </div>
  );
}
