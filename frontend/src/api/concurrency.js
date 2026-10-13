import client from "./client";

// 提交写回：携带 base_version 做乐观锁；409 由调用方弹对比/丢弃引导
export function updateConfig(configId, data) {
  return client.put(`/nginx-configs/${configId}`, data);
}

// 编辑会话租约：续期（首次即取得） / 释放
export function heartbeat(configId, holder) {
  return client.post(`/nginx-configs/${configId}/edit-heartbeat`, { holder });
}
export function releaseConfig(configId, holder) {
  return client.post(`/nginx-configs/${configId}/edit-release`, { holder });
}

// 判断某次写回失败是否为 409 版本冲突
export function isVersionConflict(error) {
  return error?.response && error.response.status === 409;
}