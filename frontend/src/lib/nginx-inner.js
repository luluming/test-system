/* 内页① 纯函数模块 —— 逐字移植 .nginx-mock/plan-c-real-conf.html，算法真源以 mock 为准。
 * 视图组件只做 JSX 渲染与 API 编排；所有解析/渲染/导出/拓扑/监听剥离/upstream 判定集中在此模块。 */

// ---- 状态（对应 mock 全局）----
let CTX = "conf"; // "conf" | "stream"
let TREE = []; // parse()/normalizeTree() 输出数组，当前活动文件树
let MIRRORS = { "443": "20551" }; // 端口对：源监听端口 : 镜像监听端口
let UPSTREAM_SET = new Set(); // 当前上下文全部 upstream 组名
let selected = null; // 当前选中节点
let allNodes = []; // walk 收集的节点池（nodesInCtx 过滤源）
let seq = 0; // _id 自增序列

const INDENT = "    ";
const FILE_NAME = {
  conf: "businesscenter_nginx_CD_master.conf",
  stream: "businesscenter_nginx_CD_master.stream",
};
let fileName = ""; // 当前配置文件名：由工作台按 configId 设置（行业间不再写死）
export function setFileName(n) { fileName = n; }
export function getFileName() { return fileName || (FILE_NAME[CTX] || FILE_NAME.conf); }

export function setCtx(c) { CTX = c; }
export function getCtx() { return CTX; }
export function setTree(t) { TREE = t; }
export function getTree() { return TREE; }
export function getMirrors() { return MIRRORS; }
/* 镜像对由后端持久化配置（nginx_mirror_pairs）；加载后覆盖默认值，空对象表示无镜像对 */
export function setMirrors(pairs) { MIRRORS = pairs || {}; }
export function setSelected(n) { selected = n; }
export function getSelected() { return selected; }
export function getUpstreamSet() { return UPSTREAM_SET; }

// ---- 基础工具（mock L996-997）----
export function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
export function qq(s) { return esc(s).replace(/"/g, "&quot;"); }

// ---- 解析（mock L900-955）----
export function scopeOf(header) {
  const w = (header || "").trim().split(/\s+/)[0];
  const map = {
    server: "server", location: "location", upstream: "upstream", map: "map", geo: "geo", if: "if",
    stream: "stream", events: "events", http: "http",
    log_format: "log_format", split_clients: "split_clients", limit_req: "limit_req", limit_conn: "limit_conn",
    limit_except: "limit_except", types: "types", include: "include",
  };
  return map[w] || null;
}

export function kvify(s) {
  const t = s.trim().replace(/;\s*$/, "");
  const i = t.indexOf(" ");
  if (i === -1) return { directive: t, value: "", raw: t };
  return { directive: t.slice(0, i).trim(), value: t.slice(i + 1).trim(), raw: t.trim() };
}

export function parse(src, rootScope) {
  /* 通用虚拟根：http / stream / events 等顶层块成为并列 children */
  const root = { scope: rootScope || "http", header: rootScope === "stream" ? "stream" : "http", children: [], options: [], parent: null, level: -1 };
  const stack = [root];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const cur = stack[stack.length - 1];
    const opens = (trimmed.match(/{/g) || []).length;
    const closes = (trimmed.match(/}/g) || []).length;
    if (opens === 0 && closes === 0 && cur) {
      if (/^#/.test(trimmed)) cur.children.push({ scope: "comment", header: trimmed.replace(/^#\s?/, ""), children: [], options: [], parent: cur });
      else cur.options.push(kvify(trimmed));
      continue;
    }
    if (opens === 0 && closes > 0) { let pops = closes; while (pops > 0 && stack.length > 1) { stack.pop(); pops--; } continue; }
    if (opens > 0) {
      const col = trimmed.indexOf("{");
      const head = (trimmed.slice(0, col) || "").trim();
      const after = trimmed.slice(col + 1).replace(/}$/, "").trim();
      const sc = scopeOf(head);
      const child = { scope: sc || "raw", header: head, children: [], options: [], parent: cur };
      cur.children.push(child);
      if (after) after.split(";").map((s) => s.trim()).filter(Boolean).forEach((s) => child.options.push(kvify(s)));
      if (closes < opens) stack.push(child);
      continue;
    }
  }
  return [root];
}

// ---- DB 树选项补 raw（对应后端 _option_dict：nginx_render.py L245-249）----
export function hydrateOption(o) {
  if (o.is_free_text === true || o.row_type === "raw") o.raw = o.directive;
  else o.raw = o.directive + (o.value ? " " + o.value : "");
  return o;
}

// ---- 遍历（mock L957-975）----
function walk(n, depth) {
  n._id = ++seq; n._depth = depth; allNodes.push(n);
  (n.children || []).forEach((c) => walk(c, depth + 1));
}

function refreshUpstreamSet() {
  UPSTREAM_SET = new Set(allNodes.filter((n) => n.scope === "upstream").map((n) => upNameOf(n)));
}

/* 把后端 /tree 返回的嵌套 blocks 结构补 parent/raw/_id，构建模块状态；返回 [root] 与 parse() 同形 */
export function normalizeTree(blocks, rootScope) {
  const root = { scope: rootScope || "http", header: rootScope === "stream" ? "stream" : "http", children: [], options: [], parent: null, level: -1 };
  const rh = rootScope === "stream" ? "stream" : "http";
  (function attach(src, parent) {
    (src || []).forEach((b) => {
      // 顶层虚拟根 KV 块（header="" 且 scope 同根、无子块）→ 并入 root.options
      if (parent === root && b.scope === rh && !b.header && !(b.children || []).length) {
        (b.options || []).forEach((o) => root.options.push(hydrateOption(o)));
        return;
      }
      const n = {
        id: b.id, scope: b.scope || "raw", header: b.header || "",
        children: [], options: (b.options || []).map(hydrateOption),
        parent, level: parent.level + 1, sort_order: b.sort_order,
      };
      parent.children.push(n);
      attach(b.children, n);
    });
  })(blocks, root);
  allNodes = [];
  seq = 0;
  root.children.forEach((n) => walk(n, 0));
  refreshUpstreamSet();
  return [root];
}

// ---- 上下文判定（mock L969-975）----
export function rootOf(n) { while (n && n.parent) n = n.parent; return n; }
export function ctxOf(n) { return (rootOf(n) || {}).scope === "stream" ? "stream" : "conf"; }
export function nodesInCtx(scopes) { return allNodes.filter((n) => scopes.indexOf(n.scope) >= 0 && ctxOf(n) === CTX); }

// ---- 统计（mock L977-995）----
export function countAll(tree) {
  const T = Array.isArray(tree) ? tree[0] : tree;
  const c = { server: 0, location: 0, upstream: 0, map: 0, if: 0, split_clients: 0, geo: 0, stream: 0, events: 0, http: 0, log_format: 0 };
  (function r(n) {
    if (n.scope === "server") c.server++; else if (n.scope === "location") c.location++; else if (n.scope === "upstream") c.upstream++;
    else if (n.scope === "map") c.map++; else if (n.scope === "if") c.if++; else if (n.scope === "split_clients") c.split_clients++;
    else if (n.scope === "geo") c.geo++; else if (n.scope === "stream") c.stream++; else if (n.scope === "events") c.events++;
    else if (n.scope === "http") c.http++; else if (n.scope === "log_format") c.log_format++;
    (n.children || []).forEach(r);
  })(T);
  return c;
}

export function treeNodeCount(tree) {
  const T = Array.isArray(tree) ? tree[0] : tree;
  let c = 0;
  (function r(n) { c++; (n.children || []).forEach(r); })(T);
  return c;
}

export function footerText(tree) {
  const c = countAll(tree);
  const parts = [];
  [["server", c.server], ["location", c.location], ["upstream", c.upstream], ["map", c.map],
   ["split_clients", c.split_clients], ["geo", c.geo], ["stream", c.stream], ["events", c.events],
   ["http", c.http], ["if", c.if]].forEach((p) => { if (p[1]) parts.push(p[1] + " " + p[0]); });
  return parts.join(" · ");
}

// ---- 辅助（mock L1007-1077）----
export function listenOf(b) {
  const vals = b.options.filter((o) => o.directive === "listen").map((o) => o.value);
  return vals.length ? vals[0].replace(/;$/, "") : "-";
}
export function snameOf(b) {
  const o = b.options.filter((o) => o.directive === "server_name");
  return o.length ? o[0].value.replace(/;$/, "") : "-";
}
export function proxyTargetsOf(b) {
  const o = b.options.filter((o) => o.directive === "proxy_pass")[0];
  return o ? String(o.value).replace(/;$/, "") : "";
}
export function proxyTargets(b) {
  const set = {}; const arr = [];
  (b.children || []).forEach((c) => {
    if (c.scope === "location") c.options.forEach((o) => {
      if (o.directive === "proxy_pass") { const h = proxyHostOf(o.value); if (h && h.kind === "name" && !set[h.host]) { set[h.host] = 1; arr.push(h.host); } }
    });
  });
  return arr;
}

// ---- KV 分类 / 排序（mock L1089-1097）----
export function isRawKV(o) { return o.is_free_text === true || (o.raw != null && o.raw.indexOf("\"") > -1) || (o.directive != null && /^[~*]/.test(o.directive)); }
export function rawText(o) { return String(o.raw != null ? o.raw : (o.directive + (o.value ? (" " + o.value) : ""))); }
export function orderedOptions(n) {
  const norm = [], def = [];
  (n.options || []).forEach((o) => { if (o.directive === "default") def.push(o); else norm.push(o); });
  return norm.concat(def);
}

// ---- R1 监听端口展示剥离（mock L1098-1103）----
export function listenPlain(b) {
  const t = String(listenOf(b)).trim();
  if (/^unix:/i.test(t)) return t;
  if (/\s/.test(t)) return t.split(/\s+/)[0];
  return t;
}
export function stripListenValue(val) {
  const t = String(val || "").trim();
  if (/^unix:/i.test(t)) return t;
  if (/\s/.test(t)) return t.split(/\s+/)[0];
  return t;
}

// ---- R2 proxy_pass 目标分类（mock L1079-1088）----
export function proxyHostOf(pv) {
  const m = String(pv || "").match(/\/\/([^\/:$]+)/);
  if (!m) return null;
  const h = m[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return { host: h, kind: "ip" };
  if (/[.\/]/.test(h)) return { host: h, kind: "domain" };
  return { host: h, kind: "name" };
}

// ---- bkind 标签（mock L1204-1211）----
export function bkindCls(scope) {
  if (scope === "server") return "srv"; if (scope === "location") return "loc"; if (scope === "map") return "map";
  if (scope === "upstream") return "up"; if (scope === "if") return "if"; if (scope === "include") return "inc";
  if (scope === "limit_except") return "lxc";
  if (scope === "split_clients") return "spl"; if (scope === "geo") return "geo"; if (scope === "stream") return "stm";
  if (scope === "events") return "evt"; if (scope === "http") return "htp"; if (scope === "log_format") return "lf";
  return "x";
}

// ---- 渲染预览（mock L1535-1557）：返回纯文本行数组 / 拼接文本 / 高亮 HTML ----
export function renderPreviewLines(node) {
  const lines = [];
  (function rb(n, depth) {
    const ind = INDENT.repeat(depth);
    if (n.scope === "comment") { lines.push("# " + n.header); return; }
    if (n.scope === "if") lines.push(ind + "# 建议少用 if");
    lines.push(ind + (n.header || "") + " {");
    const norm = [], def = [];
    n.options.forEach((o) => { if (o.directive === "default") def.push(o); else norm.push(o); });
    norm.concat(def).forEach((o) => {
      const raw = String(o.raw != null ? o.raw : (o.directive + (o.value ? (" " + o.value) : ""))).replace(/;\s*$/, "");
      if (o.row_type === "comment") { lines.push(ind + INDENT + raw); return; }
      lines.push(ind + INDENT + raw + ";");
    });
    n.children.forEach((c) => rb(c, depth + 1));
    lines.push(ind + "}");
  })(node, 0);
  return lines;
}

export function renderPreview(node) { return renderPreviewLines(node).join("\n"); }

export function renderPreviewHtml(node) {
  return renderPreviewLines(node).map((l) => {
    if (l.indexOf("default") > -1 && /-default|default /.test(l)) return "<span class='hl-default'>" + esc(l) + "</span>";
    if (l.indexOf("建议少用") > -1) return "<span class='hl-if'>" + esc(l) + "</span>";
    if (/^\s*#/.test(l)) return "<span class='cm'>" + esc(l) + "</span>";
    return esc(l);
  }).join("\n");
}

// ---- 可视树（对应 mock buildTree L1216-1369，纯数据，组件负责 JSX 渲染）----
function proxyMini(o, upSet) {
  const _h = proxyHostOf(o.value);
  if (_h && _h.kind === "name") return upSet.has(_h.host) ? { cls: "ok", text: "已匹配" } : { cls: "warn", text: "未匹配组" };
  return { cls: "", text: "直连" };
}

function buildVisualNode(n, depth, root, upSet) {
  const opts = orderedOptions(n).map((o) => ({
    ref: o,
    directive: o.directive,
    value: o.value,
    displayValue: o.directive === "listen" ? stripListenValue(o.value) : o.value,
    isDefault: o.directive === "default",
    isRaw: isRawKV(o),
    raw: rawText(o),
    mini: o.directive === "proxy_pass" ? proxyMini(o, upSet) : null,
    isNew: !!o._new,
  }));
  return {
    ref: n,
    scope: n.scope,
    header: n.header || "",
    depth,
    kind: bkindCls(n.scope),
    isRoot: n === root,
    deletable: n.parent != null,
    isIf: n.scope === "if",
    hasChildren: !!(n.children && n.children.length),
    options: opts,
    children: (n.children || []).map((c) => buildVisualNode(c, depth + 1, root, upSet)),
  };
}

/* buildTree(tree, sel)：返回以 sel（缺省为虚拟根）为树根的「可视树」数组（通用虚拟根使 http/stream/events 并列） */
export function buildTree(tree, sel) {
  const T = Array.isArray(tree) ? tree[0] : tree;
  if (!T) return [];
  const root = sel || T;
  const upSet = new Set(allUpstreamNames(T));
  return [buildVisualNode(root, 0, T, upSet)];
}

function allUpstreamNames(root) {
  const names = [];
  (function r(n) { if (n.scope === "upstream") names.push(upNameOf(n)); (n.children || []).forEach(r); })(root);
  return names;
}

// ---- 镜像同步（mock L999-1067；声明先于调用）----
export function mirrorPortOf(srv) {
  const o = (srv.options || []).filter((x) => x.directive === "listen")[0];
  return o ? String(o.value || "").replace(/;$/, "").split(/\s+/)[0] : null;
}

/* 镜像角色判定：返回 null（非镜像对）或 { role:"src"|"dst", peer: 对端端口 } */
export function mirrorInfoOf(srv) {
  const port = mirrorPortOf(srv);
  if (port == null) return null;
  if (MIRRORS[port]) return { role: "src", peer: MIRRORS[port] };
  const hit = Object.keys(MIRRORS).find((k) => MIRRORS[k] === port);
  if (hit) return { role: "dst", peer: hit };
  return null;
}

/* 结构签名（listen 端口归一化，用于镜像对差异判定） */
function sigOfNode(n) {
  const parts = [n.scope + " " + (n.header || "")];
  (n.options || []).forEach((o) => {
    if (o.directive === "listen") parts.push("listen@PORT");
    else parts.push(o.directive + "=" + String(o.value != null ? o.value : ""));
  });
  (n.children || []).forEach((c) => parts.push(sigOfNode(c)));
  return parts.join("\n");
}
export function mirrorSigOf(srv) { return sigOfNode(srv); }

function findServerByListen(port) {
  const a = TREE[0].children;
  for (let i = 0; i < a.length; i++) { if (a[i].scope === "server" && mirrorPortOf(a[i]) === port) return a[i]; }
  return null;
}

function hasPendingSub(n) {
  if (n && n._new) return true;
  return (n.children || []).some(hasPendingSub) || (n.options || []).some((o) => !!o._new);
}

function cloneOpt(o) { return { directive: o.directive, value: o.value, raw: o.raw, row_type: o.row_type, is_free_text: o.is_free_text, _new: !!o._new }; }

function cloneSub(n, parentFix) {
  const c = { scope: n.scope, header: n.header, header_src: n.header_src, _depth: n._depth, _new: !!n._new, options: (n.options || []).map(cloneOpt), children: [] };
  c._id = ++seq; c.parent = parentFix || null; allNodes.push(c);
  c.children = (n.children || []).map((k) => cloneSub(k, c));
  return c;
}

function buildMirrorServer(src, dstPort) {
  const srv = { scope: "server", header: src.header, header_src: src.header_src, _depth: 0, _new: false, options: (src.options || []).map(cloneOpt), children: [] };
  srv._id = ++seq; srv.parent = TREE[0]; allNodes.push(srv);
  srv.children = (src.children || []).map((k) => cloneSub(k, srv));
  (srv.options || []).forEach((o) => {
    if (o.directive === "listen") {
      const base = String(o.value || "").replace(/^\d{1,5}(:\d{1,5})?/, "").trim();
      o.value = dstPort + (base ? " " + base : ""); o.raw = o.directive + " " + o.value;
    }
  });
  return srv;
}

function applyMirror(dst, srv) {
  const keepPort = mirrorPortOf(dst);
  dst.header = srv.header; dst.header_src = srv.header_src;
  dst.options = (srv.options || []).map(cloneOpt);
  dst.children = (srv.children || []).map((k) => cloneSub(k, dst));
  if (keepPort) (dst.options || []).forEach((o) => {
    if (o.directive === "listen") {
      const base = String(o.value || "").replace(/^\d{1,5}(:\d{1,5})?/, "").trim();
      o.value = keepPort + (base ? " " + base : ""); o.raw = o.directive + " " + o.value;
    }
  });
}

/* 初始：确保每对镜像的目标端口 server 存在（首次加载用源 server 深克隆生成）；返回是否发生新建 */
export function initMirrors() {
  let changed = false;
  Object.keys(MIRRORS).forEach((srcPort) => {
    const dstPort = MIRRORS[srcPort];
    if (findServerByListen(dstPort)) return;
    const src = findServerByListen(srcPort); if (!src) return;
    TREE[0].children.push(buildMirrorServer(src, dstPort));
    changed = true;
  });
  if (changed) { refreshUpstreamSet(); }
  return changed;
}

/* 某次块树变更提交后调用：若 edited 属于某镜像 server，把其镜像同步为一致（非 .conf 上下文或含待编辑 _new 时跳过）；返回是否发生同步 */
export function syncMirrors(edited) {
  if (CTX !== "conf" || !edited) return false;
  let srv = edited; while (srv && srv.parent && srv.parent.parent) srv = srv.parent;
  if (!srv || srv.scope !== "server" || srv === TREE[0]) return false;
  if (hasPendingSub(srv)) return false;
  const port = mirrorPortOf(srv); if (port == null) return false;
  let dstPort = null;
  if (MIRRORS[port]) dstPort = MIRRORS[port];
  else Object.keys(MIRRORS).forEach((k) => { if (MIRRORS[k] === port) dstPort = k; });
  if (dstPort == null) return false;
  const dst = findServerByListen(dstPort); if (!dst || dst === srv) return false;
  if (hasPendingSub(dst)) return false;
  applyMirror(dst, srv);
  return true;
}

/* 编辑后重渲染钩子：同步镜像并返回 {mirrored}，供组件决定是否刷新 */
export function rebuildSelected(tree, ctx) {
  if (ctx != null) setCtx(ctx);
  return { mirrored: syncMirrors(selected) };
}

// ---- 导出中心（mock L1906-2043，适配 cfg 入参）----
export function domParse(s) { return (s || "").split(/[,\n]+/).map((e) => e.trim()).filter(Boolean); }

export function applyDomains(raw, domNew) {
  const v = (domNew || "").trim();
  if (!v) return { raw, changed: false, orig: null };
  const m = raw.replace(/;\s*$/, "").trim().match(/^server_name\s+(.+)$/);
  if (!m) return { raw, changed: false, orig: null };
  return { raw: "server_name " + v, changed: true, orig: "server_name " + m[1] };
}

export function upNameOf(n) { return (n.header || "").replace(/^upstream\s+/, "").trim(); }
export function upKeyOf(n) { return CTX + ":" + upNameOf(n); }

export function upstreamGroups(tree) {
  const T = tree || TREE;
  const root = Array.isArray(T) ? T[0] : T;
  return (root.children || []).filter((c) => c.scope === "upstream");
}

export function upNodePorts(g) {
  return g.options.filter((o) => o.directive === "server").map((o) => {
    const r = o.raw || (o.directive + (o.value ? (" " + o.value) : ""));
    const m = r.replace(/;\s*$/, "").trim().match(/^server\s+(\S+)/);
    const a = m ? m[1] : ""; const p = a.match(/:(\d+)$/);
    return p ? p[1] : "";
  });
}

export function upNodeParams(g) {
  return g.options.filter((o) => o.directive === "server").map((o) => {
    const r = o.raw || (o.directive + (o.value ? (" " + o.value) : ""));
    const m = r.replace(/;\s*$/, "").trim().match(/^server\s+(\S+)(.*)$/);
    return m ? m[2].trim() : "";
  });
}

export function upNodeRaws(g) {
  return g.options.filter((o) => o.directive === "server").map((o) => (o.raw || (o.directive + (o.value ? (" " + o.value) : ""))).replace(/;\s*$/, "").trim());
}

/* 整组替换：输入为纯 IP 列表，一个 IP = 一个节点。端口与端口后参数一律沿用该组原节点对应位置 */
export function deriveUpBackends(g, ips) {
  const ports = upNodePorts(g), params = upNodeParams(g), raws = upNodeRaws(g);
  return domParse(ips || "").map((ip, j) => {
    ip = ip.trim();
    if (!/:\d+$/.test(ip) && !/^unix:/.test(ip)) { const p = ports[j % ports.length]; if (p) ip = ip + ":" + p; }
    const prm = params[j % params.length];
    return { text: "server " + ip + (prm ? (" " + prm) : "") + ";", orig: (raws[j % raws.length] || null) };
  });
}

/* 该组用哪份 IP：先查例外（首个命中），否则回退默认；都为空则该组不替换（返回 null） */
export function ipsForGroup(k, exceptions, defaultIps) {
  for (let i = 0; i < exceptions.length; i++) { const e = exceptions[i]; if (e && e.grp === k && domParse(e.ips).length) return e.ips; }
  return defaultIps;
}

export function derivedFor(g, exceptions, defaultIps) {
  const ips = ipsForGroup(upKeyOf(g), exceptions, defaultIps);
  return domParse(ips).length ? deriveUpBackends(g, ips) : null;
}

const SSL_DROP = /^(ssl_protocols|ssl_certificate|ssl_certificate_key|ssl_session_cache|ssl_session_timeout|ssl_ciphers|ssl_prefer_server_ciphers)$/;

/* 导出渲染：逐行进结构，标明是否命中 IP/域名替换（changed/orig）。复制/下载取 change 后文本。
 * cfg = { sslOn, domNew, defaultIps, exceptions } */
export function exportLines(tree, cfg) {
  const T = Array.isArray(tree) ? tree[0] : tree;
  const sslOn = cfg.sslOn !== false;
  const domNew = cfg.domNew || "";
  const upDefaultIps = cfg.defaultIps || "";
  const upExceptions = cfg.exceptions || [];
  const out = [];
  function emit(text, changed, orig) { out.push({ text, changed: !!changed, orig: orig || null }); }
  (function walkEx(n, d) {
    const ind = INDENT.repeat(d);
    if (n.scope === "comment") { emit(ind + "# " + n.header); return; }
    if (n.scope === "if") emit(ind + "# 建议少用 if");
    emit(ind + (n.header || "") + " {");
    const body = [];
    const upRep = (n.scope === "upstream") ? derivedFor(n, upExceptions, upDefaultIps) : null;
    n.options.forEach((o) => {
      let dd = o.directive, raw = o.raw, val = o.value, isDef = false;
      if (raw == null) raw = (dd + (val ? (" " + val) : ""));
      if (upRep && dd === "server") return;
      if (!sslOn) {
        if (SSL_DROP.test(dd)) return;
        if (dd === "listen") { raw = (dd + " " + val).replace(/\bssl\b/g, " ").replace(/\s+/g, " ").trim(); }
      } else if (dd === "listen") {
        // SSL 开启时：listen 443 自动补 ssl http2（已有则不重复添加）
        const m = String(val || "").trim().match(/^(\d+)\b(.*)$/);
        if (m && m[1] === "443") {
          const parts = (m[2] || "").split(/\s+/).filter(Boolean);
          if (!parts.includes("ssl")) parts.push("ssl");
          if (!parts.includes("http2")) parts.push("http2");
          raw = "listen " + m[1] + (parts.length ? " " + parts.join(" ") : "");
        }
      }
      isDef = (dd === "default");
      const r = (dd === "server_name") ? applyDomains(raw.replace(/;\s*$/, "").trim(), domNew) : { raw: raw.replace(/;\s*$/, "").trim(), changed: false, orig: null };
      body.push({ raw: r.raw, isDefault: isDef, changed: r.changed, orig: r.orig });
    });
    const norm = body.filter((b) => !b.isDefault);
    const def = body.filter((b) => b.isDefault);
    norm.concat(def).forEach((b) => { emit(ind + INDENT + b.raw + ";", b.changed, b.orig); });
    if (upRep) { upRep.forEach((b) => { emit(ind + INDENT + b.text, true, b.orig); }); }
    n.children.forEach((c) => walkEx(c, d + 1));
    emit(ind + "}");
  })(T, 0);
  return out;
}

export function exportConfigText(tree, cfg) { return exportLines(tree, cfg).map((l) => l.text).join("\n"); }
