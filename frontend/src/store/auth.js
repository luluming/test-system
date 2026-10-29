// 认证状态工具：对 localStorage 中的 token 进行封装

const TOKEN_KEY = "token";
const LAST_ACTIVE_KEY = "token_last_active";

/** 空闲过期时长：30 分钟无操作即视为过期 */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// 解码 JWT payload（不校验签名，仅读 exp）
function decodePayload(token) {
  try {
    const part = token.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** 会话是否仍然有效：JWT 未到期 且 空闲未超 IDLE_TIMEOUT_MS */
export function isSessionValid() {
  const token = getToken();
  if (!token) return false;
  const payload = decodePayload(token);
  if (payload?.exp && Date.now() >= payload.exp * 1000) return false;
  const last = parseInt(localStorage.getItem(LAST_ACTIVE_KEY) || "0", 10);
  if (last && Date.now() - last > IDLE_TIMEOUT_MS) return false;
  return true;
}

/** 记录一次用户操作时间戳（续期空闲计时） */
export function touchActivity() {
  localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
}

// 获取当前登录 token，不存在时返回 null
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

// 保存登录 token（同时重置空闲计时）
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  touchActivity();
}

// 清除登录 token（登出）
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LAST_ACTIVE_KEY);
}
