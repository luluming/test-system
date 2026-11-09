import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal, message } from "antd";
import { listIndustries } from "../api/industry";
import { listProjects } from "../api/projects";
import {
  deleteYamlConfig,
  exportNacosZip,
  importNacosZip,
  listYamlVersions,
  nacosViewList,
} from "../api/yaml";
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
  const navigate = useNavigate();
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

  // 历史版本弹窗
  const [histRow, setHistRow] = useState(null);
  const [histRows, setHistRows] = useState([]);
  const [histLoading, setHistLoading] = useState(false);

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

  useEffect(() => {
    query();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ns]);

  const nsName = useMemo(() => {
    const m = new Map(namespaces.map((p) => [p.id, p.name]));
    return (id) => m.get(id) || `#${id}`;
  }, [namespaces]);

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

  // ---- 历史版本 ----
  const openHistory = async (r) => {
    setHistRow(r);
    setHistRows([]);
    setHistLoading(true);
    try {
      setHistRows((await listYamlVersions(r.id)).data || []);
    } catch {
      message.error("加载历史版本失败");
    } finally {
      setHistLoading(false);
    }
  };

  // ---- 删除 ----
  const removeRow = (r) => {
    Modal.confirm({
      title: `删除配置「${r.data_id}」？`,
      content: `命名空间 ${r.project_name} 下的该配置及其历史版本将一并删除，删除后不可恢复。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await deleteYamlConfig(r.id);
          message.success("已删除");
          query();
          window.dispatchEvent(new Event("industries:changed"));
        } catch (err) {
          message.error(err.response?.data?.detail || "删除失败");
        }
      },
    });
  };

  return (
    <div className="page">
      {/* === 页头 === */}
      <div className="page-head">
        <div>
          <h1>配置管理</h1>
          <p className="sub">Nacos 风格视图 · 命名空间（项目）→ 分组 → dataId，支持 ZIP 批量导入与一键导出恢复</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={doExport} disabled={exporting || ns === "all"}>
            {exporting ? "导出中…" : "导出 ZIP"}
          </button>
          <button className="btn primary" onClick={openImport}>
            导入配置
          </button>
        </div>
      </div>

      {/* === 命名空间选择 + 查询条（Nacos 控制台布局） === */}
      <div className="ncos-bar">
        <label className="ncos-label">
          命名空间
          <select className="ncos-select" value={ns} onChange={(e) => setNs(e.target.value)}>
            <option value="all">全部命名空间</option>
            {namespaces.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
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
                  </td>
                  <td className="mono">{r.group}</td>
                  <td>
                    <span className={ft.cls}>{ft.label}</span>
                  </td>
                  <td>{r.project_name}</td>
                  <td className="mono">v{r.version}</td>
                  <td className="meta">{r.updated_at ? r.updated_at.replace("T", " ").slice(0, 16) : "-"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        className="btn mini link"
                        onClick={() => navigate(`/projects/${r.project_id}/yaml?configId=${r.id}`)}
                      >
                        编辑
                      </button>
                      <button className="btn mini" onClick={() => openHistory(r)}>
                        历史
                      </button>
                      <button className="btn mini danger" onClick={() => removeRow(r)}>
                        删除
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

      {/* === 历史版本弹窗 === */}
      <Modal
        title={`历史版本 · ${histRow?.data_id || ""}`}
        open={!!histRow}
        onCancel={() => setHistRow(null)}
        footer={null}
        width={640}
        destroyOnClose
      >
        {histLoading ? (
          <p className="meta">加载中…</p>
        ) : histRows.length === 0 ? (
          <p className="meta">暂无历史版本</p>
        ) : (
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            <table className="ov-tbl">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>版本</th>
                  <th>备注</th>
                  <th style={{ width: 90 }}>操作人</th>
                  <th style={{ width: 150 }}>时间</th>
                </tr>
              </thead>
              <tbody>
                {histRows.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">v{v.version}</td>
                    <td>{v.note || "-"}</td>
                    <td>{v.created_by || "-"}</td>
                    <td className="meta">{v.created_at ? v.created_at.replace("T", " ").slice(0, 16) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="meta" style={{ marginTop: 10 }}>
          回滚请进入配置编辑工作台 → 历史版本。
        </p>
      </Modal>
    </div>
  );
}
