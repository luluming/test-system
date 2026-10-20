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
