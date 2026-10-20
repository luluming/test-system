import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { getIndustry } from "../api/industry";
import { listConfigsByIndustry } from "../api/nginx";
import { getConfigTree } from "../api/nginxInner";
import { reloadNginx, testNginxConfig } from "../api/nginxInner";
import { OpsContext } from "./ops/OpsContext";
import "./ops/ops.css";
import "./dashboard.css";

import * as lib from "../lib/nginx-inner";

import ConfigPage from "./ops/ConfigPage";
import BlockPage from "./ops/BlockPage";
import TopologyPage from "./ops/TopologyPage";
import BizPortPage from "./ops/BizPortPage";

const VIEWS = [
  { key: "config", label: "配置文件", icon: "📄" },
  { key: "block", label: "块管理", icon: "📁" },
  { key: "topology", label: "全局拓扑", icon: "🔗" },
  { key: "biz", label: "业务端口", icon: "📋" },
];

/* 行内悬停操作浮层：测连 / 启停 / 重载 */
function SideItem({ node, off, onToggle, onPing, onReload }) {
  const port = lib.listenPlain(node);
  const name = node.scope === "server" ? lib.snameOf(node) : lib.upNameOf(node);
  const locs = node.children.filter((c) => c.scope === "location").length;
  return (
    <div className={`t-item${off ? " t-off" : ""}`} style={off ? { opacity: 0.55 } : undefined} title={name}>
      <span className="t-ico">{node.scope === "server" ? "◈" : "▤"}</span>
      <span className="t-nm">{node.scope === "server" ? port : name}</span>
      {node.scope === "server" ? <span className="t-cnt">{locs} loc</span> : null}
      <span className="t-ops">
        <button className="t-op" title="连通性测试" onClick={(e) => { e.stopPropagation(); onPing(); }}>测连</button>
        <button className="t-op" title="启用/停用" onClick={(e) => { e.stopPropagation(); onToggle(); }}>启停</button>
        <button className="t-op" title="reload" onClick={(e) => { e.stopPropagation(); onReload(); }}>重载</button>
      </span>
    </div>
  );
}

export default function IndustryDetail() {
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
  const [offMap, setOffMap] = useState({});
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
      setSelected(norm[0] && norm[0].children[0] ? norm[0].children[0] : null);
    } catch {
      toast("配置树加载失败", "err");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // configId / ctx 变化时重载树
  useEffect(() => {
    loadTree(configId, ctx);
  }, [configId, ctx, loadTree]);

  const switchCtx = (c) => {
    if (c === ctx) return;
    setCtxState(c);
    loadTree(configId, c);
  };

  const toggleOff = (node) => {
    const k = node._id;
    setOffMap((prev) => ({ ...prev, [k]: !prev[k] }));
    toast(offMap[k] ? "已启用该监听点" : "已停用该监听点", offMap[k] ? "ok" : "warn");
  };

  const handleReload = () => {
    if (!configId) return;
    toast("正在 reload nginx…");
    reloadNginx(configId)
      .then((r) => toast(r.data?.output || "reload 成功，配置已热载", "ok"))
      .catch(() => toast("reload 失败", "err"));
  };

  const handlePing = () => {
    if (!configId) return;
    toast("连通性测试…");
    testNginxConfig(configId)
      .then((r) => {
        const res = (r.data && r.data.results) || [];
        const bad = res.filter((x) => !x.ok);
        toast(bad.length ? `连通性测试：${bad.length} 个端口异常` : "连通性测试：全部正常", bad.length ? "warn" : "ok");
      })
      .catch(() => toast("连通性测试失败", "err"));
  };

  const value = {
    industryId: id, industry, configs, configId, setConfigId,
    view, setView, ctx, setCtx: switchCtx, tree, setTree: setTreeState,
    stats, setStats, selected, setSelected, dirty, setDirty,
    highlightListen, setHighlightListen,
    exportInfo, setExportInfo, toast,
    loadTree,
  };

  const servers = (tree[0]?.children || []).filter((n) => n.scope === "server");
  const commons = (tree[0]?.children || []).filter((n) => ["map", "upstream", "split_clients", "geo"].includes(n.scope));

  return (
    <OpsContext.Provider value={value}>
      <div className="ops-root">
        {/* 标题栏 36px（对齐 mock） */}
        <div className="ops-titlebar">
          <div className="tb-left">
            <span className="tb-hamb">☰</span>
            <span className="tb-dot" />
            <span className="tb-brand">Nginx Console</span>
          </div>
          <div className="tb-mid">{lib.getFileName()} · {industry ? industry.name : "…"}</div>
          <div className="win-dots">
            <i className="r" /><i className="y" /><i className="g" />
          </div>
        </div>

        {/* 四视图菜单 38px（对齐 mock：仅导航，无 ctxseg） */}
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
              <div className="side-head">监听点 ({servers.length})</div>
              {servers.map((s) => (
                <SideItem
                  key={s._id}
                  node={s}
                  off={!!offMap[s._id]}
                  onToggle={() => toggleOff(s)}
                  onPing={handlePing}
                  onReload={handleReload}
                />
              ))}
              {servers.length === 0 && <div className="empty-hint">当前上下文无 server 块</div>}
            </div>
            <div className="side-group">
              <div className="side-head">共性块 ({commons.length})</div>
              {commons.map((n) => (
                <SideItem key={n._id} node={n} off={false} onToggle={() => {}} onPing={() => {}} onReload={handleReload} />
              ))}
              {commons.length === 0 && <div className="empty-hint" style={{ padding: "10px 14px" }}>无 map/upstream/geo 块</div>}
            </div>
          </div>

          {/* 主区（content） */}
          <div className="ops-main">
            <div className="view-fade" style={{ flex: 1, display: "flex", minHeight: 0 }}>
              {view === "config" && <ConfigPage />}
              {view === "block" && <BlockPage />}
              {view === "topology" && <TopologyPage />}
              {view === "biz" && <BizPortPage />}
            </div>
            <div className="foot-glow" />
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
      </div>
    </OpsContext.Provider>
  );
}
