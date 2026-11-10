import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Form, Input, Modal, message } from "antd";
import { getProject, getShare } from "../api/projects";
import {
  createYamlConfig,
  createPushDirectoryToken,
  exportNacosZip,
  getMetaBase,
  nacosViewList,
} from "../api/yaml";
import ConfigWorkbench from "../components/ConfigWorkbench";
import ProjectNav from "../components/ProjectNav";
import ShareModal from "../components/ShareModal";
import "./dashboard.css";
import "./project.css";
import "./nacos.css";

// Nacos 配置：配置文件 / 共享设置 —— 项目内的配置分区（环境变量、项目信息已移除）
export default function ProjectConfigPage() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const id = Number(projectId);

  const [project, setProject] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("nacos");

  // Nacos 风格配置文件列表（当前项目 = 一个命名空间）
  const [cfgs, setCfgs] = useState([]);
  const [cfgDataId, setCfgDataId] = useState("");
  const [cfgGroupKw, setCfgGroupKw] = useState("");
  const [cfgFuzzy, setCfgFuzzy] = useState(true);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgTenant, setCfgTenant] = useState("");
  // 层级视图折叠状态：key 为 `t:{tenant}` 或 `g:{tenant}/{group}`
  const [treeCollapsed, setTreeCollapsed] = useState({});
  const [exporting, setExporting] = useState(false);
  // 配置工作台：一个弹窗内含 编辑 / 版本时间线 / 版本对比
  const [workbenchRow, setWorkbenchRow] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [creating, setCreating] = useState(false);
  const [publicBase, setPublicBase] = useState("");
  // 整目录推送（curl + tar.gz）
  const [dirOpen, setDirOpen] = useState(false);
  const [dirToken, setDirToken] = useState(null);
  const [dirBusy, setDirBusy] = useState(false);
  const [dirPath, setDirPath] = useState("/iotp/env/nacos/data");

  // 共享设置
  const [shareOpen, setShareOpen] = useState(false);
  const [share, setShare] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await getProject(id);
      setProject(res.data);
      setError("");
    } catch (err) {
      if (err.response?.status === 403) {
        navigate("/403", { replace: true });
      } else {
        setError("项目信息加载失败");
      }
    }
  }, [id, navigate]);

  const loadShare = useCallback(async () => {
    try {
      const res = await getShare(id);
      setShare(res.data);
    } catch { /* 仅负责人可读取共享明细 */ }
  }, [id]);

  const loadCfg = useCallback(async () => {
    setCfgLoading(true);
    try {
      const res = await nacosViewList({ project_id: id });
      setCfgs(res.data || []);
    } catch { /* 列表失败不阻塞页面 */ } finally {
      setCfgLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadCfg(); }, [loadCfg]);

  const myPerm = project?.my_perm;
  const canEdit = myPerm === "owner" || myPerm === "edit" || myPerm === "admin";
  const canManage = myPerm === "owner" || myPerm === "admin";

  // ---- Nacos 配置文件：层级视图 / 导出 / 编辑与版本 / 目录推送 ----

  // 从导入描述（nacos:tenant=xxx,group=yyy）解析命名空间；无则回退到当前项目名
  const tenantOf = useCallback(
    (c) => {
      const m = /tenant=([^,]+)/.exec(c.description || "");
      return m ? m[1].trim() : c.project_name || project?.name || "default";
    },
    [project]
  );

  const cfgTenants = useMemo(() => {
    const set = [];
    cfgs.forEach((c) => {
      const t = tenantOf(c);
      if (t && !set.includes(t)) set.push(t);
    });
    return set.sort();
  }, [cfgs, tenantOf]);

  // 分组 chips 跟随所选命名空间收敛，避免几十个分组全铺在顶部
  const cfgGroups = useMemo(() => {
    const set = [];
    cfgs.forEach((c) => {
      if (cfgTenant && tenantOf(c) !== cfgTenant) return;
      if (c.group && !set.includes(c.group)) set.push(c.group);
    });
    return set.sort();
  }, [cfgs, cfgTenant, tenantOf]);

  const filteredCfgs = useMemo(() => {
    const did = cfgDataId.trim().toLowerCase();
    const grp = cfgGroupKw.trim().toLowerCase();
    return cfgs.filter((c) => {
      if (cfgTenant && tenantOf(c) !== cfgTenant) return false;
      const name = c.data_id.toLowerCase();
      const g = (c.group || "").toLowerCase();
      const nameOk = !did || (cfgFuzzy ? name.includes(did) : name === did);
      const grpOk = !grp || (cfgFuzzy ? g.includes(grp) : g === grp);
      return nameOk && grpOk;
    });
  }, [cfgs, cfgDataId, cfgGroupKw, cfgFuzzy, cfgTenant, tenantOf]);

  // 树：命名空间（tenant）→ 分组（group）→ dataId
  const cfgTree = useMemo(() => {
    const byTenant = new Map();
    filteredCfgs.forEach((c) => {
      const t = tenantOf(c);
      const g = c.group || "DEFAULT_GROUP";
      if (!byTenant.has(t)) byTenant.set(t, new Map());
      const groups = byTenant.get(t);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    });
    return Array.from(byTenant.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tenant, groups]) => ({
        tenant,
        groups: Array.from(groups.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([group, items]) => ({
            group,
            items: items.sort((a, b) => a.data_id.localeCompare(b.data_id)),
          })),
      }));
  }, [filteredCfgs, tenantOf]);

  const toggleTree = (key) =>
    setTreeCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const openWorkbench = (c) => setWorkbenchRow(c);

  const doExport = async () => {
    setExporting(true);
    try {
      await exportNacosZip(id, project.name);
      message.success("已导出 ZIP（可在 Nacos 控制台导入恢复）");
    } catch {
      message.error("导出失败");
    } finally {
      setExporting(false);
    }
  };

  // 新建配置（Nacos「创建配置」）
  const submitCreate = async () => {
    const v = await createForm.validateFields();
    setCreating(true);
    try {
      await createYamlConfig({
        industry_id: project.industry_id,
        project_id: id,
        name: v.name,
        group: v.group || "DEFAULT_GROUP",
        description: `nacos:tenant=${project.name},group=${v.group || "DEFAULT_GROUP"}`,
        content: v.content || "",
      });
      message.success("配置已创建");
      setCreateOpen(false);
      createForm.resetFields();
      loadCfg();
      load();
      window.dispatchEvent(new Event("industries:changed"));
    } catch (err) {
      message.error(err.response?.data?.detail || "创建失败");
    } finally {
      setCreating(false);
    }
  };

  // 整目录推送：一条命令把 Nacos 落盘目录全部同步进来
  const buildDirCmd = (token) => {
    const q = `project_id=${id}`;
    return (
      `tar -czf - -C ${dirPath} tenant-config-data | \\\n` +
      `  curl -sS -X POST "${publicBase || "http://localhost:8001"}/api/yaml-configs/push-directory?${q}" \\\n` +
      `    -H "Authorization: Bearer ${token || "<TOKEN>"}" \\\n` +
      `    -H "Content-Type: application/gzip" --data-binary @-`
    );
  };

  const ensureDirToken = async () => {
    if (dirToken) return dirToken;
    const res = await createPushDirectoryToken(id, 24);
    setDirToken(res.data.token);
    return res.data.token;
  };

  const copyDirCmd = async () => {
    setDirBusy(true);
    try {
      if (!publicBase) {
        try {
          const meta = await getMetaBase();
          setPublicBase(meta.data?.public_base || "");
        } catch { /* 用默认基址 */ }
      }
      const token = await ensureDirToken();
      await navigator.clipboard.writeText(buildDirCmd(token));
      message.success("已复制「正式推送」命令（含 24 小时运维令牌）");
    } catch {
      message.error("复制失败，请允许剪贴板权限后重试");
    } finally {
      setDirBusy(false);
    }
  };

  useEffect(() => {
    if (tab === "share" && canManage) loadShare();
  }, [tab, canManage, loadShare]);

  if (error) {
    return (
      <p className="err" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>{error}</span>
        <button className="btn mini" onClick={load}>重试</button>
      </p>
    );
  }
  if (!project) return <p className="meta">加载中…</p>;

  return (
    <div>
      <ProjectNav project={project} active="config" panel />

      <div className="page-head">
        <div>
          <h1>Nacos 配置</h1>
          <p className="sub">Nacos 风格配置中心：按 命名空间（tenant）→ 分组（group）→ Data ID 层级组织；支持整目录推送（自动比对并记录变更）与 ZIP 导出。</p>
        </div>
      </div>

      <div className="dtabs" style={{ marginBottom: 14, borderRadius: 6 }}>
        <div className={"dtab" + (tab === "nacos" ? " on" : "")} onClick={() => setTab("nacos")}>
          配置文件 <span className="meta">{cfgs.length}</span>
        </div>
        <div className={"dtab" + (tab === "share" ? " on" : "")} onClick={() => setTab("share")}>共享设置</div>
      </div>

      {/* ---- Nacos 配置：层级视图 命名空间（tenant）→ 分组（group）→ dataId ---- */}
      {tab === "nacos" && (
        <>
          {/* 命名空间 / 分组 chips（对应 Nacos 顶部的命名空间列表行） */}
          <div className="ncos-nsbar">
            <div className="ncos-nsrow">
              <span className="ncos-nslabel">命名空间</span>
              <div className="ncos-nschips">
                <button
                  className={"nc-chip" + (cfgTenant === "" ? " on" : "")}
                  onClick={() => {
                    setCfgTenant("");
                    setCfgGroupKw("");
                  }}
                >
                  全部（{cfgTenants.length}）
                </button>
                {cfgTenants.map((t) => (
                  <button
                    key={t}
                    className={"nc-chip" + (cfgTenant === t ? " on" : "")}
                    onClick={() => {
                      setCfgTenant(cfgTenant === t ? "" : t);
                      setCfgGroupKw("");
                    }}
                    title={t}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="ncos-nsrow">
              <span className="ncos-nslabel">分组</span>
              <div className="ncos-nschips">
                <button
                  className={"nc-chip" + (cfgGroupKw === "" ? " on" : "")}
                  onClick={() => setCfgGroupKw("")}
                >
                  全部分组
                </button>
                {cfgGroups.map((g) => (
                  <button
                    key={g}
                    className={"nc-chip" + (cfgGroupKw === g ? " on" : "")}
                    onClick={() => setCfgGroupKw(cfgGroupKw === g ? "" : g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 工具栏：创建配置 / Data ID / Group / 模糊匹配 / 查询 */}
          <div className="ncos-toolbar">
            {canEdit && (
              <button className="nc-btn nc-primary" onClick={() => setCreateOpen(true)}>
                创建配置
              </button>
            )}
            <input
              className="nc-input"
              placeholder={`Data ID${cfgFuzzy ? "（已开启模糊查询）" : ""}`}
              value={cfgDataId}
              onChange={(e) => setCfgDataId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadCfg()}
            />
            <input
              className="nc-input"
              placeholder={`Group${cfgFuzzy ? "（已开启模糊查询）" : ""}`}
              value={cfgGroupKw}
              onChange={(e) => setCfgGroupKw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadCfg()}
            />
            <label className="nc-switch">
              <span>模糊匹配</span>
              <button
                type="button"
                className={"sw" + (cfgFuzzy ? " on" : "")}
                onClick={() => setCfgFuzzy((v) => !v)}
                title={cfgFuzzy ? "点击切换为精确匹配" : "点击切换为模糊匹配"}
              >
                <i />
              </button>
            </label>
            <button className="nc-btn nc-primary" onClick={loadCfg} disabled={cfgLoading}>
              查询
            </button>
            {canEdit && (
              <button className="nc-btn nc-primary" onClick={() => setDirOpen(true)}>
                推送配置（整目录）
              </button>
            )}
            <button className="nc-btn" onClick={doExport} disabled={exporting || cfgs.length === 0}>
              {exporting ? "导出中…" : "导出 ZIP"}
            </button>
          </div>

          <p className="ncos-count">
            {cfgTenant ? <b>{cfgTenant}</b> : <b>{cfgTenants.length}</b>}
            {cfgTenant ? " 命名空间 · " : " 个命名空间 · 共 "}
            {filteredCfgs.length} 个配置
            {filteredCfgs.length !== cfgs.length && `（总计 ${cfgs.length}）`}
          </p>

          <table className="nc-tbl">
            <thead>
              <tr>
                <th>文件（Data ID）</th>
                <th style={{ width: 92 }}>格式</th>
                <th style={{ width: 72 }}>版本</th>
                <th style={{ width: 150 }}>更新时间</th>
                <th className="col-ops" style={{ width: 300 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {cfgTree.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="nc-empty">
                      {cfgs.length === 0 ? "暂无配置。点击「创建配置」新建。" : "没有匹配的配置"}
                    </div>
                  </td>
                </tr>
              )}
              {cfgTree.map(({ tenant, groups }) => {
                const tKey = `t:${tenant}`;
                const tClosed = !!treeCollapsed[tKey];
                const fileCount = groups.reduce((n, g) => n + g.items.length, 0);
                return (
                  <Fragment key={tKey}>
                    <tr
                      className="nc-tree-row nc-lv1"
                      onClick={() => toggleTree(tKey)}
                      title={tClosed ? "展开命名空间" : "收起命名空间"}
                    >
                      <td colSpan={5}>
                        <span className="nc-caret">{tClosed ? "▸" : "▾"}</span>
                        <span className="nc-tree-name">{tenant}</span>
                        <span className="nc-tree-meta">
                          {groups.length} 个分组 · {fileCount} 个文件
                        </span>
                      </td>
                    </tr>
                    {!tClosed &&
                      groups.map(({ group, items }) => {
                        const gKey = `g:${tenant}/${group}`;
                        const gClosed = !!treeCollapsed[gKey];
                        return (
                          <Fragment key={gKey}>
                            <tr
                              className="nc-tree-row nc-lv2"
                              onClick={() => toggleTree(gKey)}
                              title={gClosed ? "展开分组" : "收起分组"}
                            >
                              <td colSpan={5}>
                                <span className="nc-caret">{gClosed ? "▸" : "▾"}</span>
                                <span className="nc-tree-name">{group}</span>
                                <span className="nc-tree-meta">{items.length} 个文件</span>
                              </td>
                            </tr>
                            {!gClosed &&
                              items.map((c) => (
                                <tr key={c.id} className="nc-tree-leaf">
                                  <td>
                                    <span className="nc-leaf-dot" />
                                    <button
                                      className="nc-link"
                                      onClick={() => openWorkbench(c)}
                                      title={c.description || c.data_id}
                                    >
                                      {c.data_id}
                                    </button>
                                    {c.status === "invalid" && (
                                      <span className="tag2 warn" style={{ marginLeft: 6 }}>语法异常</span>
                                    )}
                                  </td>
                                  <td>
                                    <span className={c.format === "yaml" ? "tag2 def" : "tag2 bare"}>
                                      {c.format}
                                    </span>
                                  </td>
                                  <td className="mono">v{c.version}</td>
                                  <td className="meta">
                                    {String(c.updated_at || "").replace("T", " ").slice(0, 16)}
                                  </td>
                                  <td className="col-ops">
                                    <button className="btn mini link" onClick={() => openWorkbench(c)}>
                                      编辑 / 版本
                                    </button>
                                  </td>
                                </tr>
                              ))}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {/* ---- 共享设置 ---- */}
      {tab === "share" && (
        <>
          <div className="cfg-box">
            <div className="info-row">
              <span className="k">全员共享</span>
              <span className="v">
                {project.share_all
                  ? <span className="tag2 ok">已开启 · 所有登录用户可查看</span>
                  : <span className="tag2 bare">未开启</span>}
              </span>
            </div>
            <div className="info-row">
              <span className="k">指定共享</span>
              <span className="v">
                {project.grant_count > 0 ? `${project.grant_count} 人` : "无"}
              </span>
            </div>
            {canManage && (
              <div className="info-row">
                <span className="k">管理入口</span>
                <span className="v">
                  <button className="btn primary" onClick={() => setShareOpen(true)}>打开共享设置</button>
                </span>
              </div>
            )}
          </div>

          {!canManage && <p className="meta">共享设置仅项目负责人或系统管理员可管理。</p>}

          {canManage && share && (
            <>
              {share.grants.length > 0 ? (
                <div className="grant-list">
                  {share.grants.map((g) => (
                    <div key={g.user_id} className="grant-row">
                      <span className="g-name">{g.username}</span>
                      <span className="g-mail">{g.email}</span>
                      {g.perm === "edit"
                        ? <span className="tag2 ok">可编辑</span>
                        : <span className="tag2 bare">可查看</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="meta">暂无指定共享成员{project.share_all ? "，当前为全员共享。" : "。"}</p>
              )}
            </>
          )}
          <p className="meta" style={{ marginTop: 12 }}>
            共享变更保存后立即生效：可查看为全只读，可编辑可维护 nginx / YML 配置与环境变量。
          </p>
        </>
      )}

      {/* 配置工作台：编辑 + 版本时间线 + 版本对比（替代原「详情」「历史版本」两个弹窗） */}
      <ConfigWorkbench
        row={workbenchRow}
        tenant={workbenchRow ? tenantOf(workbenchRow) : ""}
        canEdit={canEdit}
        onClose={() => setWorkbenchRow(null)}
        onSaved={() => {
          loadCfg();
          load();
          window.dispatchEvent(new Event("industries:changed"));
        }}
      />

      {/* 创建配置（Nacos「创建配置」） */}
      <Modal
        title="创建配置"
        open={createOpen}
        onCancel={() => !creating && setCreateOpen(false)}
        onOk={submitCreate}
        confirmLoading={creating}
        okText="发布"
        cancelText="取消"
        width={680}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" preserve={false} initialValues={{ group: "DEFAULT_GROUP" }}>
          <Form.Item
            name="name"
            label="Data ID"
            rules={[
              { required: true, message: "请输入 Data ID" },
              { max: 100, message: "最多 100 个字符" },
            ]}
          >
            <Input placeholder="例如 freight_application.properties" />
          </Form.Item>
          <Form.Item name="group" label="Group">
            <Input placeholder="DEFAULT_GROUP" />
          </Form.Item>
          <Form.Item name="content" label="配置内容">
            <Input.TextArea autoSize={{ minRows: 10, maxRows: 24 }} className="mono" placeholder="粘贴配置原文…" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 整目录推送（curl + tar.gz） */}
      <Modal
        title="目录推送 · 一条命令同步整个 Nacos 目录"
        open={dirOpen}
        onCancel={() => setDirOpen(false)}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setDirOpen(false)}>关闭</button>
            <button className="btn primary" onClick={copyDirCmd} disabled={dirBusy}>
              {dirBusy ? "生成中…" : "复制「正式推送」"}
            </button>
          </div>
        }
        width={780}
        destroyOnClose
      >
        <p className="meta" style={{ marginBottom: 10 }}>
          在 Nacos 所在服务器执行该命令：把 <b>tenant-config-data</b> 目录打成 tar.gz 直接流式上传，
          系统自动逐文件比对并记录差异（新增 / 修改 / 未变 / 失败、增删行数、批次号），全程无需人工挑选文件。
        </p>
        <div className="ncos-toolbar" style={{ marginBottom: 8 }}>
          <span className="meta">Nacos 数据目录</span>
          <input
            className="nc-input"
            style={{ width: 320 }}
            value={dirPath}
            onChange={(e) => setDirPath(e.target.value)}
            placeholder="/iotp/env/nacos/data"
          />
          <span className="meta">该目录下应存在 tenant-config-data/</span>
        </div>
        <div className="nc-sect">
          <div className="nc-sect-head">
            <b>正式推送</b>
            <span className="meta">复制时自动签发 24 小时运维令牌；命令中包含当前项目 ID {id}</span>
          </div>
          <pre className="nc-content">{buildDirCmd(dirToken)}</pre>
        </div>
        <p className="meta" style={{ marginTop: 10 }}>
          返回结果形如 <code>{`{"total":194,"created":2,"staged":3,"unchanged":189,"failed":0}`}</code>；
          正文有变化的配置会先进入「推送差异」面板，确认后才生成新版本；每个改动备注含批次号与 <code>+N -M</code> 行数。
        </p>
      </Modal>

      {/* 共享设置 */}
      <ShareModal
        project={project}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        onSaved={() => { load(); loadShare(); }}
      />
    </div>
  );
}
