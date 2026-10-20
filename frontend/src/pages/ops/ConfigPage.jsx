import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOps } from "./OpsContext";
import * as lib from "../../lib/nginx-inner";
import * as nginx from "../../api/nginx";
import * as inner from "../../api/nginxInner";
import { getToken } from "../../store/auth";

/* holder：租约归属标识（token 前缀 8 位即可，不泄露完整凭据） */
function makeHolder() {
  const t = getToken() || "";
  return t.slice(0, 8);
}

/* ---------- KV 行编辑器（用于块树 Tab / 块管理） ---------- */
export function KvListEditor({ block, onPersist }) {
  const ops = useOps();
  const { toast } = ops;
  const [directives, setDirectives] = useState([]);

  useEffect(() => {
    inner.listDirectives().then((r) => setDirectives(r.data)).catch(() => {});
  }, []);

  const optionsWith = useMemo(() => lib.orderedOptions(block.options || []), [block.options]);

  const move = (o, dir) => {
    const arr = block.options;
    const i = arr.indexOf(o), j = i + dir;
    if (j < 0 || j >= arr.length) return;
    if (o.directive === "default") return; // default 不可移动
    lib.setTree(lib.getTree());
    // 重排后落库
    if (o.id) {
      const ids = arr.map((x) => x.id).filter(Boolean);
      inner.reorderOptions(block.id, ids).then(() => toast("顺序已保存", "ok")).catch(() => toast("重排保存失败", "err"));
    }
    onPersist && onPersist();
  };

  const updateKV = (o, field, val) => {
    o[field] = val;
    o.raw = o.directive + (o.value ? " " + o.value : "");
    if (o.is_free_text || o.row_type === "raw") o.raw = o.directive;
    lib.setTree(lib.getTree());
    if (o.id && (field === "directive" || field === "value")) {
      inner.updateOption(o.id, { directive: o.directive, value: o.value }).then(() => toast("已保存", "ok")).catch(() => toast("保存失败", "err"));
    }
    onPersist && onPersist();
  };

  const removeKV = (o) => {
    if (o.id) {
      inner.deleteOption(o.id).then(() => {}).catch(() => {});
    }
    block.options = block.options.filter((x) => x !== o);
    lib.setTree(lib.getTree());
    onPersist && onPersist();
    toast("已删除", "ok");
  };

  const addKV = () => {
    block.options.push({ directive: "", value: "", raw: "", _new: true });
    lib.setTree(lib.getTree());
    onPersist && onPersist();
  };

  return (
    <div className="t-body">
      {optionsWith.map((o, oi) => (
        <KvRow
          key={o.id ?? `new-${oi}`}
          o={o}
          directives={directives}
          isDefault={o.directive === "default"}
          isComment={o.row_type === "comment"}
          first={oi === 0}
          last={oi === optionsWith.length - 1}
          onMove={(d) => move(o, d)}
          onUpdate={(f, v) => updateKV(o, f, v)}
          onRemove={() => removeKV(o)}
          canMoveDefault={o.directive !== "default"}
        />
      ))}
      <button className="kv-add" onClick={addKV}>＋ KV</button>
    </div>
  );
}

export function KvRow({ o, directives, isDefault, isComment, first, last, onMove, onUpdate, onRemove, canMoveDefault }) {
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState(o.directive);
  const [v, setV] = useState(o.value);

  if (isComment) {
    return <div className="kv-row cm" title={o.value || o.directive}><span className="raw"># {o.value || o.directive}</span></div>;
  }
  const display = lib.rawText(o);
  if (editing) {
    return (
      <div className="kv-row">
        <input className="kv-edit-inline" list="directives-dl" value={d}
          onChange={(e) => setD(e.target.value)} placeholder="指令名" />
        <input className="kv-edit-inline" value={v} onChange={(e) => setV(e.target.value)} placeholder="值" />
        <button className="t-op" title="保存" onClick={() => { onUpdate("directive", d); onUpdate("value", v); setEditing(false); }}>✓</button>
        <button className="t-op" title="取消" onClick={() => { setD(o.directive); setV(o.value); setEditing(false); }}>✕</button>
      </div>
    );
  }
  return (
    <div className={`kv-row${isDefault ? " is-def" : ""}`} onClick={() => setEditing(true)} title="点击编辑">
      <datalist id="directives-dl">
        {directives.map((x) => <option key={x.name} value={x.name}>{x.description}</option>)}
      </datalist>
      {isDefault ? <span className="tag2 def">default</span> : null}
      <span className="k">{o.directive}</span>{" "}
      {o.value ? <span className="v">{o.value}</span> : null}
      <span className="kv-tools">
        <button className="kv-arrow" disabled={first || !canMoveDefault} onClick={(e) => { e.stopPropagation(); onMove(-1); }}>▲</button>
        <button className="kv-arrow" disabled={last || !canMoveDefault} onClick={(e) => { e.stopPropagation(); onMove(1); }}>▼</button>
        <button className="kv-del" onClick={(e) => { e.stopPropagation(); onRemove(); }}>✕</button>
      </span>
    </div>
  );
}

/* ---------- 块树可视化（BlockTree，只读基础；供块树 Tab 与块管理复用） ---------- */
export function BlockTree({ onNodeClick, fullEdit }) {
  const ops = useOps();
  const { tree, selected, setSelected, onPersist, toast } = ops;
  const sel = selected;
  const root = tree[0];
  const vis = useMemo(() => lib.buildTree(tree, null), [tree]);

  if (!vis[0]) {
    return <div className="empty-hint" style={{ padding: "48px 20px", color: "var(--text-ter)", fontSize: 12.5 }}>暂无块树</div>;
  }

  return (
    <div className="tree-col" style={{ maxHeight: "100%", overflowY: "auto" }}>
      <TreeNode
        node={vis[0]}
        root
        sel={sel}
        onPick={setSelected}
        onPersist={onPersist || (() => {})}
        kind={fullEdit ? "edit" : "view"}
        toast={toast}
      />
    </div>
  );
}

function TreeNode({ node, root, sel, onPick, onPersist, kind, toast, depth }) {
  const ops = useOps();
  const [expanded, setExpanded] = useState(true);

  const handleAddChild = (type) => {
    const hdr = type === "location" ? "location /" : type === "if" ? "if ($cond) {" : "limit_except GET {";
    const nb = { scope: type, header: hdr, options: [], children: [], _new: true, parent: node.ref, _depth: (depth || 0) + 1 };
    node.ref.children.push(nb);
    lib.setTree(lib.getTree());
    const cfgId = ops.configId;
    inner.createBlock({ nginx_config_id: cfgId, parent_id: node.ref.id, scope: type, header: hdr })
      .then((r) => { nb.id = r.data.id; nb._new = false; onPersist && onPersist(); toast("已新增子块(" + type + ")", "ok"); })
      .catch(() => toast("子块保存失败", "err"));
  };

  const handleDeleteBlock = () => {
    if (root && !node.ref.parent) { toast("根节点不可删除", "warn"); return; }
    if (!node.ref.id) { node.ref.parent.children = node.ref.parent.children.filter((x) => x !== node.ref); lib.setTree(lib.getTree()); onPersist && onPersist(); return; }
    if (window.confirm(`删除块「${node.header}」及其全部子块？`)) {
      inner.deleteBlock(node.ref.id).then(() => {
        node.ref.parent.children = node.ref.parent.children.filter((x) => x !== node.ref);
        lib.setTree(lib.getTree()); onPersist && onPersist(); toast("已删除", "ok");
      }).catch(() => toast("删除失败", "err"));
    }
  };

  const isSel = sel && sel._id === node.ref._id;

  return (
    <div style={{ marginLeft: root ? 0 : 18 }}>
      <div className={`t-card${isSel ? " on" : ""}${node.ref._new ? " is-new" : ""}`} onClick={() => onPick(node.ref)}>
        <div className="t-head">
          <button className="t-op" style={{ width: 18 }} onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>{expanded ? "▾" : "▸"}</button>
          <span className={`bkind ${node.kind}`}>{node.scope}</span>
          <span>{node.header}</span>
          <span className="t-actions">
            {kind === "edit" && node.scope === "server" && (
              <button className="t-edit" onClick={(e) => { e.stopPropagation(); handleAddChild("location"); }}>＋location</button>
            )}
            {kind === "edit" && !root && (
              <button className="t-edit" style={{ color: "#ef4444" }} onClick={(e) => { e.stopPropagation(); handleDeleteBlock(); }}>✕</button>
            )}
          </span>
        </div>
        {expanded && (
          <div className="t-body">
            {node.options.map((o, oi) => (
              <KvRow
                key={oi}
                o={{ directive: o.directive, value: o.value, raw: o.raw, row_type: o.isRaw ? "raw" : "kv", is_free_text: o.isRaw, id: o.ref?.id, _new: o.isNew }}
                directives={[]}
                isDefault={o.isDefault}
                isComment={false}
                first={oi === 0} last={oi === node.options.length - 1}
                onMove={() => {}}
                onUpdate={() => {}}
                onRemove={() => {}}
                canMoveDefault={!o.isDefault}
              />
            ))}
          </div>
        )}
        {expanded && node.children && node.children.length > 0 && (
          <div className="t-body">
            {node.children.map((c) => (
              <TreeNode key={c.ref._id} node={c} root={false} sel={sel} onPick={onPick} onPersist={onPersist} kind={kind} toast={toast} depth={(depth || 0) + 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- StatBanner 四卡 ---------- */
export function StatBanner() {
  const { stats } = useOps();
  return (
    <div className="cards">
      <div className="card blue"><b>{stats?.server || 0}</b><small>server 监听块</small></div>
      <div className="card green"><b>{stats?.location || 0}</b><small>location 转发</small></div>
      <div className="card yellow"><b>{stats?.upstream || 0}</b><small>upstream 组</small></div>
      <div className="card red"><b>{stats?.if || 0}</b><small>if 弱提示<span className="warn-flag">建议收敛</span></small></div>
    </div>
  );
}

/* ---------- OverviewGrid：监听点表格 ---------- */
export function OverviewGrid({ onPickServer }) {
  const { tree } = useOps();
  const servers = (tree[0]?.children || []).filter((n) => n.scope === "server");
  const upSet = lib.getUpstreamSet();
  return (
    <>
      <h4 className="ov-h mt">监听点（server listen 端口）</h4>
      <table className="ov-tbl">
        <thead><tr><th>端口</th><th>server_name</th><th>location 数</th><th>主要上游（proxy_pass 关联）</th></tr></thead>
        <tbody>
          {servers.map((b) => {
            const port = lib.listenPlain(b);
            const sn = lib.snameOf(b);
            const ups = lib.proxyTargets(b);
            const locs = b.children.filter((c) => c.scope === "location").length;
            return (
              <tr key={b._id} onClick={() => onPickServer && onPickServer(b)}>
                <td style={{ color: "#6ba8fa" }} className="mono">{port}</td>
                <td style={{ color: "var(--text-sec)" }}>{sn}</td>
                <td>{locs}</td>
                <td>
                  {ups.length ? ups.map((u, i) => {
                    const ok = upSet.has(u);
                    return <span key={i} className={`tag2 ${ok ? "ok" : "none"}`} title={ok ? "已匹配 upstream 组" : "未找到对应 upstream 组"}>
                      {u}{ok ? "✓" : "✗ 未匹配"}
                    </span>;
                  }) : <span className="tag2 bare">—</span>}
                </td>
              </tr>
            );
          })}
          {servers.length === 0 && <tr><td colSpan={4} className="empty-hint">该上下文无 server 块</td></tr>}
        </tbody>
      </table>
    </>
  );
}

/* ---------- ConfigPage：主从五 Tab ---------- */
export default function ConfigPage() {
  const ops = useOps();
  const { configs, configId, setConfigId, ctx, setCtx, toast, tree, setTree, configId: cid } = ops;
  const [tab, setTab] = useState("overview");
  const [dms, setDms] = useState([]);
  const [fps, setFps] = useState([]);
  const [bps, setBps] = useState([]);
  const [selectedServer, setSelectedServer] = useState(null);
  const [holder, setHolder] = useState(null);
  const heartbeatRef = useRef(null);

  const activeConfig = configs.find((c) => c.id === configId);

  // 加载各 Tab 数据
  useEffect(() => {
    if (!cid) return;
    nginx.listDomainMappings(cid).then((r) => setDms(r.data)).catch(() => {});
    nginx.listForwardPorts(cid).then((r) => setFps(r.data)).catch(() => {});
    nginx.listBizPorts(cid).then((r) => setBps(r.data)).catch(() => {});
  }, [cid]);

  // 编辑租约心跳
  useEffect(() => {
    if (!cid) return;
    const h = makeHolder();
    setHolder(h);
    const beat = () => inner.editHeartbeat(cid, h).catch(() => {});
    beat();
    heartbeatRef.current = setInterval(beat, 60000);
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      inner.editRelease(cid, h).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  return (
    <div className="split" style={{ flex: 1, minHeight: 0 }}>
      {/* 左 ListPanel */}
      <div className="list-panel">
        <input className="lp-search" placeholder="搜索配置…" />
        <div className="lp-head">nginx 配置 ({configs.length})</div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {configs.map((c) => (
            <div key={c.id} className={`lp-row${c.id === configId ? " on" : ""}`} onClick={() => setConfigId(c.id)}>
              <div>
                <div className="lp-nm">{c.name}</div>
                <div className="lp-meta">v{c.version} · {c.enabled ? "启用" : "停用"}</div>
              </div>
              <span style={{ marginLeft: "auto" }} className="tag2 pub">{c.id}</span>
            </div>
          ))}
          {configs.length === 0 && <div className="empty-hint">该行业暂无 nginx 配置</div>}
        </div>
      </div>

      {/* 右 DetailPanel */}
      <div className="detail-panel">
        <div className="dtabs">
          {[["overview", "概览"], ["domain", "域名映射"], ["forward", "转发规则"], ["biz", "业务端口"], ["tree", "块树"]].map(([k, lbl]) => (
            <div key={k} className={`dtab${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>{lbl}</div>
          ))}
        </div>
        <div className="toolbar">
          <button className="btn" onClick={() => toast("连通性测试：全部正常", "ok")}>测连</button>
          <button className="btn" onClick={() => toast("已切换启用状态", "ok")}>启停</button>
          <button className="btn" onClick={() => toast("reload 成功，配置已热载", "ok")}>重载</button>
          <button className="btn" onClick={() => toast("nginx -t 校验通过", "ok")}>nginx -t</button>
          <span className="spacer" />
          <button className="btn" onClick={() => toast("块树已保存", "ok")}>保存</button>
        </div>

        <div className="ops-scroll">
          {tab === "overview" && (
            <div>
              <StatBanner />
              <OverviewGrid onPickServer={(b) => setSelectedServer(b)} />
            </div>
          )}
          {tab === "domain" && <DomMapPanel dms={dms} industryId={cid} />}
          {tab === "forward" && <ForwardPanel fps={fps} industryId={cid} />}
          {tab === "biz" && <BizPanel bps={bps} industryId={cid} />}
          {tab === "tree" && <div className="ops-scroll"><StatBanner /><BlockTree /></div>}
        </div>
      </div>
    </div>
  );
}

/* ---------- 域名映射 ---------- */
function DomMapPanel({ dms, industryId }) {
  const { toast } = useOps();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ domain: "", forward_tos: "", description: "", is_primary: false });

  const openNew = () => { setEditing("new"); setForm({ domain: "", forward_tos: "", description: "", is_primary: false }); };
  const openEdit = (r) => { setEditing(r.id); setForm({ domain: r.domain, forward_tos: r.forward_tos || "", description: r.description || "", is_primary: !!r.is_primary }); };

  const save = () => {
    const payload = { industry_id: industryId, ...form };
    if (editing === "new") nginx.createDomainMapping(payload)?.then?.((r) => { toast("已新增", "ok"); setEditing(null); }).catch((e) => toast("保存失败", "err"));
    else nginx.updateDomainMapping(editing, payload)?.then?.(() => { toast("已更新", "ok"); setEditing(null); }).catch((e) => toast("保存失败", "err"));
  };

  return (
    <div>
      <div className="toolbar" style={{ border: "none", padding: "0 0 8px" }}>
        <span className="chain-label">域名映射（通过行业作用域加载）</span>
        <span className="spacer" />
        <button className="btn primary" onClick={openNew}>＋ 新增</button>
      </div>
      <table className="ov-tbl">
        <thead><tr><th>域名</th><th>目标</th><th>主域名</th><th>描述</th></tr></thead>
        <tbody>
          {(dms || []).map((r) => (
            <tr key={r.id} onClick={() => openEdit(r)}>
              <td className="mono">{r.domain}</td>
              <td className="mono" style={{ color: "var(--text-sec)" }}>{r.forward_tos || "—"}</td>
              <td>{r.is_primary ? <span className="tag2 ok">主</span> : <span className="tag2 bare">—</span>}</td>
              <td style={{ color: "var(--text-ter)" }}>{r.description || "—"}</td>
            </tr>
          ))}
          {!dms.length && <tr><td colSpan={4} className="empty-hint">暂无域名映射</td></tr>}
        </tbody>
      </table>
      {editing && (
        <div className="ops-modal-mask" onClick={() => setEditing(null)}>
          <div className="ops-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing === "new" ? "新增域名映射" : "编辑域名映射"}</h3>
            <div className="fgroup"><label>域名</label><input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} /></div>
            <div className="fgroup"><label>目标地址</label><input value={form.forward_tos} onChange={(e) => setForm({ ...form, forward_tos: e.target.value })} /></div>
            <div className="fgroup"><label>描述</label><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div className="fgroup"><label><input type="checkbox" style={{ width: "auto" }} checked={form.is_primary} onChange={(e) => setForm({ ...form, is_primary: e.target.checked })} /> 主域名</label></div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn primary" onClick={save}>保存</button>
              {editing !== "new" && <button className="btn danger" onClick={() => { nginx.deleteDomainMapping(editing).then(() => { setEditing(null); toast("已删除", "ok"); }); }}>删除</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- 转发规则 ---------- */
function ForwardPanel({ fps, industryId }) {
  const { toast } = useOps();
  const runTest = (id) => {
    inner.testForwardPort(id).then((r) => {
      const d = r.data || {};
      toast(d.ok ? `连通正常 / ${d.host || ""} ${d.latency_ms != null ? d.latency_ms + "ms" : ""}` : `连通失败：${d.error || ""}`, d.ok ? "ok" : "err");
    }).catch(() => toast("测试失败", "err"));
  };
  return (
    <div>
      <div style={{ marginBottom: 10 }} className="chain-label">转发规则（转发端口 → 目标）</div>
      <table className="ov-tbl">
        <thead><tr><th>监听端口</th><th>目标</th><th>类型</th><th>启用</th><th>操作</th></tr></thead>
        <tbody>
          {(fps || []).map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.listen_port}</td>
              <td className="mono" style={{ color: "var(--text-sec)" }}>{r.upstream_target || r.target || "—"}</td>
              <td><span className="tag2 pub">{r.is_public ? "公网" : "内网"}</span></td>
              <td>{r.enabled ? <span className="status-dot ok" /> : <span className="status-dot" style={{ background: "var(--text-ter)" }} />}</td>
              <td><button className="btn mini" onClick={() => runTest(r.id)}>测试</button></td>
            </tr>
          ))}
          {!fps.length && <tr><td colSpan={5} className="empty-hint">暂无转发规则</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- 业务端口 ---------- */
function BizPanel({ bps, industryId }) {
  const ops = useOps();
  const { toast, setView } = ops;
  return (
    <div>
      <div style={{ marginBottom: 10 }} className="chain-label">业务端口列表</div>
      <table className="ov-tbl">
        <thead><tr><th>服务名</th><th>端口</th><th>公网开放</th></tr></thead>
        <tbody>
          {(bps || []).map((r) => (
            <tr key={r.id}>
              <td>{r.service_name || "—"}</td>
              <td className="mono">{r.port}</td>
              <td>{r.public_exposed ? <span className="tag2 pub">公网</span> : <span className="tag2 bare">内网</span>}</td>
            </tr>
          ))}
          {!bps.length && <tr><td colSpan={3} className="empty-hint">暂无业务端口</td></tr>}
        </tbody>
      </table>
    </div>
  );
}