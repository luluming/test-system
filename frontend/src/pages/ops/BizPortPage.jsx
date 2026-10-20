import { useEffect, useState } from "react";
import { useOps } from "./OpsContext";
import * as nginx from "../../api/nginx";
import * as lib from "../../lib/nginx-inner";
import BizPortChips from "./BizPortChips";
import PathChain from "./PathChain";

/* 业务端口视图（方案C 主从：左list监听点 + 右detail chips+路径） */
export default function BizPortPage() {
  const ops = useOps();
  const { industryId, tree, toast, selected, setSelected } = ops;
  const [bps, setBps] = useState([]);
  const [fps, setFps] = useState([]);
  const [sel, setSel] = useState(null);

  useEffect(() => {
    nginx.listBizPorts(industryId).then((r) => setBps(r.data)).catch(() => toast("业务端口加载失败", "err"));
    nginx.listForwardPorts(industryId).then((r) => setFps(r.data)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [industryId]);

  const servers = (tree[0]?.children || []).filter((n) => n.scope === "server");

  const selPorts = sel
    ? bps.filter((b) => String(b.port) === String(sel.port) || b.id === sel.id)
    : bps;
  const selFps = sel
    ? fps.filter((f) => String(f.listen_port) === String(sel.port))
    : fps;

  return (
    <div className="split" style={{ flex: 1, minHeight: 0 }}>
      {/* 左：监听点列表（对齐 mock view-bizport list） */}
      <div className="list-panel">
        <div className="lp-head">监听点 · server ({servers.length})</div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {servers.map((b) => {
            const port = lib.listenPlain(b);
            const sn = lib.snameOf(b);
            const on = selected && selected._id === b._id;
            return (
              <div key={b._id} className={`lp-row${on ? " on" : ""}`} onClick={() => { setSelected(b); setSel(on ? null : { port: port.split(":")[1] || port }); }}>
                <span className="mono" style={{ color: "var(--brand)", fontWeight: 600 }}>{port}</span>
                <span className="mono" style={{ color: "var(--text-pri)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sn}</span>
              </div>
            );
          })}
          {servers.length === 0 && <div className="empty-hint">该上下文无 server 块</div>}
        </div>
      </div>

      {/* 右：detail（业务端口 chips + 转发规则路径） */}
      <div className="detail-panel">
        <div className="toolbar">
          <span className="chain-label">业务端口 <span className="cplus-tag">BizPortChips</span></span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => toast("业务端口已保存", "ok")}>保存</button>
        </div>
        <div className="ops-scroll" style={{ padding: "14px 18px" }}>
          <BizPortChips ports={selPorts} onPick={(p) => setSel(sel && sel.id === p.id ? null : p)} />
          <h4 className="ov-h mt">转发规则访问路径</h4>
          {(selFps.length ? selFps : fps).map((f) => (
            <PathChain key={f.id} rule={f} domain="freight.example.com" />
          ))}
          {!fps.length && <div className="empty-hint">暂无转发规则</div>}
        </div>
      </div>
    </div>
  );
}