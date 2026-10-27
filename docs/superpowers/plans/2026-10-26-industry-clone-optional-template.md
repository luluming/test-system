# 新建行业（模板源可选）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「新建行业（模板克隆）」弹窗的模板源变为可选——不选模板直接创建空行业，选模板则深拷贝整套配置（含镜像对）且与源完全独立。

**Architecture:** 后端把 `CloneIndustryRequest.source_industry_id` 改为可选，`clone_industry` service 内部分支：空值仅建空行业、有值走现有深拷贝并新增镜像对拷贝（旧 config id → 新 config id 映射）。前端弹窗下拉可选、新增可选 code 输入框（仅空行业模式）、按钮文案动态。

**Tech Stack:** FastAPI + SQLAlchemy + SQLite；React + Vite；原生 CSS。

**参考设计：** `docs/superpowers/specs/2026-10-26-industry-clone-optional-template-design.md`

**环境要点：**
- 后端启动：cwd=`backend`，`.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8001`，必须 `dangerouslyDisableSandbox: true`（沙箱阻止 socket）。用 `--reload` 便于改代码后自动生效。
- 前端：cwd=`frontend`，`npm run dev`（5173）。构建 `npm run build` 的 RemoteException 是噪音误报，构建实际成功。
- 登录：admin/admin123（或 POST /api/auth/login 换新 JWT），登录凭据勿写入任何文件。
- 前端 vite 代理 `/api` → 8001。

---

### Task 1: 后端 Schema — source_industry_id 可选 + 新增 code

**Files:**
- Modify: `backend/app/schemas/industry.py:28-33`

- [ ] **Step 1: 修改 `CloneIndustryRequest`**

将 `backend/app/schemas/industry.py` 中 `CloneIndustryRequest` 改为：

```python
class CloneIndustryRequest(BaseModel):
    """从模板行业克隆请求；source_industry_id 可选，不填则创建空行业。"""

    source_industry_id: int | None = None
    name: str = Field(min_length=1, max_length=50)
    owner: str | None = Field(default=None, max_length=50)
    code: str | None = Field(default=None, max_length=50)

    @field_validator("code")
    @classmethod
    def _code_must_be_slug(cls, v: str | None) -> str | None:
        if v is not None and not re.match(r"^[a-z0-9_]+$", v):
            raise ValueError("行业 code 仅允许小写字母、数字与下划线")
        return v
```

（`import re` 已在文件顶部存在。）

- [ ] **Step 2: 验证 schema 可导入**

Run（cwd=`backend`）：`.venv\Scripts\python.exe -c "from app.schemas.industry import CloneIndustryRequest; m=CloneIndustryRequest(name='x'); assert m.source_industry_id is None and m.code is None; m2=CloneIndustryRequest(source_industry_id=1,name='x',code='abc_1'); assert m2.source_industry_id==1; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add backend/app/schemas/industry.py
git commit -m "feat(industry): clone request source_industry_id optional with code"
```

---

### Task 2: 后端 Service — 空行业分支 + 镜像对深拷贝

**Files:**
- Modify: `backend/app/services/industry_clone.py`

- [ ] **Step 1: 修改 `clone_industry` 入口分支**

在 `backend/app/services/industry_clone.py` 的 `clone_industry` 函数开头（`source` 查询之前）插入空值分支：

```python
    if payload.source_industry_id is None:
        new_industry = Industry(
            code=payload.code or derive_code(payload.name),
            name=payload.name,
            owner=payload.owner,
            is_template=False,
            cloned_from_id=None,
        )
        db.add(new_industry)
        db.commit()
        db.refresh(new_industry)
        return new_industry
```

- [ ] **Step 2: 配置循环记录 config id 映射**

将现有配置拷贝循环改为记录 `cfg.id -> new_cfg.id`（`_copy_block_tree` 调用前加一行 `cfg_id_map[cfg.id] = new_cfg.id`）：

```python
    cfg_id_map: dict[int, int] = {}
    for cfg in source_configs:
        new_cfg = NginxConfig(
            industry_id=new_industry.id,
            name=cfg.name,
            domain=cfg.domain,
            config_text=cfg.config_text,
            enabled=cfg.enabled,
            version=1,
        )
        db.add(new_cfg)
        db.flush()
        cfg_id_map[cfg.id] = new_cfg.id
        _copy_block_tree(db, new_cfg.id, cfg.id)
```

- [ ] **Step 3: 在配置循环之后新增镜像对拷贝**

（紧跟 `for cfg in source_configs:` 循环之后，`# 2. upstreams` 注释之前）插入：

```python
    # 1.5 镜像对（config 级元数据，旧 config id → 新 config id 重映射）
    for mp in db.execute(
        select(NginxMirrorPair).where(NginxMirrorPair.nginx_config_id.in_(cfg_id_map))
    ).scalars().all():
        db.add(
            NginxMirrorPair(
                nginx_config_id=cfg_id_map[mp.nginx_config_id],
                src_listen=mp.src_listen,
                dst_listen=mp.dst_listen,
            )
        )
```

- [ ] **Step 4: 更新 import**

将 `from app.models.nginx import (...)` 元组中追加 `NginxMirrorPair`：

```python
from app.models.nginx import (
    BizPort,
    ConfigBlock,
    ConfigOption,
    DomainMapping,
    ForwardPort,
    NginxConfig,
    NginxMirrorPair,
    Upstream,
    UpstreamServer,
)
```

- [ ] **Step 5: 验证 service 可导入**

Run（cwd=`backend`）：`.venv\Scripts\python.exe -c "from app.services.industry_clone import clone_industry; print('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/industry_clone.py
git commit -m "feat(industry): clone supports empty create and mirrors deep copy"
```

---

### Task 3: 前端弹窗 — 模板源可选 + code 手填 + 动态按钮

**Files:**
- Modify: `frontend/src/pages/IndustryCloneModal.jsx`

- [ ] **Step 1: 整体替换弹窗组件**

将 `frontend/src/pages/IndustryCloneModal.jsx` 内容替换为：

```jsx
import { useMemo, useState } from "react";
import { cloneIndustry } from "../api/industry";

export default function IndustryCloneModal({ templates, open, onClose, onCreated }) {
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [owner, setOwner] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const hasSource = templates.some((t) => t.id === Number(sourceId));
  const canSubmit = useMemo(() => name.trim().length > 0, [name]);
  const btnLabel = hasSource ? "创建并克隆" : "创建空行业";

  if (!open) return null;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建行业（模板克隆）</h3>
        <p className="meta">选择模板源可深拷贝整套配置，克隆后与源完全独立；不选则创建空行业。</p>
        <label>模板源行业（可选）</label>
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">不选，创建空行业…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}（{t.code}）</option>
          ))}
        </select>
        <label>新行业名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：国内" />
        {!hasSource && (
          <>
            <label>行业 code（可选，留空自动生成）</label>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="如：domestic（小写字母/数字/下划线）" />
          </>
        )}
        <label>负责人（可选）</label>
        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="如：李工" />
        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={!canSubmit || loading}
            onClick={async () => {
              setLoading(true); setErr("");
              try {
                const payload = { name: name.trim(), owner: owner.trim() || null };
                if (hasSource) payload.source_industry_id = Number(sourceId);
                else if (code.trim()) payload.code = code.trim();
                const created = await cloneIndustry(payload);
                onCreated(created.data);
              } catch (e) {
                setErr(e.response?.data?.detail || "创建失败，请重试");
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? "创建中…" : btnLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 构建验证**

Run（cwd=`frontend`）：`npm run build`
Expected: 构建成功（RemoteException 为噪音误报，忽略；检查 `dist/` 有新产物）。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/IndustryCloneModal.jsx
git commit -m "feat(industry): clone modal template source optional with empty-create mode"
```

---

### Task 4: 接口级验证（起服务实测）

**Files:** 无（纯验证）

- [ ] **Step 1: 启动后端**

Run（cwd=`backend`，`dangerouslyDisableSandbox: true`，后台）：`.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload`
Expected: 日志显示 `Uvicorn running on http://0.0.0.0:8001`。

- [ ] **Step 2: 启动前端**

Run（cwd=`frontend`，后台）：`npm run dev`
Expected: 5173 端口可访问。

- [ ] **Step 3: 登录取 JWT**

Run：`curl -s -X POST http://localhost:8001/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"admin123\"}"`
Expected: 返回 `access_token`。

- [ ] **Step 4: 不选模板创建空行业**

Run（替换 `TOKEN`）：
`curl -s -X POST http://localhost:8001/api/industries/clone -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d "{\"name\":\"测试空行业\"}"`
Expected: 201，返回 `code=ce_shi_kong_hang_ye`（或类似派生值）、`cloned_from_id=null`。

- [ ] **Step 5: 选模板克隆 + 镜像对**

先用现有接口查询模板行业（如行业 2）：`curl -s http://localhost:8001/api/industries/2 -H "Authorization: Bearer TOKEN"`；再克隆：
`curl -s -X POST http://localhost:8001/api/industries/clone -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d "{\"source_industry_id\":2,\"name\":\"克隆验证行业\"}"`
Expected: 201，`cloned_from_id=2`。随后查询新行业下的配置与镜像对：`GET /api/nginx-configs/industry/{new_id}` 与镜像对接口，确认镜像对已拷贝。

- [ ] **Step 6: 独立性抽查**

修改源行业（如行业 2）某配置后，确认克隆行业的同名配置数据不变（内容为深拷的旧值）。

- [ ] **Step 7: Commit（如无代码变更则跳过）**

```bash
git status
```

---

## 自审

- **Spec 覆盖**：后端可选 source + 空行业分支（Task 1/2）；镜像对拷贝（Task 2）；前端下拉可选 + code 手填 + 动态按钮（Task 3）；验证含独立性抽查（Task 4）。设计文档全部要求均有对应任务。
- **占位符**：无 TBD/TODO；每个代码步骤均含完整代码。
- **类型一致性**：`CloneIndustryRequest` 新增 `code` 字段在 Task 1 定义、Task 2 service 空值分支与 Task 3 前端 payload 中一致使用；`clone_industry` 签名不变（仍接收 `payload`）；`cfg_id_map` 在 Task 2 Step 2 定义、Step 3 使用，类型 `dict[int, int]`。
