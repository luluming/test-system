import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Table,
  Tabs,
  Tag,
  message,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import {
  createBizPort,
  createDomainMapping,
  createForwardPort,
  createNginxConfig,
  deleteBizPort,
  deleteDomainMapping,
  deleteForwardPort,
  deleteNginxConfig,
  listBizPorts,
  listDomainMappings,
  listForwardPorts,
  listNginxConfigs,
  updateBizPort,
  updateDomainMapping,
  updateForwardPort,
  updateNginxConfig,
} from "../api/nginx";

// 可复用 CRUD 资源表格：列表 + 内联开关 + 新建/编辑弹窗 + 删除
function ResourceTable({
  list,
  create,
  update,
  remove,
  columns,
  toggles,
  formFields,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await list();
      setRows(res.data);
    } catch {
      message.error("获取列表失败");
    } finally {
      setLoading(false);
    }
  }, [list]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (record) => {
    setEditing(record);
    form.setFieldsValue(record);
    setModalOpen(true);
  };

  // 内联开关：改为变更字段并调用 update 接口
  const handleToggle = async (record, field) => {
    try {
      const next = !record[field];
      await update(record.id, { [field]: next });
      message.success("更新成功");
      fetchRows();
    } catch {
      message.error("更新失败");
    }
  };

  const handleSubmit = async (values) => {
    setSubmitting(true);
    try {
      if (editing) {
        await update(editing.id, values);
        message.success("保存成功");
      } else {
        await create(values);
        message.success("创建成功");
      }
      setModalOpen(false);
      fetchRows();
    } catch {
      message.error("保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await remove(id);
      message.success("删除成功");
      fetchRows();
    } catch {
      message.error("删除失败");
    }
  };

  // 内联开关列
  const toggleColumns = (toggles || []).map((t) => ({
    title: t.label,
    key: t.dataIndex,
    width: 130,
    render: (_, record) => (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Switch
          checked={record[t.dataIndex]}
          onChange={() => handleToggle(record, t.dataIndex)}
        />
        {t.tagText && (
          <Tag color={record[t.dataIndex] ? t.tagColor.true : t.tagColor.false}>
            {record[t.dataIndex] ? t.tagText.true : t.tagText.false}
          </Tag>
        )}
      </div>
    ),
  }));

  const allColumns = [
    ...columns,
    ...toggleColumns,
    {
      title: "操作",
      key: "action",
      width: 120,
      render: (_, record) => (
        <>
          <Button type="link" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确定删除该记录吗？"
            onConfirm={() => handleDelete(record.id)}
          >
            <Button type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </>
      ),
    },
  ];

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <h3 style={{ margin: 0 }}>{editing ? "编辑" : "新建"}</h3>
      </div>
      <Table
        rowKey="id"
        columns={allColumns}
        dataSource={rows}
        loading={loading}
        size="middle"
      />
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={openCreate}
        style={{ marginTop: 12 }}
      >
        新建
      </Button>
      <Modal
        title={editing ? "编辑记录" : "新建记录"}
        open={modalOpen}
        onOk={() => form.submit()}
        onCancel={() => setModalOpen(false)}
        confirmLoading={submitting}
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          {formFields.map((f) => (
            <Form.Item
              key={f.name}
              name={f.name}
              label={f.label}
              initialValue={f.initialValue}
              rules={f.rules || []}
            >
              {f.control()}
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </>
  );
}

// ---- 各资源表单字段 ----
const nginxFields = [
  {
    name: "name",
    label: "配置名",
    rules: [{ required: true, message: "请输入配置名" }],
    control: () => <Input placeholder="例如 shop.server" />,
  },
  {
    name: "domain",
    label: "服务域名",
    rules: [{ required: true, message: "请输入域名" }],
    control: () => <Input placeholder="例如 shop.example.com" />,
  },
  {
    name: "config_text",
    label: "nginx 配置正文",
    rules: [{ required: true, message: "请输入配置正文" }],
    control: () => (
      <Input.TextArea rows={6} style={{ fontFamily: "monospace" }} />
    ),
  },
  {
    name: "enabled",
    label: "启用",
    initialValue: true,
    control: () => <Switch />,
  },
];

const mappingFields = [
  {
    name: "domain",
    label: "域名",
    rules: [{ required: true, message: "请输入域名" }],
    control: () => <Input placeholder="例如 api.example.com" />,
  },
  {
    name: "forward_tos",
    label: "转发目标 (host:port)",
    rules: [{ required: true, message: "请输入转发目标" }],
    control: () => <Input placeholder="例如 127.0.0.1:8000" />,
  },
  {
    name: "protocol",
    label: "协议",
    initialValue: "http",
    control: () => (
      <Select
        options={[
          { value: "http", label: "Http" },
          { value: "https", label: "Https" },
        ]}
      />
    ),
  },
  {
    name: "description",
    label: "备注 / 服务名",
    control: () => <Input placeholder="例如 主站网关" />,
  },
  {
    name: "enabled",
    label: "启用",
    initialValue: true,
    control: () => <Switch />,
  },
];

const forwardFields = [
  {
    name: "listen_port",
    label: "监听端口",
    rules: [{ required: true, message: "请输入监听端口" }],
    control: () => (
      <InputNumber min={1} max={65535} style={{ width: "100%" }} />
    ),
  },
  {
    name: "upstream_target",
    label: "上游目标 (host:port)",
    rules: [{ required: true, message: "请输入上游目标" }],
    control: () => <Input placeholder="例如 127.0.0.1:9001" />,
  },
  {
    name: "service_name",
    label: "业务服务名",
    control: () => <Input placeholder="例如 order-svc" />,
  },
  {
    name: "protocol",
    label: "协议",
    initialValue: "http",
    control: () => (
      <Select
        options={[
          { value: "http", label: "Http" },
          { value: "https", label: "Https" },
        ]}
      />
    ),
  },
  {
    name: "enabled",
    label: "启用",
    initialValue: true,
    control: () => <Switch />,
  },
];

const bizFields = [
  {
    name: "service_name",
    label: "业务服务名",
    rules: [{ required: true, message: "请输入服务名" }],
    control: () => <Input placeholder="例如 order-svc" />,
  },
  {
    name: "port",
    label: "启动端口",
    rules: [{ required: true, message: "请输入端口" }],
    control: () => (
      <InputNumber min={1} max={65535} style={{ width: "100%" }} />
    ),
  },
  {
    name: "protocol",
    label: "协议",
    initialValue: "tcp",
    control: () => (
      <Select
        options={[
          { value: "tcp", label: "Tcp" },
          { value: "udp", label: "Udp" },
        ]}
      />
    ),
  },
  {
    name: "public_exposed",
    label: "开放到公网",
    initialValue: false,
    control: () => <Switch />,
  },
  {
    name: "note",
    label: "说明",
    control: () => <Input placeholder="端口用途说明" />,
  },
];

export default function OpsConsole() {
  return (
    <div>
      <h2 style={{ margin: "0 0 4px" }}>运维配置</h2>
      <p style={{ color: "#808090", margin: "0 0 16px" }}>
        nginx 配置 · 域名映射 · 转发端口 · 业务端口公网开放统一管理（仅配置记录，不做运行时变更）
      </p>
      <Tabs
        items={[
          {
            key: "nginx",
            label: "nginx 配置",
            children: (
              <ResourceTable
                list={listNginxConfigs}
                create={createNginxConfig}
                update={updateNginxConfig}
                remove={deleteNginxConfig}
                columns={[
                  { title: "名称", dataIndex: "name", key: "name" },
                  { title: "域名", dataIndex: "domain", key: "domain" },
                  {
                    title: "配置正文",
                    dataIndex: "config_text",
                    key: "config_text",
                    ellipsis: true,
                  },
                ]}
                toggles={[{ dataIndex: "enabled", label: "启用" }]}
                formFields={nginxFields}
              />
            ),
          },
          {
            key: "mapping",
            label: "域名映射",
            children: (
              <ResourceTable
                list={listDomainMappings}
                create={createDomainMapping}
                update={updateDomainMapping}
                remove={deleteDomainMapping}
                columns={[
                  { title: "域名", dataIndex: "domain", key: "domain" },
                  {
                    title: "转发目标",
                    dataIndex: "forward_tos",
                    key: "forward_tos",
                  },
                  {
                    title: "协议",
                    dataIndex: "protocol",
                    key: "protocol",
                    width: 90,
                    render: (v) => <Tag>{v?.toUpperCase()}</Tag>,
                  },
                  {
                    title: "备注",
                    dataIndex: "description",
                    key: "description",
                  },
                ]}
                toggles={[{ dataIndex: "enabled", label: "启用" }]}
                formFields={mappingFields}
              />
            ),
          },
          {
            key: "forward",
            label: "转发端口",
            children: (
              <ResourceTable
                list={listForwardPorts}
                create={createForwardPort}
                update={updateForwardPort}
                remove={deleteForwardPort}
                columns={[
                  {
                    title: "监听端口",
                    dataIndex: "listen_port",
                    key: "listen_port",
                    width: 100,
                  },
                  {
                    title: "上游目标",
                    dataIndex: "upstream_target",
                    key: "upstream_target",
                  },
                  {
                    title: "服务名",
                    dataIndex: "service_name",
                    key: "service_name",
                  },
                  {
                    title: "协议",
                    dataIndex: "protocol",
                    key: "protocol",
                    width: 90,
                    render: (v) => <Tag>{v?.toUpperCase()}</Tag>,
                  },
                ]}
                toggles={[{ dataIndex: "enabled", label: "启用" }]}
                formFields={forwardFields}
              />
            ),
          },
          {
            key: "biz",
            label: "业务端口·公网",
            children: (
              <ResourceTable
                list={listBizPorts}
                create={createBizPort}
                update={updateBizPort}
                remove={deleteBizPort}
                columns={[
                  {
                    title: "服务名",
                    dataIndex: "service_name",
                    key: "service_name",
                  },
                  {
                    title: "端口",
                    dataIndex: "port",
                    key: "port",
                    width: 100,
                  },
                  {
                    title: "协议",
                    dataIndex: "protocol",
                    key: "protocol",
                    width: 90,
                    render: (v) => <Tag>{v?.toUpperCase()}</Tag>,
                  },
                  {
                    title: "说明",
                    dataIndex: "note",
                    key: "note",
                  },
                ]}
                toggles={[
                  {
                    dataIndex: "public_exposed",
                    label: "开放公网",
                    tagText: { true: "公网开放", false: "内网专用" },
                    tagColor: { true: "red", false: "green" },
                  },
                ]}
                formFields={bizFields}
              />
            ),
          },
        ]}
      />
    </div>
  );
}