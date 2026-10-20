import { useEffect, useMemo, useState } from "react";
import { useOps } from "./OpsContext";
import * as lib from "../../lib/nginx-inner";
import * as inner from "../../api/nginxInner";

/* 导出中心弹窗：SSL 开关 + 域名替换 + upstream 整组替换（默认+例外）+ 实时预览 + 复制/下载 */
export default function ExportModal({ onClose }) {
  const ops = useOps();
  const { configId, tree, setExportInfo, toast } = ops;
  const [sslOn, setSslOn] = useState(true);
  const [domNew, setDomNew] = useState("");
  const [upDefaultIps, setUpDefaultIps] = useState("");
  const [exceptions, setExceptions] = useState([{ grp: "", ips: "" }]);
  const [backendOut, setBackendOut] = useState(null);

  const upNames = useMemo(() => lib.upstreamGroups(tree).map((g) => lib.upNameOf(g)), [tree]);

  const exceptionsKey = JSON.stringify(exceptions);

  const lines = useMemo(() => lib.exportLines(tree, { sslOn, domNew: domNew.trim(), defaultIps: upDefaultIps, exceptions }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, sslOn, domNew, upDefaultIps, exceptionsKey]);

  const exportText = useMemo(() => lib.exportConfigText(tree, { sslOn, domNew: domNew.trim(), defaultIps: upDefaultIps, exceptions }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, sslOn, domNew, upDefaultIps, exceptionsKey]);

  // 状态栏计数
  useEffect(() => {
    const domN = domNew.trim() ? countServerNames(lines) : 0;
    const upN = lib.upstreamGroups(tree).filter((g) => lib.derivedFor(g, exceptions, upDefaultIps.trim() ? upDefaultIps : "")).length;
    setExportInfo({ dom: domN, up: upN });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  function countServerNames(ls) { return ls.filter((l) => l.text.includes("server_name ")).length; }

  const copy = () => {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(exportText).then(() => toast("配置已复制到剪贴板", "ok"));
    else toast("复制失败（非 secure 环境）", "warn");
  };

  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([exportText], { type: "text/plain;charset=utf-8" }));
    a.download = lib.getFileName();
    a.click();
    toast("已下载配置文件", "ok");
  };

  const applyBackend = () => {
    if (!configId) return;
    inner.exportConfig(configId, {
      ssl_enabled: sslOn,
      server_name_domain: domNew.trim(),
      upstream_default_ips: upDefaultIps,
      upstream_exceptions: exceptions.filter((e) => lib.domParse(e.ips).length).map((e) => ({ grp: e.grp, ips: e.ips })),
      context: ops.ctx || "conf",
    }).then((r) => setBackendOut(r.data?.content || "")).catch((e) => toast("后端导出失败：" + (e.response?.data?.detail || ""), "err"));
  };

  return (
    <div className="ops-modal-mask" onClick={onClose}>
      <div className="ops-modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>导出配置</h3>

        <div className="fgroup">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            SSL 场景
            <button className={`btn mini${sslOn ? " primary" : ""}`} onClick={() => setSslOn(!sslOn)}>
              {sslOn ? "开启" : "关闭"}
            </button>
            <span className="exp-status">关闭时移除 ssl_* 指令并改写 listen</span>
          </label>
        </div>

        <div className="fgroup"><label>域名整体替换（留空不替换）</label>
          <input value={domNew} onChange={(e) => setDomNew(e.target.value)} placeholder="填一个新域名，所有 server_name 整体替换" /></div>

        <div className="fgroup"><label>upstream 默认后端 IP（一个 IP = 一个节点，留空跳过这些组）</label>
          <textarea className="up-ip" rows={2} value={upDefaultIps} onChange={(e) => setUpDefaultIps(e.target.value)}
            placeholder="10.0.0.2\n10.0.0.3" /></div>

        <div className="fgroup">
          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            upstream 例外（差异组）
            <button className="btn mini" onClick={() => setExceptions([...exceptions, { grp: "", ips: "" }])}>＋ 添加例外</button>
          </label>
          {exceptions.map((ex, i) => (
            <div key={i} className="up-rule">
              <div className="up-rule-head">
                <span className="up-rule-tag">例外 {i + 1}</span>
                <span className="up-rule-tools">
                  <span className="rbtn" onClick={() => setExceptions(exceptions.filter((_, x) => x !== i))}>✕ 删除</span>
                </span>
              </div>
              <div className="up-hint">目标 upstream 组</div>
              <input className="up-search" list="upgroup-list" value={ex.grp}
                onChange={(e) => setExceptions(exceptions.map((x, xi) => xi === i ? { ...x, grp: e.target.value } : x))} />
              <datalist id="upgroup-list">
                {upNames.map((n) => <option key={n} value={n} />)}
              </datalist>
              <div className="up-hint">本例外目标 IP</div>
              <textarea className="up-ip" rows={1} value={ex.ips}
                onChange={(e) => setExceptions(exceptions.map((x, xi) => xi === i ? { ...x, ips: e.target.value } : x))}
                placeholder="10.0.0.9,10.0.0.10" />
            </div>
          ))}
        </div>

        <div className="grow-note" style={{ margin: "10px 0 6px" }}>实时预览</div>
        <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border-soft)", borderRadius: 6, padding: "10px 12px", background: "var(--bg-deep2)" }}>
          {lines.map((l, i) => (
            <div key={i} className="exp-line">
              {l.changed && l.orig != null
                ? <><span className="subst">{l.text}</span><span className="sub-mark">← 原值：{l.orig}</span></>
                : /^\s*#/.test(l.text) ? <span className="cm">{l.text}</span> : <span>{l.text}</span>}
            </div>
          ))}
        </div>

        {backendOut && (
          <>
            <div className="grow-note" style={{ margin: "10px 0 6px" }}>后端导出结果（与本地一致）</div>
            <pre className="exp-line" style={{ maxHeight: 160, overflowY: "auto" }}>{backendOut}</pre>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={applyBackend}>应用导出（后端）</button>
          <button className="btn" onClick={copy}>复制</button>
          <button className="btn primary" onClick={download}>下载配置</button>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}