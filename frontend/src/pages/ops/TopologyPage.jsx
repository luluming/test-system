import { useEffect, useState } from "react";
import { useOps } from "./OpsContext";
import * as inner from "../../api/nginxInner";
import GlobalChain from "./GlobalChain";
import GroupDetail from "./GroupDetail";

/* 全局拓扑：四层链路 + 组详情（主从联动） */
export default function TopologyPage() {
  const ops = useOps();
  const { configId, toast } = ops;
  const [topo, setTopo] = useState(null);
  const [selUp, setSelUp] = useState(null);
  const [err, setErr] = useState(false);

  const load = () => {
    if (!configId) return;
    setErr(false);
    inner.getTopology(configId).then((r) => {
      setTopo(r.data);
      setSelUp(r.data.upstreams?.[0] || null);
    }).catch(() => setErr(true));
  };
  useEffect(load, [configId]);

  if (err) {
    return (
      <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center" }}>
          <div className="empty-hint" style={{ marginBottom: 12 }}>拓扑数据加载失败</div>
          <button className="btn primary" onClick={load}>重试</button>
        </div>
      </div>
    );
  }
  if (!topo) {
    return (
      <div className="ops-scroll">
        <div className="skeleton" style={{ width: "60%", height: 16, marginBottom: 10 }} />
        <div className="skeleton" style={{ width: "80%", height: 60, marginBottom: 10 }} />
        <div className="skeleton" style={{ width: "70%", height: 16 }} />
      </div>
    );
  }

  return (
    <div className="split" style={{ flex: 1, minHeight: 0 }}>
      {/* 左：监听点链路列表 */}
      <div className="list-panel">
        <div className="lp-head">全局链路 ({topo.listeners?.length || 0})</div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {(topo.listeners || []).map((l) => (
            <div key={l.id} style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-soft)" }}>
              <GlobalChain listener={l} domains={topo.domains || []} upstreams={topo.upstreams || []} links={topo.links || []} />
            </div>
          ))}
          {!topo.listeners?.length && <div className="empty-hint">当前配置无监听点</div>}
        </div>
      </div>
      {/* 右：组详情 */}
      <div className="detail-panel" style={{ padding: 16, overflowY: "auto" }}>
        <div className="chain-label" style={{ marginBottom: 10 }}>upstream 组详情</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {(topo.upstreams || []).map((u) => (
            <div key={u.id} className={`seg-i${selUp && selUp.id === u.id ? " on" : ""}`} onClick={() => setSelUp(u)}>
              {u.name}<span style={{ color: "var(--text-ter)", fontSize: 10, marginLeft: 4 }}>{u.backends?.length || 0} 节点</span>
            </div>
          ))}
          {!topo.upstreams?.length && <span className="tag2 bare">无 upstream 组</span>}
        </div>
        <GroupDetail upstream={selUp} links={topo.links || []} />
      </div>
    </div>
  );
}