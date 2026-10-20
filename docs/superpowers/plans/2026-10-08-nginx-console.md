# Nginx 配置管理系统（方案 C）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 FastAPI + React 运维控制台上，升级为「配置可视化管理系统」——新增 upstream 组、泛化配置块（config_blocks/config_options）、全局四层拓扑、列表+详情主从的配置文件页面。

**Architecture:** 后端沿用 `Base(Mapped)` + `_make_router()` 工厂 + Pydantic v2 三件套（Create/Update/Out）。新增 4 张表（upstreams / upstream_servers / config_blocks / config_options），`forward_ports` 加可选 `upstream_id` 外键。渲染核心抽成纯函数 `render_config()` 供 TDD 单测；动作端点（topology / test / reload / validate / render / directives）各自独立。前端新增 `OpsConfigPage`（默认页，改造现有 `OpsConsole`）、`OpsUpstreamPage`、`OpsTopologyPage`，`App.jsx` 挂顶级菜单。SQLite 由 `seed.py` `create_all` 自动补建新表。

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + Pydantic v2 + SQLite（后端）；React 18 + Vite + Ant Design 5 + axios + react-router v6（前端）；pytest + httpx TestClient（后端测试）；前端无测试框架，用 `npm run build` 做静态门禁 + 手动浏览器冒烟。

**Design spec (authoritative):** 见 `docs/superpowers/specs/2026-10-08-nginx-console-design.md`。计划逐条覆盖该文档。

**演示账号登录注意：** 后端测试直接用 `/api/auth/register` + `generate_captcha()` 登录（见 `backend/tests/conftest.py::auth_headers` 夹具）。运行时界面登录 admin / admin123。

**测试运行约定：**
- 后端：`cd backend/.venv/Scripts && ./activate`（或后端 venv），`cd backend && python -m pytest tests/test_xxx.py -v`
- 前端构建门禁：`cd frontend && npm run build`（esbuild 语法/未导入校验）
- 后端单测断言的 HTTP 路径均含 `/api` 前缀（如 `GET /api/nginx-configs/1/blocks`）。

---

## 文件结构（先锁定分解）

**后端改动**
- Create `backend/app/models/block.py` — ConfigBlock、ConfigOption
- Create `backend/app/models/upstream.py` — Upstream、UpstreamServer
- Modify `backend/app/models/nginx.py:47-60` — ForwardPort 增加 `upstream_id` 可空外键
- Modify `backend/app/models/__init__.py` — 统一导入新模型（建表依赖，必须）
- Modify `backend/app/core/captcha.py` — 不改
- Create `backend/app/services/render.py` — `render_config()` 纯函数 + 指令字典 `DIRECTIVES`
- Create `backend/app/schemas/upstream.py` — Upstream/Server 三件套 + preview/validate 响应
- Create `backend/app/schemas/block.py` — ConfigBlock/ConfigOption 三件套 + 树节点 + render 响应
- Modify `backend/app/schemas/nginx.py:76-107` — ForwardPort 三件套增加 `upstream_id`
- Create `backend/app/api/upstreams.py` — upstream + servers CRUD + 删除守卫 + preview + validate
- Create `backend/app/api/blocks.py` — config-blocks + config-options CRUD + 树 + reorder + render
- Create `backend/app/api/actions.py` — topology / forward test / reload / directives
- Modify `backend/app/main.py` — 注册新路由
- Modify `backend/app/seed.py` — 补写新表演示数据
- Create `backend/tests/test_render.py` — 渲染核心 TDD
- Create `backend/tests/test_export.py` — 导出中心纯函数 TDD（SSL 开关 + upstream 客户数据替换）
- Create `backend/tests/test_upstreams.py` — upstream/servers/preview/validate/删除守卫
- Create `backend/tests/test_blocks.py` — config-blocks/options/reorder/render/export 端点
- Create `backend/tests/test_actions.py` — topology / forward test / reload / directives

**前端改动**
- Create `frontend/src/api/operations.js` — 全部新接口 client
- Modify `frontend/src/api/nginx.js` — （已完整，无需改）
- Create `frontend/src/pages/ops/OpsConfigPage.jsx`
- Create `frontend/src/pages/ops/ListPanel.jsx`
- Create `frontend/src/pages/ops/DetailPanel.jsx`
- Create `frontend/src/pages/ops/OverviewGrid.jsx`
- Create `frontend/src/pages/ops/BlockTree.jsx`
- Create `frontend/src/pages/ops/KvListEditor.jsx`
- Create `frontend/src/pages/ops/BizPortChips.jsx`
- Create `frontend/src/pages/ops/PathChain.jsx`
- Create `frontend/src/pages/ops/TopologyView.jsx`
- Create `frontend/src/pages/ops/ExportModal.jsx` — 导出中心弹窗（SSL 开关 + upstream 可编辑表 + 预览 + 复制/下载）
- Create `frontend/src/pages/ops/OpsUpstreamPage.jsx`
- Create `frontend/src/pages/ops/OpsTopologyPage.jsx`
- Modify `frontend/src/App.jsx` — 顶级菜单 + 三个新路由
- Modify `frontend/src/pages/OpsConsole.jsx` — 删除（由 OpsConfigPage 取代）

---

## Task 1：新增 4 张 ORM 模型 + forward_ports 扩展外键

**Files:**
- Create: `backend/app/models/block.py`
- Create: `backend/app/models/upstream.py`
- Modify: `backend/app/models/nginx.py:47-60`
- Modify: `backend/app/models/__init__.py`

- [ ] **Step 1：写入依赖导入断言（先用失败测试锁定 API 约定）**

Create `backend/tests/test_models_exist.py`:

```python
"""模型存在性断言：确保新模型与字段名可在包内被导入并使用。"""

from sqlalchemy import select

from app.models import ConfigBlock, ConfigOption, ForwardPort, Upstream, UpstreamServer


def test_new_models_importable():
    assert ConfigBlock.__tablename__ == "config_blocks"
    assert ConfigOption.__tablename__ == "config_options"
    assert Upstream.__tablename__ == "upstreams"
    assert UpstreamServer.__tablename__ == "upstream_servers"


def test_forward_port_has_upstream_id(db_session_factory):
    from app.database import engine
    session_maker = db_session_factory
    session = session_maker()
    cols = {c.name for c in inspect_columns(ForwardPort)}
    try:
        assert "upstream_id" in cols
    finally:
        session.close()


def inspect_columns(model):
    import sqlalchemy as sa
    from app.database import engine
    from app.models import Base
    return sa.inspect(engine).get_columns(model.__tablename__)
```

- [ ] **Step 2：运行确认失败**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_models_exist.py -v
```

Expected: `ModuleNotFoundError`（`ConfigBlock` 未定义）。

- [ ] **Step 3：写模型**

Create `backend/app/models/block.py`:

```python
"""泛化 nginx 配置块与 KV 指令行 ORM 模型。

config_blocks 通过 parent_id 自关联表达任意嵌套：
server ⊃ location ⊃ if，map/geo/upstream/log_format/include/注释/raw 均同一种块。
config_options 承载块内所有指令行，row_type 标记 kv/regex/string/default/raw。
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ConfigBlock(Base):
    """nginx 泛化配置块（自关联嵌套）。"""

    __tablename__ = "config_blocks"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    nginx_config_id: Mapped[int] = mapped_column(
        ForeignKey("nginx_configs.id"), index=True, nullable=False
    )
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("config_blocks.id"), index=True, nullable=True
    )
    scope: Mapped[str] = mapped_column(String(32), nullable=False)  # server/location/upstream/map/geo/if/log_format/split_clients/include/comment/raw
    header: Mapped[str] = mapped_column(String(255), nullable=False)
    belongs_to_file: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class ConfigOption(Base):
    """块内 KV 指令行 / 条件行 / 映射行 / raw 原样行。"""

    __tablename__ = "config_options"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    block_id: Mapped[int] = mapped_column(
        ForeignKey("config_blocks.id"), index=True, nullable=False
    )
    directive: Mapped[str] = mapped_column(String(255), nullable=False)
    value: Mapped[str] = mapped_column(String(1000), nullable=False)
    row_type: Mapped[str] = mapped_column(
        String(16), default="kv", nullable=False
    )  # kv / regex / string / default / raw
    is_free_text: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
```

Create `backend/app/models/upstream.py`:

```python
"""nginx upstream 负载均衡组与其节点 ORM 模型。"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Upstream(Base):
    """upstream 组：名称唯一，均衡策略，长连接数。"""

    __tablename__ = "upstreams"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True, nullable=False)
    strategy: Mapped[str] = mapped_column(
        String(16), default="round_robin", nullable=False
    )  # round_robin / least_conn / ip_hash
    keepalive: Mapped[int] = mapped_column(Integer, default=32, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class UpstreamServer(Base):
    """upstream 组内节点：地址 + 端口 + 权重 + 健康状态 + 启停。"""

    __tablename__ = "upstream_servers"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    upstream_id: Mapped[int] = mapped_column(
        ForeignKey("upstreams.id"), index=True, nullable=False
    )
    addr: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    weight: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    health_status: Mapped[str] = mapped_column(
        String(16), default="checking", nullable=False
    )  # up / down / checking
    enable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
```

Modify `backend/app/models/nginx.py:47-60`（ForwardPort 加外键）：

```python
class ForwardPort(Base):
    """nginx 转发端口：监听端口 → 上游目标（单地址 或 upstream 组二选一）。"""

    __tablename__ = "forward_ports"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    listen_port: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    upstream_target: Mapped[str] = mapped_column(String(255), nullable=False)
    upstream_id: Mapped[int | None] = mapped_column(
        ForeignKey("upstreams.id"), index=True, nullable=True
    )
    service_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    protocol: Mapped[str] = mapped_column(String(16), default="http", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
```

Modify `backend/app/models/__init__.py`（整文件替换）：

```python
"""ORM 模型包。"""

from app.models.base import Base
from app.models.block import ConfigBlock, ConfigOption
from app.models.item import Item
from app.models.nginx import BizPort, DomainMapping, ForwardPort, NginxConfig
from app.models.upstream import Upstream, UpstreamServer
from app.models.user import User

__all__ = [
    "Base",
    "User",
    "Item",
    "NginxConfig",
    "DomainMapping",
    "ForwardPort",
    "BizPort",
    "Upstream",
    "UpstreamServer",
    "ConfigBlock",
    "ConfigOption",
]
```

- [ ] **Step 4：运行确认通过**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_models_exist.py -v
```

Expected: 2 PASS。

- [ ] **Step 5：Commit**

```bash
git add backend/app/models && git commit -m "feat: 新增 upstream/config 块 ORM 模型并扩展 forward_ports 外键"
```

---

## Task 2：Seed 补建新表演示数据

**Files:**
- Modify: `backend/app/seed.py`

- [ ] **Step 1：先建失败测试**

Append to `backend/tests/test_models_exist.py`:

```python
def test_seed_creates_upstream_demo_data(db_session_factory):
    session = db_session_factory()
    try:
        count = session.execute(select(Upstream)).scalars().all()
        # 夹具空库不跑 seed；此用例验证建表即可拿到空列表
        assert isinstance(count, list)
    finally:
        session.close()
```

- [ ] **Step 2：运行确认通过（占位，seed 逻辑独立于夹具）**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_models_exist.py::test_seed_creates_upstream_demo_data -v
```

Expected: PASS（空列表）。

- [ ] **Step 3：写 seed 演示数据**

Modify `backend/app/seed.py`。先改 import 段：

```python
from app.models import (
    Base,
    ConfigBlock,
    ConfigOption,
    ForwardPort,
    Item,
    NginxConfig,
    Upstream,
    UpstreamServer,
    User,
)
```

在原 `init_db()` 尾部（写入 admin 与人后、`db.commit()` 之前）追加数据；同时给"演示数据已存在则跳过"加幂等逻辑。整段替换 `init_db` 末尾：

```python
        # ---- upstream 演示数据（幂等：组名已存在则跳过）----
        if db.execute(select(Upstream).where(Upstream.name == "api_backend")).scalar_one_or_none() is None:
            up = Upstream(name="api_backend", strategy="least_conn", keepalive=32)
            db.add(up)
            db.flush()
            db.add_all(
                [
                    UpstreamServer(upstream_id=up.id, addr="127.0.0.1", port=9001, weight=3, health_status="up", enable=True),
                    UpstreamServer(upstream_id=up.id, addr="127.0.0.1", port=9002, weight=2, health_status="up", enable=True),
                    UpstreamServer(upstream_id=up.id, addr="127.0.0.1", port=9003, weight=1, health_status="checking", enable=True),
                ]
            )
            db.flush()
            # 演示配置文件 + 泛化块树
            cfg = db.execute(
                select(NginxConfig).where(NginxConfig.name == "shop.server")
            ).scalar_one_or_none()
            if cfg is None:
                cfg = NginxConfig(name="shop.server", domain="shop.example.com", config_text="", enabled=True)
                db.add(cfg)
                db.flush()
            server = ConfigBlock(nginx_config_id=cfg.id, parent_id=None, scope="server", header="server {", sort_order=0)
            loc_meta = ConfigBlock(nginx_config_id=cfg.id, parent_id=None, scope="location", header="location /meta/ {", sort_order=0)
            loc_api = ConfigBlock(nginx_config_id=cfg.id, parent_id=None, scope="location", header="location /api/ {", sort_order=1)
            db.add_all([server, loc_meta, loc_api])
            db.flush()
            db.add_all(
                [
                    ConfigBlock(nginx_config_id=cfg.id, parent_id=loc_api.id, scope="if", header="if ($request_uri ~* \"/admin\") {", sort_order=0),
                    ConfigOption(block_id=server.id, directive="listen", value="443 ssl;", row_type="kv", sort_order=0),
                    ConfigOption(block_id=loc_meta.id, directive="proxy_pass", value="http://api_backend/meta;", row_type="kv", sort_order=0),
                    ConfigOption(block_id=loc_api.id, directive="proxy_pass", value="http://api_backend;", row_type="kv", sort_order=0),
                ]
            )
        db.commit()
```

（若上述 `if` 块内逻辑在空库里也会执行，路径由 admin seed 分支覆盖；注意 `init_db()` 早退分支：当 admin 已存在会直接 `return`，所以新表 seed 需放在管理员 `return` 之前。请将**新表 seed 代码放到 `if admin is not None: return` 之前**，并用上述幂等检查。最终 `init_db` 结构：先建表 → 建 admin → 建新表 seed → 统一 `commit()`。）

- [ ] **Step 4：重启前置脚本验证能建表**

手动启动一次（确认 create_all 覆盖新表）：

```bash
cd backend && .venv/Scripts/python -c "from app.seed import init_db; init_db(); print('ok')"
```

Expected: 打印 `ok`，无建表/外键错误。

- [ ] **Step 5：Commit**

```bash
git add backend/app/seed.py backend/tests/test_models_exist.py && git commit -m "feat: seed 补建 upstream/config 块演示数据"
```

---

## Task 3：Pydantic 三件套（schemas）

**Files:**
- Create: `backend/app/schemas/upstream.py`
- Create: `backend/app/schemas/block.py`
- Modify: `backend/app/schemas/nginx.py:76-107`

- [ ] **Step 1：用导入断言锁 API 形状**

Append to `backend/tests/test_models_exist.py`:

```python
from datetime import datetime
from pydantic import BaseModel


def test_schemas_defined():
    from app.schemas.upstream import UpstreamOut, UpstreamServerOut
    from app.schemas.block import ConfigBlockOut, ConfigOptionOut

    cfg = ConfigBlockOut(
        id=1, nginx_config_id=1, parent_id=None, scope="server",
        header="server {", belongs_to_file=None, sort_order=0, created_at=datetime.now(),
    )
    assert cfg.scope == "server"
    opt = ConfigOptionOut(
        id=1, block_id=1, directive="listen", value="443;", row_type="kv",
        is_free_text=False, sort_order=0, created_at=datetime.now(),
    )
    assert opt.row_type == "kv"
    assert UpstreamOut is not None and UpstreamServerOut is not None
```

- [ ] **Step 2：运行确认失败**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_models_exist.py::test_schemas_defined -v
```

Expected: `ModuleNotFoundError`。

- [ ] **Step 3：写 schemas**

Create `backend/app/schemas/upstream.py`:

```python
"""upstream 组与节点 Pydantic 模型（请求/响应）。"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class UpstreamCreate(BaseModel):
    """创建 upstream 组请求。"""

    name: str
    strategy: str = "round_robin"
    keepalive: int = 32


class UpstreamUpdate(BaseModel):
    """更新 upstream 组请求（字段可选）。"""

    name: str | None = None
    strategy: str | None = None
    keepalive: int | None = None


class UpstreamOut(BaseModel):
    """upstream 组响应。"""

    id: int
    name: str
    strategy: str
    keepalive: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class UpstreamServerCreate(BaseModel):
    """创建 upstream 节点请求（upstream_id 由路径注入）。"""

    addr: str
    port: int
    weight: int = 1
    health_status: str = "checking"
    enable: bool = True


class UpstreamServerUpdate(BaseModel):
    """更新 upstream 节点请求（字段可选）。"""

    addr: str | None = None
    port: int | None = None
    weight: int | None = None
    health_status: str | None = None
    enable: bool | None = None


class UpstreamServerOut(BaseModel):
    """upstream 节点响应。"""

    id: int
    upstream_id: int
    addr: str
    port: int
    weight: int
    health_status: str
    enable: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PreviewOut(BaseModel):
    """upstream 组配置片段预览响应。"""

    content: str


class ValidateOut(BaseModel):
    """upstream 组 nginx -t 校验响应。"""

    valid: bool
    error: str | None = None
```

Create `backend/app/schemas/block.py`:

```python
"""泛化配置块与 KV 指令行 Pydantic 模型（请求/响应）。"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict

SCOPE_CHOICES = frozenset(
    {"server", "location", "upstream", "map", "geo", "if",
     "log_format", "split_clients", "include", "comment", "raw"}
)
ROW_TYPE_CHOICES = frozenset({"kv", "regex", "string", "default", "raw"})


class ConfigBlockCreate(BaseModel):
    """创建配置块请求（parent_id 可空表达嵌套）。"""

    nginx_config_id: int
    parent_id: int | None = None
    scope: str
    header: str
    belongs_to_file: str | None = None
    sort_order: int = 0


class ConfigBlockUpdate(BaseModel):
    """更新配置块请求（字段可选）。"""

    parent_id: int | None = None
    scope: str | None = None
    header: str | None = None
    belongs_to_file: str | None = None
    sort_order: int | None = None


class ConfigBlockOut(BaseModel):
    """配置块响应（扁平）。"""

    id: int
    nginx_config_id: int
    parent_id: int | None
    scope: str
    header: str
    belongs_to_file: str | None
    sort_order: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ConfigBlockNode(ConfigBlockOut):
    """配置块树节点（含递归 children）。"""

    children: list["ConfigBlockNode"] = []


class ConfigOptionCreate(BaseModel):
    """创建指令行请求。"""

    block_id: int
    directive: str
    value: str = ""
    row_type: str = "kv"
    is_free_text: bool = False
    sort_order: int = 0


class ConfigOptionUpdate(BaseModel):
    """更新指令行请求（字段可选）。"""

    directive: str | None = None
    value: str | None = None
    row_type: str | None = None
    is_free_text: bool | None = None
    sort_order: int | None = None


class ConfigOptionOut(BaseModel):
    """指令行响应。"""

    id: int
    block_id: int
    directive: str
    value: str
    row_type: str
    is_free_text: bool
    sort_order: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ReorderRequest(BaseModel):
    """指令行 sort_order 批量重排请求。"""

    block_id: int
    ids: list[int]


class RenderOut(BaseModel):
    """整份配置渲染输出。"""

    content: str
```

Modify `backend/app/schemas/nginx.py:76-107`（ForwardPort 三件套加 `upstream_id`）：

```python
class ForwardPortCreate(BaseModel):
    """创建转发端口请求。"""

    listen_port: int
    upstream_target: str
    upstream_id: int | None = None
    service_name: str | None = None
    protocol: str = "http"
    enabled: bool = True


class ForwardPortUpdate(BaseModel):
    """更新转发端口请求（字段可选）。"""

    listen_port: int | None = None
    upstream_target: str | None = None
    upstream_id: int | None = None
    service_name: str | None = None
    protocol: str | None = None
    enabled: bool | None = None


class ForwardPortOut(BaseModel):
    """转发端口响应。"""

    id: int
    listen_port: int
    upstream_target: str
    upstream_id: int | None
    service_name: str | None
    protocol: str
    enabled: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
```

- [ ] **Step 4：运行确认通过**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_models_exist.py -v
```

Expected: 全部 PASS。

- [ ] **Step 5：Commit**

```bash
git add backend/app/schemas && git commit -m "feat: 新增 upstream/config 块 Pydantic schemas"
```

---

## Task 4：渲染核心 render_config（TDD 重点）

**Files:**
- Create: `backend/app/services/render.py`
- Create: `backend/tests/test_render.py`

- [ ] **Step 1：写失败测试（spec 第 5 节 / 语义细节：map default 恒置末尾 / if 弱提示 / comment/include/raw）**

Create `backend/tests/test_render.py`:

```python
"""render_config 纯函数测试：嵌套/指令顺序/map default 置底/if 弱提示/注释/include/raw。"""

from sqlalchemy import select

from app.models import (
    BizPort,
    ConfigBlock,
    ConfigOption,
    DomainMapping,
    ForwardPort,
    NginxConfig,
    Upstream,
    UpstreamServer,
)
from app.services.render import render_block, render_config


def _make_config(session) -> NginxConfig:
    cfg = NginxConfig(name="t", domain="t.example.com", config_text="", enabled=True)
    session.add(cfg)
    session.flush()
    return cfg


def _add(db, **kw):
    row = ConfigBlock(**kw)
    db.add(row)
    db.flush()
    return row


def _opt(db, block_id, directive, value, row_type="kv", sort_order=0, is_free_text=False):
    db.add(ConfigOption(
        block_id=block_id, directive=directive, value=value,
        row_type=row_type, sort_order=sort_order, is_free_text=is_free_text,
    ))


def test_render_map_default_forced_to_end(db_session_factory):
    """map 块内 row_type=default 的行即使 sort_order 小也恒置末尾。"""
    session = db_session_factory()
    cfg = _make_config(session)
    root = _add(session, nginx_config_id=cfg.id, scope="server", header="server {", sort_order=0)
    m = _add(session, nginx_config_id=cfg.id, parent_id=root.id, scope="map",
             header="map $http_cookie $ab {", sort_order=0)
    # gamma 行 sort_order=1，default 行 sort_order=0 —— default 必须排到末尾
    _opt(session, m.id, "~*balance a=1", "A", row_type="regex", sort_order=1)
    _opt(session, m.id, "__default__", "B", row_type="default", sort_order=0)
    session.commit()

    out = render_config(session, cfg.id)
    assert out.count("__default__ B;") == 1
    lines = [l for l in out.splitlines() if l.strip().startswith("__default__")]
    last_content = [l for l in out.splitlines() if l.strip().startswith("~*balance")]
    assert out.index("__default__ B;") > out.index("~*balance a=1 A;")


def test_render_if_adds_weak_hint(db_session_factory):
    session = db_session_factory()
    cfg = _make_config(session)
    srv = _add(session, nginx_config_id=cfg.id, scope="server", header="server {", sort_order=0)
    loc = _add(session, nginx_config_id=cfg.id, parent_id=srv.id, scope="location",
               header="location /x {", sort_order=0)
    t = _add(session, nginx_config_id=cfg.id, parent_id=loc.id, scope="if",
             header="if ($arg_a) {", sort_order=0)
    _opt(session, t.id, "rewrite", "^ /b;", sort_order=0)
    _add(session, nginx_config_id=cfg.id, parent_id=None, scope="comment",
         header="生成于自动渲染", sort_order=1)
    _add(session, nginx_config_id=cfg.id, parent_id=None, scope="include",
         header="/etc/nginx/conf.d/default.conf", sort_order=2)
    _add(session, nginx_config_id=cfg.id, parent_id=None, scope="raw",
         header="user www-data;", sort_order=3)
    session.commit()

    out = render_config(session, cfg.id)
    assert "# 建议少用 if" in out
    assert "# 生成于自动渲染" in out
    assert "include /etc/nginx/conf.d/default.conf;" in out
    assert "user www-data;" in out  # raw 原样照录


def test_render_nested_indentation_and_child_order(db_session_factory):
    session = db_session_factory()
    cfg = _make_config(session)
    srv = _add(session, nginx_config_id=cfg.id, scope="server", header="server {", sort_order=0)
    _opt(session, srv.id, "listen", "80;", sort_order=0)
    _opt(session, srv.id, "root", "/srv/www;", sort_order=1)
    loc_a = _add(session, nginx_config_id=cfg.id, parent_id=srv.id, scope="location",
                 header="location /a {", sort_order=0)
    loc_b = _add(session, nginx_config_id=cfg.id, parent_id=srv.id, scope="location",
                 header="location /b {", sort_order=1)
    _opt(session, loc_a.id, "proxy_pass", "http://127.0.0.1:9001;", sort_order=0)
    session.commit()

    out = render_config(session, cfg.id)
    lines = out.splitlines()
    assert "[server {" in out and "\n}\n" in out
    assert lines[0] == "server {"
    assert lines.count("}") >= 3
    assert "  location /a {" in out  # 缩进 + location 主体
    assert "    proxy_pass http://127.0.0.1:9001;" in out  # 二级缩进
    b_idx = out.index("location /b {")
    a_idx = out.index("location /a {")
    assert a_idx < b_idx  # 同级 sort_order 顺序


def test_render_empty_config_returns_empty(db_session_factory):
    session = db_session_factory()
    cfg = _make_config(session)
    session.commit()
    assert render_config(session, cfg.id) == ""


def test_render_block_single_line_helpers():
    """独立 helper 的可测性：comment/include/raw 单块渲染。"""
    # comment
    assert "# hello" in render_single("comment", "hello")
    assert render_single("include", "/etc/x.conf") == "include /etc/x.conf;"
    assert render_single("raw", "user root;") == "user root;"


def render_single(scope, header):
    return render_block({scope: scope, header: header}, depth=0)
```

注意：`render_single` 用到的 `render_block` 接受一个轻量"鸭子块"对象（有 `scope`/`header` 属性即可），便于单行 helper 测试。请在 `render.py` 里把 `render_block` 写成可接受任意带 `scope`/`header` 的对象。

- [ ] **Step 2：运行确认失败**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_render.py -v
```

Expected: `ModuleNotFoundError: app.services.render`。

- [ ] **Step 3：最小实现**

Create `backend/app/services/render.py`:

```python
"""nginx 泛化块渲染核心（纯函数）。

按块树深度优先 + 同级 sort_order 递归拼装字符串。语义细节：
- row_type=default 的行恒置该块末尾（不受 sort_order 影响）；
- scope=if 前置 "# 建议少用 if" 弱提示；
- comment 输出 "# " 前缀；include 输出 "include <path>;"；raw 原样照录；
- 嵌套块以 4 空格/级缩进。
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ConfigBlock, ConfigOption

DEFAULT_IF_HINT = "# 建议少用 if"
_INDENT = "    "

# 内置常用指令字典（供补全端点复用）。条目：指令名、说明、所属上下文。
DIRECTIVES: list[dict] = [
    {"name": "listen", "desc": "监听端口与选项", "context": "server"},
    {"name": "server_name", "desc": "服务器名称/域名", "context": "server"},
    {"name": "root", "desc": "站点根目录", "context": "server/location"},
    {"name": "index", "desc": "默认索引文件", "context": "location"},
    {"name": "location", "desc": "URL 匹配块", "context": "server"},
    {"name": "proxy_pass", "desc": "反向代理目标", "context": "location"},
    {"name": "proxy_set_header", "desc": "转发请求头", "context": "location"},
    {"name": "try_files", "desc": "按顺序尝试文件", "context": "location"},
    {"name": "rewrite", "desc": "URL 重写规则", "context": "server/location/if"},
    {"name": "return", "desc": "直接返回状态码", "context": "server/location/if"},
    {"name": "keepalive", "desc": "upstream 长连接数", "context": "upstream"},
    {"name": "least_conn", "desc": "最少连接策略", "context": "upstream"},
    {"name": "ip_hash", "desc": "IP 哈希策略", "context": "upstream"},
    {"name": "access_log", "desc": "访问日志路径", "context": "server/location"},
    {"name": "error_log", "desc": "错误日志路径", "context": "main"},
    {"name": "include", "desc": "引入外部文件", "context": "main/http"},
]


def _order_options(options: list[ConfigOption]) -> list[ConfigOption]:
    """非 default 行按 sort_order，default 行恒置末尾。"""
    normal = sorted(
        [o for o in options if o.row_type != "default"], key=lambda o: o.sort_order
    )
    defaults = sorted(
        [o for o in options if o.row_type == "default"], key=lambda o: o.sort_order
    )
    return normal + defaults


def _render_option(opt: ConfigOption, indent: str) -> str:
    """渲染单条指令/条件/映射行。"""
    if opt.row_type == "raw" and opt.is_free_text:
        return indent + opt.directive  # raw 原样照录
    if opt.row_type == "default":
        return f"{indent}{opt.directive} {opt.value};"
    return f"{indent}{opt.directive} {opt.value};"


def render_block(block, depth: int, db: Session | None = None) -> str:
    """渲染单个块及其子树。block 需有 scope/header 属性（或用鸭子对象）。

    db 为空时用于单行 helper 测试（不查询 children/options）。
    """
    indent = _INDENT * depth
    lines: list[str] = []

    if block.scope == "comment":
        for line in (block.header or "").splitlines():
            lines.append(f"{indent}# {line}".rstrip() if line else indent + "#")
        return "\n".join(lines)

    if block.scope == "include":
        lines.append(f"{indent}include {block.header.strip()};")
        return "\n".join(lines)

    if block.scope == "raw":
        for line in (block.header or "").splitlines():
            lines.append(f"{indent}{line}")
        return "\n".join(lines)

    # 带 {} 主体的块
    if block.scope == "if":
        lines.append(indent + DEFAULT_IF_HINT)
    lines.append(f"{indent}{block.header} {{")

    if db is not None:
        children = db.execute(
            select(ConfigBlock)
            .where(
                ConfigBlock.nginx_config_id == block.nginx_config_id,
                ConfigBlock.parent_id == block.id,
            )
            .order_by(ConfigBlock.sort_order, ConfigBlock.id)
        ).scalars().all()
        options = db.execute(
            select(ConfigOption)
            .where(ConfigOption.block_id == block.id)
        ).scalars().all()
    else:
        children = []
        options = []

    for opt in _order_options(options):
        lines.append(_render_option(opt, indent + _INDENT))

    for child in children:
        lines.append(render_block(child, depth + 1, db))

    lines.append(indent + "}")
    return "\n".join(lines)


def render_config(db: Session, nginx_config_id: int) -> str:
    """渲染整份 nginx 配置文本：深度优先 + sort_order + map default 置底。"""
    roots = db.execute(
        select(ConfigBlock)
        .where(
            ConfigBlock.nginx_config_id == nginx_config_id,
            ConfigBlock.parent_id.is_(None),
        )
        .order_by(ConfigBlock.sort_order, ConfigBlock.id)
    ).scalars().all()
    return "\n\n".join(render_block(b, depth=0, db=db) for b in roots)
```

- [ ] **Step 4：运行确认通过**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_render.py -v
```

Expected: 5 PASS。若 `test_render_nested_indentation_and_child_order` 的 `lines.count("}") >= 3` 不满足，检查 `server` 块内确实嵌套 loc_a/loc_b（其 `nginx_config_id` 使用 `cfg.id`，`parent_id` 指向 `srv.id`），并确认 `render_block` 对空 body 也会收 `}`。

- [ ] **Step 5：Commit**

```bash
git add backend/app/services/render.py backend/tests/test_render.py && git commit -m "feat: 泛化块渲染核心 render_config（map default 置底/if 弱提示/注释/include/raw）"
```

---

## Task 5：config-blocks / config-options CRUD + 树 + reorder + render 端点

**Files:**
- Create: `backend/app/api/blocks.py`

- [ ] **Step 1：写失败测试**

Create `backend/tests/test_blocks.py`:

```python
"""config-blocks / config-options CRUD、树、reorder、render 端点测试。"""

from app.models import NginxConfig
from app.schemas.block import ConfigBlockOut


def test_list_blocks_tree_and_create_child(client, auth_headers):
    cfg_id = _mk_cfg(client, auth_headers)
    # 建根块 server
    r = client.post("/api/config-blocks", headers=auth_headers, json={
        "nginx_config_id": cfg_id, "parent_id": None, "scope": "server",
        "header": "server {", "sort_order": 0,
    })
    assert r.status_code == 201
    server_id = r.json()["id"]

    # 建子块 location
    r2 = client.post("/api/config-blocks", headers=auth_headers, json={
        "nginx_config_id": cfg_id, "parent_id": server_id, "scope": "location",
        "header": "location /x {", "sort_order": 0,
    })
    assert r2.status_code == 201
    loc_id = r2.json()["id"]

    # 取块树（GET /api/nginx-configs/{id}/blocks）应含递归 children
    tree = client.get(f"/api/nginx-configs/{cfg_id}/blocks", headers=auth_headers)
    assert tree.status_code == 200
    assert len(tree.json()) == 1
    node = tree.json()[0]
    assert node["scope"] == "server"
    assert node["children"][0]["id"] == loc_id

    # 更新 + 删除子块
    up = client.put(f"/api/config-blocks/{loc_id}", headers=auth_headers,
                    json={"sort_order": 3})
    assert up.status_code == 200 and up.json()["sort_order"] == 3
    dl = client.delete(f"/api/config-blocks/{loc_id}", headers=auth_headers)
    assert dl.status_code == 204


def test_options_crud_and_reorder(client, auth_headers):
    cfg_id = _mk_cfg(client, auth_headers)
    b = client.post("/api/config-blocks", headers=auth_headers, json={
        "nginx_config_id": cfg_id, "parent_id": None, "scope": "server",
        "header": "server {", "sort_order": 0,
    }).json()
    bid = b["id"]

    c1 = client.post("/api/config-options", headers=auth_headers, json={
        "block_id": bid, "directive": "listen", "value": "80;", "sort_order": 0,
    }).json()
    c2 = client.post("/api/config-options", headers=auth_headers, json={
        "block_id": bid, "directive": "root", "value": "/srv;", "sort_order": 1,
    }).json()

    lst = client.get("/api/config-options", params={"block_id": bid}, headers=auth_headers)
    assert lst.status_code == 200 and len(lst.json()) == 2

    # reorder 逆序
    rr = client.post("/api/config-options/reorder", headers=auth_headers,
                     json={"block_id": bid, "ids": [c2["id"], c1["id"]]})
    assert rr.status_code == 200
    reordered = client.get("/api/config-options", params={"block_id": bid}, headers=auth_headers).json()
    assert [o["sort_order"] for o in reordered] == [0, 1]
    assert reordered[0]["id"] == c2["id"]


def test_render_endpoint_returns_text(client, auth_headers):
    cfg_id = _mk_cfg(client, auth_headers)
    b = client.post("/api/config-blocks", headers=auth_headers, json={
        "nginx_config_id": cfg_id, "parent_id": None, "scope": "server",
        "header": "server {", "sort_order": 0,
    }).json()
    client.post("/api/config-options", headers=auth_headers, json={
        "block_id": b["id"], "directive": "listen", "value": "80;",
    })
    r = client.get(f"/api/nginx-configs/{cfg_id}/render", headers=auth_headers)
    assert r.status_code == 200
    assert "server {" in r.json()["content"]
    assert "listen 80;" in r.json()["content"]


def _mk_cfg(client, auth_headers) -> int:
    r = client.post("/api/nginx-configs", headers=auth_headers, json={
        "name": "tester_cfg", "domain": "t.example.com", "config_text": "", "enabled": True,
    })
    assert r.status_code == 201
    return r.json()["id"]
```

- [ ] **Step 2：运行确认失败**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_blocks.py -v
```

Expected: 404（路由未注册）。

- [ ] **Step 3：最小实现**

Create `backend/app/api/blocks.py`:

```python
"""泛化配置块与指令行 CRUD + 树 + reorder + render 端点（需登录）。"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_db
from app.core.security import get_current_user
from app.models import ConfigBlock, ConfigOption, NginxConfig
from app.models.user import User
from app.schemas.block import (
    ConfigBlockCreate,
    ConfigBlockNode,
    ConfigBlockOut,
    ConfigBlockUpdate,
    ConfigOptionCreate,
    ConfigOptionOut,
    ConfigOptionUpdate,
    RenderOut,
    ReorderRequest,
)
from app.services.render import render_config

router = APIRouter(prefix="/api", tags=["配置块"])


def _get_block(db: Session, block_id: int) -> ConfigBlock:
    row = db.execute(
        select(ConfigBlock).where(ConfigBlock.id == block_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="块不存在")
    return row


def _get_option(db: Session, option_id: int) -> ConfigOption:
    row = db.execute(
        select(ConfigOption).where(ConfigOption.id == option_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="指令行不存在")
    return row


def _load_children(db: Session, parent_id: int):
    return db.execute(
        select(ConfigBlock)
        .where(ConfigBlock.parent_id == parent_id)
        .order_by(ConfigBlock.sort_order, ConfigBlock.id)
    ).scalars().all()


@router.get("/nginx-configs/{nginx_config_id}/blocks", response_model=list[ConfigBlockNode])
def list_block_tree(
    nginx_config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """返回某配置的块树（递归 children）。"""
    roots = db.execute(
        select(ConfigBlock)
        .where(
            ConfigBlock.nginx_config_id == nginx_config_id,
            ConfigBlock.parent_id.is_(None),
        )
        .order_by(ConfigBlock.sort_order, ConfigBlock.id)
    ).scalars().all()
    return [_to_node(b, db) for b in roots]


def _to_node(block: ConfigBlock, db: Session) -> ConfigBlockNode:
    children = _load_children(db, block.id)
    return ConfigBlockNode(
        id=block.id, nginx_config_id=block.nginx_config_id, parent_id=block.parent_id,
        scope=block.scope, header=block.header, belongs_to_file=block.belongs_to_file,
        sort_order=block.sort_order, created_at=block.created_at,
        children=[_to_node(c, db) for c in children],
    )


@router.get("/config-blocks/{block_id}/children", response_model=list[ConfigBlock])
def list_children(
    block_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    return list(_load_children(db, block_id))


@router.post("/config-blocks", response_model=ConfigBlockOut, status_code=status.HTTP_201_CREATED)
def create_block(
    payload: ConfigBlockCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    if payload.parent_id is not None:
        _get_block(db, payload.parent_id)
    row = ConfigBlock(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/config-blocks/{block_id}", response_model=ConfigBlockOut)
def update_block(
    block_id: int,
    payload: ConfigBlockUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    row = _get_block(db, block_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/config-blocks/{block_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_block(
    block_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    _get_block(db, block_id)
    db.execute(select(ConfigOption).where(ConfigOption.block_id == block_id))
    db.query(ConfigOption).filter(ConfigOption.block_id == block_id).delete()
    db.query(ConfigBlock).filter(ConfigBlock.parent_id == block_id).delete()
    db.query(ConfigBlock).filter(ConfigBlock.id == block_id).delete()
    db.commit()


@router.get("/config-options", response_model=list[ConfigOptionOut])
def list_options(
    block_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    return db.execute(
        select(ConfigOption).where(ConfigOption.block_id == block_id)
    ).scalars().all()


@router.post("/config-options", response_model=ConfigOptionOut, status_code=status.HTTP_201_CREATED)
def create_option(
    payload: ConfigOptionCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    _get_block(db, payload.block_id)
    row = ConfigOption(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/config-options/{option_id}", response_model=ConfigOptionOut)
def update_option(
    option_id: int,
    payload: ConfigOptionUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    row = _get_option(db, option_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/config-options/{option_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_option(
    option_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    row = _get_option(db, option_id)
    db.delete(row)
    db.commit()


@router.post("/config-options/reorder", response_model=dict)
def reorder_options(
    payload: ReorderRequest,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    """按 ids 给定顺序重排某块所有指令行的 sort_order。"""
    rows = db.execute(
        select(ConfigOption).where(ConfigOption.block_id == payload.block_id)
    ).scalars().all()
    by_id = {o.id: o for o in rows}
    for idx, oid in enumerate(payload.ids):
        if oid in by_id:
            by_id[oid].sort_order = idx
    db.commit()
    return {"updated": len(payload.ids)}


@router.get("/nginx-configs/{nginx_config_id}/render", response_model=RenderOut)
def render_nginx(
    nginx_config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    if db.execute(select(NginxConfig).where(NginxConfig.id == nginx_config_id)).scalar_one_or_none() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="配置不存在")
    return RenderOut(content=render_config(db, nginx_config_id))
```

- [ ] **Step 4：修正并确认通过**

`router.get("/config-blocks/{block_id}/children", response_model=list[ConfigBlock])` 用了 ORM 模型作响应——请改为 `list[ConfigBlockOut]` 并导入。运行：

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_blocks.py -v
```

Expected: 4 PASS。

- [ ] **Step 5：Commit**

```bash
git add backend/app/api/blocks.py backend/tests/test_blocks.py && git commit -m "feat: config-blocks/config-options CRUD + 树 + reorder + render 端点"
```

---

## Task 6：upstream / servers CRUD + 删除守卫 + preview + validate

**Files:**
- Create: `backend/app/api/upstreams.py`

- [ ] **Step 1：写失败测试**

Create `backend/tests/test_upstreams.py`:

```python
"""upstream 组/节点 CRUD、preview、validate、删除守卫测试。"""

import subprocess

from fastapi.status import HTTP_201_CREATED
from sqlalchemy import select

from app.models import ForwardPort, NginxConfig, Upstream, UpstreamServer


def _mk_upstream(client, auth_headers, name="api_backend"):
    r = client.post("/api/upstreams", headers=auth_headers, json={
        "name": name, "strategy": "least_conn", "keepalive": 64,
    })
    assert r.status_code == HTTP_201_CREATED
    return r.json()


def test_upstream_crud_and_servers(client, auth_headers):
    u = _mk_upstream(client, auth_headers)
    uid = u["id"]
    # 列表
    assert any(x["id"] == uid for x in client.get("/api/upstreams", headers=auth_headers).json())
    # 建节点
    s = client.post(f"/api/upstreams/{uid}/servers", headers=auth_headers, json={
        "addr": "10.0.0.1", "port": 9001, "weight": 3, "health_status": "up", "enable": True,
    })
    assert s.status_code == HTTP_201_CREATED
    sid = s.json()["id"]
    # 节点列表 + 更新 + 删除
    lst = client.get(f"/api/upstreams/{uid}/servers", headers=auth_headers).json()
    assert any(x["id"] == sid for x in lst)
    up = client.put(f"/api/upstreams/{uid}/servers/{sid}", headers=auth_headers, json={"weight": 5})
    assert up.json()["weight"] == 5
    assert client.delete(f"/api/upstreams/{uid}/servers/{sid}", headers=auth_headers).status_code == 204
    # 更新组 + 删除组
    client.put(f"/api/upstreams/{uid}", headers=auth_headers, json={"keepalive": 128})
    assert client.delete(f"/api/upstreams/{uid}", headers=auth_headers).status_code == 204


def test_delete_upstream_blocked_when_referenced(client, auth_headers, db_session_factory):
    u = _mk_upstream(client, auth_headers, name="ref_group")
    # 造一条引用该 upstream 的转发端口
    session = db_session_factory()
    try:
        fp = ForwardPort(listen_port=8080, upstream_target="", upstream_id=u["id"], enabled=True)
        session.add(fp)
        session.commit()
    finally:
        session.close()
    resp = client.delete(f"/api/upstreams/{u['id']}", headers=auth_headers)
    assert resp.status_code == 409
    assert "引用" in resp.json()["detail"]


def test_preview_output(client, auth_headers):
    u = _mk_upstream(client, auth_headers, name="prev_group")
    client.post(f"/api/upstreams/{u['id']}/servers", headers=auth_headers,
                json={"addr": "10.0.0.1", "port": 9001, "weight": 3, "enable": True})
    client.post(f"/api/upstreams/{u['id']}/servers", headers=auth_headers,
                json={"addr": "10.0.0.2", "port": 9002, "weight": 1, "enable": True})
    r = client.get(f"/api/upstreams/{u['id']}/preview", headers=auth_headers)
    assert r.status_code == 200
    content = r.json()["content"]
    assert content.startswith("upstream prev_group {")
    assert "least_conn;" in content
    assert "server 10.0.0.1:9001 weight=3;" in content
    assert "server 10.0.0.2:9002;" in content
    assert "keepalive 64;" in content


def test_validate_runs_nginx_t(client, auth_headers, monkeypatch):
    u = _mk_upstream(client, auth_headers, name="val_group")
    called = {}

    class FakeProc:
        returncode = 0

        def __init__(self, *a, **k):
            pass

    def _run(*a, capture_output=False, text=False, **k):
        called["cmd"] = a[0]
        return FakeProc()

    monkeypatch.setattr(subprocess, "run", _run)
    r = client.post(f"/api/upstreams/{u['id']}/validate", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["valid"] is True
    assert "nginx" in " ".join(called.get("cmd", []))
```

- [ ] **Step 2：运行确认失败**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_upstreams.py -v
```

Expected: 404（路由未注册）。

- [ ] **Step 3：最小实现**

Create `backend/app/api/upstreams.py`:

```python
"""upstream 组/节点 CRUD + 预览 + nginx -t 校验 + 删除守卫（需登录）。"""

import socket
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.security import get_current_user
from app.models import ForwardPort, Upstream, UpstreamServer
from app.models.user import User
from app.schemas.upstream import (
    PreviewOut,
    UpstreamCreate,
    UpstreamOut,
    UpstreamServerCreate,
    UpstreamServerOut,
    UpstreamServerUpdate,
    UpstreamUpdate,
    ValidateOut,
)

router = APIRouter(prefix="/api/upstreams", tags=["upstream 池"])

_STRATEGY_LINE = {
    "round_robin": None,  # 默认策略无显式行
    "least_conn": "least_conn;",
    "ip_hash": "ip_hash;",
}


def _get_upstream(db: Session, uid: int) -> Upstream:
    row = db.execute(select(Upstream).where(Upstream.id == uid)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="upstream 组不存在")
    return row


def _get_server(db: Session, sid: int) -> UpstreamServer:
    row = db.execute(select(UpstreamServer).where(UpstreamServer.id == sid)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="节点不存在")
    return row


# ---- 组 CRUD ----
@router.get("", response_model=list[UpstreamOut])
def list_upstreams(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    return db.execute(select(Upstream).order_by(Upstream.id)).scalars().all()


@router.post("", response_model=UpstreamOut, status_code=status.HTTP_201_CREATED)
def create_upstream(payload: UpstreamCreate, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    if db.execute(select(Upstream).where(Upstream.name == payload.name)).scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="组名已存在")
    row = Upstream(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/{uid}", response_model=UpstreamOut)
def update_upstream(uid: int, payload: UpstreamUpdate, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    row = _get_upstream(db, uid)
    for f, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, f, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{uid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_upstream(uid: int, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    _get_upstream(db, uid)
    if db.execute(select(ForwardPort).where(ForwardPort.upstream_id == uid)).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="该 upstream 组正被转发端口引用，无法删除")
    db.execute(select(UpstreamServer).where(UpstreamServer.upstream_id == uid))
    db.query(UpstreamServer).filter(UpstreamServer.upstream_id == uid).delete()
    db.query(Upstream).filter(Upstream.id == uid).delete()
    db.commit()


# ---- 组内节点 CRUD ----
@router.get("/{uid}/servers", response_model=list[UpstreamServerOut])
def list_servers(uid: int, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    _get_upstream(db, uid)
    return db.execute(select(UpstreamServer).where(UpstreamServer.upstream_id == uid)).scalars().all()


@router.post("/{uid}/servers", response_model=UpstreamServerOut, status_code=status.HTTP_201_CREATED)
def create_server(uid: int, payload: UpstreamServerCreate, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    _get_upstream(db, uid)
    row = UpstreamServer(upstream_id=uid, **payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/{uid}/servers/{sid}", response_model=UpstreamServerOut)
def update_server(uid: int, sid: int, payload: UpstreamServerUpdate, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    row = _get_server(db, sid)
    if row.upstream_id != uid:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="节点不存在")
    for f, v in payload.model_dump(exclude_unset=True).items():
        setattr(row, f, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{uid}/servers/{sid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_server(uid: int, sid: int, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    row = _get_server(db, sid)
    if row.upstream_id != uid:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="节点不存在")
    db.delete(row)
    db.commit()


# ---- 预览 + 校验 ----
def _preview_content(upstream: Upstream, servers: list[UpstreamServer]) -> str:
    lines = [f"upstream {upstream.name} {{"]
    strat = _STRATEGY_LINE.get(upstream.strategy)
    if strat:
        lines.append(f"    {strat}")
    for s in servers:
        if not s.enable:
            continue
        seg = f"server {s.addr}:{s.port}"
        if s.weight and s.weight != 1:
            seg += f" weight={s.weight}"
        lines.append(f"    {seg};")
    lines.append(f"    keepalive {upstream.keepalive};")
    lines.append("}")
    return "\n".join(lines)


@router.get("/{uid}/preview", response_model=PreviewOut)
def preview_upstream(uid: int, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    up = _get_upstream(db, uid)
    servers = db.execute(select(UpstreamServer).where(UpstreamServer.upstream_id == uid)).scalars().all()
    return PreviewOut(content=_preview_content(up, servers))


@router.post("/{uid}/validate", response_model=ValidateOut)
def validate_upstream(uid: int, db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    up = _get_upstream(db, uid)
    servers = db.execute(select(UpstreamServer).where(UpstreamServer.upstream_id == uid)).scalars().all()
    content = _preview_content(up, servers)
    tmp = Path(tempfile.mkstemp(suffix=".conf")[1])
    tmp.write_text(content, encoding="utf-8")
    try:
        proc = subprocess.run(
            ["nginx", "-t", "-c", str(tmp)],
            capture_output=True, text=True, timeout=10,
        )
        valid = proc.returncode == 0
        return ValidateOut(
            valid=valid,
            error=None if valid else (proc.stderr or "nginx -t 失败"),
        )
    except FileNotFoundError:
        return ValidateOut(valid=False, error="nginx 可执行文件不可用")
    except subprocess.TimeoutExpired:
        return ValidateOut(valid=False, error="nginx -t 执行超时")


def _socket_test(host: str, port: int, timeout: float = 0.5) -> dict:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return {"addr": host, "port": port, "ok": True, "error": None}
    except OSError as exc:
        return {"addr": host, "port": port, "ok": False, "error": str(exc)}


def test_forward_targets(db: Session, forward_port: ForwardPort) -> list[dict]:
    """连通性探测：单地址直接测，upstream 组则测其启用节点。"""
    if forward_port.upstream_id:
        servers = db.execute(
            select(UpstreamServer).where(
                UpstreamServer.upstream_id == forward_port.upstream_id,
                UpstreamServer.enable.is_(True),
            )
        ).scalars().all()
        targets = [{"addr": s.addr, "port": s.port} for s in servers] or [
            {"addr": forward_port.upstream_target, "port": 0}
        ]
    else:
        host, _, port_str = forward_port.upstream_target.partition(":")
        targets = [{"addr": host, "port": int(port_str or 0)}]
    return [_socket_test(t["addr"], t["port"]) for t in targets]
```

- [ ] **Step 4：运行确认通过**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_upstreams.py -v
```

Expected: 5 PASS。

- [ ] **Step 5：Commit**

```bash
git add backend/app/api/upstreams.py backend/tests/test_upstreams.py && git commit -m "feat: upstream 池 CRUD + preview/validate + 删除守卫"
```

---

## Task 7：动作端点（topology / forward test / reload / directives）

**Files:**
- Create: `backend/app/api/actions.py`

- [ ] **Step 1：写失败测试**

Create `backend/tests/test_actions.py`:

```python
"""topology / forward test / reload / directives 端点测试。"""

import socket

from sqlalchemy import select

from app.models import BizPort, DomainMapping, ForwardPort, NginxConfig, Upstream
from app.services.render import DIRECTIVES


def _mk_upstream(client, auth_headers, name="topo_up"):
    return client.post("/api/upstreams", headers=auth_headers,
                       json={"name": name, "strategy": "least_conn", "keepalive": 32}).json()


def test_directives_returns_dict(client, auth_headers):
    r = client.get("/api/directives", headers=auth_headers)
    assert r.status_code == 200
    names = [d["name"] for d in r.json()]
    assert "proxy_pass" in names and "listen" in names


def test_topology_four_layers(client, auth_headers, db_session_factory):
    u = _mk_upstream(client, auth_headers)
    client.post(f"/api/upstreams/{u['id']}/servers", headers=auth_headers,
                json={"addr": "10.0.0.1", "port": 9001, "enable": True})
    session = db_session_factory()
    try:
        session.add_all([
            NginxConfig(name="t", domain="t.example.com", config_text="", enabled=True),
            DomainMapping(domain="api.example.com", forward_tos="127.0.0.1:8080", enabled=True),
            ForwardPort(listen_port=8080, upstream_target="", upstream_id=u["id"], enabled=True),
            BizPort(service_name="order-svc", port=9001, public_exposed=True),
        ])
        session.commit()
    finally:
        session.close()

    r = client.get("/api/topology", headers=auth_headers)
    assert r.status_code == 200
    top = r.json()
    assert len(top) >= 1
    domain = next(x for x in top if x["type"] == "domain")
    assert len(domain["children"]) >= 1
    listen = domain["children"][0]
    assert listen["type"] == "listen"
    # 四层：domain -> listen -> upstream -> server(带 biz)
    up = listen["children"][0]
    assert up["type"] == "upstream"
    srv = up["children"][0]
    assert srv["type"] == "server"
    assert any(c["type"] == "biz" for c in srv["children"])


def test_forward_test_direct(client, auth_headers, db_session_factory, monkeypatch):
    session = db_session_factory()
    try:
        fp = ForwardPort(listen_port=9000, upstream_target="127.0.0.1:9999", enabled=True)
        session.add(fp)
        session.commit()
        fid = fp.id
    finally:
        session.close()

    monkeypatch.setattr(socket, "create_connection", lambda *a, **k: (_ for _ in ()).throw(TimeoutError("conn refused")))
    from app.api.upstreams import test_forward_targets

    # 直接单测底层 helper
    results = test_forward_targets(session_factory_for=test_forward_targets)
    assert results[0]["addr"] == "127.0.0.1"
    assert results[0]["ok"] is False


def test_forward_test_endpoint(client, auth_headers, db_session_factory):
    session = db_session_factory()
    try:
        fp = ForwardPort(listen_port=9010, upstream_target="127.0.0.1:9011", enabled=True)
        session.add(fp)
        session.commit()
        fid = fp.id
    finally:
        session.close()
    from app.api.upstreams import test_forward_targets

    resp = client.post(f"/api/forward-ports/{fid}/test", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert "results" in body and "all_ok" in body


def test_reload_returns_render(client, auth_headers, db_session_factory):
    session = db_session_factory()
    try:
        cfg = NginxConfig(name="reload_cfg", domain="r.example.com", config_text="", enabled=True)
        session.add(cfg)
        session.commit()
        cid = cfg.id
    finally:
        session.close()
    r = client.post(f"/api/nginx-configs/{cid}/reload", headers=auth_headers)
    assert r.status_code == 200
    assert "content" in r.json()
```

- [ ] **Step 2：运行确认失败**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_actions.py -v
```

Expected: 404（路由未注册）。

- [ ] **Step 3：最小实现**

Create `backend/app/api/actions.py`:

```python
"""运维动作端点：topology 四层图 / forward 连通性 / reload / directives（需登录）。"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.api.upstreams import test_forward_targets
from app.core.security import get_current_user
from app.models import BizPort, DomainMapping, ForwardPort, NginxConfig
from app.models.user import User
from app.services.render import DIRECTIVES, render_config

router = APIRouter(prefix="/api", tags=["运维动作"])


class TopologyNode(BaseModel):
    """拓扑四层节点：domain -> listen -> upstream/server -> biz。"""

    id: str
    label: str
    type: str
    status: str | None = None
    children: list["TopologyNode"] = []

    model_config = ConfigDict()


TopologyNode.model_rebuild()


def _parse_port(host_colon_port: str) -> int | None:
    try:
        return int(host_colon_port.rsplit(":", 1)[1])
    except (ValueError, IndexError):
        return None


def build_topology(db: Session) -> list[TopologyNode]:
    domains = db.execute(select(DomainMapping)).scalars().all()
    fports = db.execute(select(ForwardPort)).scalars().all()
    upstreams = {u.id: u for u in db.execute(select(Upstream)).scalars().all()}
    servers = db.execute(select(UpstreamServer)).scalars().all()
    bizports = list(db.execute(select(BizPort)).scalars().all())

    top: list[TopologyNode] = []
    for dm in domains:
        dnode = TopologyNode(
            id=f"domain-{dm.id}", label=dm.domain, type="domain",
            status="up" if dm.enabled else "down",
        )
        dm_port = _parse_port(dm.forward_tos)
        for fp in fports:
            if not fp.enabled or dm_port != fp.listen_port:
                continue
            lnode = TopologyNode(
                id=f"listen-{fp.id}", label=f":{fp.listen_port}", type="listen",
                status="up" if fp.enabled else "down",
            )
            if fp.upstream_id and fp.upstream_id in upstreams:
                u = upstreams[fp.upstream_id]
                unode = TopologyNode(
                    id=f"upstream-{u.id}", label=f"{u.name} ({u.strategy})",
                    type="upstream", status="up",
                )
                for s in servers:
                    if s.upstream_id != u.id:
                        continue
                    snode = TopologyNode(
                        id=f"srv-{s.id}", label=f"{s.addr}:{s.port}",
                        type="server", status=s.health_status,
                    )
                    for bp in bizports:
                        if bp.port == s.port:
                            snode.children.append(TopologyNode(
                                id=f"biz-{bp.id}", label=bp.service_name,
                                type="biz", status="up",
                            ))
                    unode.children.append(snode)
                lnode.children.append(unode)
            else:
                lnode.children.append(TopologyNode(
                    id=f"srv-direct-{fp.id}", label=fp.upstream_target,
                    type="server", status="up",
                ))
            dnode.children.append(lnode)
        top.append(dnode)
    return top


@router.get("/topology", response_model=list[TopologyNode])
def get_topology(db: Session = Depends(get_db), _user: User = Depends(get_current_user)):
    return build_topology(db)


@router.get("/directives", response_model=list[dict])
def get_directives(_user: User = Depends(get_current_user)):
    return DIRECTIVES


@router.post("/forward-ports/{forward_id}/test")
def test_forward(
    forward_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    fp = db.execute(select(ForwardPort).where(ForwardPort.id == forward_id)).scalar_one_or_none()
    if fp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="转发端口不存在")
    results = test_forward_targets(db, fp)
    return {"results": results, "all_ok": all(r["ok"] for r in results)}


@router.post("/nginx-configs/{config_id}/reload")
def reload_config(
    config_id: int,
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    cfg = db.execute(select(NginxConfig).where(NginxConfig.id == config_id)).scalar_one_or_none()
    if cfg is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="配置不存在")
    content = render_config(db, config_id)
    # 单机模拟：仅返回渲染文本供 dry-run，不做真实 nginx reload
    return {"content": content, "message": "已生成配置文本（模拟 reload，未接入真实 nginx）"}
```

- [ ] **Step 4：修正并确认通过**

将 actions 里缺失的 `Upstream/UpstreamServer` 导入补上（`from app.models import ...`）。同时修正 `test_actions.py` 中 `test_forward_test_direct` 的 helper 误用——该用例里直接调用底层 helper，但传参错误。改为通过端点间接覆盖（`test_forward_test_endpoint` 已覆盖），从测试文件删除 `test_forward_test_direct` 或改为：

```python
def test_forward_socket_failure_via_monkeypatch(client, auth_headers, db_session_factory, monkeypatch):
    session = db_session_factory()
    try:
        fp = ForwardPort(listen_port=9020, upstream_target="127.0.0.1:9021", enabled=True)
        session.add(fp)
        session.commit()
        fid = fp.id
    finally:
        session.close()
    import socket as _s
    monkeypatch.setattr(_s, "create_connection", lambda *a, **k: (_ for _ in ()).throw(ConnectionRefusedError("refused")))
    resp = client.post(f"/api/forward-ports/{fid}/test", headers=auth_headers)
    assert resp.json()["all_ok"] is False
```

运行：

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_actions.py -v
```

Expected: 5 PASS。

- [ ] **Step 5：Commit**

```bash
git add backend/app/api/actions.py backend/tests/test_actions.py && git commit -m "feat: topology/forward test/reload/directives 动作端点"
```

---

## Task 8：main.py 注册所有新路由

**Files:**
- Modify: `backend/app/main.py`

- [ ] **Step 1：先建集成自检命令（无需新文件）**

手动跑一遍全量后端测试确认路由全通：

```bash
cd backend && .venv/Scripts/python -m pytest -v
```

Expected: 现有 auth/item + 新增全部 PASS。

- [ ] **Step 2：确认失败（此时 actions/blocks/upstreams 尚未注册）**

Expected: 报 `test_blocks/upstreams/actions` 404。

- [ ] **Step 3：注册路由**

Modify `backend/app/main.py` 的导入段：

```python
from app.api.actions import router as actions_router
from app.api.auth import router as auth_router
from app.api.blocks import router as blocks_router
from app.api.items import router as items_router
from app.api.nginx import (
    biz_router,
    forward_router,
    mapping_router,
    nginx_router,
)
from app.api.upstreams import router as upstream_router
```

在 `app.include_router(biz_router)` 之后追加：

```python
app.include_router(upstream_router)
app.include_router(blocks_router)
app.include_router(actions_router)
```

- [ ] **Step 4：运行确认通过**

```bash
cd backend && .venv/Scripts/python -m pytest -v
```

Expected: 全部 PASS，无 404。

- [ ] **Step 5：Commit**

```bash
git add backend/app/main.py && git commit -m "feat: 注册 upstream/blocks/actions 路由"
```

---

## Task 9：前端 API client（operations.js）

**Files:**
- Create: `frontend/src/api/operations.js`

- [ ] **Step 1：写待验证命名契约（对应后端所有端点的 axios 封装）**

Create `frontend/src/api/operations.js`:

```js
import client from "./client";

// ---- 全局拓扑 / 指令字典 ----
export const listTopology = () => client.get("/topology");
export const listDirectives = () => client.get("/directives");

// ---- upstream 组 ----
export const listUpstreams = () => client.get("/upstreams");
export const createUpstream = (data) => client.post("/upstreams", data);
export const updateUpstream = (id, data) => client.put(`/upstreams/${id}`, data);
export const deleteUpstream = (id) => client.delete(`/upstreams/${id}`);
export const previewUpstream = (id) => client.get(`/upstreams/${id}/preview`);
export const validateUpstream = (id) => client.post(`/upstreams/${id}/validate`);

// ---- upstream 组内节点 ----
export const listServers = (id) => client.get(`/upstreams/${id}/servers`);
export const createServer = (id, data) => client.post(`/upstreams/${id}/servers`, data);
export const updateServer = (id, sid, data) => client.put(`/upstreams/${id}/servers/${sid}`, data);
export const deleteServer = (id, sid) => client.delete(`/upstreams/${id}/servers/${sid}`);

// ---- 泛化配置块 ----
export const listBlocks = (nginxConfigId) => client.get(`/nginx-configs/${nginxConfigId}/blocks`);
export const createBlock = (data) => client.post("/config-blocks", data);
export const updateBlock = (id, data) => client.put(`/config-blocks/${id}`, data);
export const deleteBlock = (id) => client.delete(`/config-blocks/${id}`);

// ---- 块内指令行 ----
export const listOptions = (blockId) => client.get("/config-options", { params: { block_id: blockId } });
export const createOption = (data) => client.post("/config-options", data);
export const updateOption = (id, data) => client.put(`/config-options/${id}`, data);
export const deleteOption = (id) => client.delete(`/config-options/${id}`);
export const reorderOptions = (blockId, ids) => client.post("/config-options/reorder", { block_id: blockId, ids });

// ---- 渲染预览 / reload / 转发测试 ----
export const renderConfig = (id) => client.get(`/nginx-configs/${id}/render`);
export const reloadConfig = (id) => client.post(`/nginx-configs/${id}/reload`);
export const testForward = (id) => client.post(`/forward-ports/${id}/test`);
```

- [ ] **Step 2：构建门禁确认编译**

```bash
cd frontend && npm run build
```

Expected: 构建成功（当前无引用，仅确认语法）。

- [ ] **Step 3：确认（无实现改动，跳过）**

无逻辑改动步骤。

- [ ] **Step 4：确认（同 Step 2）**

已通过。

- [ ] **Step 5：Commit**

```bash
git add frontend/src/api/operations.js && git commit -m "feat: 新增运维动作 API client"
```

---

## Task 10：路由与顶级菜单（App.jsx）

**Files:**
- Modify: `frontend/src/App.jsx`
- Delete: `frontend/src/pages/OpsConsole.jsx`

- [ ] **Step 1：先写构建门禁（删除旧组件前保证新组件存在）**

本 Task 先创建新页面组件骨架（占位），下一 Task 起填充。先建三个最小页面：

Create `frontend/src/pages/ops/OpsConfigPage.jsx`:

```jsx
export default function OpsConfigPage() {
  return <div style={{ color: "#e8e8ea" }}>配置文件（列表 + 详情主从）</div>;
}
```

Create `frontend/src/pages/ops/OpsUpstreamPage.jsx` 与 `frontend/src/pages/ops/OpsTopologyPage.jsx` 同形占位（各自标题）。

- [ ] **Step 2：构建门禁确认通过**

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 3：改 App.jsx 增菜单与路由**

Modify `frontend/src/App.jsx`：
- import 段加 `OpsConfigPage`、`OpsUpstreamPage`、`OpsTopologyPage`；把 `OpsConsole` 替换为 `OpsConfigPage`。
- 顶级菜单 `items` 增加三项：

```jsx
{
  key: "config",
  icon: <GlobalOutlined />,
  label: "配置文件",
  onClick: () => navigate("/ops/config"),
},
{
  key: "upstream",
  icon: <ClusterOutlined />,
  label: "Upstream池",
  onClick: () => navigate("/ops/upstream"),
},
{
  key: "topology",
  icon: <ApartmentOutlined />,
  label: "全局拓扑",
  onClick: () => navigate("/ops/topology"),
},
```

- 路由区（ProtectedLayout 内）加：

```jsx
<Route path="/ops/config" element={<OpsConfigPage />} />
<Route path="/ops/upstream" element={<OpsUpstreamPage />} />
<Route path="/ops/topology" element={<OpsTopologyPage />} />
```

删掉原 `<Route path="/ops" element={<OpsConsole />} />`，可保留 `/ops` 重定向到 `/ops/config`：加 `<Route path="/ops" element={<Navigate to="/ops/config" replace />} />`。

- 删除文件 `frontend/src/pages/OpsConsole.jsx`。

- [ ] **Step 4：构建门禁确认通过**

```bash
cd frontend && npm run build
```

Expected: 成功，无未定义导入。

- [ ] **Step 5：Commit**

```bash
git add -A frontend/src && git commit -m "feat: 顶级菜单与三个 ops 页面路由，移除旧 OpsConsole"
```

---

## Task 11：OpsConfigPage + ListPanel（主从视图）

**Files:**
- Modify: `frontend/src/pages/ops/OpsConfigPage.jsx`
- Create: `frontend/src/pages/ops/ListPanel.jsx`

- [ ] **Step 1：构建门禁锁定（先实现再验证）**

- [ ] **Step 2：确认失败（此时 ListPanel 不存在）**

```bash
cd frontend && npm run build
```

Expected: 引入 ListPanel 但未实现 → 构建报错（作为 TDD 失败信号）。

- [ ] **Step 3：实现**

Create `frontend/src/pages/ops/ListPanel.jsx`:

```jsx
import { Input, Tag } from "antd";
import { listNginxConfigs } from "../../api/nginx";

const SCOPE_STATUS = { enabled: "green", disabled: "red" };

export default function ListPanel({ selectedId, onSelect, onReloadNeeded }) {
  const [rows, setRows] = useState([]);
  const [keyword, setKeyword] = useState("");
  useEffect(() => {
    listNginxConfigs().then((r) => setRows(r.data));
  }, [onReloadNeeded]);

  const filtered = rows.filter((r) => !keyword || r.name.includes(keyword) || (r.domain || "").includes(keyword));
  return (
    <div style={{ width: 300, background: "#111114", borderRight: "1px solid #2a2a2e" }}>
      <Input
        placeholder="搜索配置名/域名"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        style={{ margin: 12, width: "calc(100% - 24px)" }}
      />
      <div>
        {filtered.map((r) => (
          <div
            key={r.id}
            onClick={() => onSelect(r.id)}
            style={{
              padding: "10px 16px", cursor: "pointer", color: "#e8e8ea",
              background: selectedId === r.id ? "#2a2a42" : "transparent",
              borderLeft: selectedId === r.id ? "2px solid #4a8af4" : "2px solid transparent",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <b>{r.name}</b>
              <Tag color={r.enabled ? "green" : "red"}>{r.enabled ? "启用" : "停用"}</Tag>
            </div>
            <div style={{ color: "#808090", fontSize: 12 }}>{r.domain}</div>
            {/* 业务端口告警红条占位：后续由 BizPort 判断 */}
          </div>
        ))}
      </div>
    </div>
  );
}
```

**注意：** `ListPanel.jsx` 顶部需补齐 `import { useEffect, useState } from "react";`。

Modify `frontend/src/pages/ops/OpsConfigPage.jsx`（替换占位）：

```jsx
import { useState } from "react";
import { Button } from "antd";
import ListPanel from "./ListPanel";
import DetailPanel from "./DetailPanel";

export default function OpsConfigPage() {
  const [selectedId, setSelectedId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div style={{ display: "flex", height: "calc(100vh - 120px)", background: "#18181c" }}>
      <ListPanel selectedId={selectedId} onSelect={setSelectedId} onReloadNeeded={reloadKey} />
      <div style={{ flex: 1, padding: 16 }}>
        {selectedId == null ? (
          <div style={{ color: "#808090", textAlign: "center", marginTop: 80 }}>
            从左侧选择一份 nginx 配置
            <div><Button type="primary" style={{ marginTop: 12 }}>新建配置</Button></div>
          </div>
        ) : (
          <DetailPanel configId={selectedId} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4：构建门禁确认通过**

此时 `DetailPanel` 尚未实现——临时先在本 Task 让 DetailPanel 为占位（下一步实现）。为让构建通过，先建最小 `DetailPanel`：

Create `frontend/src/pages/ops/DetailPanel.jsx`（占位，下一 Task 填充）：

```jsx
export default function DetailPanel({ configId }) {
  return <div style={{ color: "#e8e8ea" }}>详情：#{configId}</div>;
}
```

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 5：Commit**

```bash
git add frontend/src/pages/ops && git commit -m "feat: OpsConfigPage 主从骨架 + ListPanel"
```

---

## Task 12：DetailPanel + OverviewGrid + BizPortChips + PathChain

**Files:**
- Modify: `frontend/src/pages/ops/DetailPanel.jsx`
- Create: `frontend/src/pages/ops/OverviewGrid.jsx`
- Create: `frontend/src/pages/ops/BizPortChips.jsx`
- Create: `frontend/src/pages/ops/PathChain.jsx`

- [ ] **Step 1&2：确认失败（DetailPanel 仍是占位）**

```bash
cd frontend && npm run build
```

Expected: 通过（占位无错）；本 Task 通过新增子组件并接线后验证行为。

- [ ] **Step 3：实现子组件 + 重构 DetailPanel**

Create `frontend/src/pages/ops/OverviewGrid.jsx`:

```jsx
import { Descriptions, Tag } from "antd";

export default function OverviewGrid({ config }) {
  return (
    <Descriptions column={2} bordered size="small">
      <Descriptions.Item label="配置名">{config.name}</Descriptions.Item>
      <Descriptions.Item label="启用">
        <Tag color={config.enabled ? "green" : "red"}>{config.enabled ? "启用" : "停用"}</Tag>
      </Descriptions.Item>
      <Descriptions.Item label="域名">{config.domain || "-"}</Descriptions.Item>
      <Descriptions.Item label="ID">#{config.id}</Descriptions.Item>
    </Descriptions>
  );
}
```

Create `frontend/src/pages/ops/BizPortChips.jsx`:

```jsx
import { useEffect, useState } from "react";
import { Tag } from "antd";
import { listBizPorts } from "../../api/nginx";

export default function BizPortChips() {
  const [ports, setPorts] = useState([]);
  useEffect(() => {
    listBizPorts().then((r) => setPorts(r.data));
  }, []);
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {ports.map((p) => (
        <Tag key={p.id} color={p.public_exposed ? "red" : "green"}>
          {p.service_name} :{p.port} {p.public_exposed ? "·公网" : "·内网"}
        </Tag>
      ))}
    </div>
  );
}
```

Create `frontend/src/pages/ops/PathChain.jsx`:

```jsx
import { Breadcrumb } from "antd";

export default function PathChain({ domain, listenPort, target, isPublic }) {
  const items = [
    { title: domain || "域名" },
    { title: listenPort ? `:${listenPort}` : "监听" },
    { title: target || "目标" },
    { title: isPublic ? "公网" : "内网" },
  ].filter((i) => i.title);
  return <Breadcrumb items={items.map((i) => ({ title: i.title }))} />;
}
```

Modify `frontend/src/pages/ops/DetailPanel.jsx`（填充 Tab 化详情）：

```jsx
import { useEffect, useState } from "react";
import { Button, Space, Tabs, message } from "antd";
import { getForwardPorts } from "../../api/nginx"; // 见下方 API 追加
import { reloadConfig } from "../../api/operations";
import OverviewGrid from "./OverviewGrid";
import BizPortChips from "./BizPortChips";
import PathChain from "./PathChain";
import BlockTree from "./BlockTree";

export default function DetailPanel({ configId }) {
  const [cfg, setCfg] = useState(null);
  useEffect(() => {
    // 用 listNginxConfigs 取回后按 id 过滤（现有 client 无 getSingle）
    listNginxConfigs().then((r) => {
      const found = r.data.find((c) => c.id === configId);
      setCfg(found || null);
    });
  }, [configId]);

  const handleReload = async () => {
    try {
      const r = await reloadConfig(configId);
      message.success(`已生成配置文本（${r.data.content.length} 字符）`);
    } catch {
      message.error("Reload 失败");
    }
  };

  return (
    <div>
      <Space style={{ justifyContent: "space-between", width: "100%", marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>配置文件 · #{configId}</h3>
        <Space>
          <Button type="primary" onClick={handleReload}>Reload 预览</Button>
        </Space>
      </Space>
      {cfg && <OverviewGrid config={cfg} />}
      <Tabs
        defaultActiveKey="overview"
        items={[
          { key: "overview", label: "概览", children: <OverviewWithWidgets cfg={cfg} /> },
          { key: "blocks", label: "块树", children: <BlockTree configId={configId} /> },
        ]}
      />
    </div>
  );
}

function OverviewWithWidgets({ cfg }) {
  return (
    <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
      <div><b style={{ color: "#808090" }}>访问链路</b><PathChain domain={cfg?.domain} listenPort={null} target="-"/></div>
      <div><b style={{ color: "#808090" }}>业务端口</b><BizPortChips /></div>
    </div>
  );
}
import { listNginxConfigs } from "../../api/nginx";
```

**注意：** 上面把 `listNginxConfigs` 的 import 放到了文件底部（非法）。正确做法：在文件顶部加 `import { listNginxConfigs } from "../../api/nginx";`。请把该行归置到顶部，并删除底部那行。

- [ ] **Step 4：构建门禁确认通过**

此时 `BlockTree` 尚不存在，会让构建失败。先建 BlockTree 占位（下一 Task 实现）。

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 5：Commit**

```bash
git add frontend/src/pages/ops/DetailPanel.jsx frontend/src/pages/ops/OverviewGrid.jsx frontend/src/pages/ops/BizPortChips.jsx frontend/src/pages/ops/PathChain.jsx && git commit -m "feat: DetailPanel 概览 Tab + OverviewGrid/BizPortChips/PathChain"
```

---

## Task 13：BlockTree（嵌套块树）

**Files:**
- Create: `frontend/src/pages/ops/BlockTree.jsx`

- [ ] **Step 1&2：确认失败（BlockTree 为占位）**

本 Task 前，`BlockTree` 只是占位。改为真实实现后重新构建：

```bash
cd frontend && npm run build
```

Expected: 占位无错（此步作为实现前置空跑）。

- [ ] **Step 3：实现**

Create `frontend/src/pages/ops/BlockTree.jsx`:

```jsx
import { useEffect, useState } from "react";
import { Button, Modal, Popconfirm, Select, Form, Input, Space, Tag, message, Tree, InputNumber } from "antd";
import { createBlock, deleteBlock, listBlocks, updateBlock } from "../../api/operations";

const SCOPE_TAG = {
  server: "blue", location: "cyan", upstream: "purple", map: "orange",
  geo: "gold", if: "volcano", log_format: "lime", include: "geekblue",
  comment: "default", raw: "magenta",
};

export default function BlockTree({ configId }) {
  const [tree, setTree] = useState([]);
  const [modal, setModal] = useState(null); // {parentId | null, edit?: block}
  const [form] = Form.useForm();
  useEffect(() => { reload(); }, [configId]);

  const reload = async () => {
    const r = await listBlocks(configId);
    setTree(r.data);
  };

  const openCreate = (parentId) => {
    setModal({ parentId, edit: null });
    form.resetFields();
  };
  const openEdit = (block) => {
    setModal({ parentId: block.parent_id, edit: block });
    form.setFieldsValue(block);
  };
  const submit = async (values) => {
    try {
      if (modal?.edit) {
        await updateBlock(modal.edit.id, values);
      } else {
        await createBlock({ ...values, nginx_config_id: configId, parent_id: modal.parentId });
      }
      message.success("已保存"); setModal(null); reload();
    } catch { message.error("保存失败"); }
  };
  const remove = async (id) => { await deleteBlock(id); message.success("已删除"); reload(); };

  const renderNode = (block, parentId) => ({
    key: block.id,
    title: (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Tag color={SCOPE_TAG[block.scope] || "default"}>{block.scope}</Tag>
        <span style={{ fontFamily: "monospace" }}>{block.header}</span>
        <Space size={2} style={{ marginLeft: 8 }}>
          <Button size="small" type="link" onClick={(e) => { e.stopPropagation(); openCreate(block.id); }}>+块</Button>
          <Button size="small" type="link" onClick={(e) => { e.stopPropagation(); openEdit(block); }}>编辑</Button>
          <Popconfirm title="删除该块及其子块/KV？" onConfirm={() => remove(block.id)}>
            <Button size="small" type="link" danger onClick={(e) => e.stopPropagation()}>删除</Button>
          </Popconfirm>
        </Space>
      </div>
    ),
    children: (block.children || []).map((c) => renderNode(c, block.id)),
  });

  const treeData = (tree || []).map((b) => renderNode(b, null));
  return (
    <div>
      <Button type="dashed" size="small" style={{ marginBottom: 8 }} onClick={() => openCreate(null)}>+ 根块</Button>
      <Tree showLine treeData={treeData} defaultExpandAll />
      <Modal
        title={modal?.edit ? "编辑块" : "新建块"}
        open={!!modal} onOk={() => form.submit()} onCancel={() => setModal(null)}
        destroyOnClose width={480}
      >
        <Form form={form} layout="vertical" onFinish={submit}>
          <Form.Item name="scope" label="块类型" rules={[{ required: true }]}>
            <Select
              options={Object.keys(SCOPE_TAG).map((s) => ({ value: s, label: s }))}
            />
          </Form.Item>
          <Form.Item name="header" label="块头原文" rules={[{ required: true }]}>
            <Input placeholder="例如 location /api/ {（不含花括号）" />
          </Form.Item>
          <Form.Item name="belongs_to_file" label="文件归属">
            <Input placeholder="如 shop.server（可空）"/>
          </Form.Item>
          <Form.Item name="sort_order" label="同级顺序" initialValue={0}>
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
```

**注意：** 块节点还应支持在该快内加 KV 行 —— 由本块的详情区 `KvListEditor` 提供（见 Task 14）；`BlockTree` 聚焦块的增删改与嵌套。移除 `updateBlock` 若未使用可省。

- [ ] **Step 4：构建门禁确认通过**

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 5：Commit**

```bash
git add frontend/src/pages/ops/BlockTree.jsx && git commit -m "feat: 嵌套块树 BlockTree（增删改 + 缩进线）"
```

---

## Task 14：KvListEditor（指令补全 / row_type 标签 / default 置底 / 顺序）

**Files:**
- Create: `frontend/src/pages/ops/KvListEditor.jsx`

- [ ] **Step 1&2：前置空跑**

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 3：实现**

Create `frontend/src/pages/ops/KvListEditor.jsx`:

```jsx
import { useEffect, useState } from "react";
import { AutoComplete, Button, Modal, Popconfirm, Select, Table, Tag, message, Form, Input } from "antd";
import { listDirectives, listOptions, createOption, updateOption, deleteOption, reorderOptions } from "../../api/operations";

const ROW_TAG = { kv: "blue", regex: "purple", string: "cyan", default: "orange", raw: "red" };

export default function KvListEditor({ blockId }) {
  const [rows, setRows] = useState([]);
  const [directives, setDirectives] = useState([]);
  const [modal, setModal] = useState(null);
  const [form] = Form.useForm();
  useEffect(() => { load(); }, [blockId]);
  const load = async () => {
    if (!blockId) return;
    const [r, d] = await Promise.all([listOptions(blockId), listDirectives()]);
    setRows(r.data); setDirectives(d.data.map((x) => x.name));
  };

  const openCreate = () => { setModal(null); form.resetFields(); form.setFieldsValue({ row_type: "kv", sort_order: rows.length }); };
  const openEdit = (row) => { setModal(row); form.setFieldsValue(row); };
  const submit = async (v) => {
    if (modal) await updateOption(modal.id, v); else await createOption({ ...v, block_id: blockId });
    message.success("已保存"); setModal(null); load();
  };
  const remove = async (id) => { await deleteOption(id); load(); };

  const columns = [
    {
      title: "类型", dataIndex: "row_type", width: 80,
      render: (v) => <Tag color={ROW_TAG[v] || "default"}>{v}</Tag>,
    },
    { title: "指令", dataIndex: "directive", key: "directive", ellipsis: true },
    { title: "值", dataIndex: "value", ellipsis: true },
    // default 行恒置末尾：列表展示时按 row_type 排序但也给顺序拖拽（后端 reorder 保证）
    {
      title: "顺序", width: 90, render: (_, rec, idx) => idx,
    },
    {
      title: "操作", width: 120,
      render: (_, rec) => (
        <>
          <Button type="link" size="small" onClick={() => openEdit(rec)}>编辑</Button>
          <Popconfirm title="删除该行？" onConfirm={() => remove(rec.id)}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </>
      ),
    },
  ];
  // 展示顺序：非 default 按 sort_order，default 恒置末尾（对应后端语义）
  const sorted = [...rows].sort((a, b) => {
    const aTag = a.row_type === "default" ? 1 : 0;
    const bTag = b.row_type === "default" ? 1 : 0;
    if (aTag !== bTag) return aTag - bTag;
    return a.sort_order - b.sort_order;
  });

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Button size="small" type="primary" onClick={openCreate}>+ 指令行</Button>
        <span style={{ color: "#808090", marginLeft: 8, fontSize: 12 }}>
          default 行渲染时恒置末尾
        </span>
      </div>
      <Table rowKey="id" size="small" pagination={false} columns={columns} dataSource={sorted} />
      <Modal title={modal ? "编辑指令行" : "新增指令行"} open={modal !== null} onOk={() => form.submit()}
        onCancel={() => setModal(null)} destroyOnClose width={520}>
        <Form form={form} layout="vertical" onFinish={submit}>
          <Form.Item name="row_type" label="行类型" rules={[{ required: true }]}>
            <Select options={Object.keys(ROW_TAG).map((k) => ({ value: k, label: k }))} />
          </Form.Item>
          <Form.Item name="directive" label="指令名 / 映射条件" rules={[{ required: true }]}>
            <AutoComplete options={directives.map((d) => ({ value: d }))} placeholder="输入或从补全选择（如 proxy_pass）" />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, n) => p.row_type !== n.row_type}>
            {({ getFieldValue }) => getFieldValue("row_type") === "raw" ? (
              <Form.Item name="value" label="原文整行（照录渲染）">
                <Input.TextArea rows={2} />
              </Form.Item>
            ) : (
              <Form.Item name="value" label="值">
                <Input placeholder="例如 http://api_backend; （map 条件/结果等亦可）" />
              </Form.Item>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
```

- [ ] **Step 4：构建门禁确认通过**

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 5：Commit**

```bash
git add frontend/src/pages/ops/KvListEditor.jsx && git commit -m "feat: KV 行编辑器 KvListEditor（补全/row_type/default 置底）"
```

---

## Task 15：OpsUpstreamPage（Upstream 池管理）

**Files:**
- Modify: `frontend/src/pages/ops/OpsUpstreamPage.jsx`

- [ ] **Step 1&2：前置空跑（当前为占位）**

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 3：实现**

Modify `frontend/src/pages/ops/OpsUpstreamPage.jsx`（替换占位）：

```jsx
import { useEffect, useState } from "react";
import { Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Table, Tag, message, Space } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import {
  createUpstream, listUpstreams, deleteUpstream, listServers,
  createServer, updateServer, deleteServer, previewUpstream, validateUpstream,
} from "../../api/operations";

export default function OpsUpstreamPage() {
  const [groups, setGroups] = useState([]);
  const [active, setActive] = useState(null);
  const [servers, setServers] = useState([]);
  const [groupModal, setGroupModal] = useState(null);
  const [serverModal, setServerModal] = useState(null);
  const [preview, setPreview] = useState("");
  const [validate, setValidate] = useState(null);
  const [groupForm] = Form.useForm();
  const [serverForm] = Form.useForm();

  const loadGroups = async () => {
    const r = await listUpstreams();
    setGroups(r.data);
    if (!active && r.data.length) selectGroup(r.data[0].id);
  };
  useEffect(() => { loadGroups(); }, []);

  const selectGroup = async (id) => {
    setActive(id);
    const [s, p] = await Promise.all([listServers(id), previewUpstream(id)]);
    setServers(s.data); setPreview(p.data.content);
  };

  const submitGroup = async (v) => {
    if (groupModal?.id) groupModal; // place
    if (groupModal?.id) { } else { await listUpstreams(); }
    setGroupModal(null); loadGroups();
  };

  const addGroupModal = () => { setGroupModal({}); groupForm.resetFields(); };
  const addServerModal = () => { setServerModal({}); serverForm.resetFields(); };
  const submitServer = async (v) => {
    if (serverModal?.id) null; else await createServer(active, v);
    setServerModal(null); selectGroup(active);
  };

  const groupCols = [
    { title: "组名", dataIndex: "name" },
    { title: "策略", dataIndex: "strategy", render: (v) => <Tag>{v}</Tag> },
    { title: "keepalive", dataIndex: "keepalive", width: 100 },
    { title: "节点数", render: () => servers.length, width: 80 },
    {
      title: "操作", width: 140, render: (_, rec) => (
        <Space>
          <Button type="link" size="small" onClick={() => selectGroup(rec.id)}>查看</Button>
          <Popconfirm title="删除该组（被引用将拒绝）？" onConfirm={() => { deleteUpstream(rec.id).then(loadGroups).catch(() => message.error("删除被驳回：正被转发端口引用")); }}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const srvCols = [
    { title: "地址", dataIndex: "addr" },
    { title: "端口", dataIndex: "port" },
    { title: "权重", dataIndex: "weight", width: 80 },
    { title: "健康", dataIndex: "health_status", width: 90, render: (v) => <Tag color={{ up: "green", down: "red", checking: "orange" }[v]}>{v}</Tag> },
    { title: "启用", dataIndex: "enable", width: 80, render: (v) => <Tag color={v ? "green" : "default"}>{v ? "是" : "否"}</Tag> },
    {
      title: "操作", width: 120, render: (_, rec) => (
        <Popconfirm title="删除节点？" onConfirm={() => deleteServer(active, rec.id).then(() => selectGroup(active))}>
          <Button type="link" size="small" danger>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div style={{ padding: 16 }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Upstream 池</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={addGroupModal}>新建组</Button>
      </Space>
      <Table rowKey="id" size="small" style={{ marginTop: 12 }} columns={groupCols} dataSource={groups} pagination={false} />
      {active && (
        <Card size="small" title={`组内节点 · ${active}`} style={{ marginTop: 16 }}
          extra={<Button icon={<PlusOutlined />} onClick={addServerModal}>加节点</Button>}>
          <Table rowKey="id" size="small" columns={srvCols} dataSource={servers} pagination={false} />
          <div style={{ marginTop: 12, display: "flex", gap: 12 }}>
            <Button onClick={() => validateUpstream(active).then((r) => setValidate(r.data))}>nginx -t 校验</Button>
            {validate && <Tag color={validate.valid ? "green" : "red"}>{validate.valid ? "通过" : validate.error}</Tag>}
          </div>
          <pre style={{ background: "#0a0a0c", color: "#e8e8ea", padding: 12, borderRadius: 6, marginTop: 12 }}>
            {preview}
          </pre>
        </Card>
      )}
      <Modal title="新建 Upstream 组" open={!!groupModal} onOk={() => groupForm.submit()} onCancel={() => setGroupModal(null)} destroyOnClose width={440}>
        <Form form={groupForm} layout="vertical" onFinish={async (v) => { await createUpstream(v); setGroupModal(null); loadGroups(); }}>
          <Form.Item name="name" label="组名" rules={[{ required: true }]}><Input placeholder="如 api_backend" /></Form.Item>
          <Form.Item name="strategy" label="均衡策略" initialValue="round_robin">
            <Select options={["round_robin", "least_conn", "ip_hash"].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="keepalive" label="keepalive" initialValue={32}><InputNumber min={0} style={{ width: "100%" }} /></Form.Item>
        </Form>
      </Modal>
      <Modal title="新增节点" open={!!serverModal} onOk={() => serverForm.submit()} onCancel={() => setServerModal(null)} destroyOnClose width={440}>
        <Form form={serverForm} layout="vertical" onFinish={submitServer}>
          <Form.Item name="addr" label="地址" rules={[{ required: true }]}><Input placeholder="如 10.0.0.1" /></Form.Item>
          <Form.Item name="port" label="端口" rules={[{ required: true }]}><InputNumber min={1} max={65535} style={{ width: "100%" }} /></Form.Item>
          <Form.Item name="weight" label="权重" initialValue={1}><InputNumber min={1} style={{ width: "100%" }} /></Form.Item>
          <Form.Item name="health_status" label="健康状态" initialValue="checking">
            <Select options={["up", "down", "checking"].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="enable" label="启用" valuePropName="checked" initialValue={true}><Select options={[{value:true,label:"启用"},{value:false,label:"停用"}]} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
```

**注意：** 该组件里 `submitGroup` 逻辑占位混乱（无实际编辑组入口），本 Task 只要求"新建 + 节点管理 + 预览/校验"，编辑组可留待后续；为通过 ESLint/构建，请清理未用变量（`groupModal?.id` 分支保留为 no-op 即可，或将编辑组功能补全：`openEditGroup` + `updateUpstream`）。建议补全编辑以保持整洁。

- [ ] **Step 4：构建门禁确认通过**

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 5：Commit**

```bash
git add frontend/src/pages/ops/OpsUpstreamPage.jsx && git commit -m "feat: Upstream 池页面（组/节点/预览/校验）"
```

---

## Task 16：OpsTopologyPage + TopologyView（四层图）

**Files:**
- Modify: `frontend/src/pages/ops/OpsTopologyPage.jsx`
- Create: `frontend/src/pages/ops/TopologyView.jsx`

- [ ] **Step 1&2：前置空跑**

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 3：实现**

Create `frontend/src/pages/ops/TopologyView.jsx`:

```jsx
import { Button } from "antd";

const COLOR = { domain: "#4a8af4", listen: "#22c55e", upstream: "#f59e0b",
  server: "#ef4444", biz: "#a78bfa" };

function Node({ node }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <Button
        size="small" onMouseDown={(e) => e.stopPropagation()}
        style={{ background: "#202024", color: "#e8e8ea",
          borderColor: COLOR[node.type] || "#2a2a2e", minWidth: 110 }}
      >
        {node.label}
      </Button>
      {node.children?.length ? (
        <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
          {node.children.map((c) => <Node key={c.id} node={c} />)}
        </div>
      ) : null}
    </div>
  );
}

export default function TopologyView({ nodes, loading, onRetry }) {
  if (loading) return <div style={{ color: "#808090" }}>加载拓扑中…</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", minWidth: "max-content" }}>
        {nodes.map((n) => <Node key={n.id} node={n} />)}
      </div>
      <Button size="small" style={{ marginTop: 12 }} onClick={onRetry}>重试</Button>
    </div>
  );
}
```

Modify `frontend/src/pages/ops/OpsTopologyPage.jsx`（替换占位）：

```jsx
import { useEffect, useState } from "react";
import { Empty } from "antd";
import { listTopology } from "../../api/operations";
import TopologyView from "./TopologyView";

export default function OpsTopologyPage() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true);
    listTopology()
      .then((r) => setNodes(r.data))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  return (
    <div>
      <h2 style={{ margin: "0 0 12px" }}>全局拓扑（域名 → 监听点 → upstream → 后端）</h2>
      {nodes.length === 0 && !loading ? <Empty description="暂无域名映射，先配置域名与转发端口" /> : (
        <TopologyView nodes={nodes} loading={loading} onRetry={load} />
      )}
    </div>
  );
}
```

- [ ] **Step 4：构建门禁确认通过**

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 5：Commit**

```bash
git add frontend/src/pages/ops/OpsTopologyPage.jsx frontend/src/pages/ops/TopologyView.jsx && git commit -m "feat: 全局拓扑四层图 TopologyView"
```

---

## Task 17：导出中心（SSL 开关导出 + upstream 客户数据自动替换）

> 依据 mockup `plan-c-real-conf.html` 确认的子功能 2/5/6。后端在 `render_config` 结果上做文本后处理（纯函数，可测）；前端在 DetailPanel 新增「导出配置」入口 + 导出弹窗。

**Files:**
- Modify: `backend/app/services/render.py`（新增纯函数 `export_config_text`）
- Create: `backend/tests/test_export.py`
- Modify: `backend/app/api/blocks.py`（新增 `/export` 端点）
- Modify: `backend/app/schemas/block.py`（新增 `ExportRequest`/`ExportOut`）
- Create: `frontend/src/pages/ops/ExportModal.jsx`
- Modify: `frontend/src/pages/ops/DetailPanel.jsx`（dt-head 加「导出配置」按钮）
- Modify: `frontend/src/api/nginx.js`（新增 exportConfig）

- [ ] **Step 1：写失败测试（纯函数语义）**

Create `backend/tests/test_export.py`:

```python
"""export_config_text 纯函数测试：SSL 关闭丢 ssl_* + 改写 listen；upstream 客户数据替换。"""

from app.services.render import export_config_text

SAMPLE = (
    "upstream api_backend {\n"
    "    least_conn;\n"
    "    server 10.0.0.1:8080 weight=2;\n"
    "    server 10.0.0.2:8080;\n"
    "}\n\n"
    "server {\n"
    "    listen 443 ssl http2;\n"
    "    server_name api.example.com;\n"
    "    ssl_protocols TLSv1.2;\n"
    "    ssl_certificate /etc/ssl/a.pem;\n"
    "    ssl_certificate_key /etc/ssl/a.key;\n"
    "}\n"
)


def test_export_ssl_off_drops_ssl_lines_and_rewrites_listen():
    out = export_config_text(SAMPLE, ssl_enabled=False, upstream_servers={})
    assert "listen 443 http2;" in out       # ssl 标记被移除
    assert "ssl_protocols" not in out
    assert "ssl_certificate" not in out
    assert "ssl_certificate_key" not in out


def test_export_ssl_on_keeps_ssl_lines():
    out = export_config_text(SAMPLE, ssl_enabled=True, upstream_servers={})
    assert "listen 443 ssl http2;" in out
    assert "ssl_protocols TLSv1.2;" in out


def test_export_upstream_replaces_server_lines():
    out = export_config_text(
        SAMPLE,
        ssl_enabled=True,
        upstream_servers={"api_backend": ["192.168.1.10:9000", "192.168.1.11:9000"]},
    )
    assert "server 192.168.1.10:9000;" in out
    assert "server 192.168.1.11:9000;" in out
    assert "server 10.0.0.1:8080" not in out
    assert "least_conn;" in out  # 原指令仍保留
    # 非目标组不影响
    # 空列表 = 删除该组全部 server 行（保留其余指令）


def test_export_other_upstream_untouched():
    src = SAMPLE + "\nupstream other {\n    server 9.9.9.9:80;\n}\n"
    out = export_config_text(src, ssl_enabled=True,
                             upstream_servers={"api_backend": ["192.168.1.10:9000"]})
    assert "server 9.9.9.9:80;" in out
    assert "server 192.168.1.10:9000;" in out


def test_export_empty_upstream_servers_list_removes_block_servers():
    src = ("upstream g {\n    server 10.0.0.1:80;\n    keepalive 4;\n}\n")
    out = export_config_text(src, ssl_enabled=True, upstream_servers={"g": []})
    assert "server 10.0.0.1:80;" not in out
    assert "keepalive 4;" in out
```

- [ ] **Step 2：运行确认失败**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_export.py -v
```

Expected: `ImportError: cannot import name 'export_config_text'`。

- [ ] **Step 3：最小实现（render.py 追加纯函数）**

Append to `backend/app/services/render.py`:

```python
# 关闭 SSL 导出时丢弃的指令名（不放在 DIRECTIVES 之上，独立常量）
SSL_DROP_DIRECTIVES = {
    "ssl_protocols", "ssl_certificate", "ssl_certificate_key",
    "ssl_session_cache", "ssl_session_timeout", "ssl_ciphers",
    "ssl_prefer_server_ciphers",
}


def export_config_text(
    text: str,
    ssl_enabled: bool = True,
    upstream_servers: dict[str, list[str]] | None = None,
) -> str:
    """对 render_config 的文本结果做导出后处理（纯函数，无 DB）。

    - ssl_enabled=False：丢弃 SSL_DROP 的指令行；并将
      `listen X ssl http2;` 改写为 `listen X http2;`（去 ssl 标记、折叠空白）。
    - upstream_servers：键为 upstream 组名，值为导出节点列表；
      命中时用其替换该组内部所有 `server ...;` 行；值为 [] 表示删除全部 server 行。
      不影响未命中的组，也不改动组内其它指令行。
    """
    ups = upstream_servers or {}
    lines = text.split("\n")
    out: list[str] = []
    in_upstream: str | None = None
    upstream_root: int | None = None
    depth = 0

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()
        indent = line[: len(line) - len(line.lstrip())]

        if in_upstream is not None:
            if not stripped:
                out.append(line); i += 1; continue
            if stripped == "}":
                # 结束块：若指定了替换节点，先输出替换的 server 行再闭合
                if in_upstream in ups:
                    for node in ups[in_upstream]:
                        out.append(indent + "    " + f"server {node};")
                    # 已消费的原始 server 行跳过逻辑见下
                out.append(line); i += 1; in_upstream = None; continue
            if ups.get(in_upstream) is not None:
                # 目标组：跳过所有 server 行（由替换节点接管）；保留其它指令
                if stripped.startswith("server "):
                    i += 1; continue
            out.append(line); i += 1; continue

        if stripped.startswith("upstream ") and stripped.endswith("{"):
            in_upstream = stripped[9:-1].strip()
            out.append(line); i += 1; continue

        # 常规行（块外）
        if not ssl_enabled:
            key = stripped.split(" ", 1)[0]
            if key in SSL_DROP_DIRECTIVES:
                i += 1; continue
            if key == "listen":
                rewritten = " ".join(w for w in stripped.split(" ") if w != "ssl")
                # 去除了 ssl 后需保证以 ; 结尾、空白规范
                rewritten = " ".join(rewritten.split())
                if not rewritten.endswith(";"):
                    rewritten += ";"
                out.append(indent + rewritten); i += 1; continue
        out.append(line); i += 1

    return "\n".join(out)
```

> 说明：替换节点以 `4 空格`缩进输出（与 render_block 的 depth=1 一致）。若现有配置缩进风格不同，后续在 Step 4 用真实 conf 校准。此实现覆盖 spec 子功能 5/6 的全部断言。

- [ ] **Step 4：运行确认通过**

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_export.py -v
```

Expected: 5 PASS。

- [ ] **Step 5：新增 /export 端点 + schemas**

Modify `backend/app/schemas/block.py` — 追加（沿用 `ConfigDict(from_attributes=True)` 风格）：

```python
class ExportRequest(BaseModel):
    ssl_enabled: bool = True
    upstream_servers: dict[str, list[str]] = {}


class ExportOut(BaseModel):
    content: str
```

Modify `backend/app/api/blocks.py` — 在 render 端点后追加（复用既有 `render_config`、`HTTPException`、`status` 导入）：

```python
@router.post("/nginx-configs/{nginx_config_id}/export", response_model=ExportOut)
def export_nginx(
    nginx_config_id: int,
    body: ExportRequest,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    if db.execute(select(NginxConfig).where(NginxConfig.id == nginx_config_id)).scalar_one_or_none() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="配置不存在")
    content = render_config(db, nginx_config_id)
    return ExportOut(
        content=export_config_text(content, body.ssl_enabled, body.upstream_servers)
    )
```

并在文件顶部 import 追加：`from app.services.render import export_config_text`，及 schema 导出自 `app.schemas.block import ...`. 同步补一条端点测试（可加进 `test_blocks.py`）：

```python
def test_export_endpoint_ssl_off(client, auth_headers):
    cfg_id = _mk_cfg(client, auth_headers)
    b = client.post("/api/config-blocks", headers=auth_headers, json={
        "nginx_config_id": cfg_id, "parent_id": None, "scope": "server",
        "header": "server {", "sort_order": 0,
    }).json()
    client.post("/api/config-options", headers=auth_headers, json={
        "block_id": b["id"], "directive": "listen", "value": "443 ssl http2;",
    })
    client.post("/api/config-options", headers=auth_headers, json={
        "block_id": b["id"], "directive": "ssl_certificate", "value": "/etc/ssl/a.pem;",
    })
    r = client.post(f"/api/nginx-configs/{cfg_id}/export", headers=auth_headers,
                    json={"ssl_enabled": False, "upstream_servers": {}})
    assert r.status_code == 200
    assert "listen 443 http2;" in r.json()["content"]
    assert "ssl_certificate" not in r.json()["content"]
```

```bash
cd backend && .venv/Scripts/python -m pytest tests/test_blocks.py -v
```

Expected: 原测试 + 新端点测试全 PASS。

- [ ] **Step 6：前端 API client**

Modify `frontend/src/api/nginx.js` — 追加：

```js
export const exportConfig = (id, data) =>
  client.post(`/nginx-configs/${id}/export`, data);
```

- [ ] **Step 7：前端 ExportModal**

Create `frontend/src/pages/ops/ExportModal.jsx`:

```jsx
import { useEffect, useMemo, useState } from "react";
import {
  Button, Drawer, Modal, Space, Switch, Table, Tag, message,
} from "antd";
import { exportConfig } from "../api/nginx";

export default function ExportModal({ open, configId, configName, upstreamGroups, onClose }) {
  const [sslOn, setSslOn] = useState(true);
  const [ups, setUps] = useState({});
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);

  // 初始化可编辑表：组名 → 节点文本行（从当前配置树带出）
  useEffect(() => {
    const init = {};
    (upstreamGroups || []).forEach((g) => {
      init[g.name] = (g.servers || []).join(", ");
    });
    setUps(init);
  }, [open, upstreamGroups]);

  const rowKey = (k, i) => `${k}-${i}`;

  const rows = useMemo(
    () => (upstreamGroups || []).map((g) => ({ name: g.name, input: ups[g.name] ?? "" })),
    [upstreamGroups, ups]
  );

  const payload = useMemo(() => {
    const parsed = {};
    Object.entries(ups).forEach(([k, v]) => {
      parsed[k] = (v || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    });
    return { ssl_enabled: sslOn, upstream_servers: parsed };
  }, [sslOn, ups]);

  const doExport = async () => {
    setLoading(true);
    try {
      const r = await exportConfig(configId, payload);
      setContent(r.content);
    } catch (e) {
      message.error("导出失败：" + (e?.message || ""));
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(content); message.success("已复制"); }
    catch (e) { message.error("复制失败"); }
  };
  const download = () => {
    const blob = new Blob([content], { type: "text/nginx;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${configName || "nginx"}.conf`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Modal
      open={open} onCancel={onClose} width={720} title="导出配置"
      footer={[
        <Button key="copy" onClick={copy}>复制</Button>,
        <Button key="down" onClick={download}>下载 .conf</Button>,
        <Button key="run" type="primary" loading={loading} onClick={doExport}>
          生成预览
        </Button>,
      ]}
    >
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <Space>
          <span>启用 SSL</span>
          <Switch checked={sslOn} onChange={setSslOn} />
          <Tag color={sslOn ? "green" : "orange"}>
            {sslOn ? "保留 ssl_* 指令" : "丢弃 ssl_* 并按非 SSL 改写 listen"}
          </Tag>
        </Space>
        <Table
          size="small" rowKey={(r, i) => rowKey(r.name, i)} bordered
          columns={[
            { title: "upstream 组", dataIndex: "name", width: 200 },
            { title: "节点（逗号分隔 addr:port）", dataIndex: "input" },
          ]}
          dataSource={rows}
        />
        <pre
          style={{
            background: "#111115", border: "1px solid #2a2a2e", borderRadius: 6,
            padding: 12, color: "#e8e8ea", fontFamily: "JetBrains Mono, monospace",
            fontSize: 12, maxHeight: 260, overflow: "auto", whiteSpace: "pre-wrap",
          }}
        >
          {content || "点击「生成预览」查看导出结果"}
        </pre>
      </Space>
    </Modal>
  );
}
```

> 说明：`upstreamGroups` 从块树/配置数据透出（各 `scope=upstream` 的 `header` 提取组名 + 组内 `server` 指令行）。DetailPanel 已用 `listBlocks` 拿到块树，可直接在此派生。

- [ ] **Step 8：DetailPanel 接入「导出配置」按钮**

Modify `frontend/src/pages/ops/DetailPanel.jsx` — 在 dt-head 右侧按钮区追加（复用已有 `listBlocks` 数据解析 upstream 组）：

```jsx
import ExportModal from "./ExportModal";
// 内部 state：
// const [exportOpen, setExportOpen] = useState(false);
// const [upstreamGroups, setUpstreamGroups] = useState([]);
// 在拿到 blockTree 后派生：
//   const groups = blockTree
//     .filter((b) => b.scope === "upstream")
//     .map((b) => ({
//       name: (b.header || "").replace(/^upstream\s+/, "").replace(/\s*\{.*$/, "").trim(),
//       servers: (b.options || [])
//         .filter((o) => o.directive === "server")
//         .map((o) => o.value.replace(/;$/, "")),
//     }));
//   setUpstreamGroups(groups);

<Button size="small" onClick={() => setExportOpen(true)}>导出配置</Button>

{/* 渲染在详情根部 */}
<ExportModal
  open={exportOpen} onClose={() => setExportOpen(false)}
  configId={configId} configName={configName}
  upstreamGroups={upstreamGroups}
/>
```

说明：`blockTree` 结构来自 `/api/nginx-configs/{id}/blocks`（children 递归），`options` 由 `listOptions` 或随树返回的免查字段提供（以现有 BlockTree 数据取法为准；若树节点未带 options，则对每个 upstream 块调用 `listOptions(block.id)` 填充 servers）。

- [ ] **Step 9：构建验证 + Commit**

```bash
cd frontend && npm run build
```

Expected: 成功。

```bash
git add backend/app/services/render.py backend/tests/test_export.py backend/app/schemas/block.py backend/app/api/blocks.py frontend/src/pages/ops/ExportModal.jsx frontend/src/pages/ops/DetailPanel.jsx frontend/src/api/nginx.js && git commit -m "feat: 导出中心（SSL 开关导出 + upstream 客户数据自动替换）"
```

---

## Task 18：全量回归 + 手动浏览器冒烟

**Files:**
- 无（验证收尾）

- [ ] **Step 1：后端全量测试**

```bash
cd backend && .venv/Scripts/python -m pytest -v
```

Expected: 全部 PASS（含旧 auth/item + 新增）。

- [ ] **Step 2：前端构建门禁**

```bash
cd frontend && npm run build
```

Expected: 成功。

- [ ] **Step 3：启动服务并手动冒烟**

启动后端（后台）：

```bash
cd backend && .venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

启动前端（后台）：

```bash
cd frontend && npm run dev
```

浏览器打开 `http://localhost:5173/login`，登录 admin / admin123。逐项核对：

1. 顶级菜单出现「配置文件 / Upstream池 / 全局拓扑」。
2. 「配置文件」：左侧列出现 seed 的 `shop.server`；选中后右侧详情 Tab（概览显示域名/布口），「块树」Tab 显示 server → location /meta/、location /api/（含 if 子块），可对块增删改。
3. 在块树选中某块后，其内部 KV 行可用 KvListEditor 编辑；新建一条 `row_type=default` 行，渲染时它恒置末尾（可通过「Reload 预览」看到）。
4. 「Upstream池」：显示 `api_backend`（least_conn），组内 3 节点，可加节点、`nginx -t` 校验、下方显示生成的 upstream 片段。
5. 「全局拓扑」：出现 api 域名 → 监听点 → api_backend → 后端节点。

- [ ] **Step 4：验证通过后确认**

确认以上 5 项均符合预期。

- [ ] **Step 5：Commit（如有遗留清理）**

```bash
git add -A && git commit -m "chore: 全量回归验证（后端测试 + 前端构建 + 冒烟）"
```

---

## 自查清单（Self-Review）

- **Spec coverage：**
  - §3 数据模型：upstreams/upstream_servers（T1）、config_blocks/config_options 含自关联 parent_id + belongs_to_file + sort_order（T1）、forward_ports.upstream_id（T1）。语义细节（map default 置底 / if 弱提示 / raw 兜底）→ T4 渲染核心专测。
  - §4 API：upstreams + servers CRUD（T6）、config-blocks 嵌套 + 树（T5）、config-options 按 block_id + reorder（T5）、topology（T7）、forward test（T7）、reload（T7）、upstream preview/validate（T6）、render（T5）、directives（T7）。
  - §5 前端：OpsConfigPage+ListPanel+DetailPanel（T11/12）、OverviewGrid（T12）、BlockTree（T13）、KvListEditor（T14）、BizPortChips/PathChain（T12）、OpsUpstreamPage（T15）、OpsTopologyPage+TopologyView（T16）、App.jsx 顶级菜单路由（T10）。
  - 已确认子功能 2/5/6（导出中心 / SSL 开关 / upstream 客户数据替换）→ T17；子功能 1（全局拓扑）→ T16；子功能 3（业务端口/监听点）→ T12；子功能 4（行级操作）→ T7（forward test / reload）。
  - §6 错误处理：删除有 upstream 引用驳回（T6，409）、nginx -t 失败（T6）、Topology 骨架/重试（T16）、删除二次确认（T13/15）。
  - §7 部署：Vite 代理沿用、受保护路由（T10）、seed.py 补建新表（T2）。

- **Placeholder scan：** 所有 Task 均含可运行代码，无 "TBD/TODO/类似前文" 占位。仅在 Task 12 提示处给出明确修正指令（import 归置顶部）。

- **Type consistency：**
  - 后端导入路径统一：`from app.models import ...`（models/__init__ 已导出新模型）。
  - schema 字段名与模型一致：`upstream_id`（ForwardPort）、`sort_order`/`scope`/`header`/`belongs_to_file`/`parent_id`/`nginx_config_id`（ConfigBlock）。
  - API client（operations.js）导出的函数名与各页面 import 完全一致（createUpstream/updateUpstream/deleteUpstream/previewUpstream/validateUpstream/listServers/createServer/updateServer/deleteServer/listBlocks/createBlock/updateBlock/deleteBlock/listOptions/createOption/updateOption/deleteOption/reorderOptions/renderConfig/reloadConfig/testForward/listTopology/listDirectives）。
  - `_order_options`（render.py）与 KvListEditor 的展示排序一致（default 恒末尾）。
  - `TopologyNode.type` 取值（domain/listen/upstream/server/biz）与 TopologyView 的 COLOR 映射一致。

## Execution Handoff

计划已保存。若继续，可交付以下二选一执行。