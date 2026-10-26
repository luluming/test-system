import { useMemo, useState } from "react";
import { cloneIndustry } from "../api/industry";

export default function IndustryCloneModal({ templates, open, onClose, onCreated }) {
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [owner, setOwner] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const hasSource = templates.some((t) => t.id === Number(sourceId));
  const canSubmit = useMemo(() => name.trim().length > 0, [name]);
  const btnLabel = hasSource ? "创建并克隆" : "创建空行业";

  if (!open) return null;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建行业（模板克隆）</h3>
        <p className="meta">选择模板源可深拷贝整套配置，克隆后与源完全独立；不选则创建空行业。</p>
        <label>模板源行业（可选）</label>
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">不选，创建空行业…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}（{t.code}）</option>
          ))}
        </select>
        <label>新行业名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：国内" />
        {!hasSource && (
          <>
            <label>行业 code（可选，留空自动生成）</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="如：domestic（小写字母/数字/下划线）" />
          </>
        )}
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
                const payload = { name: name.trim(), owner: owner.trim() || null };
                if (hasSource) payload.source_industry_id = Number(sourceId);
                else if (code.trim()) payload.code = code.trim();
                const created = await cloneIndustry(payload);
                onCreated(created.data);
              } catch (e) {
                setErr(e.response?.data?.detail || "创建失败，请重试");
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? "创建中…" : btnLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
