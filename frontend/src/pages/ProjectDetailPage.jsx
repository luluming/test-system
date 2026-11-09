import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Form, Input, Modal, message } from "antd";
import { getProject, updateProject } from "../api/projects";
import ProjectNav from "../components/ProjectNav";
import ShareModal from "../components/ShareModal";
import "./dashboard.css";
import "./project.css";

// 项目概览：基本信息 + 三个配置分区入口（Nginx / YML / 配置管理）
// 进入项目后由 ProjectNav 统一区分各分区，页面只做入口与概况呈现。
const SECTIONS = [
  {
    key: "nginx",
    ico: "◈",
    title: "Nginx 配置",
    desc: "server / upstream / map 块树编辑，镜像同步与配置推送",
    unit: "个配置文件",
    path: (id) => `/projects/${id}/nginx`,
    count: (p) => p.nginx_count,
  },
  {
    key: "yml",
    ico: "▤",
    title: "YML 配置",
    desc: "YAML 全文编辑器、结构树定位与版本对比",
    unit: "个 YAML 文件",
    path: (id) => `/projects/${id}/yaml`,
    count: (p) => p.yml_count,
  },
  {
    key: "cfg",
    ico: "☁",
    title: "Nacos 配置",
    desc: "Nacos 风格配置中心，按 dataId/group 管理、推送与还原",
    unit: "个配置项",
    path: (id) => `/projects/${id}/config`,
    count: (p) => (p.nacos_count || 0) + (p.env_count || 0),
  },
];

export default function ProjectDetailPage() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const id = Number(projectId);

  const [project, setProject] = useState(null);
  const [error, setError] = useState("");

  // 共享 / 编辑项目信息
  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const res = await getProject(id);
      setProject(res.data);
      setError("");
    } catch (err) {
      // 无权限访问：跳 403 页
      if (err.response?.status === 403) {
        navigate("/403", { replace: true });
      } else {
        setError("项目信息加载失败");
      }
    }
  }, [id, navigate]);

  useEffect(() => { load(); }, [load]);

  const canManage = project?.my_perm === "owner" || project?.my_perm === "admin";

  // 编辑项目信息（名称 / 备注）
  const submitEdit = async () => {
    const values = await editForm.validateFields();
    setEditLoading(true);
    try {
      await updateProject(id, { name: values.name, remark: values.remark || "" });
      message.success("项目信息已更新");
      setEditOpen(false);
      load();
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (detail && err.response?.status !== 403) message.error(detail);
    } finally {
      setEditLoading(false);
    }
  };

  const enter = (sec) => navigate(sec.path(id));

  if (error) {
    return (
      <p className="err" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>{error}</span>
        <button className="btn mini" onClick={load}>重试</button>
      </p>
    );
  }
  if (!project) return <p className="meta">加载中…</p>;

  const shareText = project.share_all
    ? "全员共享（所有登录用户可查看）"
    : project.grant_count > 0
      ? `共享给 ${project.grant_count} 人`
      : "仅负责人可用";

  return (
    <div>
      <ProjectNav project={project} active="overview" panel />

      <div className="proj-hero">
        <div>
          <h2>{project.name}</h2>
          <p className="sub">
            {project.industry_name} · code：{project.code} · 负责人：{project.owner_name}
            {project.remark ? ` · ${project.remark}` : ""}
          </p>
        </div>
        {canManage && (
          <div className="proj-hero-actions">
            <button
              className="btn"
              onClick={() => {
                editForm.setFieldsValue({ name: project.name, remark: project.remark });
                setEditOpen(true);
              }}
            >编辑信息</button>
            <button className="btn primary" onClick={() => setShareOpen(true)}>共享设置</button>
          </div>
        )}
      </div>

      <div className="proj-facts">
        <div className="fact"><small>负责人</small><span>{project.owner_name}</span></div>
        <div className="fact"><small>共享范围</small><span>{shareText}</span></div>
        <div className="fact">
          <small>我的权限</small>
          <span>
            {project.my_perm === "owner" ? "负责人（可管理）"
              : project.my_perm === "admin" ? "系统管理员"
                : project.my_perm === "edit" ? "可编辑"
                  : "只读查看"}
          </span>
        </div>
        <div className="fact">
          <small>最近更新</small>
          <span>{project.updated_at ? project.updated_at.replace("T", " ").slice(0, 16) : "—"}</span>
        </div>
      </div>

      <div className="sec-title">
        <h3>配置分区</h3>
        <span className="meta">选择要进入的工作区，各分区独立维护，互不影响</span>
      </div>
      <div className="sec-grid">
        {SECTIONS.map((sec) => (
          <div
            key={sec.key}
            className={`sec-card ${sec.key}`}
            role="button"
            tabIndex={0}
            onClick={() => enter(sec)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                enter(sec);
              }
            }}
          >
            <div className="sc-head">
              <span className="sc-ico">{sec.ico}</span>
              <div>
                <div className="sc-t">{sec.title}</div>
                <div className="sc-s">{sec.desc}</div>
              </div>
            </div>
            <div className="sc-foot">
              <span className="sc-num">{sec.count(project)}</span>
              <span className="sc-unit">{sec.unit}</span>
              <span className="sc-go">进入 →</span>
            </div>
          </div>
        ))}
      </div>

      {/* 编辑项目信息 */}
      <Modal
        title="编辑项目信息"
        open={editOpen}
        onOk={submitEdit}
        onCancel={() => setEditOpen(false)}
        confirmLoading={editLoading}
        okText="保存"
        cancelText="取消"
        width={420}
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="项目名称"
            rules={[
              { required: true, message: "请输入项目名称" },
              { max: 50, message: "不超过 50 个字符" },
            ]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="remark" label="备注" rules={[{ max: 255, message: "不超过 255 个字符" }]}>
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 共享设置 */}
      <ShareModal
        project={project}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        onSaved={load}
      />
    </div>
  );
}
