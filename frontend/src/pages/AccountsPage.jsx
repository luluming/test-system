import { useCallback, useEffect, useState } from "react";
import { Form, Input, Modal, message } from "antd";
import {
  createAccount,
  deleteAccount,
  listAccounts,
  resetAccountPassword,
  setAccountStatus,
} from "../api/accounts";
import "./dashboard.css";

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,49}$/;
const PWD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;

// 账号管理（仅系统管理员可见，路由层已拦截非 admin）
export default function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 新建账号弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createForm] = Form.useForm();

  // 重置密码：目标账号 + 结果（后端生成的新密码，展示一次供复制）
  const [resetTarget, setResetTarget] = useState(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetResult, setResetResult] = useState("");
  const [resetForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAccounts();
      setAccounts(res.data);
      setError("");
    } catch {
      setError("账号列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 新建账号
  const submitCreate = async () => {
    const values = await createForm.validateFields();
    setCreateLoading(true);
    try {
      await createAccount(values);
      message.success("账号已创建");
      setCreateOpen(false);
      createForm.resetFields();
      load();
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (detail) message.error(detail);
    } finally {
      setCreateLoading(false);
    }
  };

  // 启用/停用：停用前二次确认（停用后所有登录态立即失效）
  const toggleStatus = (acc) => {
    if (acc.is_active) {
      Modal.confirm({
        title: `停用账号 ${acc.username}？`,
        content: "停用后该账号所有登录态立即失效，需重新启用后才能登录。",
        okText: "停用",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: async () => {
          await setAccountStatus(acc.id, false);
          message.success("账号已停用");
          load();
        },
      });
    } else {
      setAccountStatus(acc.id, true).then(() => {
        message.success("账号已启用");
        load();
      });
    }
  };

  // 重置密码：成功后展示后端返回的新密码
  const submitReset = async () => {
    const values = await resetForm.validateFields();
    setResetLoading(true);
    try {
      const res = await resetAccountPassword(resetTarget.id, values.new_password);
      setResetResult(res.data?.password || values.new_password);
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (detail) message.error(detail);
    } finally {
      setResetLoading(false);
    }
  };

  const copyResetResult = async () => {
    try {
      await navigator.clipboard.writeText(resetResult);
      message.success("已复制到剪贴板");
    } catch {
      message.warning("复制失败，请手动选择复制");
    }
  };

  // 删除账号：名下有项目时禁止（按钮置灰），否则二次确认
  const removeAccount = (acc) => {
    Modal.confirm({
      title: `删除账号 ${acc.username}？`,
      content: "删除后不可恢复，该账号将无法再登录系统。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await deleteAccount(acc.id);
          message.success("账号已删除");
          load();
        } catch (err) {
          const detail = err.response?.data?.detail;
          if (detail) message.error(detail);
        }
      },
    });
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>账号管理</h1>
          <p className="sub">系统账号统一由管理员创建与维护，停用即刻失效，删除前需清空名下项目。</p>
        </div>
        <button className="btn primary" onClick={() => setCreateOpen(true)}>＋ 新建账号</button>
      </div>

      {error && (
        <p className="err" style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 10 }}>
          <span>{error}</span>
          <button className="btn mini" onClick={load}>重试</button>
        </p>
      )}
      {accounts.length === 0 && !error && !loading ? (
        <div className="empty">暂无账号。</div>
      ) : (
        <table className="ov-tbl tbl-anim">
          <thead>
            <tr>
              <th>用户名</th>
              <th>邮箱</th>
              <th>角色</th>
              <th>名下项目</th>
              <th>状态</th>
              <th>创建时间</th>
              <th className="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((acc) => {
              const isAdmin = acc.role === "admin";
              return (
                <tr key={acc.id}>
                  <td>
                    <div className="name-cell">
                      <span className="ico">{acc.username.slice(0, 1).toUpperCase()}</span>
                      <div>
                        <div>{acc.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="meta">{acc.email || "—"}</td>
                  <td>{isAdmin ? <span className="tag2 pub">管理员</span> : <span className="tag2 def">普通用户</span>}</td>
                  <td className="meta">{acc.project_count}</td>
                  <td>{acc.is_active ? <span className="tag2 ok">启用</span> : <span className="tag2 none">停用</span>}</td>
                  <td className="meta">{acc.created_at ? acc.created_at.split("T")[0] : ""}</td>
                  <td className="col-ops">
                    {isAdmin ? (
                      <span className="meta">系统预置</span>
                    ) : (
                      <>
                        <button className="btn mini" onClick={() => toggleStatus(acc)}>
                          {acc.is_active ? "停用" : "启用"}
                        </button>
                        <button
                          className="btn mini"
                          onClick={() => { setResetTarget(acc); setResetResult(""); resetForm.resetFields(); }}
                        >重置密码</button>
                        <button
                          className="row-delete"
                          disabled={acc.project_count > 0}
                          title={acc.project_count > 0 ? `该账号名下有 ${acc.project_count} 个项目，请先转移或删除` : "删除账号"}
                          onClick={() => removeAccount(acc)}
                        >删除</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="meta" style={{ padding: "14px 0 24px" }}>
        提示：停用账号后其所有登录态立即失效；账号名下存在项目时不可删除。
      </p>

      {/* 新建账号 */}
      <Modal
        title="新建账号"
        open={createOpen}
        onOk={submitCreate}
        onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        confirmLoading={createLoading}
        okText="创建"
        cancelText="取消"
        width={420}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" preserve={false}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: "请输入用户名" },
              { pattern: USERNAME_RE, message: "字母开头，3-50 位字母、数字或下划线" },
            ]}
          >
            <Input placeholder="字母开头，3-50 位字母、数字或下划线" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: "请输入邮箱" },
              { type: "email", message: "邮箱格式不正确" },
            ]}
          >
            <Input placeholder="用于找回密码" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            rules={[
              { required: true, message: "请输入初始密码" },
              { pattern: PWD_RE, message: "至少 8 位，需同时包含字母和数字" },
            ]}
          >
            <Input.Password placeholder="至少 8 位，包含字母和数字" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码 */}
      <Modal
        title={resetTarget ? `重置密码 · ${resetTarget.username}` : "重置密码"}
        open={!!resetTarget}
        onCancel={() => { setResetTarget(null); setResetResult(""); }}
        footer={resetResult ? (
          <>
            <button className="btn" onClick={copyResetResult}>复制密码</button>
            <button className="btn primary" onClick={() => { setResetTarget(null); setResetResult(""); }}>完成</button>
          </>
        ) : undefined}
        onOk={submitReset}
        confirmLoading={resetLoading}
        okText="重置"
        cancelText="取消"
        width={420}
        destroyOnClose
      >
        {resetResult ? (
          <div>
            <p className="meta" style={{ marginTop: 0 }}>新密码已生成，请复制并转交使用者（仅展示一次）：</p>
            <Input value={resetResult} readOnly onFocus={(e) => e.target.select()} />
          </div>
        ) : (
          <Form form={resetForm} layout="vertical" preserve={false}>
            <Form.Item
              name="new_password"
              label="新密码"
              rules={[
                { required: true, message: "请输入新密码" },
                { pattern: PWD_RE, message: "至少 8 位，需同时包含字母和数字" },
              ]}
            >
              <Input.Password placeholder="至少 8 位，包含字母和数字" autoComplete="new-password" />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  );
}
