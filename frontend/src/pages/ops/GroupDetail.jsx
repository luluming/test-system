import { useOps } from "./OpsContext";

/* 选中 upstream 组详情：被引用监听点 + 后端节点 */
export function GroupDetail({ upstream, links }) {
  const ops = useOps();
  const { setView, setHighlightListen } = ops;
  if (!upstream) return <div className="empty-hint">选择左侧 upstream 组查看详情</div>;
  const refs = links.filter((l) => l.upstream === upstream.name);
  const jump = (listen) => { setView("config"); setHighlightListen(String(listen)); };
  return (
    <div style={{ border: "1px solid var(--border-soft)", borderRadius: 8, background: "var(--bg-surface2)", overflow: "hidden" }}>
      <div className="t-head">
        <span className="bkind up">upstream</span>
        <span className="mono" style={{ color: "var(--warning)" }}>{upstream.name}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-ter)" }}>{upstream.backends.length} 节点</span>
      </div>
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="grow-note">被引用（监听点）</div>
        <div className="t-row">
          {refs.map((l, i) => (
            <span key={i} className="t-node loc" onClick={() => jump(l.listen)}>{l.listen}</span>
          ))}
          {!refs.length && <span className="t-node" style={{ color: "var(--text-ter)" }}>未被监听点引用</span>}
        </div>
        <div className="grow-note" style={{ marginTop: 6 }}>后端节点</div>
        <div className="t-row">
          {(upstream.backends || []).map((b, i) => (
            <span key={i} className="t-node bk">{b.addr}{b.port ? ":" + b.port : ""}</span>
          ))}
          {!upstream.backends?.length && <span className="t-node" style={{ color: "var(--text-ter)" }}>无后端节点</span>}
        </div>
      </div>
    </div>
  );
}

export default GroupDetail;