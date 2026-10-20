import { useEffect, useMemo, useState } from "react";
import { useOps } from "./OpsContext";
import * as lib from "../../lib/nginx-inner";
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

/* ---------- 块管理页（全屏 BlockTree + 预览 + 导出） ---------- */
export default function BlockPage() {
  const ops = useOps();
  const { tree, toast } = ops;
  const [showAdd, setShowAdd] = useState(false);
  const [showExport, setShowExport] = useState(false);

  const previewHtml = useMemo(() => {
    const root = tree[0];
    if (!root) return "";
    return lib.renderPreviewHtml(root);
  }, [tree]);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="toolbar">
        <span className="chain-label">块树编辑</span>
        <button className="btn primary" onClick={() => setShowAdd(true)}>＋ 顶级块</button>
        <button className="btn" onClick={() => { ops.loadTree(ops.configId, ops.ctx); toast("已同步最新配置", "ok"); }}>同步</button>
        <span className="spacer" />
        <button className="btn" onClick={() => setShowExport(true)}>导出配置</button>
      </div>
      <div className="blockwrap">
        <BlockTree fullEdit />
        <div className="preview-col">
          <div className="pv-head">预览 · renderPreview</div>
          <pre className="pv" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </div>
      </div>
      <AddBlockModal open={showAdd} onClose={() => setShowAdd(false)} onAdded={() => ops.loadTree(ops.configId, ops.ctx)} />
      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </div>
  );
}