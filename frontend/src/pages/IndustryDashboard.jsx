import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "antd";
import { deleteIndustry, listIndustries } from "../api/industry";
import { listConfigsByIndustry } from "../api/nginx";
import { getConfigTree } from "../api/nginxInner";
import { getYamlStatsByIndustry } from "../api/yaml";
import IndustryCloneModal from "./IndustryCloneModal";
import IndustryDeleteModal from "./IndustryDeleteModal";
import "./dashboard.css";

export default function IndustryDashboard() {
  const navigate = useNavigate();
  const [industries, setIndustries] = useState([]);
  const [configCounts, setConfigCounts] = useState({});
  const [listenTotal, setListenTotal] = useState(0);
  // YML 真实统计：{industry_id: {yml_count, hosts, clusters, total_nodes}}
  const [ymlStats, setYmlStats] = useState({});
  const [openClone, setOpenClone] = useState(false);
  // 删除确认弹窗：待删除的行业（null 表示未打开）
  const [delTarget, setDelTarget] = useState(null);
  const [error, setError] = useState("");
  // 工作台类型选择：进入 Nginx 行业管理 或 YML 行业管理
  const [mode, setMode] = useState("nginx");
  const [toast, setToast] = useState("");

  const load = useCallback(async (curMode) => {
    try {
      const res = await listIndustries(curMode);
      setIndustries(res.data);
      setError("");
    } catch { setError("行业列表加载失败"); }
  }, []);

  // Nginx 行业统计（逐行业查配置块 → 算 server/stream）
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

  // YML 行业统计（一次批量 API）
  const loadYmlStats = useCallback(async () => {
    try {
      const res = await getYamlStatsByIndustry();
      // 后端返回的 key 是字符串，转成数字方便查询
      const map = {};
      for (const [k, v] of Object.entries(res.data || {})) { map[Number(k)] = v; }
      setYmlStats(map);
    } catch { setYmlStats({}); }
  }, []);

  useEffect(() => { load(mode).then(() => undefined); }, [load, mode]);
  useEffect(() => { if (industries.length) loadCounts(industries); /* eslint-disable-line */ }, [loadCounts, industries]);
  useEffect(() => { if (industries.length) loadYmlStats(); /* eslint-disable-line */ }, [loadYmlStats, industries]);

  const templates = useMemo(() => industries.filter((i) => i.is_template), [industries]);
  const clonedNames = useMemo(() => {
    const byId = new Map(industries.map((i) => [i.id, i.name]));
    return new Map(
      industries.filter((i) => i.cloned_from_id != null)
        .map((i) => [i.id, "克隆自 · " + (byId.get(i.cloned_from_id) ?? i.cloned_from_id)])
    );
  }, [industries]);
  // 统计卡只汇总当前菜单可见的行业，避免另一模块的数据串进来
  const nginxAgg = useMemo(() => {
    let total = 0;
    let stream = 0;
    for (const ind of industries) {
      total += configCounts[ind.id]?.total ?? 0;
      stream += configCounts[ind.id]?.stream ?? 0;
    }
    return { total, stream };
  }, [industries, configCounts]);
  const ymlAgg = useMemo(() => {
    let count = 0;
    let hosts = 0;
    let clusters = 0;
    for (const ind of industries) {
      const s = ymlStats[ind.id];
      if (!s) continue;
      count += s.yml_count || 0;
      hosts += s.hosts || 0;
      clusters += s.clusters || 0;
    }
    return { count, hosts, clusters };
  }, [industries, ymlStats]);

  const notify = (msg) => { setToast(msg); setTimeout(() => setToast(""), 2600); };

  // 刷新列表 + 当前菜单的统计数据
  const refresh = async () => {
    try {
      const list = await listIndustries(mode).then((r) => r.data);
      setIndustries(list);
      loadYmlStats();
      loadCounts(list);
    } catch { setError("行业列表加载失败"); }
  };

  return (
    <div>
      {/* 页头（统一外壳视觉） */}
      <div className="page-head">
        <div>
          <h1>行业管理</h1>
          <p className="sub">每个行业独立维护自己的 nginx / stream / YAML 配置，可基于模板源克隆初始化。</p>
        </div>
        <button className="btn primary" onClick={() => setOpenClone(true)}>＋ 新建行业（模板克隆）</button>
      </div>

      {/* 工作台类型选择：进入 nginx 或 yml 行业管理 */}
      <div className="mode-switch">
        <div
          className={`mode-card${mode === "nginx" ? " on" : ""}`}
          onClick={() => setMode("nginx")}
        >
          <span className="m-ico">◈</span>
          <div>
            <div className="m-t">Nginx 行业管理</div>
            <div className="m-s">server / upstream / map · 块树编辑与推送</div>
          </div>
        </div>
        <div
          className={`mode-card yml${mode === "yml" ? " on" : ""}`}
          onClick={() => setMode("yml")}
        >
          <span className="m-ico">🟨</span>
          <div>
            <div className="m-t">YML 行业管理</div>
            <div className="m-s">deploy_config 等 YAML 文件 · 全文编辑器</div>
          </div>
        </div>
      </div>

      {/* 统计卡（统一 .cards） */}
      {mode === "nginx" ? (
        <div className="cards">
          <div className="card blue"><b>{industries.length}</b><small>行业总数</small></div>
          <div className="card green"><b>{nginxAgg.total}</b><small>nginx 配置</small></div>
          <div className="card yellow"><b>{nginxAgg.stream}</b><small>stream 配置</small></div>
          <div className="card"><b>{listenTotal}</b><small>全网监听点</small></div>
        </div>
      ) : (
        <div className="cards">
          <div className="card blue"><b>{industries.length}</b><small>行业总数</small></div>
          <div className="card green"><b>{ymlAgg.count}</b><small>yml 配置</small></div>
          <div className="card yellow"><b>{ymlAgg.hosts}</b><small>主机</small></div>
          <div className="card"><b>{ymlAgg.clusters}</b><small>集群</small></div>
        </div>
      )}

      {error && (
        <p className="err" style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 10 }}>
          <span>{error}</span>
          <button className="btn mini" onClick={() => load(mode)}>重试</button>
        </p>
      )}
      {industries.length === 0 && !error ? (
        <div className="empty">暂无行业，点击「新建行业（模板克隆）」创建。</div>
      ) : (
        <table className="ov-tbl tbl-anim clickable">
          <thead>
            <tr>
              <th>行业</th>
              {mode === "nginx"
                ? <><th>nginx server</th><th>upstream</th><th>stream</th></>
                : <><th>yml 配置</th><th>主机</th><th>集群</th></>}
              <th>归属·更新</th><th className="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            {industries.map((ind) => {
              const ys = ymlStats[ind.id] || { yml_count: 0, hosts: 0, clusters: 0 };
              return (
                <tr key={ind.id} onClick={() => navigate(mode === "nginx" ? `/ops/${ind.id}` : `/ops/${ind.id}/yaml`)}>
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
                  {mode === "nginx" ? (
                    <>
                      <td className="meta">{configCounts[ind.id]?.total ?? 0}</td>
                      <td className="meta">—</td>
                      <td className="meta">{configCounts[ind.id]?.stream ?? 0}</td>
                    </>
                  ) : (
                    <>
                      <td className="meta">{ys.yml_count}</td>
                      <td className="meta">{ys.hosts}</td>
                      <td className="meta">{ys.clusters}</td>
                    </>
                  )}
                  <td className="meta">{ind.updated_at ? ind.updated_at.split("T")[0] : ""}</td>
                  <td className="col-ops">
                    {mode === "nginx" ? (
                      <button className="row-enter" onClick={(e) => { e.stopPropagation(); navigate(`/ops/${ind.id}`); }}>Nginx 配置</button>
                    ) : (
                      <button className="row-enter yml" onClick={(e) => { e.stopPropagation(); navigate(`/ops/${ind.id}/yaml`); }}>YML 配置</button>
                    )}
                    <button
                      className="row-delete"
                      onClick={(e) => { e.stopPropagation(); setDelTarget(ind); }}
                      title={ind.is_template ? "模板源行业禁止删除" : "删除行业或清空当前模块数据"}
                    >删除</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="meta" style={{ padding: "14px 0 24px" }}>
        提示：选择「模板源」行业作为克隆基准，克隆后将完全独立；无人编辑时配置按行业隔离。
      </p>

      <IndustryCloneModal
        templates={templates}
        open={openClone}
        cloneScope={mode === "yml" ? "yml" : mode === "nginx" ? "nginx" : "both"}
        onClose={() => setOpenClone(false)}
        onCreated={() => { setOpenClone(false); load(mode); }}
      />

      <IndustryDeleteModal
        industry={delTarget}
        mode={mode}
        open={!!delTarget}
        onClose={() => setDelTarget(null)}
        onDone={(msg) => { setDelTarget(null); notify(msg); refresh(); }}
      />

      {toast && (
        <div style={{ position: "fixed", right: 18, bottom: 36, zIndex: 1000, background: "var(--bg-surface2)", border: "1px solid var(--border)", borderLeft: "4px solid var(--brand)", borderRadius: 8, padding: "8px 14px", fontSize: 13, boxShadow: "0 4px 20px rgba(0,0,0,.18)", animation: "fadeUp .25s ease" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
