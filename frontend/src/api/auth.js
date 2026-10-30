import client from "./client";

// 用户登录：data 为 { username, password, captcha_id, captcha_code }，请求 /api/auth/login
export function login(data) {
  return client.post("/auth/login", data);
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
// 成功返回 { message, access_token }，前端需用新 token 替换旧 token 保持会话
export function changePassword(data) {
  return client.post("/auth/change-password", data);
}

// 获取当前登录用户信息：请求 /api/auth/me
export function fetchMe() {
  return client.get("/auth/me");
}
