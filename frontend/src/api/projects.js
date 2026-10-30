import client from "./client";

// ---- 项目管理 ----

// 项目列表：{ industry_id?, tab? }，tab ∈ mine|shared|all（all 仅 admin）
export function listProjects(params = {}) {
  return client.get("/projects", { params });
}

// 新建项目：data 为 { industry_id, name, code, remark? }，任何登录用户可建
export function createProject(data) {
  return client.post("/projects", data);
}

// 项目详情：无权限时后端返回 403
export function getProject(id) {
  return client.get(`/projects/${id}`);
}

// 更新项目：data 为 { name?, remark? }（owner/admin）
export function updateProject(id, data) {
  return client.put(`/projects/${id}`, data);
}

// 删除项目：非空项目后端返回 409（owner/admin）
export function deleteProject(id) {
  return client.delete(`/projects/${id}`);
}

// 按行业统计项目数：返回 { "<industry_id>": { project_count } }
export function getProjectStatsByIndustry() {
  return client.get("/projects/stats-by-industry");
}

// ---- 项目共享（owner/admin）----

// 读取共享设置：{ share_all, grants: [{user_id,username,email,perm}] }
export function getShare(projectId) {
  return client.get(`/projects/${projectId}/share`);
}

// 全量替换共享设置：data 为 { share_all, grants: [{user_id, perm: "view"|"edit"}] }
export function putShare(projectId, data) {
  return client.put(`/projects/${projectId}/share`, data);
}

// ---- 项目环境变量 ----

// 变量列表：[{id,project_id,key,value,remark,updated_by,created_at,updated_at}]
export function listEnvVars(projectId) {
  return client.get(`/projects/${projectId}/env-vars`);
}

// 新增变量：data 为 { key, value, remark? }，键冲突 409
export function createEnvVar(projectId, data) {
  return client.post(`/projects/${projectId}/env-vars`, data);
}

// 更新变量：data 为 { value?, remark? }
export function updateEnvVar(projectId, varId, data) {
  return client.put(`/projects/${projectId}/env-vars/${varId}`, data);
}

export function deleteEnvVar(projectId, varId) {
  return client.delete(`/projects/${projectId}/env-vars/${varId}`);
}
