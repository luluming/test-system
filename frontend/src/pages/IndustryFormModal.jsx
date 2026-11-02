import { useEffect, useState } from "react";
import { Checkbox, Form, Input, Modal, Select, message } from "antd";
import { cloneIndustry, createIndustry, updateIndustry } from "../api/industry";

// 常用行业预设：点击后填入名称与 code，避免重复手输
const PRESETS = [
  { name: "海外货运", code: "overseas_freight" },
  { name: "国内货运", code: "domestic_freight" },
  { name: "出租", code: "taxi" },
  { name: "公交", code: "bus" },
  { name: "矿山", code: "mining" },
];

const CODE_RE = /^[A-Za-z0-9_-]+$/;

function errText(e) {
  const d = e?.response?.data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => x.msg).join("；");
  return "操作失败，请重试";
}

// 行业新建 / 编辑弹窗：code 与归属范围创建后不可变更
export default function IndustryFormModal({ open, mode = "create", industry = null, templates = [], onClose, onSaved }) {
  const isEdit = mode === "edit";
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState(null);

  useEffect(() => {
    if (!open) return;
    setSource(null);
    if (isEdit) {
      form.setFieldsValue({
        name: industry?.name,
        owner: industry?.owner,
        remark: industry?.remark,
        is_template: !!industry?.is_template,
      });
    } else {
      form.resetFields();
    }
  }, [open, isEdit, industry, form]);

  const fillPreset = (p) => {
    form.setFieldsValue({ name: p.name, code: p.code });
  };

  const submit = async () => {
    const values = await form.validateFields();
    setLoading(true);
    try {
      if (isEdit) {
        await updateIndustry(industry.id, {
          name: values.name.trim(),
          owner: values.owner?.trim() || null,
          remark: values.remark?.trim() || null,
          is_template: !!values.is_template,
        });
        message.success("行业信息已更新");
      } else {
        const name = values.name.trim();
        const owner = values.owner?.trim() || null;
        if (values.source) {
          // 从现有行业复制配置（可选）
          const created = await cloneIndustry({
            name,
            owner,
            source_industry_id: values.source,
            clone_scope: values.scope || "both",
          });
          const remark = values.remark?.trim();
          if (remark) await updateIndustry(created.data.id, { remark });
          message.success("行业已创建并复制配置");
        } else {
          await createIndustry({
            code: (values.code || "").trim() || `ind_${Date.now().toString(36)}`,
            name,
            owner,
            remark: values.remark?.trim() || null,
          });
          message.success("行业已创建");
        }
      }
      onSaved && onSaved();
      onClose();
    } catch (err) {
      message.error(errText(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={isEdit ? `编辑行业 · ${industry?.name || ""}` : "新建行业"}
      open={open}
      onOk={submit}
      onCancel={onClose}
      confirmLoading={loading}
      okText={isEdit ? "保存" : "创建"}
      cancelText="取消"
      width={520}
      destroyOnClose
    >
      {isEdit && (
        <p className="meta" style={{ marginBottom: 12 }}>
          行业 code：<span style={{ fontFamily: "var(--mono)" }}>{industry?.code}</span>（创建后不可变更）
        </p>
      )}

      {!isEdit && (
        <>
          <p className="meta" style={{ marginBottom: 6 }}>常用行业（点击快速填入）：</p>
          <div className="preset-chips">
            {PRESETS.map((p) => (
              <button type="button" key={p.code} className="preset-chip" onClick={() => fillPreset(p)}>
                {p.name}
              </button>
            ))}
          </div>
        </>
      )}

      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item
          name="name"
          label="行业名称"
          rules={[
            { required: true, message: "请输入行业名称" },
            { max: 50, message: "不超过 50 个字符" },
          ]}
        >
          <Input placeholder="如：海外货运" autoComplete="off" />
        </Form.Item>

        {!isEdit && (
          <Form.Item
            name="code"
            label="行业 code（可选，留空自动生成）"
            rules={[
              {
                validator: (_, v) =>
                  !v || CODE_RE.test(v)
                    ? Promise.resolve()
                    : Promise.reject(new Error("仅允许字母、数字、下划线与连字符")),
              },
              { max: 50, message: "不超过 50 个字符" },
            ]}
          >
            <Input placeholder="如：domestic_freight" autoComplete="off" />
          </Form.Item>
        )}

        <Form.Item name="owner" label="负责人" rules={[{ max: 50, message: "不超过 50 个字符" }]}>
          <Input placeholder="选填，如：李工" autoComplete="off" />
        </Form.Item>

        <Form.Item name="remark" label="备注" rules={[{ max: 255, message: "不超过 255 个字符" }]}>
          <Input.TextArea rows={2} placeholder="选填" />
        </Form.Item>

        {isEdit && (
          <Form.Item name="is_template" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Checkbox>
              设为模板源行业
              <span className="meta" style={{ marginLeft: 6 }}>（可被克隆复用，且不可删除）</span>
            </Checkbox>
          </Form.Item>
        )}

        {!isEdit && (
          <>
            <div className="cfg-divider">高级：从现有行业复制配置（可选）</div>
            <div style={{ display: "flex", gap: 10 }}>
              <Form.Item name="source" label="模板源行业" style={{ flex: 1 }}>
                <Select
                  allowClear
                  placeholder="不复制，创建空行业"
                  onChange={(v) => setSource(v || null)}
                  options={templates.map((t) => ({ value: t.id, label: `${t.name}（${t.code}）` }))}
                />
              </Form.Item>
              {source && (
                <Form.Item name="scope" label="复制范围" initialValue="both" style={{ width: 150 }}>
                  <Select
                    options={[
                      { value: "both", label: "Nginx + YAML" },
                      { value: "nginx", label: "仅 Nginx" },
                      { value: "yml", label: "仅 YAML" },
                    ]}
                  />
                </Form.Item>
              )}
            </div>
          </>
        )}
      </Form>
    </Modal>
  );
}
