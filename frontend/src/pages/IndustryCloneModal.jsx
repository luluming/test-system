import { useMemo, useState } from "react";
import { cloneIndustry } from "../api/industry";

export default function IndustryCloneModal({ templates, open, onClose, onCreated, cloneScope = "both" }) {
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [owner, setOwner] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const hasSource = templates.some((t) => t.id === Number(sourceId));
  const canSubmit = useMemo(() => name.trim().length > 0, [name]);
  const scopeLabel = cloneScope === "yml" ? "仅 YAML" : cloneScope === "nginx" ? "仅 Nginx" : "Nginx + YAML";
  const btnLabel = hasSource ? `创建并克隆（${scopeLabel}）` : "创建空行业";

  // code 本地校验：字母/数字/下划线/连字符（输入时已转小写并去空格）
  const codeErr = !hasSource && code.trim() !== "" && !/^[a-z0-9_-]+$/.test(code.trim());

  const errText = (e) => {
    const d = e?.response?.data?.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((x) => x.msg).join("；");
    return "创建失败，请重试";
  };

  if (!open) return null;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建行业（模板克隆 · {scopeLabel}）</h3>
        <p className="meta">
          {cloneScope !== "both"
            ? `当前处于 ${cloneScope === "yml" ? "YML" : "Nginx"} 行业管理模式，克隆将只拷贝 ${scopeLabel} 配置。`
            : "克隆将同时拷贝 Nginx 和 YAML 两套配置。"}
          不选模板源则创建空行业。
        </p>
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
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toLowerCase().replace(/\s+/g, ""))}
              placeholder="如：domestic-web（字母/数字/下划线/连字符）"
            />
            {codeErr && <p className="err">code 仅允许字母、数字、下划线与连字符</p>}
          </>
        )}
        <label>负责人（可选）</label>
        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="如：李工" />
        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!canSubmit || loading || codeErr}
            onClick={async () => {
              setLoading(true); setErr("");
              try {
                const payload = { name: name.trim(), owner: owner.trim() || null, clone_scope: cloneScope };
                if (hasSource) payload.source_industry_id = Number(sourceId);
                else if (code.trim()) payload.code = code.trim();
                const created = await cloneIndustry(payload);
                onCreated(created.data);
              } catch (e) {
                setErr(errText(e));
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
