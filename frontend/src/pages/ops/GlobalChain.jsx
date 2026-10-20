import { useOps } from "./OpsContext";

/* 四层全局链路：业务域名 → 监听点 → path → upstream 组 → 后端节点（点击节点跳转配置文件视图并定位） */
export function GlobalChain({ listener, domains, upstreams, links }) {
  const ops = useOps();
  const { setView, setHighlightListen } = ops;
  const jump = (listen) => {
    setView("config");
    setHighlightListen(String(listen));
  };
  const up = upstreams.find((u) => u.name === (links.find((l) => l.listen === listener.listen_plain) || {}).upstream);
  const domain = domains[0] || { domain: listener.server_name || "-" };
  const firstPath = (listener.proxy_targets && listener.proxy_targets[0]) || "/";
  return (
    <div className="chain-box">
      <div className="chain-label">全局链路 · <span className="mono" style={{ color: "var(--warning)" }}>{listener.server_name || "-"}</span>
        <span className="tap">点击节点可跳转</span><span className="cplus-tag">GlobalChain</span></div>
      <div className="oc-chain">
        <span className="oc-node is-domain" onClick={() => jump(listener.listen_plain)}>{domain.domain || listener.server_name || "-"}</span>
        <span className="oc-arrow">→</span>
        <span className="oc-node" onClick={() => jump(listener.listen_plain)}>{listener.listen_plain}</span>
        <span className="oc-arrow">→</span>
        <span className="oc-node" onClick={() => jump(listener.listen_plain)}>{firstPath}</span>
        <span className="oc-arrow">→</span>
        <span className={`oc-node is-upstream${up ? " matchok" : " unmatched"}`} onClick={() => jump(listener.listen_plain)}>
          {up ? up.name : ((links.find((l) => l.listen === listener.listen_plain) || {}).upstream || "-")}
        </span>
        {up ? up.backends.slice(0, 4).map((b, i) => (
          <span key={i} style={{ display: "contents" }}>
            <span className="oc-arrow">→</span>
            <span className="oc-node is-backend">{b.addr}{b.port ? ":" + b.port : ""}</span>
          </span>
        )) : null}
        {up && up.backends.length > 4 && (
          <><span className="oc-arrow">→</span><span className="oc-node is-backend">+{up.backends.length - 4}</span></>
        )}
      </div>
    </div>
  );
}

export default GlobalChain;