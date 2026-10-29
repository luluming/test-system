import { useState } from "react";
import { deleteIndustry } from "../api/industry";

const LABEL = { nginx: "Nginx", yml: "YML" };

/**
 * 行业删除弹窗：删除只作用于当前菜单所在的模块，绝不跨菜单删除。
 * - 只归属当前模块的行业：清除数据并移除行业记录
 * - 同时归属两个菜单（模板源）：只清空当前模块数据，行业保留在另一菜单
 */
export default function IndustryDeleteModal({ industry, mode, open, onClose, onDone }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  if (!open || !industry) return null;

  const otherMode = mode === "nginx" ? "yml" : "nginx";
  const shared = industry.scope === "both";
  const curLabel = LABEL[mode];
  const otherLabel = LABEL[otherMode];

  const run = async () => {
    setLoading(true);
    setErr("");
    try {
      await deleteIndustry(industry.id, mode);
      onDone(
        shared
          ? `已清空「${industry.name}」的 ${curLabel} 数据，行业仍保留在 ${otherLabel} 菜单`
          : `已删除行业「${industry.name}」及其 ${curLabel} 配置`,
      );
    } catch (e) {
      const d = e?.response?.data?.detail;
      setErr(typeof d === "string" ? d : "操作失败，请稍后再试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>删除「{industry.name}」</h3>
        {industry.is_template ? (
          <p className="err">
            这是模板源行业，禁止删除。如需移除模板属性，请先编辑该行业取消模板标记。
          </p>
        ) : (
          <p className="meta">
            删除只作用于当前 <b>{curLabel} 行业管理</b>，不会影响另一个菜单。
            {shared
              ? `该行业同时作为模板源出现在 ${curLabel} 与 ${otherLabel} 菜单，本次只清空它的 ${curLabel} 配置，行业本身仍保留在 ${otherLabel} 菜单。`
              : `该行业仅归属 ${curLabel} 菜单，删除后其行业记录与 ${curLabel} 配置一并移除。`}
          </p>
        )}
        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={loading}>
            取消
          </button>
          {!industry.is_template && (
            <button className="btn danger" disabled={loading} onClick={run}>
              {loading ? "处理中…" : shared ? `清空 ${curLabel} 数据` : "删除该行业"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
