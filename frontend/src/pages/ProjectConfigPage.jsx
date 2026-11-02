import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Form, Input, Modal, message } from "antd";
import {
  createEnvVar,
  deleteEnvVar,
  getProject,
  getShare,
  listEnvVars,
  updateEnvVar,
  updateProject,
} from "../api/projects";
import ProjectNav from "../components/ProjectNav";
import ShareModal from "../components/ShareModal";
import "./dashboard.css";
import "./project.css";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PERM_TAGS = {
  owner: <span className="tag2 pub">负责人</span>,
  edit: <span className="tag2 ok">可编辑</span>,
  view: <span className="tag2 bare">可查看</span>,
  admin: <span className="tag2 warn">管理员</span>,
};

// 配置管理：环境变量 / 项目信息 / 共享设置 —— 项目内的第三个配置分区
export default function ProjectConfigPage() {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const id = Number(projectId);

  const [project, setProject] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("env");

  // 环境变量
  const [envVars, setEnvVars] = useState([]);
  const [filter, setFilter] = useState("");
  const [envOpen, setEnvOpen] = useState(false);
  const [envTarget, setEnvTarget] = useState(null); // null=新增，否则为编辑对象
  const [envLoading, setEnvLoading] = useState(false);
  const [envForm] = Form.useForm();

  // 项目信息
  const [infoForm, setInfoForm] = useState({ name: "", remark: "" });
  const [infoSaving, setInfoSaving] = useState(false);

  // 共享设置
  const [shareOpen, setShareOpen] = useState(false);
  const [share, setShare] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await getProject(id);
      setProject(res.data);
      setInfoForm({ name: res.data.name, remark: res.data.remark || "" });
      setError("");
    } catch (err) {
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

  const loadShare = useCallback(async () => {
    try {
      const res = await getShare(id);
      setShare(res.data);
    } catch { /* 仅负责人可读取共享明细 */ }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadEnv(); }, [loadEnv]);

  const myPerm = project?.my_perm;
  const canEdit = myPerm === "owner" || myPerm === "edit" || myPerm === "admin";
  const canManage = myPerm === "owner" || myPerm === "admin";

  useEffect(() => {
    if (tab === "share" && canManage) loadShare();
  }, [tab, canManage, loadShare]);

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

  // 保存项目信息（名称 / 备注）
  const saveInfo = async () => {
    const name = infoForm.name.trim();
    if (!name) { message.error("请输入项目名称"); return; }
    setInfoSaving(true);
    try {
      await updateProject(id, { name, remark: infoForm.remark || "" });
      message.success("项目信息已更新");
      load();
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (detail && err.response?.status !== 403) message.error(detail);
    } finally {
      setInfoSaving(false);
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
      <ProjectNav project={project} active="config" panel />

      <div className="page-head">
        <div>
          <h1>配置管理</h1>
          <p className="sub">环境变量、项目信息与共享设置，均只作用于当前项目。</p>
        </div>
      </div>

      <div className="dtabs" style={{ marginBottom: 14, borderRadius: 6 }}>
        <div className={"dtab" + (tab === "env" ? " on" : "")} onClick={() => setTab("env")}>
          环境变量 <span className="meta">{envVars.length}</span>
        </div>
        <div className={"dtab" + (tab === "info" ? " on" : "")} onClick={() => setTab("info")}>项目信息</div>
        <div className={"dtab" + (tab === "share" ? " on" : "")} onClick={() => setTab("share")}>共享设置</div>
      </div>

      {/* ---- 环境变量 ---- */}
      {tab === "env" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div style={{ maxWidth: 320, flex: 1 }}>
              <Input
                allowClear
                placeholder="搜索键或值"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {canEdit && (
              <button className="btn primary" onClick={() => openEnvModal(null)}>＋ 新增变量</button>
            )}
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
        </>
      )}

      {/* ---- 项目信息 ---- */}
      {tab === "info" && (
        <>
          <div className="cfg-box">
            <div className="info-row"><span className="k">所属行业</span><span className="v">{project.industry_name}</span></div>
            <div className="info-row"><span className="k">项目名称</span><span className="v">{project.name}</span></div>
            <div className="info-row"><span className="k">项目标识</span><span className="v mono">{project.code}</span></div>
            <div className="info-row"><span className="k">负责人</span><span className="v">{project.owner_name}</span></div>
            <div className="info-row"><span className="k">我的权限</span><span className="v">{PERM_TAGS[myPerm]}</span></div>
            <div className="info-row">
              <span className="k">创建时间</span>
              <span className="v mono">{project.created_at ? project.created_at.replace("T", " ").slice(0, 16) : "—"}</span>
            </div>
            <div className="info-row">
              <span className="k">最近更新</span>
              <span className="v mono">{project.updated_at ? project.updated_at.replace("T", " ").slice(0, 16) : "—"}</span>
            </div>
          </div>

          {canManage ? (
            <div className="cfg-edit">
              <div className="f">
                <label>项目名称</label>
                <input
                  value={infoForm.name}
                  maxLength={50}
                  onChange={(e) => setInfoForm({ ...infoForm, name: e.target.value })}
                  placeholder="不超过 50 个字符"
                />
              </div>
              <div className="f">
                <label>备注</label>
                <textarea
                  rows={2}
                  value={infoForm.remark}
                  maxLength={255}
                  onChange={(e) => setInfoForm({ ...infoForm, remark: e.target.value })}
                  placeholder="选填"
                />
                <div className="hint">项目标识（code）与所属行业创建后不可变更。</div>
              </div>
              <button className="btn primary" onClick={saveInfo} disabled={infoSaving}>
                {infoSaving ? "保存中…" : "保存修改"}
              </button>
            </div>
          ) : (
            <p className="meta">项目信息仅负责人或系统管理员可编辑。</p>
          )}
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
