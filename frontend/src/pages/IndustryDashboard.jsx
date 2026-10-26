import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listIndustries } from "../api/industry";
import { listConfigsByIndustry } from "../api/nginx";
import { getConfigTree } from "../api/nginxInner";
import IndustryCloneModal from "./IndustryCloneModal";
import "./dashboard.css";

export default function IndustryDashboard() {
  const navigate = useNavigate();
  const [industries, setIndustries] = useState([]);
  const [configCounts, setConfigCounts] = useState({});
  const [listenTotal, setListenTotal] = useState(0);
  const [openClone, setOpenClone] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await listIndustries();
      setIndustries(res.data);
      setError("");
    } catch { setError("行业列表加载失败"); }
  }, []);

  const loadCounts = useCallback(async (list) => {
    const map = {};
    let total = 0;
    for (const ind of list) {
      let srv = 0;
      try {
        const data = (await listConfigsByIndustry(ind.id)).data;
        for (const cfg of data) {
          try {
            const tree = (await getConfigTree(cfg.id)).data;
            srv += (tree.blocks || []).filter((b) => b.scope === "server").length;
          } catch { /* 单配置树加载失败不计入 */ }
        }
        map[ind.id] = { total: data.length, stream: data.filter((x) => String(x.name || "").includes(".stream")).length, servers: srv };
      } catch { map[ind.id] = { total: 0, stream: 0, servers: 0 }; }
      total += srv;
    }
    setConfigCounts(map);
    setListenTotal(total);
  }, []);

  useEffect(() => { load().then(() => undefined); }, [load]);
  useEffect(() => { if (industries.length) loadCounts(industries); /* eslint-disable-line */ }, [loadCounts, industries]);

  const templates = useMemo(() => industries.filter((i) => i.is_template), [industries]);
  const clonedNames = useMemo(() => {
    const byId = new Map(industries.map((i) => [i.id, i.name]));
    return new Map(
      industries.filter((i) => i.cloned_from_id != null)
        .map((i) => [i.id, "克隆自 · " + (byId.get(i.cloned_from_id) ?? i.cloned_from_id)])
    );
  }, [industries]);
  const streamCount = Object.values(configCounts).reduce((a, b) => a + (b.stream || 0), 0);

  return (
    <div>
      {/* 页头（统一外壳视觉） */}
      <div className="page-head">
        <div>
          <h1>行业管理</h1>
          <p className="sub">每个行业独立维护自己的 nginx / stream 配置，可基于模板源克隆初始化。</p>
        </div>
        <button className="btn primary" onClick={() => setOpenClone(true)}>＋ 新建行业（模板克隆）</button>
      </div>

      {/* 统计卡（统一 .cards） */}
      <div className="cards">
        <div className="card blue"><b>{industries.length}</b><small>行业总数</small></div>
        <div className="card green"><b>{Object.values(configCounts).reduce((a, b) => a + (b.total || 0), 0)}</b><small>nginx 配置</small></div>
        <div className="card yellow"><b>{streamCount}</b><small>stream 配置</small></div>
        <div className="card"><b>{listenTotal}</b><small>全网监听点</small></div>
      </div>

      {error && (
        <p className="err" style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 10 }}>
          <span>{error}</span>
          <button className="btn mini" onClick={load}>重试</button>
        </p>
      )}
      {industries.length === 0 && !error ? (
        <div className="empty">暂无行业，点击「新建行业（模板克隆）」创建。</div>
      ) : (
        <table className="ov-tbl tbl-anim clickable">
          <thead>
            <tr>
              <th>行业</th><th>nginx server</th><th>upstream</th>
              <th>stream</th><th>归属·更新</th><th className="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            {industries.map((ind) => (
              <tr key={ind.id} onClick={() => navigate(`/ops/${ind.id}`)}>
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
                <td className="meta">{configCounts[ind.id]?.total ?? 0}</td>
                <td className="meta">—</td>
                <td className="meta">{configCounts[ind.id]?.stream ?? 0}</td>
                <td className="meta">{ind.updated_at ? ind.updated_at.split("T")[0] : ""}</td>
                <td className="col-ops">
                  <span className="row-arrow">进入 →</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="meta" style={{ padding: "14px 0 24px" }}>
        提示：选择「模板源」行业作为克隆基准，克隆后将完全独立；无人编辑时配置按行业隔离。
      </p>

      <IndustryCloneModal
        templates={templates}
        open={openClone}
        onClose={() => setOpenClone(false)}
        onCreated={() => { setOpenClone(false); load(); }}
      />
    </div>
  );
}