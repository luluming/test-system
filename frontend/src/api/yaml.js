import client from "./client";

// ---- YAML 配置管理（后端真实 API）----

export function listYamlConfigs(industryId) {
  return client.get("/yaml-configs", { params: { industry_id: industryId } });
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
