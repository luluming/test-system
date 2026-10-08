import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Card, Form, Input, message } from "antd";
import {
  LockOutlined,
  MailOutlined,
  SafetyOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { fetchCaptcha, resetPassword } from "../api/auth";
import "./auth.css";

// 重置密码页：与登录页共用分栏布局与设计语言（无需登录）
export default function ResetPassword() {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [captcha, setCaptcha] = useState(null); // { captcha_id, captcha_image }
  const captchaLoadingRef = useRef(false); // 防止验证码重复请求

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

  // 提交重置密码表单
  const onFinish = async (values) => {
    // 验证码尚未加载成功时先补齐验证码再提交
    if (!captcha?.captcha_id) {
      message.warning("验证码尚未加载，请稍候");
      loadCaptcha();
      return;
    }
    setLoading(true);
    try {
      // 校验用户名 + 邮箱 + 验证码后重置密码，成功后返回登录页
      await resetPassword({
        username: values.username,
        email: values.email,
        captcha_id: captcha.captcha_id,
        captcha_code: values.captcha,
        new_password: values.password,
      });
      message.success("密码重置成功，请使用新密码登录");
      navigate("/login");
    } catch (err) {
      const detail = err.response?.data?.detail;
      // 验证码错误或过期：提示并自动刷新验证码、清空验证码输入
      if (typeof detail === "string" && detail.includes("验证码")) {
        message.error(detail);
        form.setFieldValue("captcha", "");
        loadCaptcha();
      } else {
        message.error(detail || "密码重置失败，请重试");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      {/* 左侧深色品牌区：产品名 + 标语（窄屏时隐藏） */}
      <aside className="auth-brand">
        <div className="auth-brand-inner">
          <h1>test-system</h1>
          <p>安全 · 简洁 · 高效，一站式内部协作平台</p>
        </div>
      </aside>

      {/* 右侧表单区：重置密码表单卡片 */}
      <main className="auth-panel">
        <Card
          className="auth-card"
          style={{
            width: 400,
            maxWidth: "100%",
            borderRadius: 10,
            borderColor: "#e2e7ee",
            boxShadow: "0 2px 16px rgba(30, 41, 51, 0.06)",
          }}
          styles={{ body: { padding: "32px 32px 28px" } }}
        >
          <h2 className="auth-title">重置密码</h2>
          <p className="auth-subtitle">验证身份后即可设置新密码</p>
          <Form
            form={form}
            name="reset-password"
            onFinish={onFinish}
            size="large"
          >
            <Form.Item
              name="username"
              rules={[{ required: true, message: "请输入用户名" }]}
            >
              <Input
                prefix={<UserOutlined />}
                placeholder="用户名"
                autoComplete="username"
              />
            </Form.Item>
            <Form.Item
              name="email"
              rules={[
                { required: true, message: "请输入邮箱" },
                { type: "email", message: "邮箱格式不正确" },
              ]}
            >
              <Input
                prefix={<MailOutlined />}
                placeholder="注册邮箱"
                autoComplete="email"
              />
            </Form.Item>
            <Form.Item
              name="captcha"
              rules={[{ required: true, message: "请输入验证码" }]}
            >
              <Input
                prefix={<SafetyOutlined />}
                placeholder="验证码"
                maxLength={6}
                suffix={
                  captcha ? (
                    <img
                      className="captcha-img"
                      src={captcha.captcha_image}
                      key={captcha.captcha_id}
                      alt="验证码"
                      title="点击刷新验证码"
                      onClick={loadCaptcha}
                    />
                  ) : (
                    <span className="captcha-loading" onClick={loadCaptcha}>
                      点击加载验证码
                    </span>
                  )
                }
              />
            </Form.Item>
            <Form.Item
              name="password"
              rules={[
                { required: true, message: "请输入新密码" },
                { min: 6, message: "密码长度不能少于 6 位" },
              ]}
            >
              <Input.Password
                prefix={<LockOutlined />}
                placeholder="新密码（至少 6 位）"
                autoComplete="new-password"
              />
            </Form.Item>
            <Form.Item style={{ marginBottom: 12 }}>
              <Button type="primary" htmlType="submit" block loading={loading}>
                重置密码
              </Button>
            </Form.Item>
            <div
              className="auth-actions"
              style={{ justifyContent: "center" }}
            >
              <Link to="/login">返回登录</Link>
            </div>
          </Form>
        </Card>
      </main>
    </div>
  );
}
