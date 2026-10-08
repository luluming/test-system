import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Card, Form, Input, message } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { register } from "../api/auth";

// 注册页：居中卡片式布局
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
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f0f2f5",
      }}
    >
      <Card title="test-system 注册" style={{ width: 360 }}>
        <Form name="register" onFinish={onFinish} size="large">
          <Form.Item
            name="username"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input prefix={<UserOutlined />} placeholder="用户名" />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: "请输入密码" }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
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
          <Form.Item style={{ marginBottom: 8 }}>
            <Button type="primary" htmlType="submit" block loading={loading}>
              注册
            </Button>
          </Form.Item>
          <div style={{ textAlign: "center" }}>
            已有账号？<Link to="/login">返回登录</Link>
          </div>
        </Form>
      </Card>
    </div>
  );
}
