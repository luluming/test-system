import client from "./client";

// ---- 配置块树 ----
export function listBlocks(nginxConfigId) {
  return client.get("/config-blocks", { params: { nginx_config_id: nginxConfigId } });
}
export function createBlock(data) {
  return client.post("/config-blocks", data);
}
export function updateBlock(id, data) {
  return client.put(`/config-blocks/${id}`, data);
}
export function deleteBlock(id) {
  return client.delete(`/config-blocks/${id}`);
}
export function mirrorBlock(srcId, dstId) {
  return client.post(`/config-blocks/${srcId}/mirror/${dstId}`);
}
// ---- 镜像对配置（配置文件级持久化） ----
export function listMirrorPairs(configId) {
  return client.get(`/nginx-configs/${configId}/mirror-pairs`);
}
export function createMirrorPair(configId, data) {
  return client.post(`/nginx-configs/${configId}/mirror-pairs`, data);
}
export function deleteMirrorPair(configId, pairId) {
  return client.delete(`/nginx-configs/${configId}/mirror-pairs/${pairId}`);
}
// ---- 配置版本快照（保存 = 存一版渲染文本，用于历史对比） ----
export function listVersions(configId) {
  return client.get(`/nginx-configs/${configId}/versions`);
}
export function createVersion(configId, data) {
  return client.post(`/nginx-configs/${configId}/versions`, data);
}
export function blockChildren(blockId) {
  return client.get(`/config-blocks/${blockId}/children`);
}

// ---- 配置选项（KV 行）----
export function listOptions(blockId) {
  return client.get("/config-options", { params: { block_id: blockId } });
}
export function createOption(data) {
  return client.post("/config-options", data);
}
export function updateOption(id, data) {
  return client.put(`/config-options/${id}`, data);
}
export function deleteOption(id) {
  return client.delete(`/config-options/${id}`);
}
export function reorderOptions(blockId, ids) {
  return client.put("/config-options/reorder", { block_id: blockId, ids });
}
export function reorderBlocks(parentId, ids) {
  return client.put("/config-blocks/reorder", { parent_id: parentId, ids });
}

// ---- 配置树 / 渲染 / 导出 / 动作 ----
export function getConfigTree(configId) {
  return client.get(`/nginx-configs/${configId}/tree`);
}
export function renderConfig(configId, context = "conf") {
  return client.get(`/nginx-configs/${configId}/render`, { params: { context } });
}
export function exportConfig(configId, payload) {
  return client.post(`/nginx-configs/${configId}/export`, payload);
}
export function validateNginxConfig(configId, content) {
  return client.post(`/nginx-configs/${configId}/validate`, { content });
}
export function reloadNginx(configId) {
  return client.post(`/nginx-configs/${configId}/reload`);
}
export function testNginxConfig(configId) {
  return client.post(`/nginx-configs/${configId}/test`);
}
export function testForwardPort(forwardId) {
  return client.post(`/forward-ports/${forwardId}/test`);
}

// ---- 编辑租约心跳 / 释放 ----
export function editHeartbeat(configId, holder) {
  return client.post(`/nginx-configs/${configId}/edit-heartbeat`, { holder });
}
export function editRelease(configId, holder) {
  return client.post(`/nginx-configs/${configId}/edit-release`, { holder });
}

// ---- Upstream 池 ----
export function listUpstreams(industryId) {
  return client.get("/upstreams", { params: { industry_id: industryId } });
}
export function createUpstream(data) {
  return client.post("/upstreams", data);
}
export function updateUpstream(id, data) {
  return client.put(`/upstreams/${id}`, data);
}
export function deleteUpstream(id) {
  return client.delete(`/upstreams/${id}`);
}
export function listUpstreamServers(upstreamId) {
  return client.get(`/upstreams/${upstreamId}/servers`);
}
export function createUpstreamServer(upstreamId, data) {
  return client.post(`/upstreams/${upstreamId}/servers`, data);
}
export function updateUpstreamServer(upstreamId, serverId, data) {
  return client.put(`/upstreams/${upstreamId}/servers/${serverId}`, data);
}
export function deleteUpstreamServer(upstreamId, serverId) {
  return client.delete(`/upstreams/${upstreamId}/servers/${serverId}`);
}
export function upstreamPreview(upstreamId) {
  return client.get(`/upstreams/${upstreamId}/preview`);
}
export function validateUpstream(upstreamId) {
  return client.post(`/upstreams/${upstreamId}/validate`);
}

// ---- 拓扑 / 指令字典 ----
export function getTopology(configId) {
  return client.get("/topology", { params: { config_id: configId } });
}
export function listDirectives() {
  return client.get("/directives");
}

// ---- 本地配置推送（两阶段：预览 → 确认提交）----
export function previewPush(configId, file) {
  const fd = new FormData();
  fd.append("file", file);
  return client.post(`/nginx-configs/${configId}/push/preview`, fd);
}
export function applyPush(configId, taskId) {
  return client.post(`/nginx-configs/${configId}/push/${taskId}/apply`, {});
}
export function listPushTasks(configId) {
  return client.get(`/nginx-configs/${configId}/push-tasks`);
}
export function getPushTask(configId, taskId) {
  return client.get(`/nginx-configs/${configId}/push-tasks/${taskId}`);
}
// ---- 推送一次性 token（签发后单次使用，10 分钟过期）----
export function createPushToken(configId, purpose) {
  return client.post(`/nginx-configs/${configId}/push-tokens`, null, {
    params: { purpose },
  });
}
// ---- 全局元信息：后端公网基址（供 curl 命令使用）----
export function getMetaBase() {
  return client.get("/meta");
}
