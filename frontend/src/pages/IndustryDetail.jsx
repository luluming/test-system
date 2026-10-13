import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getIndustry } from "../api/industry";
import { listConfigsByIndustry } from "../api/nginx";
import "./dashboard.css";

// 外壳阶段的最小行业概览页：验证行业作用域与 version 字段端到端打通。
// 完整逐行业控制台（BlockTree/拓扑/业务端口/导出）由「内页①」替换本页。
export default function IndustryDetail() {
  const { industryId } = useParams();
  const [ind, setInd] = useState(null);
  const [cfgs, setCfgs] = useState([]);

  useEffect(() => {
    (async () => {
      const id = Number(industryId);
      try {
        const [indRes, cfgRes] = await Promise.all([getIndustry(id), listConfigsByIndustry(id)]);
        setInd(indRes.data);
        setCfgs(cfgRes.data);
      } catch { /* 由内页①接管错误态 */ }
    })();
  }, [industryId]);

  if (!ind) return <div className="shell" style={{ padding: 24 }}>加载中…</div>;
  return (
    <div className="shell">
      <header className="shell-bar">
        <span className="crumb">‹ 行业管理</span>
        <span className="crumb">› {ind.name}</span>
      </header>
      <div className="db-wrap">
        <h1 style={{ marginTop: 24 }}>{ind.name}</h1>
        <p className="meta">{ind.code}{ind.is_template ? " · 模板源" : ""}</p>
        <table className="db-tbl" style={{ marginTop: 16 }}>
          <thead><tr><th>配置名</th><th>域名</th><th>启用</th><th>版本</th></tr></thead>
          <tbody>
            {cfgs.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="meta">{c.domain ?? "—"}</td>
                <td className="meta">{c.enabled ? "是" : "否"}</td>
                <td className="meta">v{c.version}</td>
              </tr>
            ))}
            {cfgs.length === 0 && (
              <tr><td colSpan={4} className="empty">该行业暂无 nginx 配置，可通过「从模板克隆初始化」创建。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}