import { useOps } from "./OpsContext";
import * as lib from "../../lib/nginx-inner";

/* 业务端口分组 chips（端口用 listenPlain 剥离修饰词） */
export function BizPortChips({ ports, onPick }) {
  const { setView } = useOps();
  return (
    <div className="chip-grid">
      {(ports || []).map((p) => (
        <div key={p.id} className="chip" onClick={() => onPick && onPick(p)}>
          <span className="cp-port">{lib.stripListenValue(String(p.port))}</span>
          <span className="cp-name">{p.service_name || "未命名服务"}</span>
          <span className="cp-meta">
            <span className={`oc-pill ${p.public_exposed ? "pub" : "priv"}`}>{p.public_exposed ? "公网" : "内网"}</span>
          </span>
        </div>
      ))}
      {!ports?.length && <div className="empty-hint">该行业暂无业务端口</div>}
    </div>
  );
}

export default BizPortChips;