import { useEffect, useMemo, useState } from "react";
import { useOps } from "./OpsContext";
import * as lib from "../../lib/nginx-inner";
import * as nginx from "../../api/nginx";
import * as inner from "../../api/nginxInner";

/* ---------- KV 行编辑器（用于块树 Tab / 块管理） ---------- */
export function KvListEditor({ block, onPersist }) {
  const ops = useOps();
  const { toast } = ops;
  const [directives, setDirectives] = useState([]);

  useEffect(() => {
    inner.listDirectives().then((r) => setDirectives(r.data)).catch(() => {});
  }, []);

  // 原地变更（增/删/交换）后数组引用不变，不能 useMemo，否则列表不刷新
  const optionsWith = lib.orderedOptions(block);

  const move = (o, dir) => {
    const arr = block.options;
    const i = arr.indexOf(o), j = i + dir;
    if (j < 0 || j >= arr.length) return;
    if (o.directive === "default") return; // default 不可移动
    [arr[i], arr[j]] = [arr[j], arr[i]]; // 交换位置
    lib.setTree(lib.getTree());
    // 重排后落库
    const ids = arr.map((x) => x.id).filter(Boolean);
    if (ids.length > 1) {
      inner.reorderOptions(block.id, ids).then(() => toast("顺序已保存", "ok")).catch(() => toast("重排保存失败", "err"));
    }
    onPersist && onPersist();
  };

  /* 提交（新增/编辑统一入口，对齐 mock：单次提交，避免重复 createOption）
   * onPersist 必须在持久化 API 成功后再调用：若同步提前触发镜像同步，
   * mirror 复制的是旧 DB 状态（PUT 尚未生效），会造成 443/20551 竞态不一致。 */
  const commitKV = (o, d, v) => {
    o.directive = (d || "").trim();
    o.value = (v || "").trim();
    o.raw = o.directive + (o.value ? " " + o.value : "");
    if (o.is_free_text || o.row_type === "raw") o.raw = o.directive;
    lib.setTree(lib.getTree());
    if (o.id) {
      inner.updateOption(o.id, { directive: o.directive, value: o.value })
        .then(() => { onPersist && onPersist(); toast("已保存", "ok"); })
        .catch(() => toast("保存失败", "err"));
    } else if (o._new) {
      inner.createOption({ block_id: block.id, directive: o.directive, value: o.value, row_type: o.row_type || "kv" })
        .then((r) => { o.id = r.data.id; o._new = false; lib.setTree(lib.getTree()); onPersist && onPersist(); toast("已保存", "ok"); })
        .catch(() => toast("新增 KV 保存失败", "err"));
    } else {
      onPersist && onPersist();
    }
  };

  const removeKV = (o) => {
    const removeLocal = () => {
      block.options = block.options.filter((x) => x !== o);
      lib.setTree(lib.getTree());
      onPersist && onPersist();
      toast("已删除", "ok");
    };
    if (o.id) inner.deleteOption(o.id).then(removeLocal).catch(removeLocal);
    else removeLocal();
  };

  const addKV = () => {
    block.options.push({ directive: "", value: "", raw: "", _new: true });
    lib.setTree(lib.getTree());
    onPersist && onPersist();
    toast("已新增 KV，编辑指令名与值后回车生效", "ok");
  };

  return (
    <div className="t-body">
      <datalist id="directives-dl">
        {directives.map((x) => <option key={x.name} value={x.name}>{x.description}</option>)}
      </datalist>
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
          onCommit={(d, v) => commitKV(o, d, v)}
          onRemove={() => removeKV(o)}
          canMoveDefault={o.directive !== "default"}
        />
      ))}
      <button className="kv-add" onClick={addKV}>＋ KV</button>
    </div>
  );
}

export function KvRow({ o, directives, isDefault, isComment, first, last, onMove, onCommit, onRemove, canMoveDefault }) {
  // mock 对齐：新增行直接进入行内编辑（两个输入框），回车/失焦提交生效
  const [editing, setEditing] = useState(o._new === true);
  const [d, setD] = useState(o.directive);
  const [v, setV] = useState(o.value);

  if (isComment) {
    return <div className="kv-row cm" title={o.value || o.directive}><span className="raw"># {o.value || o.directive}</span></div>;
  }
  const display = lib.rawText(o);
  if (editing) {
    const doCommit = () => {
      if (o._new && !String(d).trim()) return; // 新增行指令名不能为空，留待继续编辑
      onCommit(d, v);
      setEditing(false);
    };
    return (
      <div className="kv-row kv-new">
        <input className="kv-edit-inline" list="directives-dl" value={d} autoFocus={!!o._new}
          onChange={(e) => setD(e.target.value)} placeholder="指令名"
          onKeyDown={(e) => { if (e.key === "Enter") doCommit(); }} />
        <input className="kv-edit-inline" value={v} onChange={(e) => setV(e.target.value)}
          placeholder="值（可含参数，如 /api/ 或 http://…）"
          onKeyDown={(e) => { if (e.key === "Enter") doCommit(); }} />
        <button className="t-op" title="保存" onClick={() => { doCommit(); }}>✓</button>
        {!o._new && <button className="t-op" title="取消" onClick={() => { setD(o.directive); setV(o.value); setEditing(false); }}>✕</button>}
      </div>
    );
  }
  return (
    <div className={`kv-row${isDefault ? " is-def" : ""}`} onClick={() => setEditing(true)} title="点击编辑">
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
  const { tree, selected, setSelected, toast, configId, ctx, loadTree, syncMirrorsNow } = ops;
  const sel = selected;
  const root = tree[0];
  const vis = useMemo(() => lib.buildTree(tree, sel), [tree, sel]);
  // 树对象为原地变更，浅拷贝数组生成新引用即可触发 React 重渲染；编辑提交后自动触发镜像同步
  const persist = () => {
    ops.setTree([...(ops.tree || [])]);
    syncMirrorsNow && syncMirrorsNow();
  };

  if (!vis[0]) {
    return (
      <div className="empty-hint" style={{ padding: "40px 20px", color: "var(--text-ter)", fontSize: 12.5 }}>
        <div>暂无块树</div>
        <div style={{ marginTop: 6, fontSize: 11.5 }}>配置为空或加载失败，可重试加载，或在右上角「＋ 块」新增</div>
        <button className="btn mini" style={{ marginTop: 12 }} onClick={() => loadTree && loadTree(configId, ctx)}>重新加载</button>
      </div>
    );
  }

  return (
    <div className="tree-col" style={{ maxHeight: "100%", overflowY: "auto" }}>
      <TreeNode
        node={vis[0]}
        root
        sel={sel}
        onPick={setSelected}
        onPersist={persist}
        kind={fullEdit ? "edit" : "view"}
        toast={toast}
      />
    </div>
  );
}

function TreeNode({ node, root, sel, onPick, onPersist, kind, toast, depth, first, last, onMove }) {
  const ops = useOps();
  const [expanded, setExpanded] = useState(true);
  const [addOpen, setAddOpen] = useState(false); // ＋子块 下拉菜单
  const [editingHeader, setEditingHeader] = useState(false);
  const [hdr, setHdr] = useState(node.header);

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

  /* 块头改名（mock：双击标题行内编辑，回车/失焦提交） */
  const commitHeader = () => {
    const h = (hdr || "").trim();
    setEditingHeader(false);
    if (!h || h === node.ref.header) return;
    node.ref.header = h;
    lib.setTree(lib.getTree());
    if (node.ref.id) {
      inner.updateBlock(node.ref.id, { header: h })
        .then(() => { onPersist && onPersist(); toast("已改名", "ok"); })
        .catch(() => toast("改名失败", "err"));
    } else {
      onPersist && onPersist();
    }
  };

  /* 同级块重排（▲/▼）：在真实 children 数组内交换并落库 sort_order */
  const moveChild = (c, dir) => {
    const arr = node.ref.children;
    const i = arr.indexOf(c.ref), j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    lib.setTree(lib.getTree());
    const ids = arr.map((x) => x.id).filter(Boolean);
    if (ids.length > 1) {
      inner.reorderBlocks(node.ref.id, ids)
        .then(() => { onPersist && onPersist(); toast("顺序已保存", "ok"); })
        .catch(() => toast("重排保存失败", "err"));
    } else {
      onPersist && onPersist();
    }
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

  /* 注释节点：渲染为纯注释行（非块卡片，无 +KV 容器），与兄弟块按 sort_order 交错保住文件位置 */
  if (node.scope === "comment") {
    return (
      <div style={{ marginLeft: root ? 0 : 18 }}>
        <div className="kv-row cm" title={node.header}><span className="raw"># {node.header}</span></div>
      </div>
    );
  }

  const isSel = sel && sel._id === node.ref._id;

  return (
    <div style={{ marginLeft: root ? 0 : 18 }}>
      <div className={`t-card${isSel ? " on" : ""}${node.ref._new ? " is-new" : ""}`} onClick={() => onPick(node.ref)}>
        <div className="t-head">
          <button className="t-op" style={{ width: 18 }} onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}>{expanded ? "▾" : "▸"}</button>
          <span className={`bkind ${node.kind}`}>{node.scope}</span>
          {editingHeader ? (
            <input className="hdr-edit" autoFocus value={hdr} onChange={(e) => setHdr(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => commitHeader()}
              onKeyDown={(e) => { if (e.key === "Enter") commitHeader(); if (e.key === "Escape") { setHdr(node.header); setEditingHeader(false); } }} />
          ) : (
            <span className="hdr" title="双击改名" onDoubleClick={(e) => { e.stopPropagation(); setHdr(node.header); setEditingHeader(true); }}>{node.header}</span>
          )}
          <span className="t-actions">
            {kind === "edit" && ["server", "location", "if"].includes(node.scope) && (
              <span className="add-wrap">
                <button className="t-edit" onClick={(e) => { e.stopPropagation(); setAddOpen(!addOpen); }}>＋子块 ▾</button>
                {addOpen && (
                  <span className="sub-menu" onClick={(e) => e.stopPropagation()}>
                    {["location", "if", "limit_except"].map((tp) => (
                      <button key={tp} className="sub-it" onClick={() => { setAddOpen(false); handleAddChild(tp); }}>{tp}</button>
                    ))}
                  </span>
                )}
              </span>
            )}
            {kind === "edit" && !root && typeof onMove === "function" && (
              <>
                <button className="t-edit" title="上移" disabled={first} onClick={(e) => { e.stopPropagation(); onMove(-1); }}>▲</button>
                <button className="t-edit" title="下移" disabled={last} onClick={(e) => { e.stopPropagation(); onMove(1); }}>▼</button>
              </>
            )}
            {kind === "edit" && !root && (
              <button className="t-edit" style={{ color: "#ef4444" }} onClick={(e) => { e.stopPropagation(); handleDeleteBlock(); }}>✕</button>
            )}
          </span>
        </div>
        {expanded && <KvListEditor block={node.ref} onPersist={onPersist} />}
        {expanded && node.children && node.children.length > 0 && (
          <div className="t-body">
            {node.children.map((c, ci) => (
              <TreeNode key={c.ref._id} node={c} root={false} sel={sel} onPick={onPick} onPersist={onPersist} kind={kind} toast={toast} depth={(depth || 0) + 1}
                first={ci === 0} last={ci === node.children.length - 1} onMove={(dir) => moveChild(c, dir)} />
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

/* ---------- 域名映射 ---------- */
export function DomMapPanel({ dms, industryId }) {
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
export function ForwardPanel({ fps, industryId }) {
  const { toast } = useOps();
  return (
    <div>
      <div style={{ marginBottom: 10 }} className="chain-label">转发规则（转发端口 → 目标）</div>
      <table className="ov-tbl">
        <thead><tr><th>监听端口</th><th>目标</th><th>类型</th><th>启用</th></tr></thead>
        <tbody>
          {(fps || []).map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.listen_port}</td>
              <td className="mono" style={{ color: "var(--text-sec)" }}>{r.upstream_target || r.target || "—"}</td>
              <td><span className="tag2 pub">{r.is_public ? "公网" : "内网"}</span></td>
              <td>{r.enabled ? <span className="status-dot ok" /> : <span className="status-dot" style={{ background: "var(--text-ter)" }} />}</td>
            </tr>
          ))}
          {!fps.length && <tr><td colSpan={4} className="empty-hint">暂无转发规则</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
