import { useEffect, useState } from "react";
import { useOps } from "./OpsContext";
import * as nginx from "../../api/nginx";
import BizPortChips from "./BizPortChips";
import PathChain from "./PathChain";

/* 业务端口视图：分组 chips + 每条转发规则访问路径链路 */
export default function BizPortPage() {
  const ops = useOps();
  const { industryId, toast } = ops;
  const [bps, setBps] = useState([]);
  const [fps, setFps] = useState([]);
  const [sel, setSel] = useState(null);

  useEffect(() => {
    nginx.listBizPorts(industryId).then((r) => setBps(r.data)).catch(() => toast("业务端口加载失败", "err"));
    nginx.listForwardPorts(industryId).then((r) => setFps(r.data)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [industryId]);

  const selPorts = sel
    ? bps.filter((b) => String(b.port) === String(sel.port) || b.id === sel.id)
    : bps;
  const selFps = sel
    ? fps.filter((f) => String(f.listen_port) === String(sel.port))
    : fps;

  return (
    <div className="ops-scroll">
      <div className="chain-label" style={{ marginBottom: 10 }}>业务端口 <span className="cplus-tag">BizPortChips</span></div>
      <BizPortChips ports={bps} onPick={(p) => setSel(sel && sel.id === p.id ? null : p)} />
      <h4 className="ov-h mt">转发规则访问路径</h4>
      {(selFps.length ? selFps : fps).map((f) => (
        <PathChain key={f.id} rule={f} domain="freight.example.com" />
      ))}
      {!fps.length && <div className="empty-hint">暂无转发规则</div>}
    </div>
  );
}