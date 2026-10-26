import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Form, Input, message } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { register } from "../api/auth";
import "./auth.css";

// 注册页：与登录页共用分栏布局与 IDE 设计语言
export default function Register() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  // 提交注册表单
  const onFinish = async (values) => {
    setLoading(true);
    try {
      // 调用注册接口，成功后跳转登录页
      await register({
        username: values.username,
        password: values.password,
      });
      message.success("注册成功，请登录");
      navigate("/login");
    } catch (err) {
      // 优先展示后端返回的错误信息
      const msg = err.response?.data?.detail || "注册失败，请重试";
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      {/* 左侧深色品牌区：产品名 + 标语（窄屏时隐藏） */}
      <aside className="auth-brand">
        <div className="auth-brand-inner">
          <span className="auth-logo-dot" />
          <h1>Nginx 配置管理系统</h1>
          <p>行业隔离 · 块级配置 · 拓扑预览，一站式 nginx / stream 运维工作台</p>
        </div>
      </aside>

      {/* 右侧表单区：注册表单卡片 */}
      <main className="auth-panel">
        <div className="auth-card">
          <h2 className="auth-title">创建账号</h2>
          <p className="auth-subtitle">注册后即可开始维护各行业 nginx 配置</p>
          <Form name="register" onFinish={onFinish} size="large">
            <Form.Item
              name="username"
              rules={[{ required: true, message: "请输入用户名" }]}
            >
              <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
            </Form.Item>
            <Form.Item
              name="password"
              rules={[{ required: true, message: "请输入密码" }]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="new-password" />
            </Form.Item>
            <Form.Item
              name="confirm"
              dependencies={["password"]}
              rules={[
                { required: true, message: "请再次输入密码" },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    // 校验两次输入的密码是否一致
                    if (!value || getFieldValue("password") === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error("两次输入的密码不一致"));
                  },
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="确认密码" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 12 }}>
              <Button type="primary" htmlType="submit" block loading={loading}>
                注册
              </Button>
            </Form.Item>
            <div className="auth-actions" style={{ justifyContent: "center" }}>
              已有账号？<Link to="/login">返回登录</Link>
            </div>
          </Form>
        </div>
      </main>
    </div>
  );
}
