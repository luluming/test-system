import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "antd";
import { useNavigate, useParams } from "react-router-dom";
import { getIndustry } from "../api/industry";
import { listConfigsByIndustry, createNginxConfig } from "../api/nginx";
import { getConfigTree, deleteBlock, mirrorBlock, listMirrorPairs, createMirrorPair, deleteMirrorPair, reorderBlocks } from "../api/nginxInner";
import { OpsContext } from "./ops/OpsContext";
import "./ops/ops.css";
import "./dashboard.css";

import * as lib from "../lib/nginx-inner";

import BlockPage, { AddBlockModal } from "./ops/BlockPage";

const VIEWS = [
  { key: "block", label: "块管理", icon: "📁" },
];

/* 行内悬停操作浮层：排序（监听点 ▲▼） / 删除 */
function SideItem({ node, off, active, onSelect, onMove, onDelete, mirror }) {
  const port = lib.listenPlain(node);
  const name = node.scope === "server" ? port : lib.upNameOf(node);
  const locs = node.children.filter((c) => c.scope === "location").length;
  return (
    <div
      className={`t-item${off ? " t-off" : ""}${active ? " on" : ""}`}
      style={off ? { opacity: 0.55 } : undefined}
      title={name}
      onClick={onSelect}
    >
      <span className="t-ico">{node.scope === "server" ? "◈" : "▤"}</span>
      <span className="t-nm">{node.scope === "server" ? port : name}</span>
      {mirror && (
        <span
          className={`mir-badge ${mirror.role}${mirror.same ? "" : " diff"}`}
          title={mirror.role === "dst"
            ? `自动镜像自 ${mirror.peer}：内容由 ${mirror.peer} 同步，勿直接修改`
            : `镜像母本：${mirror.peer} 自动跟随本监听点`}
        >
          {mirror.role === "dst" ? `↻镜像 ${mirror.peer}` : "母本"}
          <i className={`dot ${mirror.same ? "same" : "diff"}`} />
        </span>
      )}
      {node.scope === "server" ? <span className="t-cnt">{locs} loc</span> : null}
      <span className="t-ops">
        {node.scope === "server" && typeof onMove === "function" && (
          <>
            <button className="t-op" title="上移（配置文件顺序）" onClick={(e) => { e.stopPropagation(); onMove(-1); }}>▲</button>
            <button className="t-op" title="下移（配置文件顺序）" onClick={(e) => { e.stopPropagation(); onMove(1); }}>▼</button>
          </>
        )}
        {onDelete && <button className="t-op del" title="删除该块" onClick={(e) => { e.stopPropagation(); onDelete(); }}>✕</button>}
      </span>
    </div>
  );
}

export default function IndustryDetail() {
  const navigate = useNavigate();
  const { industryId } = useParams();
  const id = Number(industryId);

  const [industry, setIndustry] = useState(null);
  const [configs, setConfigs] = useState([]);
  const [configId, setConfigId] = useState(null);
  const [view, setView] = useState("block");
  const [ctx, setCtxState] = useState("conf");
  const [tree, setTreeState] = useState([]);
  const [stats, setStats] = useState(null);
  const [selected, setSelected] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [highlightListen, setHighlightListen] = useState(null);
  const [exportInfo, setExportInfo] = useState({ dom: 0, up: 0 });
  const [toasts, setToasts] = useState([]);
  const [mirrorPairs, setMirrorPairs] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showCreateCfg, setShowCreateCfg] = useState(false);
  const [cfgName, setCfgName] = useState("");
  const toastSeq = useRef(0);

  const toast = useCallback((msg, type) => {
    const t = { id: ++toastSeq.current, msg, type };
    setToasts((prev) => [...prev.slice(-3), t]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 3200);
  }, []);

  // 初始加载：行业 + 配置列表
  useEffect(() => {
    (async () => {
      try {
        const [indRes, cfgRes] = await Promise.all([getIndustry(id), listConfigsByIndustry(id)]);
        setIndustry(indRes.data);
        setConfigs(cfgRes.data);
        if (cfgRes.data.length) setConfigId(cfgRes.data[0].id);
      } catch {
        toast("行业数据加载失败", "err");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 加载当前配置的块树（按上下文）
  const loadTree = useCallback(async (cid, c) => {
    if (!cid) return;
    try {
      const res = await getConfigTree(cid);
      const norm = lib.normalizeTree(res.data.blocks || [], c);
      lib.setCtx(c);
      lib.setTree(norm);
      setCtxState(c);
      setTreeState(norm);
      setStats(lib.countAll(norm));
      const kids = norm[0] ? norm[0].children : [];
      setSelected(kids.find((n) => n.scope === "server") || kids[0] || null);
    } catch {
      toast("配置树加载失败", "err");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // configId / ctx 变化时重载树
  useEffect(() => {
    const cfg = configs.find((x) => x.id === configId);
    lib.setFileName(cfg ? cfg.name : "");
    loadTree(configId, ctx);
  }, [configId, ctx, loadTree, configs]);

  // .conf ⇄ .stream 是两条独立 NginxConfig 记录：切换上下文时联动切换对应配置
  const switchCtx = (c) => {
    if (c === ctx) return;
    const target = configs.find((x) => (c === "stream") === x.name.includes(".stream"));
    if (target && target.id !== configId) setConfigId(target.id);
    setCtxState(c);
  };

  // 删除监听点 / 共性块（带确认，落库后重载树）
  const deleteSide = (node) => {
    const kind = node.scope === "server" ? "监听点" : "共性块";
    const label = node.scope === "server" ? lib.listenPlain(node) : lib.upNameOf(node);
    const bid = node.id || (node.ref && node.ref.id);
    if (!bid) { toast("该块缺少数据库 id，无法删除", "err"); return; }
    Modal.confirm({
      title: "删除确认",
      content: `确认删除该${kind}「${label}」？此操作不可恢复。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: () => deleteBlock(bid)
        .then(() => {
          if (selected && selected._id === node._id) setSelected(null);
          loadTree(configId, ctx);
          toast(`已删除${kind}「${label}」`, "ok");
        })
        .catch((e) => toast("删除失败：" + (e.response?.data?.detail || "未知错误"), "err")),
    });
  };

  // 监听点顺序调整（▲▼）：在顶层 children 中交换相邻 server，全量落库重排
  const moveSide = (node, dir) => {
    const kids = tree[0]?.children || [];
    const list = kids.filter((n) => n.scope === "server");
    const i = list.indexOf(node), j = i + dir;
    if (j < 0 || j >= list.length) return;
    const a = list[i], b = list[j];
    const ai = kids.indexOf(a), bi = kids.indexOf(b);
    [kids[ai], kids[bi]] = [kids[bi], kids[ai]];
    lib.setTree(lib.getTree());
    setTreeState([...tree]);
    const ids = kids.map((x) => x.id).filter(Boolean);
    if (ids.length < 2) return;
    reorderBlocks(null, ids)
      .then(() => { loadTree(configId, ctx); toast("监听点顺序已保存", "ok"); })
      .catch((e) => toast("顺序保存失败：" + (e.response?.data?.detail || "未知错误"), "err"));
  };

  // 刷新镜像对（后端持久化 → 模块 MIRRORS + 状态）
  const refreshMirrors = useCallback(() => {
    if (!configId) return;
    listMirrorPairs(configId)
      .then((r) => {
        const pairs = r.data || [];
        lib.setMirrors(Object.fromEntries(pairs.map((p) => [p.src_listen, p.dst_listen])));
        setMirrorPairs(pairs);
      })
      .catch(() => {});
  }, [configId]);

  // 加载镜像对；旧数据自动迁移：443+20551 已对齐但无镜像对记录 → 补默认对
  useEffect(() => {
    if (!configId) return;
    listMirrorPairs(configId)
      .then((r) => {
        if ((r.data || []).length) { refreshMirrors(); return; }
        const T = lib.getTree()[0];
        const has = (p) => (T?.children || []).some((s) => s.scope === "server" && lib.mirrorPortOf(s) === p);
        if (has("443") && has("20551")) {
          createMirrorPair(configId, { src_listen: "443", dst_listen: "20551" }).finally(() => refreshMirrors());
        } else {
          lib.setMirrors({});
          setMirrorPairs([]);
        }
      })
      .catch(() => refreshMirrors());
  }, [configId, refreshMirrors]);

  // 镜像自动同步：内存树立即同步（镜像端 ← 母本端，支持多对），并调用后端 mirror 接口落库后重载
  const syncMirrorsNow = useCallback(() => {
    if (ctx !== "conf") return;
    const T = tree[0];
    if (!T) return;
    const srvList = (T.children || []).filter((n) => n.scope === "server");
    const pairs = lib.getMirrors();
    const hit = Object.entries(pairs).map(([srcPort, dstPort]) => {
      const src = srvList.find((x) => lib.mirrorPortOf(x) === srcPort);
      const dst = srvList.find((x) => lib.mirrorPortOf(x) === dstPort);
      if (!src || !dst) return null;
      if (!lib.syncMirrors(src)) return null; // 内容已一致则跳过
      return { src, dst };
    }).filter(Boolean);
    if (!hit.length) return;
    setTreeState(lib.getTree());
    Promise.all(hit.map(({ src, dst }) => {
      const srcId = src.id, dstId = dst.id;
      if (!srcId || !dstId) return Promise.resolve();
      return mirrorBlock(srcId, dstId).then(() => loadTree(configId, ctx));
    })).then(() => toast(`已同步镜像：${hit.map((h) => `${lib.mirrorPortOf(h.dst)} ← ${lib.mirrorPortOf(h.src)}`).join("、")}`, "ok"))
      .catch((e) => toast("镜像落库失败：" + (e.response?.data?.detail || "未知错误"), "err"));
  }, [ctx, tree, toast, loadTree, configId]);

  // 空行业引导：新建第一个配置文件（.conf），创建后自动选中进入块管理
  const createCfgOk = () => {
    const nm = cfgName.trim();
    if (!nm) { toast("请输入配置文件名", "warn"); return; }
    createNginxConfig({
      industry_id: id,
      name: nm,
      config_text: "http {\n    include mime.types;\n    default_type application/octet-stream;\n    sendfile on;\n}\n",
      enabled: true,
    })
      .then((r) => {
        setShowCreateCfg(false);
        setCfgName("");
        toast("已创建配置文件 " + r.data.name, "ok");
        return listConfigsByIndustry(id).then((res) => {
          setConfigs(res.data);
          setConfigId(r.data.id);
        });
      })
      .catch((e) => toast("创建失败：" + (e.response?.data?.detail || "未知错误"), "err"));
  };

  const value = {
    industryId: id, industry, configs, configId, setConfigId,
    view, setView, ctx, setCtx: switchCtx, tree, setTree: setTreeState,
    stats, setStats, selected, setSelected, dirty, setDirty,
    highlightListen, setHighlightListen,
    exportInfo, setExportInfo, toast,
    loadTree, syncMirrorsNow, refreshMirrors,
  };

  const servers = (tree[0]?.children || []).filter((n) => n.scope === "server");
  const commons = (tree[0]?.children || []).filter((n) => ["map", "upstream", "split_clients", "geo"].includes(n.scope));

  // 镜像对状态：母本 / 镜像目标 + 一致判定（listen 端口归一化后比对结构签名）
  const mirrorMap = useMemo(() => {
    const m = {};
    servers.forEach((s) => {
      const info = lib.mirrorInfoOf(s);
      if (!info) return;
      const peer = servers.find((x) => lib.mirrorPortOf(x) === info.peer);
      m[s._id] = {
        role: info.role,
        peer: info.peer,
        same: !!peer && lib.mirrorSigOf(s) === lib.mirrorSigOf(peer),
      };
    });
    return m;
  }, [servers, mirrorPairs]);

  return (
    <OpsContext.Provider value={value}>
      <div className="ops-root">
        {/* 标题栏 36px（对齐 mock） */}
        <div className="ops-titlebar">
          <div className="tb-left">
            <span className="tb-back" onClick={() => navigate("/")} title="返回行业管理">← 行业管理</span>
          </div>
          <div className="tb-mid">{lib.getFileName()} · {industry ? industry.name : "…"}</div>
          <div className="win-dots">
            <i className="r" /><i className="y" /><i className="g" />
          </div>
        </div>

        {/* 视图菜单 38px（仅块管理） */}
        <div className="ops-menubar">
          {VIEWS.map((v) => (
            <div key={v.key} className={`navi${view === v.key ? " on" : ""}`} data-view={v.key} onClick={() => setView(v.key)}>
              <span className="navi-ico">{v.icon}</span>{v.label}
            </div>
          ))}
        </div>

        {/* 主体：side + content（对齐 mock） */}
        <div className="ops-body">
          <div className="ops-sidebar">
            {/* ctxseg 归位：侧边栏最顶部 */}
            <div className="ctxseg">
              {["conf", "stream"].map((c) => (
                <div key={c} className={`ctx-i${ctx === c ? " on" : ""}`} onClick={() => switchCtx(c)}>
                  .{c}
                </div>
              ))}
            </div>
            <div className="side-group grow">
              <div className="side-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: 10 }}>
                <span>监听点 ({servers.length})</span>
                <button className="side-add" title="新增监听点（server 块）" onClick={() => setShowAdd(true)}>＋ 监听点</button>
              </div>
              {servers.map((s) => (
                <SideItem
                  key={s._id}
                  node={s}
                  active={!!(selected && selected._id === s._id)}
                  onSelect={() => setSelected(s)}
                  onMove={(dir) => moveSide(s, dir)}
                  onDelete={() => deleteSide(s)}
                  mirror={mirrorMap[s._id]}
                />
              ))}
              {servers.length === 0 && <div className="empty-hint">当前上下文无 server 块</div>}
            </div>
            <div className="side-group cmn">
              <div className="side-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: 10 }}>
                <span>共性块 ({commons.length})</span>
                <button className="side-add" title="新增共性块（upstream / map / geo）" onClick={() => setShowAdd(true)}>＋ 共性块</button>
              </div>
              {commons.map((n) => (
                <SideItem key={n._id} node={n} active={!!(selected && selected._id === n._id)} onSelect={() => setSelected(n)} onDelete={() => deleteSide(n)} />
              ))}
              {commons.length === 0 && <div className="empty-hint" style={{ padding: "10px 14px" }}>无 map/upstream/geo 块</div>}
            </div>
          </div>

          {/* 主区（content）：空行业显示引导面板，避免空白页 */}
          <div className="ops-main">
            {configs.length === 0 ? (
              <div className="ops-empty">
                <div className="ops-empty-card">
                  <h3>该行业暂无配置文件</h3>
                  <p>该行业还没有任何 nginx 配置。可以新建一个 <span className="mono">.conf</span> 配置文件开始维护，创建后即可通过「＋ 块」添加 server / upstream 等配置。</p>
                  <button className="btn primary" onClick={() => setShowCreateCfg(true)}>新建配置文件</button>
                </div>
              </div>
            ) : (
              <>
                <div className="view-fade" style={{ flex: 1, display: "flex", minHeight: 0 }}>
                  {view === "block" && <BlockPage />}
                </div>
                <div className="foot-glow" />
              </>
            )}
          </div>
        </div>

        {/* 状态栏 28px */}
        <div className="ops-statusbar">
          <span className="mono">main</span>
          <span className="status-dot ok" />
          <span>clean</span>
          <span className="err">0 错误</span>
          <span className="warn">0 警告</span>
          <span className="mono">{ctx === "stream" ? "stream" : "conf"}</span>
          <span className="mono">Ln {servers.length} · {stats ? stats.server + stats.location + stats.upstream : 0} 块</span>
          <span style={{ marginLeft: "auto" }}>
            {exportInfo.dom ? `${exportInfo.dom} 条域名替换` : ""}
            {exportInfo.dom && exportInfo.up ? " · " : ""}
            {exportInfo.up ? `${exportInfo.up} 组 upstream 整组替换` : ""}
            {!exportInfo.dom && !exportInfo.up ? "未设置导出替换" : ""}
          </span>
        </div>

        {/* Toast */}
        <div className="toast-box">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.type || ""}`}>{t.msg}</div>
          ))}
        </div>

        {/* 新增顶级块（监听点 / 共性块共用，弹窗内选择 scope） */}
        <AddBlockModal open={showAdd} onClose={() => setShowAdd(false)} onAdded={() => loadTree(configId, ctx)} />

        {/* 空行业引导：新建第一个配置文件 */}
        {showCreateCfg && (
          <div className="ops-modal-mask" onClick={() => setShowCreateCfg(false)}>
            <div className="ops-modal" onClick={(e) => e.stopPropagation()}>
              <h3>新建配置文件</h3>
              <div className="fgroup">
                <label>配置文件名（.conf）</label>
                <input value={cfgName} onChange={(e) => setCfgName(e.target.value)} placeholder={(industry?.code || "industry") + "_nginx.conf"} autoFocus />
              </div>
              <div className="modal-tip">创建后可在块管理中通过「＋ 块」添加 server / upstream / map 等配置，也可用「推送配置」导入已有 conf 文件。</div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setShowCreateCfg(false)}>取消</button>
                <button className="btn primary" onClick={createCfgOk}>创建</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </OpsContext.Provider>
  );
}
