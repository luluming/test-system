import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Form, Input, Modal, message } from "antd";
import {
  createEnvVar,
  deleteEnvVar,
  getProject,
  listEnvVars,
  updateEnvVar,
  updateProject,
} from "../api/projects";
import ShareModal from "../components/ShareModal";
import "./dashboard.css";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PERM_TAGS = {
  owner: <span className="tag2 pub">负责人</span>,
  edit: <span className="tag2 ok">可编辑</span>,
  view: <span className="tag2 bare">可查看</span>,
  admin: <span className="tag2 warn">管理员</span>,
};

// 项目详情：基本信息 + nginx / YML 配置入口 + 环境变量管理 + 共享设置
export default function ProjectDetailPage() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const id = Number(projectId);

  const [project, setProject] = useState(null);
  const [error, setError] = useState("");

  // 环境变量
  const [envVars, setEnvVars] = useState([]);
  const [filter, setFilter] = useState("");
  const [envOpen, setEnvOpen] = useState(false);
  const [envTarget, setEnvTarget] = useState(null); // null=新增，否则为编辑对象
  const [envLoading, setEnvLoading] = useState(false);
  const [envForm] = Form.useForm();

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

  const loadEnv = useCallback(async () => {
    try {
      const res = await listEnvVars(id);
      setEnvVars(res.data);
    } catch { /* 列表失败不阻塞页面，403 已由拦截器提示 */ }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadEnv(); }, [loadEnv]);

  const myPerm = project?.my_perm;
  const canEdit = myPerm === "owner" || myPerm === "edit" || myPerm === "admin";
  const canManage = myPerm === "owner" || myPerm === "admin";

  // 键 / 值过滤
  const filteredVars = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    if (!kw) return envVars;
    return envVars.filter(
      (v) => v.key.toLowerCase().includes(kw) || (v.value || "").toLowerCase().includes(kw)
    );
  }, [envVars, filter]);

  // 新增 / 编辑变量
  const openEnvModal = (target) => {
    setEnvTarget(target);
    if (target) {
      envForm.setFieldsValue({ key: target.key, value: target.value, remark: target.remark });
    } else {
      envForm.resetFields();
    }
    setEnvOpen(true);
  };

  const submitEnv = async () => {
    const values = await envForm.validateFields();
    setEnvLoading(true);
    try {
      if (envTarget) {
        await updateEnvVar(id, envTarget.id, { value: values.value, remark: values.remark });
        message.success("变量已更新");
      } else {
        await createEnvVar(id, { key: values.key, value: values.value, remark: values.remark });
        message.success("变量已新增");
      }
      setEnvOpen(false);
      loadEnv();
      load();
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (detail && err.response?.status !== 403) message.error(detail);
    } finally {
      setEnvLoading(false);
    }
  };

  const removeEnv = (v) => {
    Modal.confirm({
      title: `删除变量 ${v.key}？`,
      content: "删除后不可恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await deleteEnvVar(id, v.id);
          message.success("变量已删除");
          loadEnv();
          load();
        } catch (err) {
          const detail = err.response?.data?.detail;
          if (detail && err.response?.status !== 403) message.error(detail);
        }
      },
    });
  };

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
      <div className="page-head">
        <div>
          <h1>
            <span className="meta" style={{ cursor: "pointer" }} onClick={() => navigate(`/industries/${project.industry_id}/projects`)}>
              {project.industry_name}
            </span>
            <span className="meta"> / </span>
            {project.name}
            <span style={{ marginLeft: 10 }}>{PERM_TAGS[myPerm]}</span>
            {myPerm === "view" && <span className="tag2 bare" style={{ marginLeft: 6 }}>只读</span>}
          </h1>
          <p className="sub">
            code：{project.code} · 负责人：{project.owner_name}
            {project.share_all ? " · 全员共享" : project.grant_count > 0 ? ` · 共享给 ${project.grant_count} 人` : ""}
            {project.remark ? ` · ${project.remark}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {canManage && (
            <button className="btn" onClick={() => {
              editForm.setFieldsValue({ name: project.name, remark: project.remark });
              setEditOpen(true);
            }}>编辑信息</button>
          )}
          {canManage && (
            <button className="btn primary" onClick={() => setShareOpen(true)}>共享</button>
          )}
        </div>
      </div>

      {/* 配置入口：Nginx / YML */}
      <div className="mode-switch">
        <div className="mode-card" onClick={() => navigate(`/projects/${id}/ops`)}>
          <span className="m-ico">◈</span>
          <div>
            <div className="m-t">Nginx 配置</div>
            <div className="m-s">{project.nginx_count} 个配置文件 · server / upstream / map 块树编辑与推送</div>
          </div>
        </div>
        <div className="mode-card yml" onClick={() => navigate(`/projects/${id}/yaml`)}>
          <span className="m-ico">🟨</span>
          <div>
            <div className="m-t">YML 配置</div>
            <div className="m-s">{project.yml_count} 个 YAML 文件 · 全文编辑器</div>
          </div>
        </div>
      </div>

      {/* 环境变量 */}
      <div className="page-head" style={{ marginTop: 22 }}>
        <div>
          <h1 style={{ fontSize: 16 }}>环境变量</h1>
          <p className="sub">项目级键值对配置，键名需为合法环境变量名。</p>
        </div>
        {canEdit && (
          <button className="btn primary" onClick={() => openEnvModal(null)}>＋ 新增变量</button>
        )}
      </div>
      <div style={{ marginBottom: 10, maxWidth: 320 }}>
        <Input
          allowClear
          placeholder="搜索键或值"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {filteredVars.length === 0 ? (
        <div className="empty">{envVars.length === 0 ? "暂无环境变量。" : "无匹配结果。"}</div>
      ) : (
        <table className="ov-tbl tbl-anim">
          <thead>
            <tr>
              <th style={{ width: "22%" }}>键</th>
              <th style={{ width: "30%" }}>值</th>
              <th>备注</th>
              <th>更新人</th>
              <th>更新时间</th>
              {canEdit && <th className="col-ops">操作</th>}
            </tr>
          </thead>
          <tbody>
            {filteredVars.map((v) => (
              <tr key={v.id}>
                <td className="mono">{v.key}</td>
                <td>
                  <span
                    className="meta"
                    style={{ display: "inline-block", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}
                    title={v.value}
                  >{v.value}</span>
                </td>
                <td className="meta">{v.remark || "—"}</td>
                <td className="meta">{v.updated_by || "—"}</td>
                <td className="meta">{v.updated_at ? v.updated_at.replace("T", " ").slice(0, 16) : ""}</td>
                {canEdit && (
                  <td className="col-ops">
                    <button className="btn mini" onClick={() => openEnvModal(v)}>编辑</button>
                    <button className="row-delete" onClick={() => removeEnv(v)}>删除</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 新增 / 编辑变量 */}
      <Modal
        title={envTarget ? `编辑变量 · ${envTarget.key}` : "新增变量"}
        open={envOpen}
        onOk={submitEnv}
        onCancel={() => setEnvOpen(false)}
        confirmLoading={envLoading}
        okText="保存"
        cancelText="取消"
        width={460}
        destroyOnClose
      >
        <Form form={envForm} layout="vertical" preserve={false}>
          <Form.Item
            name="key"
            label="键"
            rules={[
              { required: true, message: "请输入键名" },
              { pattern: ENV_KEY_RE, message: "字母或下划线开头，仅字母、数字、下划线" },
              { max: 128, message: "不超过 128 个字符" },
            ]}
          >
            <Input placeholder="如 JAVA_OPTS" autoComplete="off" disabled={!!envTarget} />
          </Form.Item>
          <Form.Item name="value" label="值" rules={[{ required: true, message: "请输入值" }]}>
            <Input.TextArea rows={3} placeholder="变量值" />
          </Form.Item>
          <Form.Item name="remark" label="备注" rules={[{ max: 255, message: "不超过 255 个字符" }]}>
            <Input placeholder="选填" autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>

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
