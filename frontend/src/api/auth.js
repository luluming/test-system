import client from "./client";

// 用户登录：data 为 { username, password, captcha_id, captcha_code }，请求 /api/auth/login
export function login(data) {
  return client.post("/auth/login", data);
}

// 用户注册：data 为 { username, password }，请求 /api/auth/register
export function register(data) {
  return client.post("/auth/register", data);
}

// 获取图形验证码：返回 { captcha_id, captcha_image }，请求 /api/auth/captcha
export function fetchCaptcha() {
  return client.get("/auth/captcha");
}

// 重置密码（无需登录）：data 为 { username, email, captcha_id, captcha_code, new_password }，请求 /api/auth/reset-password
export function resetPassword(data) {
  return client.post("/auth/reset-password", data);
}

// 修改密码（需登录）：data 为 { old_password, new_password }，请求 /api/auth/change-password
// 本期仅封装方法，暂不接入 UI
export function changePassword(data) {
  return client.post("/auth/change-password", data);
}
