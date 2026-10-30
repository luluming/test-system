import axios from "axios";
import { message } from "antd";
import { clearToken, getToken, isSessionValid, touchActivity } from "../store/auth";

// 创建 axios 实例：所有请求以 /api 为前缀。开发环境由 Vite 自定义代理转发到后端
const client = axios.create({
  baseURL: "/api",
  timeout: 10000,
});

function redirectToLogin(reason = "expired") {
  clearToken();
  // 避免在登录页重复跳转
  if (window.location.pathname !== "/login") {
    window.location.href = `/login?reason=${reason}`;
  }
}

// 请求拦截器：自动携带 Authorization: Bearer <token>
// 发起请求前先检查本地会话（JWT exp + 空闲超时）；过期则不发请求、直接回登录页
client.interceptors.request.use((config) => {
  const token = getToken();
  if (!token) return config;
  if (!isSessionValid()) {
    redirectToLogin();
    return Promise.reject(new axios.Cancel("会话已过期，请重新登录"));
  }
  touchActivity();
  config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// 响应拦截器：统一处理 401 未授权 / 403 无权限
client.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const detail = error.response?.data?.detail;
    if (status === 401) {
      // 账号被停用与会话过期区分提示
      const reason = typeof detail === "string" && detail.includes("停用") ? "disabled" : "expired";
      redirectToLogin(reason);
    } else if (status === 403 && typeof detail === "string" && detail) {
      // 无权限：全局轻提示，页面自行决定后续跳转
      message.error(detail);
    }
    return Promise.reject(error);
  }
);

export default client;
