import client from "./client";

export function listIndustries(scopeFilter) {
  const params = scopeFilter ? { scope_filter: scopeFilter } : undefined;
  return client.get("/industries", { params });
}
export function createIndustry(data) {
  return client.post("/industries", data);
}
export function updateIndustry(id, data) {
  return client.put(`/industries/${id}`, data);
}
export function deleteIndustry(id, deleteScope) {
  const params = deleteScope ? { delete_scope: deleteScope } : undefined;
  return client.delete(`/industries/${id}`, { params });
}
export function cloneIndustry(data) {
  return client.post("/industries/clone", data);
}
export function getIndustry(id) {
  return client.get(`/industries/${id}`);
}