import client from "./client";

// ---- 账号管理（仅系统管理员）----

// 账号列表：返回 [{id,username,email,role,is_active,project_count,created_at}]
export function listAccounts() {
  return client.get("/accounts");
}

// 新建账号：data 为 { username, email, password }
export function createAccount(data) {
  return client.post("/accounts", data);
}

// 启用/停用账号：停用后该账号所有登录态立即失效
export function setAccountStatus(id, isActive) {
  return client.put(`/accounts/${id}/status`, { is_active: isActive });
}

// 重置账号密码：返回 { password } 供管理员复制给使用者
export function resetAccountPassword(id, newPassword) {
  return client.put(`/accounts/${id}/password`, { new_password: newPassword });
}

// 删除账号：名下有项目时后端返回 409
export function deleteAccount(id) {
  return client.delete(`/accounts/${id}`);
}

// 账号搜索（共享授权选人用）：返回 [{id,username,email,is_active}] 最多 10 条
export function searchAccounts(q) {
  return client.get("/accounts/search", { params: { q } });
}
