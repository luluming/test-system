import axios from "axios";
import { clearToken, getToken } from "../store/auth";

// 创建 axios 实例：所有请求以 /api 为前缀。开发环境由 Vite 自定义代理转发到后端
const client = axios.create({
  baseURL: "/api",
  timeout: 10000,
});

// 请求拦截器：自动携带 Authorization: Bearer <token>
client.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器：统一处理 401 未授权
client.interceptors.response.use(
  (response) => response,
  (error) => {
    // 401：token 缺失或失效，清除 token 并跳转登录页
    if (error.response && error.response.status === 401) {
      clearToken();
      // 避免在登录页重复跳转
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

export default client;
