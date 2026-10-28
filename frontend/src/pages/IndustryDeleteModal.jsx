import { useState } from "react";
import { deleteIndustry } from "../api/industry";

const LABEL = { nginx: "Nginx", yml: "YML" };

/**
 * 行业删除弹窗：让用户选择「只清空当前模块数据」还是「删除整个行业」。
 * scope=both 的行业两个选项都提供；只归属单一模块的行业只能整条删除。
 */
export default function IndustryDeleteModal({ industry, mode, open, onClose, onDone }) {
  const [loading, setLoading] = useState("");
  const [err, setErr] = useState("");

  if (!open || !industry) return null;

  const otherMode = mode === "nginx" ? "yml" : "nginx";
  const isBoth = industry.scope === "both";
  const curLabel = LABEL[mode];
  const otherLabel = LABEL[otherMode];

  const run = async (deleteScope) => {
    setLoading(deleteScope);
    setErr("");
    try {
      await deleteIndustry(industry.id, deleteScope);
      onDone(
        deleteScope === "all"
          ? `已删除行业「${industry.name}」及其全部配置`
          : `已清空「${industry.name}」的 ${curLabel} 配置，行业保留在 ${otherLabel} 菜单`,
      );
    } catch (e) {
      const d = e?.response?.data?.detail;
      setErr(typeof d === "string" ? d : "操作失败，请稍后再试");
    } finally {
      setLoading("");
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
          <>
            <p className="meta">
              归属菜单：
              {isBoth ? "Nginx + YML 两个菜单" : `${LABEL[industry.scope]} 菜单`}。 请选择删除范围，
              操作不可恢复。
            </p>
            {isBoth && (
              <p className="meta">
                「仅删除 {curLabel} 数据」只会清空该行业的 {curLabel} 配置，行业本身仍保留在{" "}
                {otherLabel} 菜单；「删除整个行业」会同时清空两侧数据并移除行业记录。
              </p>
            )}
          </>
        )}
        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={!!loading}>
            取消
          </button>
          {!industry.is_template && isBoth && (
            <button
              className="btn danger"
              disabled={!!loading}
              onClick={() => run(mode)}
            >
              {loading === mode ? "清理中…" : `仅删除 ${curLabel} 数据`}
            </button>
          )}
          {!industry.is_template && (
            <button
              className="btn danger"
              disabled={!!loading}
              onClick={() => run("all")}
            >
              {loading === "all" ? "删除中…" : "删除整个行业"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
