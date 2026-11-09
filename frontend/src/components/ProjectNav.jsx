import { useNavigate } from "react-router-dom";
import "./projectnav.css";

// 项目内导航：所有项目页面共用同一条「面包屑 + 分区页签」，
// 保证进入项目后能随时区分并切换 概览 / Nginx 配置 / YML 配置 / 配置管理。
const TABS = [
  { key: "overview", label: "概览" },
  { key: "nginx", label: "Nginx 配置" },
  { key: "yaml", label: "YML 配置" },
  { key: "config", label: "Nacos 配置" },
];

// 各分区的计数角标（Nacos 配置 = nacos 导入 + 环境变量）
const COUNT_KEYS = { nginx: ["nginx_count"], yaml: ["yml_count"], config: ["nacos_count", "env_count"] };

function permTag(perm) {
  if (perm === "owner") return <span className="tag2 pub">负责人</span>;
  if (perm === "edit") return <span className="tag2 ok">可编辑</span>;
  if (perm === "view") return <span className="tag2 bare">可查看</span>;
  if (perm === "admin") return <span className="tag2 warn">管理员</span>;
  return null;
}

export default function ProjectNav({ project, active, right = null, panel = false }) {
  const navigate = useNavigate();
  if (!project) return null;

  const go = (key) => {
    const base = `/projects/${project.id}`;
    if (key === "overview") navigate(base);
    else if (key === "nginx") navigate(`${base}/nginx`);
    else if (key === "yaml") navigate(`${base}/yaml`);
    else navigate(`${base}/config`);
  };

  return (
    <div className={`pnav${panel ? " pnav-panel" : ""}`} role="navigation" aria-label="项目导航">
      <span
        className="pnav-back"
        title="返回行业项目列表"
        onClick={() => navigate(`/industries/${project.industry_id}/projects`)}
      >
        ← {project.industry_name || "行业"}
      </span>
      <span className="pnav-sep" />
      <span className="pnav-name" title={project.name} onClick={() => go("overview")}>
        {project.name}
      </span>
      <span className="pnav-code mono">{project.code}</span>
      {permTag(project.my_perm)}
      {project.my_perm === "view" && <span className="tag2 bare">只读</span>}

      <div className="pnav-tabs" role="tablist">
        {TABS.map((t) => {
          const keys = COUNT_KEYS[t.key];
          const n = keys ? keys.reduce((sum, k) => sum + (project[k] || 0), 0) : null;
          return (
            <div
              key={t.key}
              role="tab"
              tabIndex={0}
              aria-selected={active === t.key}
              className={`pnav-tab${active === t.key ? " on" : ""}`}
              onClick={() => go(t.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  go(t.key);
                }
              }}
            >
              {t.label}
              {n != null && <i className="pn-n">{n}</i>}
            </div>
          );
        })}
      </div>

      {right && <div className="pnav-right">{right}</div>}
    </div>
  );
}
