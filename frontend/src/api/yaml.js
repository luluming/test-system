import client from "./client";

// ---- YAML 配置管理（后端真实 API）----

export function listYamlConfigs(industryId, projectId, extraParams = {}) {
  const params = { ...extraParams };
  if (industryId) params.industry_id = industryId;
  if (projectId) params.project_id = projectId;
  return client.get("/yaml-configs", { params });
}
export function createYamlConfig(data) {
  return client.post("/yaml-configs", data);
}
export function getYamlConfig(id) {
  return client.get(`/yaml-configs/${id}`);
}
export function saveYamlConfig(id, data) {
  return client.put(`/yaml-configs/${id}`, data);
}
export function deleteYamlConfig(id) {
  return client.delete(`/yaml-configs/${id}`);
}
export function listYamlVersions(id) {
  return client.get(`/yaml-configs/${id}/versions`);
}
export function rollbackYamlConfig(id, data) {
  return client.post(`/yaml-configs/${id}/rollback`, data);
}
export function getYamlTree(id) {
  return client.get(`/yaml-configs/${id}/tree`);
}
// ---- 推送（两阶段 preview/apply + 一次性 token）----
export function previewPush(configId, file) {
  const fd = new FormData();
  fd.append("file", file);
  return client.post(`/yaml-configs/${configId}/push/preview`, fd);
}
export function applyPush(configId, taskId) {
  return client.post(`/yaml-configs/${configId}/push/${taskId}/apply`, {});
}
export function createYamlPushToken(configId, purpose) {
  return client.post(`/yaml-configs/${configId}/push-tokens`, null, {
    params: { purpose },
  });
}
export function listYamlPushTasks(configId) {
  return client.get(`/yaml-configs/${configId}/push-tasks`);
}
// ---- 整目录推送：签发短期令牌（供 curl 一次性同步 Nacos 落盘目录）----
export function createPushDirectoryToken(projectId, hours = 24) {
  return client.post("/yaml-configs/push-directory-token", null, {
    params: { project_id: projectId, hours },
  });
}
// ---- 推送差异：命名空间/分组/组件三级统计 + 批量处理 ----
export function listPushDiffs(params = {}) {
  return client.get("/yaml-configs/push-diffs", { params });
}
export function resolvePushDiffs(data) {
  return client.post("/yaml-configs/push-diffs/resolve", data);
}

// ---- 全局元信息：后端公网基址（供 curl 命令使用）----
export function getMetaBase() {
  return client.get("/meta");
}

// ---- 批量统计（Dashboard 用）----
export function getYamlStatsByIndustry(industryIds) {
  const params = {};
  if (industryIds && industryIds.length) params.industry_ids = industryIds.join(",");
  return client.get("/yaml-configs/stats-by-industry", { params });
}

// ---- Nacos 风格配置管理（命名空间/分组/dataId）----
export function nacosViewList(params) {
  return client.get("/yaml-configs/nacos-view", { params });
}
export function importNacosZip(formData, params) {
  return client.post("/yaml-configs/import-zip", formData, { params, timeout: 120000 });
}
export async function exportNacosZip(projectId, name = "") {
  const res = await client.get("/yaml-configs/export-zip", {
    params: { project_id: projectId },
    responseType: "blob",
  });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nacos-${name || projectId}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
