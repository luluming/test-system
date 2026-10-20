import { useEffect, useMemo, useState } from "react";
import { useOps } from "./OpsContext";
import * as inner from "../../api/nginxInner";

/* 右栏 Upstream 池：组列表 + 组详情（strategy/keepalive/节点表/预览/validate），可折叠 */
export default function UpstreamPool() {
  const ops = useOps();
  const { industryId, toast } = ops;
  const [collapsed, setCollapsed] = useState(false);
  const [ups, setUps] = useState([]);
  const [selId, setSelId] = useState(null);
  const [servers, setServers] = useState([]);
  const [preview, setPreview] = useState("");
  const [validate, setValidate] = useState(null);

  useEffect(() => {
    if (!industryId) return;
    inner.listUpstreams(industryId).then((r) => {
      setUps(r.data);
      if (r.data.length) setSelId(r.data[0].id);
    }).catch(() => toast("upstream 池加载失败", "err"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [industryId]);

  const sel = useMemo(() => ups.find((u) => u.id === selId), [ups, selId]);

  useEffect(() => {
    if (!selId) { setServers([]); setPreview(""); return; }
    inner.listUpstreamServers(selId).then((r) => setServers(r.data)).catch(() => {});
    inner.upstreamPreview(selId).then((r) => setPreview(r.data?.content || "")).catch(() => {});
  }, [selId]);

  if (collapsed) {
    return (
      <div className="up-pool collapsed" style={{ display: "flex", flexDirection: "column" }}>
        <div className="up-head" style={{ padding: "10px 12px" }}>
          <button className="fold" onClick={() => setCollapsed(false)} title="展开">◀</button>
        </div>
      </div>
    );
  }

  const toggleServer = (s) => {
    inner.updateUpstreamServer(selId, s.id, { enable: !s.enable }).then((r) => {
      setServers((prev) => prev.map((x) => (x.id === s.id ? { ...x, enable: r.data.enable } : x)));
      toast(r.data.enable ? "节点已启用" : "节点已停用", r.data.enable ? "ok" : "warn");
    }).catch(() => toast("操作失败", "err"));
  };

  const runValidate = () => {
    inner.validateUpstream(selId).then((r) => {
      setValidate(r.data);
      toast(r.data.ok ? "upstream 片段校验通过" : "校验失败：" + (r.data.error_line || ""), r.data.ok ? "ok" : "err");
    }).catch(() => toast("校验请求失败", "err"));
  };

  return (
    <div className="up-pool">
      <div className="up-head">
        上游池
        <span className="tag2 bare" style={{ fontSize: 9 }}>{ups.length} 组</span>
        <button className="fold" onClick={() => setCollapsed(true)} title="折叠">▶</button>
      </div>
      <div className="up-body">
        <div className="up-groups">
          <div className="grow-note" style={{ marginBottom: 6 }}>组</div>
          {ups.map((u) => (
            <div key={u.id} className={`up-item${u.id === selId ? " on" : ""}`} onClick={() => setSelId(u.id)}>
              {u.name}<span className="up-bc">{u.strategy === "round_robin" ? "rr" : u.strategy}</span>
            </div>
          ))}
          {!ups.length && <div className="empty-hint" style={{ padding: "20px 0", fontSize: 11 }}>无 upstream 组</div>}
        </div>
        <div className="up-detail">
          {sel && (
            <>
              <div className="up-name">{sel.name}</div>
              <div className="up-sub">
                strategy：{sel.strategy} · keepalive：{sel.keepalive}
              </div>
              <div className="grow-note">节点（{servers.length}）</div>
              {servers.map((s) => (
                <div key={s.id} className="node-row">
                  <span className="status-dot" style={{ background: s.enable === false ? "var(--text-ter)" : "var(--success)" }} />
                  <span className="naddr">{s.addr}{s.port ? ":" + s.port : ""}</span>
                  <span className="nwt">{s.weight != null && s.weight !== 1 ? "w=" + s.weight : ""}</span>
                  <button className="t-op" title="启停" onClick={() => toggleServer(s)}>启停</button>
                </div>
              ))}
              {!servers.length && <div className="empty-hint" style={{ padding: "14px 0", fontSize: 11 }}>该组暂无节点</div>}
              <div className="up-preview">
                <pre>{preview || "…"}</pre>
              </div>
              <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                <button className="btn mini" onClick={runValidate}>nginx -t 校验</button>
              </div>
              {validate && !validate.ok && (
                <div className="err" style={{ marginTop: 6, fontSize: 11, color: "#ef4444" }}>
                  第 {validate.error_line} 行错误：{validate.output}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}