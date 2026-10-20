import { useEffect, useMemo, useState } from "react";
import { useOps } from "./OpsContext";
import * as lib from "../../lib/nginx-inner";
const { treeNodeCount } = lib;
import * as inner from "../../api/nginxInner";
import { BlockTree } from "./ConfigPage";
import ExportModal from "./ExportModal";

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

/* ---------- 块管理页（方案C 主从：左list监听点 + 右detail 块树/预览 tab） ---------- */
export default function BlockPage() {
  const ops = useOps();
  const { tree, toast, selected, setSelected } = ops;
  const [tab, setTab] = useState("tree");
  const [showAdd, setShowAdd] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const root = tree[0];
  const servers = (root?.children || []).filter((n) => n.scope === "server");

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
            const sn = lib.snameOf(b);
            const locs = b.children.filter((c) => c.scope === "location").length;
            return (
              <div key={b._id} className={`lp-row${selected && selected._id === b._id ? " on" : ""}`} onClick={() => pickServer(b)}>
                <span className="mono" style={{ color: "var(--brand)", fontWeight: 600 }}>{port}</span>
                <span className="mono" style={{ color: "var(--text-pri)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sn}</span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
                  <span className="cnt" style={{ fontSize: 10, color: "var(--text-ter)", fontFamily: "var(--mono)" }}>{locs}</span>
                  <span className="tag2 pub">公网</span>
                </span>
              </div>
            );
          })}
          {servers.length === 0 && <div className="empty-hint">该上下文无 server 块</div>}
        </div>
      </div>

      {/* 右：detail（操作按钮 + 块树/预览 tab） */}
      <div className="detail-panel">
        <div className="toolbar">
          <span className="file mono" style={{ fontSize: 12 }}>{lib.getFileName()}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => toast("行级操作：测连/启停/reload", "ok")}>行级操作</button>
          <button className="btn" onClick={() => setShowAdd(true)}>＋ 块</button>
          <button className="btn" onClick={() => setShowExport(true)}>导出配置</button>
          <button className="btn" onClick={() => { ops.loadTree(ops.configId, ops.ctx); toast("已同步最新配置", "ok"); }}>同步</button>
          <button className="btn primary" onClick={() => toast("已保存，配置已热载", "ok")}>保存</button>
        </div>
        <div className="dtabs">
          <div className={`dtab${tab === "tree" ? " on" : ""}`} onClick={() => setTab("tree")}>块树（嵌套）<span className="n" style={{ fontSize: 9, color: "var(--text-ter)", marginLeft: 6, fontFamily: "var(--mono)" }}>{tree.length ? treeNodeCount(tree) : ""}</span></div>
          <div className={`dtab${tab === "preview" ? " on" : ""}`} onClick={() => setTab("preview")}>配置预览</div>
        </div>
        <div className="ops-scroll" style={{ padding: "12px 16px" }}>
          {tab === "tree" ? (
            <BlockTree fullEdit />
          ) : (
            <div className="preview-wrap">
              <pre className="pv" style={{ flex: 1, overflow: "auto", margin: 0, padding: "14px 16px", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.55, color: "var(--text-pri)" }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          )}
        </div>
      </div>
      <AddBlockModal open={showAdd} onClose={() => setShowAdd(false)} onAdded={() => ops.loadTree(ops.configId, ops.ctx)} />
      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </div>
  );
}