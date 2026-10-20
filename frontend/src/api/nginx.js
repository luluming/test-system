import client from "./client";

// ---- nginx 配置 ----
export function listNginxConfigs() {
  return client.get("/nginx-configs");
}
export function createNginxConfig(data) {
  return client.post("/nginx-configs", data);
}
export function updateNginxConfig(id, data) {
  return client.put(`/nginx-configs/${id}`, data);
}
export function deleteNginxConfig(id) {
  return client.delete(`/nginx-configs/${id}`);
}

// ---- 域名映射 ----
export function listDomainMappings(industryId) {
  return client.get("/domain-mappings", { params: { industry_id: industryId } });
}
export function createDomainMapping(data) {
  return client.post("/domain-mappings", data);
}
export function updateDomainMapping(id, data) {
  return client.put(`/domain-mappings/${id}`, data);
}
export function deleteDomainMapping(id) {
  return client.delete(`/domain-mappings/${id}`);
}

// ---- 转发端口 ----
export function listForwardPorts(industryId) {
  return client.get("/forward-ports", { params: { industry_id: industryId } });
}
export function createForwardPort(data) {
  return client.post("/forward-ports", data);
}
export function updateForwardPort(id, data) {
  return client.put(`/forward-ports/${id}`, data);
}
export function deleteForwardPort(id) {
  return client.delete(`/forward-ports/${id}`);
}

// ---- 业务端口（含公网开放开关）----
export function listBizPorts(industryId) {
  return client.get("/biz-ports", { params: { industry_id: industryId } });
}

// ---- 行业作用域 ----（追加，其余原方法保留）
export function listConfigsByIndustry(industryId) {
  return client.get("/nginx-configs", { params: { industry_id: industryId } });
}
export function createBizPort(data) {
  return client.post("/biz-ports", data);
}
export function updateBizPort(id, data) {
  return client.put(`/biz-ports/${id}`, data);
}
export function deleteBizPort(id) {
  return client.delete(`/biz-ports/${id}`);
}