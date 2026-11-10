import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, message } from "antd";
import { listIndustries } from "../api/industry";
import { listProjects } from "../api/projects";
import {
  exportNacosZip,
  importNacosZip,
  listPushDiffs,
  nacosViewList,
  resolvePushDiffs,
} from "../api/yaml";
import ConfigWorkbench from "../components/ConfigWorkbench";
import { getUser } from "../store/auth";
import "./nacos.css";

const FORMAT_TAG = {
  yaml: { cls: "tag2 def", label: "yaml" },
  properties: { cls: "tag2 bare", label: "properties" },
  json: { cls: "tag2 none", label: "json" },
  text: { cls: "tag2 none", label: "text" },
};

// 配置管理 · Nacos 视图
// 复刻 Nacos 控制台的配置列表体验：命名空间（项目）选择 + dataId/group 搜索
// + 平铺表格（dataId | group | 格式 | 命名空间 | 版本 | 修改时间 | 操作），
// 并提供「导入 ZIP（tenant-config-data / 控制台导出格式）」与「导出 ZIP（控制台可回导）」。
export default function NacosConfigPage() {
  const isAdmin = getUser()?.role === "admin";

  // 命名空间（项目）与查询条件
  const [namespaces, setNamespaces] = useState([]);
  const [ns, setNs] = useState("all");
  const [dataId, setDataId] = useState("");
  const [group, setGroup] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // 导入弹窗
  const [importOpen, setImportOpen] = useState(false);
  const [industries, setIndustries] = useState([]);
  const [impIndustry, setImpIndustry] = useState("");
  const [impProject, setImpProject] = useState("");
  const [impConflict, setImpConflict] = useState("skip");
  const [impFile, setImpFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState(null);

  // 配置工作台：编辑 + 版本时间线 + 版本对比（替代原「历史」弹窗）
  const [workbenchRow, setWorkbenchRow] = useState(null);

  // 推送差异：按命名空间→分组→组件统计 + 批量处理
  const [diffs, setDiffs] = useState({ total: 0, by_project: [] });
  const [diffOpen, setDiffOpen] = useState(false);
  const [selDiffs, setSelDiffs] = useState([]);
  const [diffBusy, setDiffBusy] = useState(false);

  // 命名空间列表 = 当前用户可见项目（管理员 all；普通用户 mine+shared 去重）
  const loadNamespaces = useCallback(async () => {
    try {
      if (isAdmin) {
        setNamespaces((await listProjects({ tab: "all" })).data || []);
      } else {
        const [mine, shared] = await Promise.all([
          listProjects({ tab: "mine" }),
          listProjects({ tab: "shared" }),
        ]);
        const map = new Map();
        [...(mine.data || []), ...(shared.data || [])].forEach((p) => map.set(p.id, p));
        setNamespaces([...map.values()]);
      }
    } catch {
      /* 静默：命名空间下拉为空不阻塞主列表 */
    }
  }, [isAdmin]);

  const query = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (ns !== "all") params.project_id = ns;
      if (dataId.trim()) params.data_id = dataId.trim();
      if (group.trim()) params.group = group.trim();
      setRows((await nacosViewList(params)).data || []);
    } catch {
      message.error("加载配置列表失败");
    } finally {
      setLoading(false);
    }
  }, [ns, dataId, group]);

  useEffect(() => {
    loadNamespaces();
  }, [loadNamespaces]);

  // 推送差异统计：页面头部徽标 + 命名空间下拉计数共用
  const loadDiffs = useCallback(async () => {
    try {
      setDiffs((await listPushDiffs()).data || { total: 0, by_project: [] });
    } catch {
      /* 静默：差异统计失败不阻塞配置列表 */
    }
  }, []);

  useEffect(() => {
    loadDiffs();
  }, [loadDiffs]);

  const diffByProject = useMemo(() => {
    const m = new Map();
    (diffs.by_project || []).forEach((p) => m.set(p.project_id, p));
    return m;
  }, [diffs]);

  // 组件级差异：config_id → { added, removed }，供表格里 dataId 旁直接标注
  const diffByConfig = useMemo(() => {
    const m = new Map();
    (diffs.by_project || []).forEach((p) =>
      p.groups.forEach((g) =>
        g.items.forEach((it) => m.set(it.config_id, it))
      )
    );
    return m;
  }, [diffs]);

  useEffect(() => {
    query();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ns]);

  const nsName = useMemo(() => {
    const m = new Map(namespaces.map((p) => [p.id, p.name]));
    return (id) => m.get(id) || `#${id}`;
  }, [namespaces]);

  // 可从命名空间（项目）的 my_perm 推断编辑权限，避免对只读用户展示保存按钮
  const editableProjectIds = useMemo(() => {
    const s = new Set();
    namespaces.forEach((p) => {
      if (isAdmin || ["owner", "edit", "admin"].includes(p.my_perm)) s.add(p.id);
    });
    return s;
  }, [namespaces, isAdmin]);

  // ---- 导入 ZIP ----
  const openImport = async () => {
    setReport(null);
    setImpFile(null);
    setImpProject("");
    setImpConflict("skip");
    setImportOpen(true);
    try {
      const res = await listIndustries();
      setIndustries(res.data || []);
    } catch {
      /* 行业下拉失败时提示 */
    }
  };

  const submitImport = async () => {
    if (!impIndustry) return message.warning("请选择目标行业");
    if (!impFile) return message.warning("请选择要导入的 ZIP 文件");
    const fd = new FormData();
    fd.append("file", impFile);
    const params = { industry_id: impIndustry, conflict: impConflict };
    if (impProject) params.project_id = impProject;
    setImporting(true);
    try {
      const res = await importNacosZip(fd, params);
      setReport(res.data);
      message.success(
        `导入完成：新增 ${res.data.created}，覆盖 ${res.data.updated}，跳过 ${res.data.skipped}`
      );
      query();
      loadNamespaces();
      window.dispatchEvent(new Event("industries:changed"));
    } catch (err) {
      message.error(err.response?.data?.detail || "导入失败");
    } finally {
      setImporting(false);
    }
  };

  // ---- 导出 ZIP（Nacos 控制台可回导格式）----
  const doExport = async () => {
    if (ns === "all") return message.warning("请先选择一个命名空间再导出");
    setExporting(true);
    try {
      await exportNacosZip(ns, nsName(Number(ns)));
      message.success("已导出 ZIP（可直接在 Nacos 控制台导入）");
    } catch {
      message.error("导出失败");
    } finally {
      setExporting(false);
    }
  };

  // ---- 推送差异：勾选 + 批量处理（采用新推送 / 保留当前）----
  const shownDiffProjects = useMemo(() => {
    const list = diffs.by_project || [];
    return ns === "all" ? list : list.filter((p) => String(p.project_id) === String(ns));
  }, [diffs, ns]);

  const shownDiffItems = useMemo(
    () => shownDiffProjects.flatMap((p) => p.groups.flatMap((g) => g.items)),
    [shownDiffProjects]
  );

  const toggleDiff = (id) =>
    setSelDiffs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const toggleGroupDiffs = (items, checked) => {
    const ids = items.filter((i) => i.can_edit).map((i) => i.id);
    setSelDiffs((prev) =>
      checked ? [...new Set([...prev, ...ids])] : prev.filter((x) => !ids.includes(x))
    );
  };

  const doResolveDiffs = async (mode, ids, scope) => {
    const body = { mode, ...(scope || {}) };
    if (ids) body.ids = ids;
    else body.all = true;
    setDiffBusy(true);
    try {
      const res = await resolvePushDiffs(body);
      const d = res.data || {};
      const ok = mode === "incoming" ? `采用 ${d.applied}` : `保留 ${d.ignored}`;
      message.success(
        `处理完成：${ok}${d.skipped?.length ? `，跳过 ${d.skipped.length}` : ""}`
      );
      if (d.skipped?.length) {
        message.warning(d.skipped.slice(0, 3).map((s) => `${s.name}：${s.reason}`).join("；"));
      }
      setSelDiffs([]);
      await loadDiffs();
      query();
    } catch (err) {
      message.error(err.response?.data?.detail || "处理失败");
    } finally {
      setDiffBusy(false);
    }
  };

  const diffScope = ns === "all" ? {} : { project_id: Number(ns) };

  const confirmResolve = (mode, ids, count, scope) => {
    const label = mode === "incoming" ? "采用新推送" : "保留当前";
    Modal.confirm({
      title: `确认${label}`,
      content:
        mode === "incoming"
          ? `将对 ${count} 处差异采用新推送内容，生成新版本并写入变更记录。`
          : `将对 ${count} 处差异保留当前内容，丢弃本次推送的新内容。`,
      okText: "确认",
      cancelText: "取消",
      onOk: () => doResolveDiffs(mode, ids, scope),
    });
  };

  return (
    <div className="page">
      {/* === 页头 === */}
      <div className="page-head">
        <div>
          <h1>Nacos 配置</h1>
          <p className="sub">命名空间（项目）→ 分组 → dataId，支持 ZIP 批量导入与一键导出恢复</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className={`btn${diffs.total ? " primary" : ""}`}
            onClick={() => {
              setSelDiffs([]);
              loadDiffs();
              setDiffOpen(true);
            }}
          >
            推送差异
            <span className={diffs.total ? "nc-badge" : "nc-badge zero"}>{diffs.total}</span>
          </button>
          <button className="btn" onClick={doExport} disabled={exporting || ns === "all"}>
            {exporting ? "导出中…" : "导出 ZIP"}
          </button>
          <button className="btn primary" onClick={openImport}>
            导入配置
          </button>
        </div>
      </div>

      {/* === 全量批量处理条：针对当前命名空间下所有组件 === */}
      <div className={"ncbatch" + (shownDiffItems.length ? " has-diff" : "")}>
        <div className="ncbatch-main">
          <span className="ncbatch-title">组件批量处理</span>
          <span className="ncbatch-scope">
            {ns === "all"
              ? "全部命名空间"
              : namespaces.find((p) => String(p.id) === ns)?.name || "—"}
            {" · "}
            <b>{shownDiffItems.length}</b> 个组件待处理
          </span>
          {shownDiffItems.length > 0 ? (
            <span className="ncbatch-delta mono">
              <i className="add">+{shownDiffItems.reduce((s, i) => s + i.added, 0)}</i>
              <i className="del">-{shownDiffItems.reduce((s, i) => s + i.removed, 0)}</i>
            </span>
          ) : (
            <span className="ncbatch-ok">全部组件已与推送内容一致</span>
          )}
        </div>
        <div className="ncbatch-ops">
          <button
            className="btn mini"
            onClick={() => {
              setSelDiffs([]);
              loadDiffs();
              setDiffOpen(true);
            }}
          >
            查看明细
          </button>
          <button
            className="btn mini"
            disabled={!shownDiffItems.length || diffBusy}
            onClick={() =>
              confirmResolve("keep", null, shownDiffItems.length, diffScope)
            }
          >
            全部保留当前
          </button>
          <button
            className="btn mini primary"
            disabled={!shownDiffItems.length || diffBusy}
            onClick={() =>
              confirmResolve("incoming", null, shownDiffItems.length, diffScope)
            }
          >
            {diffBusy ? "处理中…" : "全部采用新推送"}
          </button>
        </div>
      </div>

      {/* === 命名空间选择 + 查询条（Nacos 控制台布局） === */}
      <div className="ncos-bar">
        <label className="ncos-label">
          命名空间
          <select className="ncos-select" value={ns} onChange={(e) => setNs(e.target.value)}>
            <option value="all">全部命名空间{diffs.total ? `（${diffs.total} 处差异）` : ""}</option>
            {namespaces.map((p) => {
              const d = diffByProject.get(p.id);
              return (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {d?.total ? `（${d.total} 处差异）` : ""}
                </option>
              );
            })}
          </select>
        </label>
        <input
          className="ncos-input"
          placeholder="dataId"
          value={dataId}
          onChange={(e) => setDataId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && query()}
        />
        <input
          className="ncos-input"
          placeholder="group"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && query()}
        />
        <button className="btn primary" onClick={query}>
          查询
        </button>
        <button
          className="btn"
          onClick={() => {
            setDataId("");
            setGroup("");
            query();
          }}
        >
          重置
        </button>
        <span className="meta" style={{ marginLeft: "auto" }}>
          {loading ? "加载中…" : `共 ${rows.length} 条配置`}
        </span>
      </div>

      {/* === 配置表格 === */}
      <div style={{ overflowX: "auto" }}>
        <table className="ov-tbl">
          <thead>
            <tr>
              <th style={{ width: "34%" }}>dataId</th>
              <th style={{ width: "18%" }}>group</th>
              <th style={{ width: "9%" }}>格式</th>
              <th style={{ width: "16%" }}>命名空间</th>
              <th style={{ width: "6%" }}>版本</th>
              <th style={{ width: "10%" }}>修改时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <p className="empty">暂无配置 · 点击右上角「导入配置」上传 Nacos ZIP，或在项目工作台中新建</p>
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const ft = FORMAT_TAG[r.format] || FORMAT_TAG.text;
              return (
                <tr key={r.id}>
                  <td>
                    <span className="mono" title={r.description || r.data_id}>
                      {r.data_id}
                    </span>
                    {r.status === "invalid" && <span className="tag2 warn" style={{ marginLeft: 6 }}>语法异常</span>}
                    {(() => {
                      const d = diffByConfig.get(r.id);
                      if (!d) return null;
                      return (
                        <span
                          className="nc-diffchip"
                          title={`待处理推送差异：新增 ${d.added} 行、删除 ${d.removed} 行，可点「推送差异」处理`}
                        >
                          差异
                          <i className="add">+{d.added}</i>
                          <i className="del">-{d.removed}</i>
                        </span>
                      );
                    })()}
                  </td>
                  <td className="mono">{r.group}</td>
                  <td>
                    <span className={ft.cls}>{ft.label}</span>
                  </td>
                  <td>
                    <span>{r.project_name}</span>
                    {(() => {
                      const d = diffByProject.get(r.project_id);
                      if (!d?.total) return null;
                      return (
                        <span
                          className="nc-diffchip"
                          title={`该命名空间共 ${d.total} 个组件有差异（+${d.added} -${d.removed}）`}
                        >
                          {d.total} 处
                        </span>
                      );
                    })()}
                  </td>
                  <td className="mono">v{r.version}</td>
                  <td className="meta">{r.updated_at ? r.updated_at.replace("T", " ").slice(0, 16) : "-"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        className="btn mini link"
                        onClick={() => setWorkbenchRow(r)}
                      >
                        编辑
                      </button>
                      <button className="btn mini" onClick={() => setWorkbenchRow(r)}>
                        版本
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* === 导入配置弹窗 === */}
      <Modal
        title="导入配置（Nacos ZIP）"
        open={importOpen}
        onCancel={() => !importing && setImportOpen(false)}
        footer={null}
        width={620}
        destroyOnClose
      >
        <div className="ncos-form">
          <div className="ncos-field">
            <label>目标行业 *</label>
            <select
              className="ncos-select"
              style={{ flex: 1 }}
              value={impIndustry}
              onChange={(e) => {
                setImpIndustry(e.target.value);
                setImpProject("");
              }}
            >
              <option value="">请选择行业</option>
              {industries.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div className="ncos-field">
            <label>目标项目（命名空间）</label>
            <select
              className="ncos-select"
              style={{ flex: 1 }}
              value={impProject}
              onChange={(e) => setImpProject(e.target.value)}
            >
              <option value="">自动（三层结构按命名空间建项目）</option>
              {namespaces
                .filter((p) => !impIndustry || p.industry_id === Number(impIndustry))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="ncos-field">
            <label>同名冲突</label>
            <div style={{ display: "flex", gap: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={impConflict === "skip"} onChange={() => setImpConflict("skip")} />
                跳过
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" checked={impConflict === "overwrite"} onChange={() => setImpConflict("overwrite")} />
                覆盖为新版本（可回滚）
              </label>
            </div>
          </div>
          <div className="ncos-field">
            <label>ZIP 文件 *</label>
            <input
              type="file"
              accept=".zip"
              onChange={(e) => setImpFile(e.target.files?.[0] || null)}
            />
          </div>
          <p className="meta">
            兼容两种目录结构：① 服务端磁盘快照 <code>tenant-config-data/&#123;命名空间&#125;/&#123;group&#125;/&#123;dataId&#125;</code>（按命名空间自动建项目）；
            ② Nacos 控制台导出 <code>&#123;group&#125;/&#123;dataId&#125;</code>（需指定目标项目）。
            单文件 ≤1MB，单次 ≤500 个。
          </p>

          {report && (
            <div className="ncos-report">
              <div className="tag2 ok">
                {report.mode === "tenant" ? "按命名空间导入" : "导入指定项目"} · 新建项目 {report.projects_created}
              </div>
              <span className="meta">
                共 {report.total} · 新增 {report.created} · 覆盖 {report.updated} · 跳过 {report.skipped}
                {report.failed?.length ? ` · 失败 ${report.failed.length}` : ""}
              </span>
              {report.failed?.length > 0 && (
                <ul className="err" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {report.failed.slice(0, 8).map((f, i) => (
                    <li key={i}>
                      {f.name}：{f.reason}
                    </li>
                  ))}
                  {report.failed.length > 8 && <li>… 其余 {report.failed.length - 8} 项</li>}
                </ul>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn" onClick={() => setImportOpen(false)} disabled={importing}>
              {report ? "关闭" : "取消"}
            </button>
            {!report && (
              <button className="btn primary" onClick={submitImport} disabled={importing}>
                {importing ? "导入中…" : "开始导入"}
              </button>
            )}
          </div>
        </div>
      </Modal>

      {/* === 推送差异：命名空间 → 分组 → 组件，三级统计 + 批量处理 === */}
      <Modal
        title={`推送差异 · ${diffs.total} 处待处理`}
        open={diffOpen}
        onCancel={() => !diffBusy && setDiffOpen(false)}
        footer={null}
        width={860}
        destroyOnClose
      >
        {shownDiffItems.length === 0 ? (
          <p className="ncos-empty">
            {ns === "all"
              ? "当前没有待处理的推送差异：所有既有配置都已与推送内容一致。"
              : "当前命名空间没有待处理的推送差异。"}
          </p>
        ) : (
          <div className="ncos-diff">
            <div className="ncos-diff-toolbar">
              <div className="ncos-diff-left">
                <button
                  className="btn mini"
                  disabled={diffBusy}
                  onClick={() => toggleGroupDiffs(shownDiffItems, true)}
                >
                  全选
                </button>
                <button className="btn mini" disabled={diffBusy} onClick={() => setSelDiffs([])}>
                  清空
                </button>
                <span className="meta">已选 {selDiffs.length} / {shownDiffItems.length}</span>
              </div>
              <div className="ncos-diff-right">
                <button
                  className="btn mini"
                  disabled={!selDiffs.length || diffBusy}
                  onClick={() => confirmResolve("keep", selDiffs, selDiffs.length, diffScope)}
                >
                  选中 · 保留当前
                </button>
                <button
                  className="btn mini primary"
                  disabled={!selDiffs.length || diffBusy}
                  onClick={() => confirmResolve("incoming", selDiffs, selDiffs.length, diffScope)}
                >
                  选中 · 采用新推送
                </button>
              </div>
            </div>

            <div className="ncos-diff-all">
              <span className="meta">
                {ns === "all" ? "一键处理全部命名空间" : "一键处理当前命名空间"}的{" "}
                {shownDiffItems.length} 处差异
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn mini"
                  disabled={diffBusy}
                  onClick={() =>
                    confirmResolve("keep", null, shownDiffItems.length, diffScope)
                  }
                >
                  全部保留当前
                </button>
                <button
                  className="btn mini primary"
                  disabled={diffBusy}
                  onClick={() =>
                    confirmResolve("incoming", null, shownDiffItems.length, diffScope)
                  }
                >
                  全部采用新推送
                </button>
              </div>
            </div>

            <div className="ncos-diff-list">
              {shownDiffProjects.map((p) => (
                <div key={p.project_id} className="ncos-diff-ns">
                  <div className="ncos-diff-nshead">
                    <b>{p.project_name}</b>
                    <span className="tag2 warn">{p.total} 处</span>
                    <span className="mono meta">+{p.added} -{p.removed}</span>
                  </div>
                  {p.groups.map((g) => {
                    const ids = g.items.filter((i) => i.can_edit).map((i) => i.id);
                    const checked = ids.length > 0 && ids.every((i) => selDiffs.includes(i));
                    return (
                      <div key={g.group} className="ncos-diff-group">
                        <div className="ncos-diff-ghead">
                          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => toggleGroupDiffs(g.items, e.target.checked)}
                            />
                            <span className="mono">{g.group}</span>
                          </label>
                          <span className="meta">{g.items.length} 个组件</span>
                        </div>
                        {g.items.map((it) => (
                          <div key={it.id} className="ncos-diff-row">
                            <input
                              type="checkbox"
                              checked={selDiffs.includes(it.id)}
                              onChange={() => toggleDiff(it.id)}
                            />
                            <span className="mono ncos-diff-name" title={it.name}>
                              {it.name}
                            </span>
                            <span className="mono ncos-diff-lines">
                              <i>+{it.added}</i> <em>-{it.removed}</em>
                            </span>
                            <span className="meta">
                              v{it.base_version}
                              {it.current_version != null && it.current_version !== it.base_version
                                ? `（现 v${it.current_version}）`
                                : ""}
                            </span>
                            <span className="ncos-diff-ops">
                              <button
                                className="btn mini link"
                                disabled={!it.can_edit || diffBusy}
                                onClick={() => confirmResolve("incoming", [it.id], 1)}
                              >
                                采用
                              </button>
                              <button
                                className="btn mini link"
                                disabled={!it.can_edit || diffBusy}
                                onClick={() => confirmResolve("keep", [it.id], 1)}
                              >
                                保留
                              </button>
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* === 配置工作台：编辑 + 版本时间线 + 版本对比 === */}
      <ConfigWorkbench
        row={workbenchRow}
        tenant={workbenchRow?.project_name || ""}
        canEdit={editableProjectIds.has(workbenchRow?.project_id)}
        onClose={() => setWorkbenchRow(null)}
        onSaved={() => {
          query();
          window.dispatchEvent(new Event("industries:changed"));
        }}
      />
    </div>
  );
}
