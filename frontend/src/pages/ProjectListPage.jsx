import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Form, Input, Modal, message } from "antd";
import { getIndustry } from "../api/industry";
import { createProject, deleteProject, listProjects } from "../api/projects";
import { getUser } from "../store/auth";
import ShareModal from "../components/ShareModal";
import "./dashboard.css";

const CODE_RE = /^[a-z0-9-]{1,50}$/;

// 我的权限角标
const PERM_TAGS = {
  owner: <span className="tag2 pub">负责人</span>,
  edit: <span className="tag2 ok">可编辑</span>,
  view: <span className="tag2 bare">可查看</span>,
  admin: <span className="tag2 warn">管理员</span>,
};

// 行业下的项目列表：我创建的 / 共享给我的 / (admin)全部项目
export default function ProjectListPage() {
  const navigate = useNavigate();
  const { industryId } = useParams();
  const id = Number(industryId);
  const isAdmin = getUser()?.role === "admin";

  const [industry, setIndustry] = useState(null);
  const [projects, setProjects] = useState([]);
  const [tab, setTab] = useState("mine");
  const [error, setError] = useState("");

  // 新建项目弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createForm] = Form.useForm();

  // 共享弹窗目标项目
  const [shareTarget, setShareTarget] = useState(null);

  // 删除确认：需输入项目名称二次确认
  const [delTarget, setDelTarget] = useState(null);
  const [delName, setDelName] = useState("");
  const [delLoading, setDelLoading] = useState(false);

  useEffect(() => {
    getIndustry(id).then((res) => setIndustry(res.data)).catch(() => setError("行业信息加载失败"));
  }, [id]);

  const load = useCallback(async (curTab) => {
    try {
      const res = await listProjects({ industry_id: id, tab: curTab });
      setProjects(res.data);
      setError("");
    } catch {
      setError("项目列表加载失败");
    }
  }, [id]);

  useEffect(() => { load(tab); }, [load, tab]);

  // 新建项目：所属行业与 code 创建后不可变更
  const submitCreate = async () => {
    const values = await createForm.validateFields();
    setCreateLoading(true);
    try {
      await createProject({
        industry_id: id,
        name: values.name,
        code: values.code,
        remark: values.remark || undefined,
      });
      message.success("项目已创建");
      setCreateOpen(false);
      createForm.resetFields();
      load(tab);
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (detail) message.error(detail);
    } finally {
      setCreateLoading(false);
    }
  };

  // 删除项目：输入名称完全匹配后才能删除；非空项目后端 409
  const submitDelete = async () => {
    setDelLoading(true);
    try {
      await deleteProject(delTarget.id);
      message.success("项目已删除");
      setDelTarget(null);
      load(tab);
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (detail && err.response?.status !== 403) message.error(detail);
    } finally {
      setDelLoading(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>
            <span className="meta" style={{ cursor: "pointer" }} onClick={() => navigate("/")}>行业</span>
            <span className="meta"> / </span>
            {industry?.name || "…"}
          </h1>
          <p className="sub">行业下的项目列表，项目独立维护 nginx / YML 配置与环境变量。</p>
        </div>
        <button className="btn primary" onClick={() => setCreateOpen(true)}>＋ 新建项目</button>
      </div>

      {/* 页签：我创建的 / 共享给我的 / 全部项目（仅管理员） */}
      <div className="dtabs" style={{ marginBottom: 14, borderRadius: 6 }}>
        <div className={"dtab" + (tab === "mine" ? " on" : "")} onClick={() => setTab("mine")}>我创建的</div>
        <div className={"dtab" + (tab === "shared" ? " on" : "")} onClick={() => setTab("shared")}>共享给我的</div>
        {isAdmin && (
          <div className={"dtab" + (tab === "all" ? " on" : "")} onClick={() => setTab("all")}>全部项目</div>
        )}
      </div>

      {error && (
        <p className="err" style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 10 }}>
          <span>{error}</span>
          <button className="btn mini" onClick={() => load(tab)}>重试</button>
        </p>
      )}
      {projects.length === 0 && !error ? (
        <div className="empty">
          {tab === "mine" ? "暂无我创建的项目，点击「新建项目」创建。" : tab === "shared" ? "暂无共享给我的项目。" : "暂无项目。"}
        </div>
      ) : (
        <table className="ov-tbl tbl-anim clickable">
          <thead>
            <tr>
              <th>项目</th>
              <th>负责人</th>
              <th>我的权限</th>
              <th>配置</th>
              <th>共享</th>
              <th>更新时间</th>
              <th className="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const canManage = p.my_perm === "owner" || p.my_perm === "admin";
              return (
                <tr key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
                  <td>
                    <div className="name-cell">
                      <span className="ico">{p.name.slice(0, 1)}</span>
                      <div>
                        <div>{p.name}</div>
                        <div className="meta">{p.code}{p.remark ? ` · ${p.remark}` : ""}</div>
                      </div>
                    </div>
                  </td>
                  <td className="meta">{p.owner_name}</td>
                  <td>{PERM_TAGS[p.my_perm] || p.my_perm}</td>
                  <td className="meta">nginx {p.nginx_count} · yml {p.yml_count} · 变量 {p.env_count}</td>
                  <td className="meta">
                    {p.share_all ? <span className="tag2 ok">全员</span> : p.grant_count > 0 ? `${p.grant_count} 人` : "—"}
                  </td>
                  <td className="meta">{p.updated_at ? p.updated_at.split("T")[0] : ""}</td>
                  <td className="col-ops">
                    <button className="row-enter" onClick={(e) => { e.stopPropagation(); navigate(`/projects/${p.id}`); }}>进入</button>
                    {canManage && (
                      <button className="btn mini" onClick={(e) => { e.stopPropagation(); setShareTarget(p); }}>共享</button>
                    )}
                    {canManage && (
                      <button
                        className="row-delete"
                        onClick={(e) => { e.stopPropagation(); setDelTarget(p); setDelName(""); }}
                      >删除</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="meta" style={{ padding: "14px 0 24px" }}>
        提示：项目删除前需清空其下 nginx / YML 配置与环境变量；共享变更即时生效。
      </p>

      {/* 新建项目 */}
      <Modal
        title="新建项目"
        open={createOpen}
        onOk={submitCreate}
        onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        confirmLoading={createLoading}
        okText="创建"
        cancelText="取消"
        width={420}
        destroyOnClose
      >
        <p className="meta" style={{ marginTop: 0 }}>创建后不可变更所属行业与项目标识（code）。</p>
        <Form form={createForm} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label="项目名称"
            rules={[
              { required: true, message: "请输入项目名称" },
              { max: 50, message: "不超过 50 个字符" },
            ]}
          >
            <Input placeholder="行业内需唯一" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="code"
            label="项目标识（code）"
            rules={[
              { required: true, message: "请输入项目标识" },
              { pattern: CODE_RE, message: "仅小写字母、数字、中划线，不超过 50 位" },
            ]}
          >
            <Input placeholder="如 demo-a" autoComplete="off" />
          </Form.Item>
          <Form.Item name="remark" label="备注" rules={[{ max: 255, message: "不超过 255 个字符" }]}>
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 删除项目：输入项目名称二次确认 */}
      <Modal
        title={`删除项目 · ${delTarget?.name || ""}`}
        open={!!delTarget}
        onOk={submitDelete}
        onCancel={() => setDelTarget(null)}
        confirmLoading={delLoading}
        okText="删除"
        okButtonProps={{ danger: true, disabled: delName !== delTarget?.name }}
        cancelText="取消"
        width={420}
        destroyOnClose
      >
        <p className="meta">此操作不可恢复。请输入项目名称 <b>{delTarget?.name}</b> 以确认删除：</p>
        <Input value={delName} onChange={(e) => setDelName(e.target.value)} placeholder="输入项目名称" autoComplete="off" />
      </Modal>

      {/* 共享设置 */}
      <ShareModal
        project={shareTarget}
        open={!!shareTarget}
        onClose={() => setShareTarget(null)}
        onSaved={() => load(tab)}
      />
    </div>
  );
}
