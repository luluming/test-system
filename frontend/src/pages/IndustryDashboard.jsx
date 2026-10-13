import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listIndustries } from "../api/industry";
import { listConfigsByIndustry } from "../api/nginx";
import { useTheme } from "../theme/ThemeProvider";
import IndustryCloneModal from "./IndustryCloneModal";
import "./dashboard.css";

const SWATCHES = [
  { k: "dark", s: "#0a0a0c" },
  { k: "soft", s: "#16162a" },
  { k: "light", s: "#f4f6f9" },
];

export default function IndustryDashboard() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [industries, setIndustries] = useState([]);
  const [configCounts, setConfigCounts] = useState({});
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
    for (const ind of list) {
      try {
        map[ind.id] = (await listConfigsByIndustry(ind.id)).data.length;
      } catch { map[ind.id] = 0; }
    }
    setConfigCounts(map);
  }, []);

  useEffect(() => { load().then(() => undefined); }, [load]);
  useEffect(() => { if (industries.length) loadCounts(industries); /* eslint-disable-line */ }, [loadCounts]);

  const templates = useMemo(() => industries.filter((i) => i.is_template), [industries]);
  const clonedNames = useMemo(() => {
    const byId = new Map(industries.map((i) => [i.id, i.name]));
    return new Map(
      industries.filter((i) => i.cloned_from_id != null)
        .map((i) => [i.id, "克隆自 · " + (byId.get(i.cloned_from_id) ?? i.cloned_from_id)])
    );
  }, [industries]);
  const streamCount = 0; // 本阶段 stream 独立文件由「内页①」落地，展示占位 0

  return (
    <div className="shell">
      <header className="shell-bar">
        <span className="logo">Nginx 配置管理系统</span>
        <span className="crumb">› 行业管理</span>
        <div className="ctl">
          {SWATCHES.map((sw) => (
            <button
              key={sw.k}
              title={sw.k}
              className={"swatch" + (theme === sw.k ? " active" : "")}
              style={{ background: sw.s }}
              onClick={() => setTheme(sw.k)}
            />
          ))}
        </div>
      </header>

      <section className="shell-head">
        <div className="row">
          <div>
            <h1>行业管理</h1>
            <p className="sub">每个行业独立维护自己的 nginx / stream 配置，可基于模板源克隆初始化。</p>
          </div>
          <button className="primary-btn" onClick={() => setOpenClone(true)}>＋ 新建行业（模板克隆）</button>
        </div>
      </section>

      <div className="kpi">
        <div className="kpi-item"><div className="num">{industries.length}</div><div className="lbl">行业总数</div></div>
        <div className="kpi-item"><div className="num">{Object.values(configCounts).reduce((a, b) => a + b, 0)}</div><div className="lbl">nginx 配置</div></div>
        <div className="kpi-item"><div className="num">{streamCount}</div><div className="lbl">stream 配置</div></div>
        <div className="kpi-item"><div className="num">—</div><div className="lbl">全网监听点</div></div>
      </div>

      <div className="db-wrap">
        {error && <p className="err">{error}</p>}
        {industries.length === 0 && !error ? (
          <div className="empty">暂无行业，点击「新建行业（模板克隆）」创建。</div>
        ) : (
          <table className="db-tbl tbl-anim">
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
                  <td className="meta">{configCounts[ind.id] ?? 0}</td>
                  <td className="meta">—</td>
                  <td className="meta">—</td>
                  <td className="meta">{ind.updated_at ? ind.updated_at.split("T")[0] : ""}</td>
                  <td className="col-ops">
                    <span className="row-arrow">→</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="meta" style={{ padding: "0 16px 24px" }}>
          提示：选择「模板源」行业作为克隆基准，克隆后将完全独立；无人编辑时配置按行业隔离。
        </p>
      </div>

      <IndustryCloneModal
        templates={templates}
        open={openClone}
        onClose={() => setOpenClone(false)}
        onCreated={() => { setOpenClone(false); load(); }}
      />
    </div>
  );
}