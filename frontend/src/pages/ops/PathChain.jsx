import { useOps } from "./OpsContext";
import * as lib from "../../lib/nginx-inner";

/* 转发规则访问路径链路：公网/内网 → 域名:端口 → /path → upstream 组或目标地址 */
export function PathChain({ rule, domain }) {
  const { setView, setHighlightListen } = useOps();
  const upSet = lib.getUpstreamSet();
  const target = rule.upstream_target || rule.target || "-";
  const targetIsUp = rule.upstream_id != null;
  const matched = targetIsUp ? upSet.has(target) : null;
  const jump = () => { setView("config"); setHighlightListen(String(rule.listen_port)); };
  return (
    <div className="rule-row">
      <div className="rule-meta">
        <span>{rule.service_name || "ANY"}</span>
        <span className="uuid">{rule.path ? " " + rule.path : String(rule.listen_port)}</span>
        <span className={`oc-pill ${rule.is_public ? "pub" : "priv"}`}>{rule.is_public ? "公网" : "内网"}</span>
        <span className="cplus-tag" style={{ marginLeft: "auto" }}>PathChain</span>
      </div>
      <div className="oc-chain compact">
        <span className={`oc-pill ${rule.is_public ? "pub" : "priv"}`}>{rule.is_public ? "公网" : "内网"}</span>
        <span className="oc-arrow">→</span>
        <span className="oc-node is-domain" onClick={jump}>{domain}</span>
        <span className="oc-arrow">→</span>
        <span className="oc-node" onClick={jump}>{lib.stripListenValue(String(rule.listen_port))}</span>
        <span className="oc-arrow">→</span>
        <span className="oc-node" onClick={jump}>{rule.path || "/"}</span>
        <span className="oc-arrow">→</span>
        {targetIsUp
          ? <span className={`oc-node is-target-up ${matched ? "matchok" : "unmatched"}`} onClick={jump}>{target}</span>
          : <span className="oc-node is-upstream" onClick={jump}>{target}</span>}
      </div>
    </div>
  );
}

export default PathChain;