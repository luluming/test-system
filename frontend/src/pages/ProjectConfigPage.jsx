import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Form, Input, Modal, message } from "antd";
import { getProject, getShare } from "../api/projects";
import {
  createYamlConfig,
  createPushDirectoryToken,
  deleteYamlConfig,
  exportNacosZip,
  getMetaBase,
  getYamlConfig,
  listYamlVersions,
  nacosViewList,
  saveYamlConfig,
} from "../api/yaml";
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
  const [histRow, setHistRow] = useState(null);
  const [histRows, setHistRows] = useState([]);
  const [histOpenV, setHistOpenV] = useState(null); // 展开的版本号（查看变更内容）
  const [detailRow, setDetailRow] = useState(null);
  const [detailQuery, setDetailQuery] = useState("");
  const [detailCase, setDetailCase] = useState(false);
  const [detailRegex, setDetailRegex] = useState(false);
  const [detailIdx, setDetailIdx] = useState(0); // 当前命中序号（0 基）
  const preRef = useRef(null);
  // 编辑配置（在 Nacos 页内直接编辑，不再跳转到 YAML 工作台）
  const [editRow, setEditRow] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [creating, setCreating] = useState(false);
  const [restRow, setRestRow] = useState(null);
  const [restVer, setRestVer] = useState("");
  const [restBusy, setRestBusy] = useState(false);
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

  // ---- Nacos 配置文件：层级视图 / 导出 / 详情 / 历史 / 编辑 / 还原 / 删除 ----

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

  // 详情内容搜索：支持 大小写敏感 / 正则 两种模式，命中按序编号（mi），供跳转定位
  const { detailSegments, detailMatchCount, detailSearchErr } = useMemo(() => {
    const text = detailRow?.content_text ?? "";
    const q = detailQuery;
    const none = { detailSegments: [{ text, hit: false }], detailMatchCount: 0, detailSearchErr: "" };
    if (!q.trim()) return none;

    if (detailRegex) {
      let re;
      try {
        re = new RegExp(q, detailCase ? "g" : "gi");
      } catch {
        return { detailSegments: [{ text, hit: false }], detailMatchCount: 0, detailSearchErr: "正则表达式无效" };
      }
      const segs = [];
      let last = 0;
      let count = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex += 1; continue; }
        if (m.index > last) segs.push({ text: text.slice(last, m.index), hit: false });
        segs.push({ text: m[0], hit: true, mi: count });
        count += 1;
        last = m.index + m[0].length;
      }
      if (last < text.length) segs.push({ text: text.slice(last), hit: false });
      return { detailSegments: segs, detailMatchCount: count, detailSearchErr: "" };
    }

    const hay = detailCase ? text : text.toLowerCase();
    const needle = detailCase ? q : q.toLowerCase();
    const segs = [];
    let from = 0;
    let count = 0;
    while (true) {
      const idx = hay.indexOf(needle, from);
      if (idx === -1) {
        if (from < text.length) segs.push({ text: text.slice(from), hit: false });
        break;
      }
      if (idx > from) segs.push({ text: text.slice(from, idx), hit: false });
      segs.push({ text: text.slice(idx, idx + q.length), hit: true, mi: count });
      count += 1;
      from = idx + q.length;
    }
    return { detailSegments: segs, detailMatchCount: count, detailSearchErr: "" };
  }, [detailRow, detailQuery, detailCase, detailRegex]);

  // 关键词/模式变化后回到第 1 个命中
  useEffect(() => {
    setDetailIdx(0);
  }, [detailQuery, detailCase, detailRegex, detailRow?.id]);

  // 当前命中自动滚动到视口中央
  useEffect(() => {
    if (!detailMatchCount) return;
    const marks = preRef.current?.querySelectorAll("mark.nc-hit");
    const el = marks && marks[detailIdx];
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [detailIdx, detailMatchCount]);

  const stepMatch = (delta) => {
    if (!detailMatchCount) return;
    setDetailIdx((i) => (i + delta + detailMatchCount) % detailMatchCount);
  };

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

  // 详情：列表项不含全文，单独拉取配置详情
  const openDetail = async (c) => {
    setDetailQuery("");
    setDetailRow({ ...c, content_text: "（加载中…）" });
    try {
      const res = await getYamlConfig(c.id);
      setDetailRow({ ...c, content_text: res.data.content_text, version: res.data.version });
    } catch {
      setDetailRow({ ...c, content_text: "内容加载失败" });
    }
  };

  // 编辑：在当前页弹窗内直接改（Nacos 配置与 YAML 工作台互不干扰，避免跳转异常）
  const openEdit = async (c) => {
    setEditRow({ ...c, content_text: "（加载中…）" });
    setEditContent("");
    setEditNote("");
    try {
      const res = await getYamlConfig(c.id);
      setEditRow({ ...c, version: res.data.version });
      setEditContent(res.data.content_text || "");
    } catch {
      message.error("配置内容加载失败");
      setEditRow(null);
    }
  };

  const submitEdit = async (forceDraft = false) => {
    if (!editRow) return;
    setEditBusy(true);
    try {
      const res = await saveYamlConfig(editRow.id, {
        content: editContent,
        expected_version: editRow.version,
        note: editNote.trim() || undefined,
        force_draft: forceDraft,
      });
      message.success(`已保存，当前版本 v${res.data.version}`);
      setEditRow(null);
      loadCfg();
      load();
      window.dispatchEvent(new Event("industries:changed"));
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (err.response?.status === 422) {
        const errs = Array.isArray(detail?.errors) ? detail.errors : [];
        const text = errs.length ? errs.join("\n") : detail?.message || "语法校验未通过";
        Modal.confirm({
          title: "配置内容语法校验未通过",
          content: (
            <div>
              <pre className="nc-err-pre">{text}</pre>
              <p className="meta">仍要保存为草稿吗？草稿会标记为语法异常，不参与推送。</p>
            </div>
          ),
          okText: "仍保存为草稿",
          cancelText: "返回修改",
          onOk: () => submitEdit(true),
        });
      } else if (err.response?.status === 409) {
        message.error("配置已被他人修改，请刷新列表后重试");
        loadCfg();
      } else {
        message.error(detail?.message || "保存失败");
      }
    } finally {
      setEditBusy(false);
    }
  };

  // 历史版本：读取完整内容用于「变更内容」对比
  const openHistory = async (c) => {
    setHistRow(c);
    setHistRows([]);
    setHistOpenV(null);
    try {
      setHistRows((await listYamlVersions(c.id)).data || []);
    } catch {
      message.error("加载历史版本失败");
    }
  };

  // 行级 diff：对比该版本与上一版本（无上一版本时按全部新增展示）
  const diffLines = (version) => {
    const idx = histRows.findIndex((v) => v.version === version);
    const cur = histRows[idx]?.content || "";
    const prev = histRows[idx + 1]?.content || ""; // 版本列表按倒序返回
    const a = prev ? prev.split("\n") : [];
    const b = cur.split("\n");
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
    let suf = 0;
    while (
      suf < a.length - pre &&
      suf < b.length - pre &&
      a[a.length - 1 - suf] === b[b.length - 1 - suf]
    ) suf += 1;
    const removed = a.slice(pre, a.length - suf);
    const added = b.slice(pre, b.length - suf);
    return { pre: b.slice(0, pre), removed, added, suf: b.slice(b.length - suf) };
  };

  // 每条变更记录相对上一版本的增删行数（用于列表上直观展示）
  const histStats = useMemo(() => {
    const out = {};
    histRows.forEach((v, i) => {
      const prev = histRows[i + 1]?.content || "";
      const cur = v.content || "";
      let added = 0;
      let removed = 0;
      for (const line of cur.split("\n")) {
        if (!prev.split("\n").includes(line)) added += 1;
      }
      for (const line of prev.split("\n")) {
        if (!cur.split("\n").includes(line)) removed += 1;
      }
      out[v.version] = { added, removed };
    });
    return out;
  }, [histRows]);

  // 从系统还原：按版本号把线上原文拉回磁盘（推送统一走「目录推送」）
  const openRestore = async (c) => {
    setRestRow(c);
    setRestVer(String(c.version || 1));
    setRestBusy(true);
    try {
      if (!publicBase) {
        const meta = await getMetaBase();
        setPublicBase(meta.data?.public_base || "");
      }
    } catch { /* 使用默认基址 */ } finally {
      setRestBusy(false);
    }
  };

  const buildRestCmd = (token) =>
    `curl -sS "${publicBase || "http://localhost:8001"}/api/yaml-configs/${restRow?.id}/versions/${restVer || restRow?.version}/raw" \\\n` +
    `  -H "Authorization: Bearer ${token || "<TOKEN>"}" \\\n` +
    `  -o ./${restRow?.data_id || "config.txt"}`;

  const copyRestCmd = async () => {
    setRestBusy(true);
    try {
      if (!publicBase) {
        try {
          const meta = await getMetaBase();
          setPublicBase(meta.data?.public_base || "");
        } catch { /* 用默认基址 */ }
      }
      const token = await ensureDirToken();
      await navigator.clipboard.writeText(buildRestCmd(token));
      message.success(`已复制还原命令（v${restVer || restRow?.version}）`);
    } catch {
      message.error("复制失败，请允许剪贴板权限后重试");
    } finally {
      setRestBusy(false);
    }
  };

  // 整目录推送：一条命令把 Nacos 落盘目录全部同步进来
  const buildDirCmd = (token, dryRun) => {
    const q = `project_id=${id}${dryRun ? "&dry_run=true" : ""}`;
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

  const copyDirCmd = async (dryRun) => {
    setDirBusy(true);
    try {
      if (!publicBase) {
        try {
          const meta = await getMetaBase();
          setPublicBase(meta.data?.public_base || "");
        } catch { /* 用默认基址 */ }
      }
      const token = await ensureDirToken();
      await navigator.clipboard.writeText(buildDirCmd(token, dryRun));
      message.success(
        dryRun
          ? "已复制「试运行」命令：只比对不落库，先确认差异再正式推送"
          : "已复制「正式推送」命令（含 24 小时运维令牌）"
      );
    } catch {
      message.error("复制失败，请允许剪贴板权限后重试");
    } finally {
      setDirBusy(false);
    }
  };

  const removeCfg = (c) => {
    Modal.confirm({
      title: `删除配置「${c.data_id}」？`,
      content: "该配置及其历史版本将一并删除，删除后不可恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await deleteYamlConfig(c.id);
          message.success("已删除");
          loadCfg();
          window.dispatchEvent(new Event("industries:changed"));
        } catch (err) {
          message.error(err.response?.data?.detail || "删除失败");
        }
      },
    });
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
                                      onClick={() => openDetail(c)}
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
                                    <button className="btn mini" onClick={() => openDetail(c)}>详情</button>
                                    <button className="btn mini" onClick={() => openHistory(c)}>历史版本</button>
                                    {canEdit && (
                                      <button className="btn mini link" onClick={() => openEdit(c)}>编辑</button>
                                    )}
                                    {canEdit && (
                                      <button className="btn mini" onClick={() => openRestore(c)}>还原</button>
                                    )}
                                    {canEdit && (
                                      <button className="row-delete" onClick={() => removeCfg(c)}>删除</button>
                                    )}
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

      {/* 详情：查看配置全文（支持内容搜索高亮） */}
      <Modal
        title={`配置详情 · ${detailRow?.data_id || ""}`}
        open={!!detailRow}
        onCancel={() => setDetailRow(null)}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setDetailRow(null)}>关闭</button>
            {canEdit && (
              <button
                className="btn primary"
                onClick={() => {
                  const c = detailRow;
                  setDetailRow(null);
                  openEdit(c);
                }}
              >
                编辑
              </button>
            )}
          </div>
        }
        width={820}
        destroyOnClose
      >
        <div className="nc-detail-meta">
          <span className="meta">命名空间</span>
          <span className="mono">{detailRow ? tenantOf(detailRow) : ""}</span>
          <span className="meta">Group</span>
          <span className="mono">{detailRow?.group}</span>
          <span className="meta">格式</span>
          <span>{detailRow?.format}</span>
          <span className="meta">版本</span>
          <span className="mono">v{detailRow?.version}</span>
        </div>
        <div className="nc-searchbar">
          <input
            className="nc-input nc-search"
            placeholder="在配置内容中搜索…（Enter 下一个，Shift+Enter 上一个）"
            value={detailQuery}
            onChange={(e) => setDetailQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                stepMatch(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <button
            type="button"
            className={"nc-btn nc-tgl" + (detailCase ? " on" : "")}
            title="区分大小写"
            onClick={() => setDetailCase((v) => !v)}
          >
            Aa
          </button>
          <button
            type="button"
            className={"nc-btn nc-tgl" + (detailRegex ? " on" : "")}
            title="正则表达式"
            onClick={() => setDetailRegex((v) => !v)}
          >
            .*
          </button>
          {detailQuery.trim() && (
            <>
              <span className="nc-search-count">
                {detailMatchCount > 0 ? `${detailIdx + 1}/${detailMatchCount}` : "0 处匹配"}
              </span>
              <button type="button" className="nc-btn" onClick={() => stepMatch(-1)} disabled={!detailMatchCount} title="上一个">
                ↑
              </button>
              <button type="button" className="nc-btn" onClick={() => stepMatch(1)} disabled={!detailMatchCount} title="下一个">
                ↓
              </button>
              <button type="button" className="nc-btn" onClick={() => setDetailQuery("")}>清空</button>
            </>
          )}
        </div>
        {detailSearchErr && <p className="nc-regex-err">{detailSearchErr}</p>}
        <pre className="nc-content" ref={preRef}>
          {detailSegments.map((seg, i) =>
            seg.hit ? (
              <mark key={i} className={"nc-hit" + (seg.mi === detailIdx ? " on" : "")}>{seg.text}</mark>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
        </pre>
      </Modal>

      {/* 编辑配置（Nacos 页内编辑，保存时写版本快照，不再跳转到 YAML 工作台） */}
      <Modal
        title={`编辑配置 · ${editRow?.data_id || ""}`}
        open={!!editRow}
        onCancel={() => !editBusy && setEditRow(null)}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setEditRow(null)} disabled={editBusy}>取消</button>
            <button className="btn primary" onClick={() => submitEdit(false)} disabled={editBusy}>
              {editBusy ? "保存中…" : "保存并发布"}
            </button>
          </div>
        }
        width={860}
        destroyOnClose
      >
        <div className="nc-detail-meta">
          <span className="meta">命名空间</span>
          <span className="mono">{editRow ? tenantOf(editRow) : ""}</span>
          <span className="meta">Group</span>
          <span className="mono">{editRow?.group}</span>
          <span className="meta">当前版本</span>
          <span className="mono">v{editRow?.version}</span>
        </div>
        <textarea
          className="nc-editor mono"
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          spellCheck={false}
          placeholder="配置内容加载中…"
        />
        <div className="nc-edit-note">
          <span className="meta">变更说明</span>
          <input
            className="nc-input"
            style={{ flex: 1 }}
            placeholder="选填，例如：修复数据库连接超时"
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
          />
        </div>
      </Modal>

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

      {/* 历史版本 · 变更记录 / 变更内容 */}
      <Modal
        title={`变更记录 · ${histRow?.data_id || ""}`}
        open={!!histRow}
        onCancel={() => setHistRow(null)}
        footer={null}
        width={820}
        destroyOnClose
      >
        {histRows.length === 0 ? (
          <p className="meta">暂无变更记录</p>
        ) : (
          <div style={{ maxHeight: 480, overflowY: "auto" }}>
            {histRows.map((v) => {
              const d = histOpenV === v.version ? diffLines(v.version) : null;
              return (
                <div key={v.id} className="nc-hist">
                  <div className="nc-hist-head">
                    <b className="mono">v{v.version}</b>
                    {v.version === histRows[0].version && (
                      <span className="tag2 ok">当前版本</span>
                    )}
                    <span className="nc-hist-note">{v.note || "（无备注）"}</span>
                    {histStats[v.version] && (histStats[v.version].added > 0 || histStats[v.version].removed > 0) && (
                      <>
                        <span className="tag2 ok">+{histStats[v.version].added}</span>
                        <span className="tag2 warn">-{histStats[v.version].removed}</span>
                      </>
                    )}
                    <span className="meta" style={{ marginLeft: "auto" }}>
                      {v.created_by || "-"} · {v.created_at ? v.created_at.replace("T", " ").slice(0, 16) : "-"}
                    </span>
                    <button
                      className="btn mini"
                      onClick={() => setHistOpenV(histOpenV === v.version ? null : v.version)}
                    >
                      {histOpenV === v.version ? "收起变更" : "查看变更内容"}
                    </button>
                  </div>
                  {d && (
                    <div className="nc-diff">
                      {d.pre.length > 0 && (
                        <pre className="d-ctx">
                          {d.pre.map((l, i) => `${String(i + 1).padStart(4, " ")}  ${l}`).join("\n")}
                        </pre>
                      )}
                      {d.removed.length > 0 && (
                        <pre className="d-del">
                          {d.removed.map((l) => `- ${l}`).join("\n")}
                        </pre>
                      )}
                      {d.added.length > 0 && (
                        <pre className="d-add">
                          {d.added.map((l) => `+ ${l}`).join("\n")}
                        </pre>
                      )}
                      {d.removed.length === 0 && d.added.length === 0 && (
                        <p className="meta" style={{ margin: "6px 0 0" }}>该版本内容与上一版本一致。</p>
                      )}
                      {d.suf.length > 0 && (
                        <pre className="d-ctx" style={{ opacity: 0.6 }}>
                          {d.suf.slice(0, 5).map((l) => `   ${l}`).join("\n")}
                          {d.suf.length > 5 ? "\n   …" : ""}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="meta" style={{ marginTop: 10 }}>
          变更内容以「该版本 vs 上一版本」逐行对比；回滚请进入 YML 工作台 → 历史版本。
        </p>
      </Modal>

      {/* 从系统还原单个配置（推送统一走「目录推送」） */}
      <Modal
        title={`从系统还原 · ${restRow?.data_id || ""}`}
        open={!!restRow}
        onCancel={() => setRestRow(null)}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setRestRow(null)}>关闭</button>
            <button className="btn primary" onClick={copyRestCmd} disabled={restBusy}>
              {restBusy ? "生成中…" : "复制还原命令"}
            </button>
          </div>
        }
        width={700}
        destroyOnClose
      >
        <p className="meta" style={{ marginBottom: 10 }}>
          在 Nacos 所在服务器执行该命令，按指定版本把配置原文拉回磁盘，用于回退或对齐生产文件。
          推送请使用列表上方的「目录推送」，一次同步整个目录，无需逐个文件操作。
        </p>
        <div className="nc-detail-meta" style={{ marginBottom: 10 }}>
          <span className="meta">配置文件</span>
          <span className="mono">{restRow?.data_id}</span>
          <span className="meta">Group</span>
          <span className="mono">{restRow?.group}</span>
        </div>
        <div className="ncos-toolbar" style={{ marginBottom: 8 }}>
          <span className="meta">版本号</span>
          <input
            className="nc-input"
            style={{ width: 90 }}
            value={restVer}
            onChange={(e) => setRestVer(e.target.value.replace(/[^\d]/g, ""))}
            placeholder={`1-${restRow?.version || 1}`}
          />
          <span className="meta">令牌复用「目录推送」签发的 24 小时运维令牌</span>
        </div>
        <pre className="nc-content">{buildRestCmd(dirToken)}</pre>
      </Modal>

      {/* 整目录推送（curl + tar.gz） */}
      <Modal
        title="目录推送 · 一条命令同步整个 Nacos 目录"
        open={dirOpen}
        onCancel={() => setDirOpen(false)}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setDirOpen(false)}>关闭</button>
            <button className="btn" onClick={() => copyDirCmd(true)} disabled={dirBusy}>
              复制「试运行」
            </button>
            <button className="btn primary" onClick={() => copyDirCmd(false)} disabled={dirBusy}>
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
            <b>① 试运行（只比对，不落库）</b>
            <span className="meta">先看差异，确认后再正式推送</span>
          </div>
          <pre className="nc-content">{buildDirCmd(dirToken, true)}</pre>
        </div>
        <div className="nc-sect">
          <div className="nc-sect-head">
            <b>② 正式推送</b>
            <span className="meta">复制时自动签发 24 小时运维令牌；命令中包含当前项目 ID {id}</span>
          </div>
          <pre className="nc-content">{buildDirCmd(dirToken, false)}</pre>
        </div>
        <p className="meta" style={{ marginTop: 10 }}>
          返回结果形如 <code>{`{"total":194,"created":0,"updated":3,"unchanged":191,"failed":0}`}</code>；
          每个改动都会写入变更记录，备注含批次号与 <code>+N -M</code> 行数。
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
