import { useCallback, useEffect, useState } from "react";
import { Button, Form, Input, Modal, Popconfirm, Table, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import client from "../api/client";

// 主页仪表盘：items 列表 + 新建（Modal）+ 删除（Popconfirm）
export default function Dashboard() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  // 拉取 items 列表
  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.get("/items");
      setItems(res.data);
    } catch {
      message.error("获取列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  // 新建 item
  const handleCreate = async (values) => {
    setSubmitting(true);
    try {
      await client.post("/items", values);
      message.success("创建成功");
      setModalOpen(false);
      form.resetFields();
      fetchItems();
    } catch {
      message.error("创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  // 删除 item
  const handleDelete = async (id) => {
    try {
      await client.delete(`/items/${id}`);
      message.success("删除成功");
      fetchItems();
    } catch {
      message.error("删除失败");
    }
  };

  const columns = [
    { title: "ID", dataIndex: "id", key: "id", width: 80 },
    { title: "名称", dataIndex: "name", key: "name" },
    {
      title: "操作",
      key: "action",
      width: 120,
      render: (_, record) => (
        <Popconfirm
          title="确定删除该条目吗？"
          onConfirm={() => handleDelete(record.id)}
        >
          <Button type="link" danger>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      {/* 页面标题与操作栏 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <h2 style={{ margin: 0 }}>条目列表</h2>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setModalOpen(true)}
        >
          新建
        </Button>
      </div>

      {/* items 表格 */}
      <Table rowKey="id" columns={columns} dataSource={items} loading={loading} />

      {/* 新建条目弹窗 */}
      <Modal
        title="新建条目"
        open={modalOpen}
        onOk={() => form.submit()}
        onCancel={() => setModalOpen(false)}
        confirmLoading={submitting}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input placeholder="请输入名称" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
