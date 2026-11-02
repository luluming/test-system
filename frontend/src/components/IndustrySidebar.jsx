import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Input, Modal, message } from "antd";
import { deleteIndustry, listIndustries } from "../api/industry";
import { listProjects } from "../api/projects";
import { getUser } from "../store/auth";
import IndustryFormModal from "../pages/IndustryFormModal";
import "./industrysidebar.css";

// 左侧行业导航：行业树的常驻入口。
// 行业 → 项目 两级展开，当前行业/项目高亮；行业搜索与新建/编辑/删除集中在同一处，
// 进入 Nginx / YML 工作台后仍保留该栏，避免丢失「我在哪个行业/项目」的上下文。
export default function IndustrySidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const isAdmin = getUser()?.role === "admin";

  const [collapsed, setCollapsed] = useState(false);
  const [industries, setIndustries] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  // 拉取行业 + 当前用户可见项目（管理员 all；普通用户 mine + shared 去重）
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const indRes = await listIndustries();
      let list = [];
      if (isAdmin) {
        list = (await listProjects({ tab: "all" })).data || [];
      } else {
        const [mine, shared] = await Promise.all([
          listProjects({ tab: "mine" }),
          listProjects({ tab: "shared" }),
        ]);
        const map = new Map();
        [...(mine.data || []), ...(shared.data || [])].forEach((p) => map.set(p.id, p));
        list = [...map.values()];
      }
      setIndustries(indRes.data || []);
      setProjects(list);
    } catch {
      // 静默失败：导航栏不阻塞主内容区
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  // 行业页或其他位置修改行业后，通过自定义事件通知导航栏刷新
  useEffect(() => {
    const onChanged = () => load();
    window.addEventListener("industries:changed", onChanged);
    return () => window.removeEventListener("industries:changed", onChanged);
  }, [load]);

  // 当前路由所在行业 / 项目
  const routeIndustryId = useMemo(() => {
    const m = location.pathname.match(/^\/industries\/(\d+)\//);
    if (m) return Number(m[1]);
    return null;
  }, [location.pathname]);

  const routeProjectId = useMemo(() => {
    const m = location.pathname.match(/^\/projects\/(\d+)/);
    return m ? Number(m[1]) : null;
  }, [location.pathname]);

  const currentIndustryId = useMemo(() => {
    if (routeIndustryId) return routeIndustryId;
    if (!routeProjectId) return null;
    return projects.find((p) => p.id === routeProjectId)?.industry_id ?? null;
  }, [routeIndustryId, routeProjectId, projects]);

  // 进入项目/行业时自动展开对应行业
  useEffect(() => {
    if (!currentIndustryId) return;
    setExpanded((prev) => {
      if (prev.has(currentIndustryId)) return prev;
      const next = new Set(prev);
      next.add(currentIndustryId);
      return next;
    });
  }, [currentIndustryId]);

  const byIndustry = useMemo(() => {
    const map = new Map();
    projects.forEach((p) => {
      if (!map.has(p.industry_id)) map.set(p.industry_id, []);
      map.get(p.industry_id).push(p);
    });
    return map;
  }, [projects]);

  const kw = keyword.trim().toLowerCase();
  const rows = useMemo(() => {
    return industries
      .map((ind) => {
        const all = byIndustry.get(ind.id) || [];
        const indMatch = !kw || ind.name.toLowerCase().includes(kw) || ind.code.toLowerCase().includes(kw);
        const matched = kw
          ? all.filter((p) => p.name.toLowerCase().includes(kw) || p.code.toLowerCase().includes(kw))
          : all;
        return { ind, projects: indMatch ? all : matched, visible: indMatch || matched.length > 0 };
      })
      .filter((r) => r.visible);
  }, [industries, byIndustry, kw]);

  const templates = useMemo(() => industries.filter((i) => i.is_template), [industries]);

  const toggle = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (ind) => {
    setEditing(ind);
    setFormOpen(true);
  };

  // 删除行业（仅 admin）：有项目时后端 409；scope=both 需依次清两侧数据
  const removeIndustry = (ind) => {
    Modal.confirm({
      title: `删除行业「${ind.name}」？`,
      content: "将删除该行业及其下全部配置数据，删除后不可恢复。行业下存在项目时不可删除。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          if (ind.scope === "both") {
            await deleteIndustry(ind.id, "nginx");
            await deleteIndustry(ind.id, "yml");
          } else {
            await deleteIndustry(ind.id, ind.scope === "yml" ? "yml" : "nginx");
          }
          message.success("行业已删除");
          if (currentIndustryId === ind.id) navigate("/");
          load();
        } catch (err) {
          const detail = err.response?.data?.detail;
          message.error(typeof detail === "string" ? detail : "删除失败");
        }
      },
    });
  };

  const onSaved = () => {
    load();
    window.dispatchEvent(new Event("industries:changed"));
  };

  if (collapsed) {
    return (
      <aside className="sh-sidebar collapsed">
        <div className="sb-rail">
          <button className="sb-iconbtn" title="展开行业导航" onClick={() => setCollapsed(false)}>
            ☰
          </button>
          <span className="sb-rail-txt">行业导航</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sh-sidebar">
      <div className="sb-head">
        <span className="sb-title">行业导航</span>
        <span className="sb-total" title="行业总数">{industries.length}</span>
        <button className="sb-iconbtn sb-collapse" title="折叠行业导航" onClick={() => setCollapsed(true)}>
          «
        </button>
      </div>

      <div className="sb-search">
        <Input
          size="small"
          allowClear
          placeholder="搜索行业 / 项目"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      <div className="sb-tree">
        {loading && <p className="sb-empty">加载中…</p>}
        {!loading && rows.length === 0 && <p className="sb-empty">未找到匹配的行业</p>}

        {rows.map(({ ind, projects: ps }) => {
          const open = expanded.has(ind.id) || (!!kw && ps.length > 0);
          const activeInd = ind.id === currentIndustryId;
          return (
            <div className="sb-ind" key={ind.id}>
              <div
                className={`sb-ind-row${activeInd ? " on" : ""}`}
                title={ind.name}
                onClick={() => {
                  toggle(ind.id);
                  navigate(`/industries/${ind.id}/projects`);
                }}
              >
                <span className="sb-caret" onClick={(e) => { e.stopPropagation(); toggle(ind.id); }}>
                  {open ? "▾" : "▸"}
                </span>
                <span className="sb-ind-name">{ind.name}</span>
                {ind.is_template && <span className="sb-tpl" title="模板源行业">模</span>}
                <span className="sb-count" title="可见项目数">{ps.length}</span>
                {isAdmin && (
                  <span className="sb-acts">
                    <button
                      className="sb-act"
                      title="编辑行业"
                      onClick={(e) => { e.stopPropagation(); openEdit(ind); }}
                    >✎</button>
                    <button
                      className="sb-act danger"
                      title={ind.is_template ? "模板源行业禁止删除" : "删除行业"}
                      onClick={(e) => { e.stopPropagation(); removeIndustry(ind); }}
                    >✕</button>
                  </span>
                )}
              </div>

              {open && (
                <div className="sb-projs">
                  {ps.length === 0 && <div className="sb-proj empty">暂无项目</div>}
                  {ps.map((p) => (
                    <div
                      key={p.id}
                      className={`sb-proj${p.id === routeProjectId ? " on" : ""}`}
                      title={`${p.name} · ${p.code}`}
                      onClick={() => navigate(`/projects/${p.id}`)}
                    >
                      <span className="sb-proj-dot" />
                      <span className="sb-proj-name">{p.name}</span>
                    </div>
                  ))}
                  <div
                    className="sb-proj-add"
                    onClick={() => navigate(`/industries/${ind.id}/projects`)}
                  >
                    ＋ 新建项目
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="sb-foot">
        {isAdmin ? (
          <>
            <button className="btn primary sb-new" onClick={openCreate}>＋ 新建行业</button>
            <button className="sb-manage" onClick={() => navigate("/")}>行业管理 →</button>
          </>
        ) : (
          <button className="btn sb-new" onClick={() => navigate("/")}>行业总览</button>
        )}
      </div>

      <IndustryFormModal
        open={formOpen}
        mode={editing ? "edit" : "create"}
        industry={editing}
        templates={templates}
        onClose={() => setFormOpen(false)}
        onSaved={onSaved}
      />
    </aside>
  );
}
