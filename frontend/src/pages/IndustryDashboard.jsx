import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal, message } from "antd";
import { deleteIndustry, listIndustries } from "../api/industry";
import { getProjectStatsByIndustry, listProjects } from "../api/projects";
import { getUser } from "../store/auth";
import IndustryCloneModal from "./IndustryCloneModal";
import "./dashboard.css";

// 行业管理：行业 → 项目的入口。行业只承载项目，配置归属到项目
export default function IndustryDashboard() {
  const navigate = useNavigate();
  const isAdmin = getUser()?.role === "admin";

  const [industries, setIndustries] = useState([]);
  // 各行业项目数：{industry_id: count}
  const [projStats, setProjStats] = useState({});
  const [mineCount, setMineCount] = useState(0);
  const [sharedCount, setSharedCount] = useState(0);
  const [openClone, setOpenClone] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await listIndustries();
      setIndustries(res.data);
      setError("");
    } catch { setError("行业列表加载失败"); }
    // 各行业项目数（批量）
    try {
      const stats = await getProjectStatsByIndustry();
      const map = {};
      for (const [k, v] of Object.entries(stats.data || {})) {
        map[Number(k)] = v.project_count || 0;
      }
      setProjStats(map);
    } catch { setProjStats({}); }
    // 我的项目 / 共享给我的 计数
    try {
      const [mine, shared] = await Promise.all([
        listProjects({ tab: "mine" }),
        listProjects({ tab: "shared" }),
      ]);
      setMineCount(mine.data.length);
      setSharedCount(shared.data.length);
    } catch { /* 计数失败不阻塞 */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const templates = useMemo(() => industries.filter((i) => i.is_template), [industries]);
  const clonedNames = useMemo(() => {
    const byId = new Map(industries.map((i) => [i.id, i.name]));
    return new Map(
      industries.filter((i) => i.cloned_from_id != null)
        .map((i) => [i.id, "克隆自 · " + (byId.get(i.cloned_from_id) ?? i.cloned_from_id)])
    );
  }, [industries]);
  const totalProjects = useMemo(
    () => Object.values(projStats).reduce((a, b) => a + b, 0),
    [projStats]
  );

  // 删除行业（仅 admin）：有项目时后端 409；scope=both 需依次清两侧数据后移除行业
  const removeIndustry = (ind) => {
    Modal.confirm({
      title: `删除行业「${ind.name}」？`,
      content: "将删除该行业及其下全部配置数据，删除后不可恢复。行业下存在项目时不可删除。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          if (ind.scope === "both") {
            await deleteIndustry(ind.id, "nginx");
            await deleteIndustry(ind.id, "yml");
          } else {
            await deleteIndustry(ind.id, ind.scope === "yml" ? "yml" : "nginx");
          }
          message.success("行业已删除");
          load();
        } catch (err) {
          const detail = err.response?.data?.detail;
          if (detail) message.error(detail);
        }
      },
    });
  };

  return (
    <div>
      {/* 页头（统一外壳视觉）：新建行业仅管理员 */}
      <div className="page-head">
        <div>
          <h1>行业管理</h1>
          <p className="sub">行业下按项目隔离配置，每个项目独立维护 nginx / YML 配置与环境变量。</p>
        </div>
        {isAdmin && (
          <button className="btn primary" onClick={() => setOpenClone(true)}>＋ 新建行业（模板克隆）</button>
        )}
      </div>

      {/* 统计卡（统一 .cards） */}
      <div className="cards">
        <div className="card blue"><b>{industries.length}</b><small>行业总数</small></div>
        <div className="card green"><b>{totalProjects}</b><small>项目总数</small></div>
        <div className="card yellow"><b>{mineCount}</b><small>我的项目</small></div>
        <div className="card"><b>{sharedCount}</b><small>共享给我</small></div>
      </div>

      {error && (
        <p className="err" style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 10 }}>
          <span>{error}</span>
          <button className="btn mini" onClick={load}>重试</button>
        </p>
      )}
      {industries.length === 0 && !error ? (
        <div className="empty">
          {isAdmin ? "暂无行业，点击「新建行业（模板克隆）」创建。" : "暂无行业，请联系管理员创建。"}
        </div>
      ) : (
        <table className="ov-tbl tbl-anim clickable">
          <thead>
            <tr>
              <th>行业</th>
              <th>项目数</th>
              <th>归属·更新</th>
              <th className="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            {industries.map((ind) => (
              <tr key={ind.id} onClick={() => navigate(`/industries/${ind.id}/projects`)}>
                <td>
                  <div className="name-cell">
                    <span className="ico">{ind.name.slice(0, 1)}</span>
                    <div>
                      <div>{ind.name}
                        {ind.is_template && <span className="tag tpl" style={{ marginLeft: 8 }}>模板源</span>}
                        {clonedNames.has(ind.id) && <span className="tag cloned" style={{ marginLeft: 8 }}>{clonedNames.get(ind.id)}</span>}
                      </div>
                      <div className="meta">{ind.code}{ind.owner ? ` · ${ind.owner}` : ""}</div>
                    </div>
                  </div>
                </td>
                <td className="meta">{projStats[ind.id] ?? 0}</td>
                <td className="meta">{ind.updated_at ? ind.updated_at.split("T")[0] : ""}</td>
                <td className="col-ops">
                  <button className="row-enter" onClick={(e) => { e.stopPropagation(); navigate(`/industries/${ind.id}/projects`); }}>项目列表</button>
                  {isAdmin && (
                    <button
                      className="row-delete"
                      onClick={(e) => { e.stopPropagation(); removeIndustry(ind); }}
                      title={ind.is_template ? "模板源行业禁止删除" : "删除行业"}
                    >删除</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="meta" style={{ padding: "14px 0 24px" }}>
        提示：点击行业进入项目列表；行业下存在项目时不可删除。
      </p>

      <IndustryCloneModal
        templates={templates}
        open={openClone}
        cloneScope="both"
        onClose={() => setOpenClone(false)}
        onCreated={() => { setOpenClone(false); load(); }}
      />
    </div>
  );
}
