import client from "./client";

export function listIndustries() {
  return client.get("/industries");
}
export function createIndustry(data) {
  return client.post("/industries", data);
}
export function updateIndustry(id, data) {
  return client.put(`/industries/${id}`, data);
}
export function deleteIndustry(id) {
  return client.delete(`/industries/${id}`);
}
export function cloneIndustry(data) {
  return client.post("/industries/clone", data);
}
export function getIndustry(id) {
  return client.get(`/industries/${id}`);
}