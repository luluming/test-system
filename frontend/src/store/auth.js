// 认证状态工具：对 localStorage 中的 token 进行封装

const TOKEN_KEY = "token";

// 获取当前登录 token，不存在时返回 null
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

// 保存登录 token
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

// 清除登录 token（登出）
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}
