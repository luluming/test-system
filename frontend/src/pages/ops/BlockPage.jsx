import { useEffect, useMemo, useState } from "react";
import { Modal } from "antd";
import { useOps } from "./OpsContext";
import * as lib from "../../lib/nginx-inner";
const { treeNodeCount } = lib;
import * as nginx from "../../api/nginx";
import * as inner from "../../api/nginxInner";
import { BlockTree, StatBanner, DomMapPanel, ForwardPanel } from "./ConfigPage";
import ExportModal from "./ExportModal";
import PushModal from "./PushModal";

/* ---------- 新增顶级块弹窗（对齐 mock abSetScope/abOK） ---------- */
export function AddBlockModal({ open, onClose, onAdded }) {
  const ops = useOps();
  const { configId, toast } = ops;
  const [scope, setScope] = useState("server");
  const [form, setForm] = useState({ sname: "", listen: "", mapSrc: "", mapDst: "", splSrc: "", splDst: "", geoVar: "", upName: "", upSrv: "" });

  const validSegs = ["server", "map", "split_clients", "geo", "upstream", "events"];
  const f = (k) => form[k] || "";

  const ok = () => {
    if (!configId) { toast("无选中配置", "warn"); return; }
    let header = "", opts = [];
    if (scope === "server") {
      const sn = f("sname").trim(), li = f("listen").trim();
      if (li) opts.push({ directive: "listen", value: li, raw: "listen " + li });
      if (sn) opts.push({ directive: "server_name", value: sn, raw: "server_name " + sn });
      header = "server {";
    } else if (scope === "map") {
      if (!f("mapSrc") || !f("mapDst")) { toast("请填写 map 的源变量与结果变量", "warn"); return; }
      header = "map " + f("mapSrc") + " " + f("mapDst") + " {";
    } else if (scope === "split_clients") {
      if (!f("splSrc") || !f("splDst")) { toast("请填写 split_clients 的源/结果变量", "warn"); return; }
      header = "split_clients " + f("splSrc") + " " + f("splDst") + " {";
    } else if (scope === "geo") {
      if (!f("geoVar")) { toast("请填写 geo 变量名", "warn"); return; }
      header = "geo " + f("geoVar") + " {";
    } else if (scope === "upstream") {
      const nm = f("upName").trim().replace(/\s+/g, "_");
      if (!nm) { toast("请输入 upstream 组名", "warn"); return; }
      if (lib.getUpstreamSet().has(nm)) { toast("upstream 组已存在：" + nm, "warn"); return; }
      if (f("upSrv").trim()) opts.push({ directive: "server", value: f("upSrv").trim(), raw: "server " + f("upSrv").trim() });
      header = "upstream " + nm + " {";
    } else if (scope === "events") {
      header = "events {";
    }
    const payload = { nginx_config_id: configId, parent_id: null, scope, header };
    inner.createBlock(payload).then((r) => {
      // 选项逐个创建
      opts.forEach((o) => inner.createOption({ block_id: r.data.id, directive: o.directive, value: o.value, row_type: "kv" }));
      toast("已新增 " + scope + " 块", "ok");
      onAdded && onAdded();
      onClose();
    }).catch((e) => toast("新增失败：" + (e.response?.data?.detail || "未知错误"), "err"));
  };

  if (!open) return null;
  return (
    <div className="ops-modal-mask" onClick={onClose}>
      <div className="ops-modal" onClick={(e) => e.stopPropagation()}>
        <h3>新增顶级块</h3>
        <div className="seg-row">
          {validSegs.map((s) => (
            <div key={s} className={`seg-i${scope === s ? " on" : ""}`} onClick={() => setScope(s)}>{s}</div>
          ))}
        </div>
        {scope === "server" && (
          <>
            <div className="fgroup"><label>server_name（可选）</label><input value={form.sname} onChange={(e) => setForm({ ...form, sname: e.target.value })} placeholder="api.example.com" /></div>
            <div className="fgroup"><label>listen（可选）</label><input value={form.listen} onChange={(e) => setForm({ ...form, listen: e.target.value })} placeholder="443 ssl http2" /></div>
          </>
        )}
        {scope === "map" && (
          <>
            <div className="fgroup"><label>源变量</label><input value={form.mapSrc} onChange={(e) => setForm({ ...form, mapSrc: e.target.value })} placeholder="$http_upgrade" /></div>
            <div className="fgroup"><label>结果变量</label><input value={form.mapDst} onChange={(e) => setForm({ ...form, mapDst: e.target.value })} placeholder="$connection_upgrade" /></div>
          </>
        )}
        {scope === "split_clients" && (
          <>
            <div className="fgroup"><label>源变量</label><input value={form.splSrc} onChange={(e) => setForm({ ...form, splSrc: e.target.value })} /></div>
            <div className="fgroup"><label>结果变量</label><input value={form.splDst} onChange={(e) => setForm({ ...form, splDst: e.target.value })} /></div>
          </>
        )}
        {scope === "geo" && (
          <div className="fgroup"><label>geo 变量</label><input value={form.geoVar} onChange={(e) => setForm({ ...form, geoVar: e.target.value })} placeholder="$remote_addr" /></div>
        )}
        {scope === "upstream" && (
          <>
            <div className="fgroup"><label>upstream 组名</label><input value={form.upName} onChange={(e) => setForm({ ...form, upName: e.target.value })} /></div>
            <div className="fgroup"><label>初始后端（可选）</label><input value={form.upSrv} onChange={(e) => setForm({ ...form, upSrv: e.target.value })} placeholder="10.0.0.97:8080 weight=5" /></div>
          </>
        )}
        <div className="modal-tip">在 <span className="monob">.conf</span> 配置文件（http 上下文）新增顶级块，与其他 server / map / upstream 同级。</div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={ok}>创建</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 镜像设置弹窗：配置「母本端口 → 镜像端口」持久化镜像对 ---------- */
export function MirrorModal({ open, onClose }) {
  const ops = useOps();
  const { tree, configId, toast, loadTree, refreshMirrors, ctx } = ops;
  const [pairs, setPairs] = useState([]);
  const [srcP, setSrcP] = useState("");
  const [dstP, setDstP] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !configId) return;
    inner.listMirrorPairs(configId).then((r) => setPairs(r.data || [])).catch(() => {});
  }, [open, configId]);

  const servers = (tree[0]?.children || []).filter((n) => n.scope === "server");
  const ports = servers.map((s) => lib.listenPlain(s)).filter(Boolean);
  const inPair = (p) => pairs.some((x) => x.src_listen === p || x.dst_listen === p);

  const add = () => {
    if (!srcP || !dstP) { toast("请选择母本端口与镜像端口", "warn"); return; }
    if (srcP === dstP) { toast("两个端口不能相同", "warn"); return; }
    const src = servers.find((s) => lib.mirrorPortOf(s) === srcP);
    const dst = servers.find((s) => lib.mirrorPortOf(s) === dstP);
    if (!src || !dst) { toast("未找到对应监听点", "warn"); return; }
    setBusy(true);
    // 先同步内容（镜像覆盖），再落库镜像对配置
    inner.mirrorBlock(src.id, dst.id)
      .then(() => inner.createMirrorPair(configId, { src_listen: srcP, dst_listen: dstP }))
      .then(() => {
        setBusy(false);
        toast(`已设置镜像：${dstP} 与 ${srcP} 保持一致`, "ok");
        onClose();
        loadTree(configId, ctx);
        refreshMirrors && refreshMirrors();
      })
      .catch((e) => { setBusy(false); toast("镜像设置失败：" + (e.response?.data?.detail || "未知错误"), "err"); });
  };

  const remove = (p) => {
    Modal.confirm({
      title: "解除镜像关系",
      content: `解除镜像关系「${p.src_listen} → ${p.dst_listen}」？双方内容不会被修改。`,
      okText: "解除",
      okType: "danger",
      cancelText: "取消",
      onOk: () => inner.deleteMirrorPair(configId, p.id)
        .then(() => { toast("已解除镜像关系", "ok"); refreshMirrors && refreshMirrors(); })
        .catch((e) => toast("解除失败：" + (e.response?.data?.detail || "未知错误"), "err")),
    });
  };

  if (!open) return null;
  return (
    <div className="ops-modal-mask" onClick={onClose}>
      <div className="ops-modal" onClick={(e) => e.stopPropagation()}>
        <h3>镜像设置（监听点内容保持一致）</h3>
        <div className="mir-list">
          {pairs.map((p) => (
            <div key={p.id} className="mir-row">
              <span className="mono mir-src">{p.src_listen}</span>
              <span className="mir-arrow">→ 自动同步</span>
              <span className="mono mir-dst">{p.dst_listen}</span>
              <button className="t-op del" title="解除镜像关系" onClick={() => remove(p)}>✕</button>
            </div>
          ))}
          {pairs.length === 0 && <div className="empty-hint">尚未设置镜像对。选择两个监听点，使它们内容保持一致（仅 listen 端口各自保留）。</div>}
        </div>
        <div className="fgroup mir-add" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select className="mir-sel" value={srcP} onChange={(e) => setSrcP(e.target.value)} title="母本端口（内容以此为准）">
            <option value="">母本端口…</option>
            {ports.filter((p) => !inPair(p) || p === srcP).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <span className="mir-arrow">→ 同步到</span>
          <select className="mir-sel" value={dstP} onChange={(e) => setDstP(e.target.value)} title="镜像端口（自动跟随母本）">
            <option value="">镜像端口…</option>
            {ports.filter((p) => p !== srcP && (!inPair(p) || p === dstP)).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="modal-tip">母本端口内容变更后，镜像端口会自动同步为一致；删除镜像对只解除关系，不改动内容。</div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>关闭</button>
          <button className="btn primary" disabled={busy} onClick={add}>建立镜像</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 版本对比弹窗：历史版本列表 + 任选两版逐行 diff ---------- */
function fmtTime(s) { if (!s) return ""; const d = new Date(s); return d.toLocaleString("zh-CN", { hour12: false }); }

function diffLines(a, b) {
  const A = (a || "").split("\n"), B = (b || "").split("\n");
  const rows = [], usedB = new Set();
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      rows.push({ t: "same", a: A[i], no: [i + 1, j + 1] }); i++; j++; continue;
    }
    let nb = -1;
    for (let k = j; k < B.length; k++) { if (!usedB.has(k) && B[k] === A[i]) { nb = k; break; } }
    if (nb >= 0) {
      for (let k = j; k < nb; k++) { rows.push({ t: "add", b: B[k] }); usedB.add(k); }
      rows.push({ t: "same", a: A[i], no: [i + 1, nb + 1] }); usedB.add(nb); i++; j = nb + 1; continue;
    }
    rows.push({ t: "del", a: A[i] }); i++;
  }
  for (let k = j; k < B.length; k++) { if (!usedB.has(k)) rows.push({ t: "add", b: B[k] }); }
  return rows;
}

export function VersionModal({ open, onClose }) {
  const ops = useOps();
  const { configId, toast } = ops;
  const [versions, setVersions] = useState([]);
  const [sel, setSel] = useState([null, null]); // [A 版本, B 版本]
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !configId) return;
    setLoading(true);
    inner.listVersions(configId)
      .then((r) => {
        const list = r.data || [];
        setVersions(list);
        if (list.length >= 2) setSel([list[0], list[1]]); // 默认最近两版
        else setSel([list[0] || null, null]);
        setLoading(false);
      })
      .catch(() => { setLoading(false); toast("版本列表加载失败", "err"); });
  }, [open, configId]);

  if (!open) return null;
  const v0 = sel[0], v1 = sel[1];
  const rows = (v0 && v1) ? diffLines(v0.content, v1.content) : [];
  const delN = rows.filter((r) => r.t === "del").length;
  const addN = rows.filter((r) => r.t === "add").length;

  return (
    <div className="ops-modal-mask" onClick={onClose}>
      <div className="ops-modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>版本对比</h3>
        {loading ? <div className="empty-hint">加载中…</div> : versions.length === 0 ? (
          <div className="empty-hint">暂无版本记录。修改配置后点击工具栏「保存」，即可生成一个版本快照。</div>
        ) : (
          <>
            <div className="ver-sel" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <span className="mir-arrow">对比</span>
              <select className="mir-sel" value={v0 ? v0.id : ""}
                onChange={(e) => setSel([versions.find((v) => v.id === Number(e.target.value)), sel[1]])}>
                {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {fmtTime(v.created_at)}</option>)}
              </select>
              <span className="mir-arrow">与</span>
              <select className="mir-sel" value={v1 ? v1.id : ""}
                onChange={(e) => setSel([sel[0], versions.find((v) => v.id === Number(e.target.value))])}>
                {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {fmtTime(v.created_at)}</option>)}
              </select>
            </div>
            <div className="ver-stat" style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 11, color: "var(--text-ter)" }}>
              <span>删除 {delN} 行</span><span>新增 {addN} 行</span><span>共 {rows.length} 行</span>
            </div>
            <div className="ver-diff" style={{ maxHeight: 340, overflowY: "auto", border: "1px solid var(--border-soft)", borderRadius: 6, background: "var(--bg-deep2)", fontFamily: "var(--mono)", fontSize: 12 }}>
              {rows.map((r, i) => (
                <div key={i} className={`dif-row ${r.t}`} style={{ display: "flex", gap: 8, padding: "1px 8px", lineHeight: 1.6 }}>
                  <span className="dif-no" style={{ width: 30, flex: "none", color: "var(--text-ter)", userSelect: "none" }}>{r.t === "del" ? (r.no ? r.no[0] : "") : r.t === "add" ? "" : (r.no ? r.no[0] : "")}</span>
                  <span className="dif-mk" style={{ width: 14, flex: "none", color: "var(--text-ter)", userSelect: "none" }}>{r.t === "del" ? "−" : r.t === "add" ? "+" : " "}</span>
                  <span className="dif-tx">{r.t === "del" ? (r.a ?? "") : r.t === "add" ? (r.b ?? "") : (r.a ?? "")}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="modal-actions"><button className="btn primary" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}

/* ---------- 块管理页（方案C 主从：左list监听点 + 右detail 块树/预览 tab） ---------- */
export default function BlockPage() {
  const ops = useOps();
  const { tree, toast, selected, setSelected } = ops;
  const [tab, setTab] = useState("tree");
  const [showAdd, setShowAdd] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showMirror, setShowMirror] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showPush, setShowPush] = useState(false);

  const root = tree[0];
  const servers = (root?.children || []).filter((n) => n.scope === "server");

  // 「保存」= 把当前配置渲染文本（SSL 开启）存为一个版本快照
  const saveVersion = () => {
    const cfgId = ops.configId;
    if (!cfgId || !tree[0]) { toast("暂无配置可保存", "warn"); return; }
    const text = lib.exportConfigText(tree, { sslOn: true });
    inner.createVersion(cfgId, { content: text })
      .then((r) => toast(`已保存版本 v${r.data.version}`, "ok"))
      .catch((e) => toast("保存版本失败：" + (e.response?.data?.detail || "未知错误"), "err"));
  };

  // 域名映射 / 转发规则（并入块管理页子页）
  const [dms, setDms] = useState([]);
  const [fps, setFps] = useState([]);
  useEffect(() => {
    if (!ops.configId) return;
    nginx.listDomainMappings(ops.configId).then((r) => setDms(r.data)).catch(() => {});
    nginx.listForwardPorts(ops.configId).then((r) => setFps(r.data)).catch(() => {});
  }, [ops.configId]);

  const previewHtml = useMemo(() => {
    if (!root) return "";
    return lib.renderPreviewHtml(root);
  }, [tree]);

  const pickServer = (s) => {
    setSelected(s);
    setTab("tree");
  };

  return (
    <div className="split" style={{ flex: 1, minHeight: 0 }}>
      {/* 左：监听点列表（方案C 对齐 mock listenList） */}
      <div className="list-panel">
        <div className="lp-head">监听点 · server ({servers.length})</div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {servers.map((b) => {
            const port = lib.listenPlain(b);
            const locs = b.children.filter((c) => c.scope === "location").length;
            return (
              <div key={b._id} className={`lp-row${selected && selected._id === b._id ? " on" : ""}`} onClick={() => pickServer(b)}>
                <span className="mono" style={{ color: "var(--brand)", fontWeight: 600 }}>{port}</span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                  <span className="cnt" style={{ fontSize: 10, color: "var(--text-ter)", fontFamily: "var(--mono)" }}>{locs}</span>
                  <span className="tag2 pub">公网</span>
                </span>
              </div>
            );
          })}
          {servers.length === 0 && (
            <div className="empty-hint">
              <div>该上下文无 server 块</div>
              <button className="btn mini" style={{ marginTop: 8 }} onClick={() => ops.loadTree(ops.configId, ops.ctx)}>重新加载</button>
            </div>
          )}
        </div>
      </div>

      {/* 右：detail（操作按钮 + 块树/预览 tab） */}
      <div className="detail-panel">
        <StatBanner />
        <div className="toolbar">
          <span className="file mono" style={{ fontSize: 12 }}>{lib.getFileName()}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => setShowAdd(true)}>＋ 块</button>
          <span className="tb-sep" />
          <button className="btn" onClick={() => setShowExport(true)}>导出配置</button>
          <button className="btn" title="本地配置推送：上传 conf 预览差异后提交" onClick={() => setShowPush(true)}>推送配置</button>
          <span className="tb-sep" />
          <button className="btn" title="配置镜像对：两个监听点内容保持一致" onClick={() => setShowMirror(true)}>镜像设置</button>
          <button className="btn" title="查看配置历史版本并对比差异" onClick={() => setShowVersions(true)}>版本对比</button>
          <button className="btn" title="从服务端重载最新配置" onClick={() => { ops.loadTree(ops.configId, ops.ctx); toast("已刷新最新配置", "ok"); }}>刷新</button>
          <span className="tb-sep" />
          <button className="btn primary" title="把当前配置渲染文本存为一个版本" onClick={() => saveVersion()}>保存</button>
        </div>
        <div className="dtabs">
          <div className={`dtab${tab === "tree" ? " on" : ""}`} title="块树（嵌套）" onClick={() => setTab("tree")}>块树（嵌套）<span className="n" style={{ fontSize: 9, color: "var(--text-ter)", marginLeft: 6, fontFamily: "var(--mono)" }}>{tree.length ? treeNodeCount(tree) : ""}</span></div>
          <div className={`dtab${tab === "preview" ? " on" : ""}`} title="配置预览" onClick={() => setTab("preview")}>配置预览</div>
          <div className={`dtab${tab === "domain" ? " on" : ""}`} title="域名映射" onClick={() => setTab("domain")}>域名映射</div>
          <div className={`dtab${tab === "forward" ? " on" : ""}`} title="转发规则" onClick={() => setTab("forward")}>转发规则</div>
        </div>
        <div className="ops-scroll" style={{ padding: "12px 16px" }}>
          {tab === "tree" && <BlockTree fullEdit />}
          {tab === "preview" && (
            <div className="preview-wrap">
              <pre className="pv" style={{ flex: 1, overflow: "auto", margin: 0, padding: "14px 16px", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.55, color: "var(--text-pri)" }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          )}
          {tab === "domain" && <DomMapPanel dms={dms} industryId={ops.configId} />}
          {tab === "forward" && <ForwardPanel fps={fps} industryId={ops.configId} />}
        </div>
      </div>
      <AddBlockModal open={showAdd} onClose={() => setShowAdd(false)} onAdded={() => ops.loadTree(ops.configId, ops.ctx)} />
      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
      <MirrorModal open={showMirror} onClose={() => setShowMirror(false)} />
      <VersionModal open={showVersions} onClose={() => setShowVersions(false)} />
      <PushModal open={showPush} onClose={() => setShowPush(false)} />
    </div>
  );
}