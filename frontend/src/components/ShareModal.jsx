import { useEffect, useState } from "react";
import { Modal, Select, Switch, message } from "antd";
import { getShare, putShare } from "../api/projects";
import { searchAccounts } from "../api/accounts";

// 项目共享设置弹窗（仅 owner/admin 可打开）
// 全员共享：固定为可查看；指定人：可查看 / 可编辑，不可添加负责人本人
export default function ShareModal({ project, open, onClose, onSaved }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shareAll, setShareAll] = useState(false);
  const [grants, setGrants] = useState([]); // [{user_id, username, email, perm}]
  const [pool, setPool] = useState([]); // 账号候选池：默认前 10 个，输入时改为搜索结果
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    setLoading(true);
    setPool([]);
    // 预加载候选账号，让下拉框一打开就有可选项（超过 4 个时下拉内部滚动）
    searchAccounts("")
      .then((res) => setPool(res.data || []))
      .catch(() => setPool([]));
    getShare(project.id)
      .then((res) => {
        setShareAll(!!res.data.share_all);
        setGrants(res.data.grants || []);
      })
      .catch(() => message.error("共享设置加载失败"))
      .finally(() => setLoading(false));
  }, [open, project]);

  // 输入关键字时向服务端检索；清空后恢复默认候选列表
  const onSearch = async (q) => {
    const kw = (q || "").trim();
    if (!kw) {
      try {
        const res = await searchAccounts("");
        setPool(res.data || []);
      } catch {
        setPool([]);
      }
      return;
    }
    setSearching(true);
    try {
      const res = await searchAccounts(kw);
      setPool(res.data || []);
    } catch {
      setPool([]);
    } finally {
      setSearching(false);
    }
  };

  // 选中账号加入授权列表，默认可查看
  const onPick = (userId) => {
    const u = pool.find((o) => o.id === userId);
    if (!u) return;
    setGrants((gs) => [...gs, { user_id: u.id, username: u.username, email: u.email, perm: "view" }]);
  };

  // 候选账号：排除负责人本人与已在授权列表中的账号
  const excluded = new Set([project?.owner_id, ...grants.map((g) => g.user_id)]);
  const candidates = pool.filter((u) => !excluded.has(u.id));

  const setPerm = (userId, perm) => {
    setGrants((gs) => gs.map((g) => (g.user_id === userId ? { ...g, perm } : g)));
  };

  const removeGrant = (userId) => {
    setGrants((gs) => gs.filter((g) => g.user_id !== userId));
  };

  // 保存：全量替换共享设置，变更即时生效
  const save = async () => {
    setSaving(true);
    try {
      await putShare(project.id, {
        share_all: shareAll,
        grants: grants.map((g) => ({ user_id: g.user_id, perm: g.perm })),
      });
      message.success("共享设置已保存，变更即时生效");
      onSaved?.();
      onClose();
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (detail && err.response?.status !== 403) message.error(detail);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={project ? `共享设置 · ${project.name}` : "共享设置"}
      open={open}
      onOk={save}
      onCancel={onClose}
      confirmLoading={saving}
      okText="保存"
      cancelText="取消"
      width={520}
      destroyOnClose
    >
      {loading ? (
        <p className="meta">加载中…</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 全员共享：固定只读 */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch checked={shareAll} onChange={setShareAll} />
            <span>全员共享</span>
            <span className="meta">开启后所有人可查看本项目（固定为可查看）</span>
          </div>

          {/* 指定人共享 */}
          <div>
            <div className="meta" style={{ marginBottom: 8 }}>指定人共享（可查看 / 可编辑）</div>
            <Select
              showSearch
              // 本地即时过滤已加载候选，同时保留服务端模糊搜索
              filterOption={(input, option) =>
                (option?.label ?? "").toLowerCase().includes(input.toLowerCase())
              }
              onSearch={onSearch}
              onSelect={onPick}
              loading={searching}
              value={null}
              listHeight={128}
              placeholder="输入用户名或邮箱匹配；默认显示 4 个，更多可滚动"
              style={{ width: "100%" }}
              notFoundContent={searching ? "搜索中…" : "无匹配账号"}
              options={candidates.map((u) => ({
                value: u.id,
                label: `${u.username}（${u.email || "无邮箱"}）${u.is_active ? "" : " · 已停用"}`,
                disabled: !u.is_active,
              }))}
            />
            {grants.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {grants.map((g) => (
                  <div key={g.user_id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {g.username}
                      <span className="meta" style={{ marginLeft: 8 }}>{g.email}</span>
                    </span>
                    <Select
                      size="small"
                      value={g.perm}
                      style={{ width: 96 }}
                      onChange={(v) => setPerm(g.user_id, v)}
                      options={[
                        { value: "view", label: "可查看" },
                        { value: "edit", label: "可编辑" },
                      ]}
                    />
                    <button className="btn mini" title="移除" onClick={() => removeGrant(g.user_id)}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="meta" style={{ margin: 0 }}>提示：保存后变更即时生效；被移除的用户将立即失去访问权限。</p>
        </div>
      )}
    </Modal>
  );
}
