import { useMemo, useState } from "react";
import { cloneIndustry } from "../api/industry";

export default function IndustryCloneModal({ templates, open, onClose, onCreated }) {
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const canSubmit = useMemo(
    () => templates.some((t) => t.id === Number(sourceId)) && name.trim().length > 0,
    [templates, sourceId, name]
  );

  if (!open) return null;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建行业（模板克隆）</h3>
        <p className="meta">从模板源深拷贝整套配置，克隆后与源完全独立。</p>
        <label>模板源行业</label>
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">选择模板源…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}（{t.code}）</option>
          ))}
        </select>
        <label>新行业名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：国内" />
        <label>负责人（可选）</label>
        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="如：李工" />
        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!canSubmit || loading}
            onClick={async () => {
              setLoading(true); setErr("");
              try {
                const created = await cloneIndustry({
                  source_industry_id: Number(sourceId),
                  name: name.trim(),
                  owner: owner.trim() || null,
                });
                onCreated(created.data);
              } catch (e) {
                setErr(e.response?.data?.detail || "克隆失败，请重试");
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? "克隆中…" : "创建并克隆"}
          </button>
        </div>
      </div>
    </div>
  );
}