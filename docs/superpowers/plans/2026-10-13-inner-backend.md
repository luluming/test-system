# 内页① · 后端（块树 / upstream / 渲染导出 / 拓扑 / 动作端点）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在方案C 外壳（多行业 + 登录 + 克隆）之上，为每个行业补齐「配置可视化管理系统」后端能力：泛化块树（config_blocks/config_options）、upstream 组与节点、深度优先渲染、导出中心（SSL 开关 + server_name 域名替换 + upstream 整组替换）、安全子进程动作端点（test/reload/validate）、全局拓扑聚合、指令字典，并把行业克隆扩展为整套深拷贝。

**Architecture:** 复用既有 `_make_router` 风格与 `get_db/get_current_user` 依赖。新增 4 张表（config_blocks/config_options/upstreams/upstream_servers），给 domain_mappings/forward_ports/biz_ports 加 `industry_id`（ForwardPort 再加 `upstream_id`）。渲染/导出算法**逐字移植** mock `plan-c-real-conf.html`（L1915-2021）的纯函数到 `backend/app/services/`，端点只做「DB 树 → 纯函数」的薄封装。动作端点一律 `subprocess.run([...], shell=False)` + 临时文件 + 路径白名单。每个 Task 以 TDD 闭环（先写失败测试 → 实现 → 通过 → 提交）。

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (Mapped) + Pydantic v2 + pytest + SQLite；测试命令（backend 目录）：`.\.venv\Scripts\python -m pytest tests/ -q`；涉及 venv/服务运行须 `dangerouslyDisableSandbox=true`。

**关键前置（重要）：** 本计划给既有三张表加列 + 新增四张表。**开发库 `backend/test_system.db` 在 T1 完成后需删除重建**（`Base.metadata.create_all` 不会给已存在的 SQLite 表加列）；测试库由 conftest 每次新建，无此问题。所有 git add 精确到列出的文件，**不碰** 既有 untracked（`backend/app/core/logging.py`、`.nginx-mock/`、`.trae/`、`frontend/src/pages/OpsConsole.jsx` 等）。

---

### Task 1: 数据模型 —— 四张新表 + 既有三表加行业维度

**Files:**
- Modify: `backend/app/models/nginx.py`（追加 4 个类 + 修改 3 个既有类）
- Modify: `backend/app/models/__init__.py`
- Test: `backend/tests/test_inner_models.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_inner_models.py`：

```python
"""内页① 数据模型测试：四张新表 + 既有表行业维度。"""

from sqlalchemy import select

from app.models import (
    BizPort,
    ConfigBlock,
    ConfigOption,
    DomainMapping,
    ForwardPort,
    Industry,
    NginxConfig,
    Upstream,
    UpstreamServer,
)


def _industry(db, code="i1"):
    ind = Industry(code=code, name="行业" + code)
    db.add(ind)
    db.flush()
    return ind


def _config(db, ind, name="conf"):
    cfg = NginxConfig(industry_id=ind.id, name=name, config_text="", version=1)
    db.add(cfg)
    db.flush()
    return cfg


def test_config_block_and_option_persist(db_session_factory):
    """config_blocks / config_options 可落库并回读。"""
    db = db_session_factory()
    ind = _industry(db)
    cfg = _config(db, ind)
    blk = ConfigBlock(
        nginx_config_id=cfg.id, scope="server", header="server {", sort_order=0
    )
    db.add(blk)
    db.flush()
    opt = ConfigOption(
        block_id=blk.id, directive="listen", value="80", row_type="kv", sort_order=0
    )
    db.add(opt)
    db.commit()
    assert blk.id is not None and opt.id is not None
    got = db.execute(select(ConfigOption).where(ConfigOption.block_id == blk.id)).scalars().one()
    assert got.directive == "listen" and got.value == "80"
    db.close()


def test_config_block_nested_parent(db_session_factory):
    """parent_id 自关联表达嵌套：location 挂在 server 下。"""
    db = db_session_factory()
    ind = _industry(db)
    cfg = _config(db, ind)
    srv = ConfigBlock(nginx_config_id=cfg.id, scope="server", header="server {", sort_order=0)
    db.add(srv)
    db.flush()
    loc = ConfigBlock(
        nginx_config_id=cfg.id, parent_id=srv.id, scope="location", header="location /api/ {", sort_order=0
    )
    db.add(loc)
    db.commit()
    assert loc.parent_id == srv.id
    db.close()


def test_upstream_unique_per_industry(db_session_factory):
    """upstreams 组名在行业内唯一；跨行业允许同名。"""
    db = db_session_factory()
    a = _industry(db, "a")
    b = _industry(db, "b")
    db.add(Upstream(industry_id=a.id, name="api_backend"))
    db.add(Upstream(industry_id=b.id, name="api_backend"))
    db.commit()
    db.close()


def test_legacy_tables_require_industry(db_session_factory):
    """domain_mappings / forward_ports / biz_ports 现在必须带 industry_id。"""
    db = db_session_factory()
    ind = _industry(db)
    db.add(DomainMapping(industry_id=ind.id, domain="a.example.com", forward_tos="10.0.0.1:80"))
    db.add(ForwardPort(industry_id=ind.id, listen_port=8080, upstream_target="10.0.0.1:8080"))
    db.add(BizPort(industry_id=ind.id, service_name="web", port=8080))
    db.commit()
    db.close()


def test_forward_port_upstream_fk(db_session_factory):
    """forward_ports.upstream_id 可空且可引用 upstreams.id。"""
    db = db_session_factory()
    ind = _industry(db)
    up = Upstream(industry_id=ind.id, name="web_backend")
    db.add(up)
    db.flush()
    fp = ForwardPort(
        industry_id=ind.id, listen_port=8080, upstream_target="web_backend", upstream_id=up.id
    )
    db.add(fp)
    db.commit()
    assert fp.upstream_id == up.id
    db.close()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `.\.venv\Scripts\python -m pytest tests/test_inner_models.py -q`
Expected: FAIL —— `ImportError: cannot import name 'ConfigBlock'`（新表尚未定义）

- [ ] **Step 3: 实现模型**

修改 `backend/app/models/nginx.py`：

追加 import（在既有 import 块中补 `UniqueConstraint` 已存在，无需改）：

在 `NginxConfig` 类之后、`DomainMapping` 之前插入四个新类：

```python
class ConfigBlock(Base):
    """泛化 nginx 块：靠 scope + parent_id 表达任意嵌套层级。

    server/location/upstream/map/geo/if/log_format/split_clients/include/comment/raw
    统一为一种块；层级完全由 parent_id 递归描述。
    """

    __tablename__ = "config_blocks"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    nginx_config_id: Mapped[int] = mapped_column(
        ForeignKey("nginx_configs.id"), index=True, nullable=False
    )
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("config_blocks.id"), index=True, nullable=True
    )
    scope: Mapped[str] = mapped_column(String(32), nullable=False)
    header: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    belongs_to_file: Mapped[str | None] = mapped_column(String(100), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class ConfigOption(Base):
    """块内通用 KV 行 + raw 原样行（指令顺序即输出顺序）。"""

    __tablename__ = "config_options"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    block_id: Mapped[int] = mapped_column(
        ForeignKey("config_blocks.id"), index=True, nullable=False
    )
    directive: Mapped[str] = mapped_column(String(100), nullable=False)
    value: Mapped[str] = mapped_column(String(1000), default="", nullable=False)
    row_type: Mapped[str] = mapped_column(String(16), default="kv", nullable=False)
    is_free_text: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class Upstream(Base):
    """nginx upstream 组（按行业作用域）。"""

    __tablename__ = "upstreams"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    strategy: Mapped[str] = mapped_column(
        String(32), default="round_robin", nullable=False
    )
    keepalive: Mapped[int] = mapped_column(Integer, default=32, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    __table_args__ = (UniqueConstraint("industry_id", "name"),)


class UpstreamServer(Base):
    """upstream 组内节点。"""

    __tablename__ = "upstream_servers"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    upstream_id: Mapped[int] = mapped_column(
        ForeignKey("upstreams.id"), index=True, nullable=False
    )
    addr: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    weight: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    health_status: Mapped[str] = mapped_column(
        String(16), default="checking", nullable=False
    )
    enable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
```

修改既有三表加行业维度：

`DomainMapping`：在 `id` 之后加 `industry_id` 列，并把 `domain` 的 `unique=True` 改为普通索引 + 类级联合唯一：

```python
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    domain: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    forward_tos: Mapped[str] = mapped_column(String(255), nullable=False)
    protocol: Mapped[str] = mapped_column(String(16), default="http", nullable=False)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    __table_args__ = (UniqueConstraint("industry_id", "domain"),)
```

`ForwardPort`：加 `industry_id` 与 `upstream_id`：

```python
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    upstream_id: Mapped[int | None] = mapped_column(
        ForeignKey("upstreams.id"), index=True, nullable=True
    )
    listen_port: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    upstream_target: Mapped[str] = mapped_column(String(255), nullable=False)
    service_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    protocol: Mapped[str] = mapped_column(String(16), default="http", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
```

`BizPort`：加 `industry_id`：

```python
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    service_name: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    port: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    protocol: Mapped[str] = mapped_column(String(16), default="tcp", nullable=False)
    public_exposed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
```

修改 `backend/app/models/__init__.py`：

```python
from app.models.nginx import (
    BizPort,
    ConfigBlock,
    ConfigOption,
    DomainMapping,
    ForwardPort,
    NginxConfig,
    Upstream,
    UpstreamServer,
)

__all__ = [
    "Base",
    "User",
    "Item",
    "Industry",
    "NginxConfig",
    "ConfigBlock",
    "ConfigOption",
    "Upstream",
    "UpstreamServer",
    "DomainMapping",
    "ForwardPort",
    "BizPort",
]
```

- [ ] **Step 4: 运行测试确认通过**

Run: `.\.venv\Scripts\python -m pytest tests/test_inner_models.py -q`
Expected: PASS（5 passed）

同时跑全量回归：Run: `.\.venv\Scripts\python -m pytest tests/ -q`
Expected: 全绿（约 38 passed；T1 不改任何端点行为）

- [ ] **Step 5: 提交**

```bash
git add backend/app/models/nginx.py backend/app/models/__init__.py backend/tests/test_inner_models.py
git commit -m "feat(models): 内页①四张新表 + 既有表加行业维度"
```

---

### Task 2: upstreams + upstream_servers CRUD 与 preview

**Files:**
- Create: `backend/app/schemas/nginx_inner.py`
- Create: `backend/app/api/nginx_inner.py`（本 Task 只含 upstream_router 部分；后续 Task 追加同文件其余 router）
- Modify: `backend/app/main.py`（注册 upstream_router）
- Test: `backend/tests/test_inner_upstream.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_inner_upstream.py`：

```python
"""upstream 组与节点 CRUD（行业作用域）+ preview。"""


def _mk_industry(client, auth_headers, code):
    return client.post(
        "/api/industries", json={"code": code, "name": code}, headers=auth_headers
    ).json()


def test_upstream_crud_scoped_by_industry(client, auth_headers):
    """创建组、按行业过滤列表、更新、删除；跨行业隔离。"""
    a = _mk_industry(client, auth_headers, "ua")
    b = _mk_industry(client, auth_headers, "ub")
    created = client.post(
        "/api/upstreams",
        json={"industry_id": a["id"], "name": "api_backend", "strategy": "least_conn", "keepalive": 64},
        headers=auth_headers,
    )
    assert created.status_code == 201
    up = created.json()
    assert up["industry_id"] == a["id"] and up["strategy"] == "least_conn" and up["keepalive"] == 64

    la = client.get(f"/api/upstreams?industry_id={a['id']}", headers=auth_headers).json()
    lb = client.get(f"/api/upstreams?industry_id={b['id']}", headers=auth_headers).json()
    assert [u["name"] for u in la] == ["api_backend"]
    assert lb == []

    upd = client.put(
        f"/api/upstreams/{up['id']}",
        json={"strategy": "ip_hash", "keepalive": 16},
        headers=auth_headers,
    )
    assert upd.status_code == 200 and upd.json()["strategy"] == "ip_hash" and upd.json()["keepalive"] == 16

    assert client.delete(f"/api/upstreams/{up['id']}", headers=auth_headers).status_code == 204
    assert client.get(f"/api/upstreams?industry_id={a['id']}", headers=auth_headers).json() == []


def test_upstream_name_unique_per_industry(client, auth_headers):
    """同行业重名 409；跨行业允许。"""
    a = _mk_industry(client, auth_headers, "uc")
    b = _mk_industry(client, auth_headers, "ud")
    body = {"industry_id": a["id"], "name": "shared"}
    assert client.post("/api/upstreams", json=body, headers=auth_headers).status_code == 201
    assert client.post("/api/upstreams", json=body, headers=auth_headers).status_code == 409
    assert client.post("/api/upstreams", json={**body, "industry_id": b["id"]}, headers=auth_headers).status_code == 201


def test_upstream_servers_nested_crud(client, auth_headers):
    """组内节点增删改 + 列表。"""
    ind = _mk_industry(client, auth_headers, "ue")
    up = client.post(
        "/api/upstreams",
        json={"industry_id": ind["id"], "name": "api_backend"},
        headers=auth_headers,
    ).json()
    s1 = client.post(
        f"/api/upstreams/{up['id']}/servers",
        json={"addr": "10.0.0.97", "port": 8080, "weight": 5},
        headers=auth_headers,
    )
    assert s1.status_code == 201
    s2 = client.post(
        f"/api/upstreams/{up['id']}/servers",
        json={"addr": "10.0.0.193", "port": 8080, "weight": 5},
        headers=auth_headers,
    )
    servers = client.get(f"/api/upstreams/{up['id']}/servers", headers=auth_headers).json()
    assert [s["addr"] for s in servers] == ["10.0.0.97", "10.0.0.193"]

    upd = client.put(
        f"/api/upstreams/{up['id']}/servers/{s1.json()['id']}",
        json={"weight": 10, "health_status": "up"},
        headers=auth_headers,
    )
    assert upd.status_code == 200 and upd.json()["weight"] == 10

    assert client.delete(
        f"/api/upstreams/{up['id']}/servers/{s2.json()['id']}", headers=auth_headers
    ).status_code == 204
    servers = client.get(f"/api/upstreams/{up['id']}/servers", headers=auth_headers).json()
    assert len(servers) == 1


def test_upstream_preview(client, auth_headers):
    """preview 生成 upstream {} 片段：策略指令 + 节点行 + keepalive。"""
    ind = _mk_industry(client, auth_headers, "uf")
    up = client.post(
        "/api/upstreams",
        json={"industry_id": ind["id"], "name": "api_backend", "strategy": "least_conn", "keepalive": 32},
        headers=auth_headers,
    ).json()
    client.post(
        f"/api/upstreams/{up['id']}/servers",
        json={"addr": "10.0.0.97", "port": 8080, "weight": 5},
        headers=auth_headers,
    )
    r = client.get(f"/api/upstreams/{up['id']}/preview", headers=auth_headers)
    assert r.status_code == 200
    text = r.json()["content"]
    assert text == (
        "upstream api_backend {\n"
        "    least_conn;\n"
        "    server 10.0.0.97:8080 weight=5;\n"
        "    keepalive 32;\n"
        "}"
    )
```

- [ ] **Step 2: 运行测试确认失败**

Run: `.\.venv\Scripts\python -m pytest tests/test_inner_upstream.py -q`
Expected: FAIL —— `404`（路由未注册）/ `ImportError`

- [ ] **Step 3: 实现 schemas**

新建 `backend/app/schemas/nginx_inner.py`：

```python
"""内页① Pydantic 模型：upstream / upstream_servers / config_blocks / config_options 与动作请求。

沿用 schemas/nginx.py 的 Create/Update/Out 三件套 + ConfigDict(from_attributes=True) 约定。
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# ---- upstream ----

class UpstreamCreate(BaseModel):
    industry_id: int
    name: str = Field(min_length=1, max_length=100)
    strategy: str = "round_robin"
    keepalive: int = 32


class UpstreamUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    strategy: str | None = None
    keepalive: int | None = None


class UpstreamOut(BaseModel):
    id: int
    industry_id: int
    name: str
    strategy: str
    keepalive: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class UpstreamServerCreate(BaseModel):
    addr: str = Field(min_length=1, max_length=255)
    port: int | None = None
    weight: int = 1
    health_status: str = "checking"
    enable: bool = True


class UpstreamServerUpdate(BaseModel):
    addr: str | None = Field(default=None, min_length=1, max_length=255)
    port: int | None = None
    weight: int | None = None
    health_status: str | None = None
    enable: bool | None = None


class UpstreamServerOut(BaseModel):
    id: int
    upstream_id: int
    addr: str
    port: int | None
    weight: int
    health_status: str
    enable: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
```

- [ ] **Step 4: 实现 upstream router**

新建 `backend/app/api/nginx_inner.py`（本 Task 写入 `upstream_router` 与辅助 `_get_by_id_inner/_get_upstream`；后续 Task 在同文件追加其余 router 与端点）：

```python
"""内页① 端点：upstream / config-blocks / config-options / render / export / topology / directives / test / reload / validate。

复用 app/api/nginx.py 的 _make_router 风格与 get_db/get_current_user 依赖。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.security import get_current_user
from app.models.nginx import Upstream, UpstreamServer
from app.models.user import User
from app.schemas.nginx_inner import (
    UpstreamCreate,
    UpstreamOut,
    UpstreamServerCreate,
    UpstreamServerOut,
    UpstreamServerUpdate,
    UpstreamUpdate,
)

upstream_router = APIRouter(prefix="/api/upstreams", tags=["upstream"])


def _get_upstream(db: Session, upstream_id: int) -> Upstream:
    row = db.execute(
        select(Upstream).where(Upstream.id == upstream_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="upstream 组不存在")
    return row


def _get_server(db: Session, server_id: int) -> UpstreamServer:
    row = db.execute(
        select(UpstreamServer).where(UpstreamServer.id == server_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="upstream 节点不存在")
    return row


@upstream_router.get("", response_model=list[UpstreamOut])
def list_upstreams(
    industry_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[Upstream]:
    return list(
        db.execute(
            select(Upstream)
            .where(Upstream.industry_id == industry_id)
            .order_by(Upstream.id)
        ).scalars().all()
    )


@upstream_router.post("", response_model=UpstreamOut, status_code=status.HTTP_201_CREATED)
def create_upstream(
    payload: UpstreamCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Upstream:
    row = Upstream(**payload.model_dump())
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该行业下 upstream 组名已存在")
    db.refresh(row)
    return row


@upstream_router.get("/{upstream_id}", response_model=UpstreamOut)
def get_upstream(
    upstream_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Upstream:
    return _get_upstream(db, upstream_id)


@upstream_router.put("/{upstream_id}", response_model=UpstreamOut)
def update_upstream(
    upstream_id: int,
    payload: UpstreamUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Upstream:
    row = _get_upstream(db, upstream_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(row, field, value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该行业下 upstream 组名已存在")
    db.refresh(row)
    return row


@upstream_router.delete("/{upstream_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_upstream(
    upstream_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    db.delete(_get_upstream(db, upstream_id))
    db.commit()


@upstream_router.get("/{upstream_id}/servers", response_model=list[UpstreamServerOut])
def list_servers(
    upstream_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[UpstreamServer]:
    _get_upstream(db, upstream_id)
    return list(
        db.execute(
            select(UpstreamServer)
            .where(UpstreamServer.upstream_id == upstream_id)
            .order_by(UpstreamServer.id)
        ).scalars().all()
    )


@upstream_router.post(
    "/{upstream_id}/servers",
    response_model=UpstreamServerOut,
    status_code=status.HTTP_201_CREATED,
)
def create_server(
    upstream_id: int,
    payload: UpstreamServerCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> UpstreamServer:
    _get_upstream(db, upstream_id)
    row = UpstreamServer(upstream_id=upstream_id, **payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@upstream_router.put(
    "/{upstream_id}/servers/{server_id}", response_model=UpstreamServerOut
)
def update_server(
    upstream_id: int,
    server_id: int,
    payload: UpstreamServerUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> UpstreamServer:
    row = _get_server(db, server_id)
    if row.upstream_id != upstream_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="upstream 节点不存在")
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@upstream_router.delete("/{upstream_id}/servers/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_server(
    upstream_id: int,
    server_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    row = _get_server(db, server_id)
    if row.upstream_id != upstream_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="upstream 节点不存在")
    db.delete(row)
    db.commit()


@upstream_router.get("/{upstream_id}/preview")
def upstream_preview(
    upstream_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    up = _get_upstream(db, upstream_id)
    servers = list(
        db.execute(
            select(UpstreamServer)
            .where(UpstreamServer.upstream_id == upstream_id)
            .order_by(UpstreamServer.id)
        ).scalars().all()
    )
    return {"content": _upstream_preview_text(up, servers)}


def _upstream_preview_text(up: Upstream, servers: list[UpstreamServer]) -> str:
    lines = [f"upstream {up.name} {{"]
    if up.strategy == "least_conn":
        lines.append("    least_conn;")
    elif up.strategy == "ip_hash":
        lines.append("    ip_hash;")
    for s in servers:
        addr = s.addr + (f":{s.port}" if s.port else "")
        suffix = f" weight={s.weight}" if s.weight != 1 else ""
        lines.append(f"    server {addr}{suffix};")
    lines.append(f"    keepalive {up.keepalive};")
    lines.append("}")
    return "\n".join(lines)
```

修改 `backend/app/main.py`：

```python
from app.api.nginx_inner import upstream_router
...
app.include_router(upstream_router)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `.\.venv\Scripts\python -m pytest tests/test_inner_upstream.py -q`
Expected: PASS（4 passed）

- [ ] **Step 6: 提交**

```bash
git add backend/app/schemas/nginx_inner.py backend/app/api/nginx_inner.py backend/app/main.py backend/tests/test_inner_upstream.py
git commit -m "feat(api): upstream 组与节点 CRUD + preview（行业作用域）"
```

---

### Task 3: config-blocks / config-options CRUD（嵌套树 + default 置底语义）

**Files:**
- Modify: `backend/app/schemas/nginx_inner.py`（追加 block/option schemas）
- Modify: `backend/app/api/nginx_inner.py`（追加 blocks_router / options_router / config-tree 端点）
- Modify: `backend/app/main.py`（注册新 router）
- Test: `backend/tests/test_inner_blocks.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_inner_blocks.py`：

```python
"""config-blocks / config-options CRUD：嵌套、children、default 置底、删除子树。"""


def _mk(client, headers):
    ind = client.post(
        "/api/industries", json={"code": "bk", "name": "块"}, headers=headers
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "conf", "config_text": "server {}"},
        headers=headers,
    ).json()
    return ind, cfg


def test_block_tree_create_and_children(client, auth_headers):
    """建 server → location 子块；children 端点按 sort_order 返回。"""
    _, cfg = _mk(client, auth_headers)
    srv = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    loc = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "parent_id": srv["id"], "scope": "location", "header": "location /api/ {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    assert loc["parent_id"] == srv["id"]
    kids = client.get(f"/api/config-blocks/{srv['id']}/children", headers=auth_headers).json()
    assert [k["scope"] for k in kids] == ["location"]
    top = client.get(f"/api/config-blocks?nginx_config_id={cfg['id']}", headers=auth_headers).json()
    assert [t["scope"] for t in top] == ["server"]


def test_config_tree_endpoint(client, auth_headers):
    """GET /api/nginx-configs/{id}/tree 返回嵌套树。"""
    _, cfg = _mk(client, auth_headers)
    srv = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "parent_id": srv["id"], "scope": "location", "header": "location / {", "sort_order": 0},
        headers=auth_headers,
    )
    tree = client.get(f"/api/nginx-configs/{cfg['id']}/tree", headers=auth_headers).json()
    assert tree["blocks"][0]["scope"] == "server"
    assert tree["blocks"][0]["children"][0]["scope"] == "location"


def test_option_default_bottom(client, auth_headers):
    """options 列表：default 恒置底（即使 sort_order 靠前）。"""
    _, cfg = _mk(client, auth_headers)
    blk = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "map", "header": "map $a $b {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    client.post(
        "/api/config-options",
        json={"block_id": blk["id"], "directive": "default", "value": "upgrade", "row_type": "default", "sort_order": 0},
        headers=auth_headers,
    )
    client.post(
        "/api/config-options",
        json={"block_id": blk["id"], "directive": "~^\\\\.", "value": "1.0.0.1", "row_type": "regex", "sort_order": 1},
        headers=auth_headers,
    )
    opts = client.get(f"/api/config-options?block_id={blk['id']}", headers=auth_headers).json()
    assert [o["directive"] for o in opts] == ["~^\\\\.", "default"]


def test_option_reorder(client, auth_headers):
    """reorder 批量重排 sort_order；default 仍恒置底。"""
    _, cfg = _mk(client, auth_headers)
    blk = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    o1 = client.post("/api/config-options", json={"block_id": blk["id"], "directive": "listen", "value": "80", "sort_order": 0}, headers=auth_headers).json()
    o2 = client.post("/api/config-options", json={"block_id": blk["id"], "directive": "server_name", "value": "a.com", "sort_order": 1}, headers=auth_headers).json()
    r = client.put(
        "/api/config-options/reorder",
        json={"block_id": blk["id"], "ids": [o2["id"], o1["id"]]},
        headers=auth_headers,
    )
    assert r.status_code == 200
    opts = client.get(f"/api/config-options?block_id={blk['id']}", headers=auth_headers).json()
    assert [o["directive"] for o in opts] == ["server_name", "listen"]


def test_delete_block_prunes_subtree(client, auth_headers):
    """删除 server 块级联删掉其 location 子块与 options。"""
    _, cfg = _mk(client, auth_headers)
    srv = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    loc = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "parent_id": srv["id"], "scope": "location", "header": "location / {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    client.post("/api/config-options", json={"block_id": loc["id"], "directive": "proxy_pass", "value": "http://x", "sort_order": 0}, headers=auth_headers)
    assert client.delete(f"/api/config-blocks/{srv['id']}", headers=auth_headers).status_code == 204
    assert client.get(f"/api/config-blocks/{loc['id']}", headers=auth_headers).status_code == 404
    assert client.get(f"/api/config-options?block_id={loc['id']}", headers=auth_headers).json() == []
```

- [ ] **Step 2: 运行测试确认失败**

Run: `.\.venv\Scripts\python -m pytest tests/test_inner_blocks.py -q`
Expected: FAIL —— `404`（路由未注册）

- [ ] **Step 3: 追加 schemas**

在 `backend/app/schemas/nginx_inner.py` 末尾追加：

```python
# ---- config_blocks ----

class ConfigBlockCreate(BaseModel):
    nginx_config_id: int
    parent_id: int | None = None
    scope: str = Field(min_length=1, max_length=32)
    header: str = ""
    belongs_to_file: str | None = None
    sort_order: int = 0


class ConfigBlockUpdate(BaseModel):
    scope: str | None = None
    header: str | None = None
    parent_id: int | None = None
    belongs_to_file: str | None = None
    sort_order: int | None = None


class ConfigBlockOut(BaseModel):
    id: int
    nginx_config_id: int
    parent_id: int | None
    scope: str
    header: str
    belongs_to_file: str | None
    sort_order: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ---- config_options ----

class ConfigOptionCreate(BaseModel):
    block_id: int
    directive: str
    value: str = ""
    row_type: str = "kv"
    is_free_text: bool = False
    sort_order: int = 0


class ConfigOptionUpdate(BaseModel):
    directive: str | None = None
    value: str | None = None
    row_type: str | None = None
    is_free_text: bool | None = None
    sort_order: int | None = None


class ConfigOptionOut(BaseModel):
    id: int
    block_id: int
    directive: str
    value: str
    row_type: str
    is_free_text: bool
    sort_order: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class OptionReorderRequest(BaseModel):
    block_id: int
    ids: list[int]
```

- [ ] **Step 4: 实现 blocks / options router**

在 `backend/app/api/nginx_inner.py` 末尾追加：

```python
from app.models.nginx import ConfigBlock, ConfigOption
from app.schemas.nginx_inner import (
    ConfigBlockCreate,
    ConfigBlockOut,
    ConfigBlockUpdate,
    ConfigOptionCreate,
    ConfigOptionOut,
    ConfigOptionUpdate,
    OptionReorderRequest,
)

blocks_router = APIRouter(prefix="/api/config-blocks", tags=["配置块"])
options_router = APIRouter(prefix="/api/config-options", tags=["配置选项"])
config_tree_router = APIRouter(prefix="/api/nginx-configs", tags=["nginx 配置树"])


def _get_block(db: Session, block_id: int) -> ConfigBlock:
    row = db.execute(
        select(ConfigBlock).where(ConfigBlock.id == block_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="配置块不存在")
    return row


def _all_block_rows(db: Session, config_id: int) -> list[ConfigBlock]:
    return list(
        db.execute(
            select(ConfigBlock)
            .where(ConfigBlock.nginx_config_id == config_id)
            .order_by(ConfigBlock.sort_order, ConfigBlock.id)
        ).scalars().all()
    )


def _collect_subtree_ids(db: Session, block_id: int) -> list[int]:
    """收集 block 及其全部后代 id（用于级联删除）。"""
    rows = _all_block_rows(db, _get_block(db, block_id).nginx_config_id)
    children = {}
    for b in rows:
        children.setdefault(b.parent_id, []).append(b.id)
    out = []

    def walk(pid: int) -> None:
        for cid in children.get(pid, []):
            out.append(cid)
            walk(cid)

    out.append(block_id)
    walk(block_id)
    return out


@blocks_router.get("", response_model=list[ConfigBlockOut])
def list_blocks(
    nginx_config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[ConfigBlock]:
    return [
        b
        for b in _all_block_rows(db, nginx_config_id)
        if b.parent_id is None
    ]


@blocks_router.post("", response_model=ConfigBlockOut, status_code=status.HTTP_201_CREATED)
def create_block(
    payload: ConfigBlockCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ConfigBlock:
    if payload.parent_id is not None:
        parent = _get_block(db, payload.parent_id)
        if parent.nginx_config_id != payload.nginx_config_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="父块不属于该配置文件")
    row = ConfigBlock(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@blocks_router.get("/{block_id}", response_model=ConfigBlockOut)
def get_block(
    block_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ConfigBlock:
    return _get_block(db, block_id)


@blocks_router.get("/{block_id}/children", response_model=list[ConfigBlockOut])
def block_children(
    block_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[ConfigBlock]:
    return list(
        db.execute(
            select(ConfigBlock)
            .where(ConfigBlock.parent_id == block_id)
            .order_by(ConfigBlock.sort_order, ConfigBlock.id)
        ).scalars().all()
    )


@blocks_router.put("/{block_id}", response_model=ConfigBlockOut)
def update_block(
    block_id: int,
    payload: ConfigBlockUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ConfigBlock:
    row = _get_block(db, block_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@blocks_router.delete("/{block_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_block(
    block_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    ids = _collect_subtree_ids(db, block_id)
    db.execute(ConfigOption.__table__.delete().where(ConfigOption.block_id.in_(ids)))
    db.execute(ConfigBlock.__table__.delete().where(ConfigBlock.id.in_(ids)))
    db.commit()


@config_tree_router.get("/{config_id}/tree")
def config_tree(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    rows = _all_block_rows(db, config_id)
    ids = [b.id for b in rows]
    options = (
        list(
            db.execute(
                select(ConfigOption)
                .where(ConfigOption.block_id.in_(ids))
                .order_by(ConfigOption.sort_order, ConfigOption.id)
            ).scalars().all()
        )
        if ids
        else []
    )
    opt_map: dict[int, list[ConfigOption]] = {}
    for o in options:
        opt_map.setdefault(o.block_id, []).append(o)
    child_map: dict[int | None, list[ConfigBlock]] = {}
    for b in rows:
        child_map.setdefault(b.parent_id, []).append(b)

    def to_dict(b: ConfigBlock) -> dict:
        return {
            "id": b.id,
            "scope": b.scope,
            "header": b.header,
            "sort_order": b.sort_order,
            "children": [to_dict(c) for c in child_map.get(b.id, [])],
            "options": [
                {
                    "id": o.id,
                    "directive": o.directive,
                    "value": o.value,
                    "row_type": o.row_type,
                    "is_free_text": o.is_free_text,
                    "sort_order": o.sort_order,
                }
                for o in opt_map.get(b.id, [])
            ],
        }

    return {"config_id": config_id, "blocks": [to_dict(b) for b in child_map.get(None, [])]}


@options_router.get("", response_model=list[ConfigOptionOut])
def list_options(
    block_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[ConfigOption]:
    rows = list(
        db.execute(
            select(ConfigOption)
            .where(ConfigOption.block_id == block_id)
            .order_by(ConfigOption.sort_order, ConfigOption.id)
        ).scalars().all()
    )
    # map default 恒置底：先非 default 按 sort_order，再 default 按 sort_order
    norm = [o for o in rows if o.directive != "default"]
    defs = [o for o in rows if o.directive == "default"]
    return norm + defs


@options_router.post("", response_model=ConfigOptionOut, status_code=status.HTTP_201_CREATED)
def create_option(
    payload: ConfigOptionCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ConfigOption:
    _get_block(db, payload.block_id)
    row = ConfigOption(**payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@options_router.get("/{option_id}", response_model=ConfigOptionOut)
def get_option(
    option_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ConfigOption:
    row = db.execute(select(ConfigOption).where(ConfigOption.id == option_id)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="配置选项不存在")
    return row


@options_router.put("/{option_id}", response_model=ConfigOptionOut)
def update_option(
    option_id: int,
    payload: ConfigOptionUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ConfigOption:
    row = get_option(option_id, db=db)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@options_router.put("/reorder")
def reorder_options(
    payload: OptionReorderRequest,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    rows = list(
        db.execute(
            select(ConfigOption).where(ConfigOption.block_id == payload.block_id)
        ).scalars().all()
    )
    by_id = {o.id: o for o in rows}
    for index, oid in enumerate(payload.ids):
        if oid in by_id:
            by_id[oid].sort_order = index
    db.commit()
    return {"message": "重排成功"}


@options_router.delete("/{option_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_option(
    option_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    db.delete(get_option(option_id, db=db))
    db.commit()
```

> 注意：`update_option` / `delete_option` 内直接以 `db=db` 调用 `get_option` —— FastAPI 会把它当普通函数调用（关键字传参），不触发依赖注入。若希望保持端点风格，可改为内部辅助函数；当前写法最小改动且测试可通过。

修改 `backend/app/main.py`：

```python
from app.api.nginx_inner import (
    config_tree_router,
    blocks_router,
    options_router,
    upstream_router,
)
...
app.include_router(blocks_router)
app.include_router(options_router)
app.include_router(config_tree_router)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `.\.venv\Scripts\python -m pytest tests/test_inner_blocks.py -q`
Expected: PASS（5 passed）

- [ ] **Step 6: 提交**

```bash
git add backend/app/schemas/nginx_inner.py backend/app/api/nginx_inner.py backend/app/main.py backend/tests/test_inner_blocks.py
git commit -m "feat(api): config-blocks/config-options CRUD + 树端点 + default 置底"
```

---

### Task 4: 渲染服务（parse 移植 + 深度优先渲染）+ GET /render

**Files:**
- Create: `backend/app/services/nginx_render.py`
- Modify: `backend/app/api/nginx_inner.py`（追加 render 端点）
- Test: `backend/tests/test_render.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_render.py`：

```python
"""渲染服务：parse 移植 + 深度优先 render（复刻 mock renderPreview / orderedOptions）。"""

from app.services.nginx_render import parse, render_text


DEMO = """server {
  listen 443 ssl http2;
  server_name freight.example.com;
  location /api/ {
    proxy_pass http://api_backend;
  }
}
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}"""


def test_parse_builds_generalized_tree():
    root = parse(DEMO, "http")
    scopes = [c["scope"] for c in root["children"]]
    assert scopes == ["server", "map"]
    srv = root["children"][0]
    assert srv["header"] == "server"
    listens = [o for o in srv["options"] if o["directive"] == "listen"]
    assert listens[0]["value"] == "443 ssl http2"
    loc = srv["children"][0]
    assert loc["scope"] == "location" and loc["header"] == "location /api/"
    assert loc["options"][0]["directive"] == "proxy_pass"
    mp = root["children"][1]
    assert [o["directive"] for o in mp["options"]] == ["default", ""]


def test_render_text_replicates_render_preview():
    root = parse(DEMO, "http")
    lines = render_text(root)
    assert lines == [
        "http {",
        "    server {",
        "        listen 443 ssl http2;",
        "        server_name freight.example.com;",
        "        location /api/ {",
        "            proxy_pass http://api_backend;",
        "        }",
        "    }",
        "    map $http_upgrade $connection_upgrade {",
        "        default upgrade;",
        "        '' close;",
        "    }",
        "}",
    ]


def test_render_comment_and_if():
    root = parse("# 这是注释\nif ($x) { return 404; }\nserver { listen 80; }", "http")
    lines = render_text(root)
    assert "# 这是注释" in lines
    assert "        # 建议少用 if" in lines
```

- [ ] **Step 2: 运行测试确认失败**

Run: `.\.venv\Scripts\python -m pytest tests/test_render.py -q`
Expected: FAIL —— `ModuleNotFoundError: No module named 'app.services.nginx_render'`

- [ ] **Step 3: 实现渲染服务**

新建 `backend/app/services/nginx_render.py`：

```python
"""渲染服务：原文 → 泛化块树（parse 移植自 mock L925-955）+ 深度优先渲染（renderPreview L1535-1557）。

纯函数，供 seed 建块、render 端点、export 复用。
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.nginx import ConfigBlock, ConfigOption

INDENT = "    "

_SCOPES = {
    "server": "server",
    "location": "location",
    "upstream": "upstream",
    "map": "map",
    "geo": "geo",
    "if": "if",
    "stream": "stream",
    "events": "events",
    "http": "http",
    "log_format": "log_format",
    "split_clients": "split_clients",
    "limit_req": "limit_req",
    "limit_conn": "limit_conn",
    "limit_except": "limit_except",
    "types": "types",
    "include": "include",
}


def scope_of(header: str) -> str | None:
    """块头首词 → scope；未知返回 None（由调用方降级为 raw）。"""
    head = (header or "").strip()
    if not head:
        return None
    return _SCOPES.get(head.split()[0])


def kvify(line: str) -> dict:
    """一行指令 → {directive, value, raw}；无空格则 value 为空。"""
    t = line.strip().rstrip(";").strip()
    if " " not in t:
        return {"directive": t, "value": "", "raw": t}
    i = t.index(" ")
    return {"directive": t[:i].strip(), "value": t[i + 1:].strip(), "raw": t.strip()}


def parse(src: str, root_scope: str = "http") -> dict:
    """原文 → 泛化块树（通用虚拟根，http/stream/events 顶层块并列）。"""
    root = {
        "scope": root_scope,
        "header": "stream" if root_scope == "stream" else "http",
        "children": [],
        "options": [],
        "parent": None,
        "level": -1,
    }
    stack = [root]
    for line in src.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        cur = stack[-1]
        opens = trimmed.count("{")
        closes = trimmed.count("}")
        if opens == 0 and closes == 0 and cur:
            if trimmed.startswith("#"):
                cur["children"].append(
                    {
                        "scope": "comment",
                        "header": trimmed.replace("#", "", 1).lstrip(),
                        "children": [],
                        "options": [],
                        "parent": cur,
                    }
                )
            else:
                cur["options"].append(kvify(trimmed))
            continue
        if opens == 0 and closes > 0:
            pops = closes
            while pops > 0 and len(stack) > 1:
                stack.pop()
                pops -= 1
            continue
        if opens > 0:
            col = trimmed.index("{")
            head = trimmed[:col].strip()
            after = trimmed[col + 1:].rstrip("}").strip()
            sc = scope_of(head)
            child = {
                "scope": sc or "raw",
                "header": head,
                "children": [],
                "options": [],
                "parent": cur,
            }
            cur["children"].append(child)
            if after:
                for s in after.split(";"):
                    s = s.strip()
                    if s:
                        child["options"].append(kvify(s))
            if closes < opens:
                stack.append(child)
            continue
    return root


def ordered_options(options: list[dict]) -> list[dict]:
    """map default 恒置底；其余按书写/重排顺序。"""
    norm = [o for o in options if o.get("directive") != "default"]
    defs = [o for o in options if o.get("directive") == "default"]
    return norm + defs


def _option_raw(o: dict) -> str:
    raw = o.get("raw")
    if raw is None:
        raw = o.get("directive", "") + ((" " + o.get("value", "")) if o.get("value") else "")
    return raw


def render_text(node: dict) -> list[str]:
    """复刻 mock renderPreview：深度优先 + 缩进 + default 置底 + comment/if 弱提示。"""
    lines = []

    def rb(n: dict, depth: int) -> None:
        ind = INDENT * depth
        if n.get("scope") == "comment":
            lines.append("# " + n.get("header", ""))
            return
        if n.get("scope") == "if":
            lines.append(ind + "# 建议少用 if")
        lines.append(ind + (n.get("header") or "") + " {")
        for o in ordered_options(n.get("options", [])):
            lines.append(ind + INDENT + _option_raw(o).rstrip(";").rstrip() + ";")
        for c in n.get("children", []):
            rb(c, depth + 1)
        lines.append(ind + "}")

    rb(node, 0)
    return lines


def render_config_text(node: dict) -> str:
    return "\n".join(render_text(node))


def persist_tree(db: Session, config_id: int, root: dict) -> None:
    """把 parse 出的泛化树落库（seed / 测试用），父块映射保持嵌套。"""

    def insert(parent_id: int | None, node: dict) -> None:
        row = ConfigBlock(
            nginx_config_id=config_id,
            parent_id=parent_id,
            scope=node["scope"],
            header=node.get("header", ""),
            sort_order=0,
        )
        db.add(row)
        db.flush()
        for o in node.get("options", []):
            db.add(
                ConfigOption(
                    block_id=row.id,
                    directive=o.get("directive", ""),
                    value=o.get("value", ""),
                    row_type=_row_type_of(o),
                    is_free_text=bool(o.get("is_free_text")),
                    sort_order=0,
                )
            )
        for idx, child in enumerate(node.get("children", [])):
            child["_sort"] = idx
            insert(row.id, child)

    for idx, child in enumerate(root.get("children", [])):
        child["_sort"] = idx
        insert(None, child)
    db.commit()


def _row_type_of(o: dict) -> str:
    if o.get("row_type"):
        return o["row_type"]
    raw = o.get("raw")
    if o.get("is_free_text"):
        return "raw"
    if o.get("directive") == "default":
        return "default"
    if o.get("directive", "").startswith(("~", "*")):
        return "regex"
    return "kv"


def build_config_dict(db: Session, config_id: int, context: str = "conf") -> dict:
    """从 DB 组装渲染/导出所需的泛化树 dict（虚拟根按上下文包 http/stream）。"""
    rows = list(
        db.execute(
            select(ConfigBlock)
            .where(ConfigBlock.nginx_config_id == config_id)
            .order_by(ConfigBlock.sort_order, ConfigBlock.id)
        ).scalars().all()
    )
    ids = [b.id for b in rows]
    options = (
        list(
            db.execute(
                select(ConfigOption)
                .where(ConfigOption.block_id.in_(ids))
                .order_by(ConfigOption.sort_order, ConfigOption.id)
            ).scalars().all()
        )
        if ids
        else []
    )
    opt_map: dict[int, list[ConfigOption]] = {}
    for o in options:
        opt_map.setdefault(o.block_id, []).append(o)
    child_map: dict[int | None, list[ConfigBlock]] = {}
    for b in rows:
        child_map.setdefault(b.parent_id, []).append(b)

    def to_dict(b: ConfigBlock) -> dict:
        return {
            "id": b.id,
            "scope": b.scope,
            "header": b.header,
            "children": [to_dict(c) for c in child_map.get(b.id, [])],
            "options": [_option_dict(o) for o in opt_map.get(b.id, [])],
        }

    root_header = "stream" if context == "stream" else "http"
    return {
        "scope": context,
        "header": root_header,
        "children": [to_dict(b) for b in child_map.get(None, [])],
        "options": [],
    }


def _option_dict(o: ConfigOption) -> dict:
    if o.is_free_text or o.row_type == "raw":
        return {"directive": o.directive, "value": o.value, "row_type": o.row_type, "raw": o.directive}
    raw = o.directive + ((" " + o.value) if o.value else "")
    return {"directive": o.directive, "value": o.value, "row_type": o.row_type, "raw": raw}
```

- [ ] **Step 4: 追加 render 端点**

在 `backend/app/api/nginx_inner.py` 末尾追加：

```python
from app.services.nginx_render import build_config_dict, render_config_text

config_actions_router = APIRouter(prefix="/api/nginx-configs", tags=["nginx 配置动作"])


@config_actions_router.get("/{config_id}/render")
def render_config(
    config_id: int,
    context: str = "conf",
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    root = build_config_dict(db, config_id, context=context)
    return {"content": render_config_text(root)}
```

修改 `backend/app/main.py`：

```python
from app.api.nginx_inner import (
    blocks_router,
    config_actions_router,
    config_tree_router,
    options_router,
    upstream_router,
)
...
app.include_router(config_actions_router)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `.\.venv\Scripts\python -m pytest tests/test_render.py -q`
Expected: PASS（3 passed）

Run: `.\.venv\Scripts\python -m pytest tests/ -q`
Expected: 全绿（约 50 passed）

- [ ] **Step 6: 提交**

```bash
git add backend/app/services/nginx_render.py backend/app/api/nginx_inner.py backend/app/main.py backend/tests/test_render.py
git commit -m "feat(render): parse 移植 + 深度优先渲染 + GET /render"
```

---

### Task 5: 导出中心后端（SSL 开关 + server_name 域名替换 + upstream 整组替换）

**Files:**
- Create: `backend/app/services/nginx_export.py`
- Modify: `backend/app/schemas/nginx_inner.py`（追加 ExportRequest / UpstreamException）
- Modify: `backend/app/api/nginx_inner.py`（追加 export 端点）
- Test: `backend/tests/test_export.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_export.py`：

```python
"""导出中心：SSL 开关 + server_name 替换 + upstream 整组替换（默认+例外）。"""

from app.services.nginx_export import (
    apply_domains,
    derive_up_backends,
    dom_parse,
    export_lines,
    ips_for_group,
    up_key_of,
    up_name_of,
)
from app.services.nginx_render import parse

UPSTREAM_CONF = """upstream api_backend {
  server 10.0.0.97:8080 weight=5 max_fails=2 fail_timeout=30s;
  server 10.0.0.193:8080 weight=5 max_fails=2 fail_timeout=30s;
}
upstream web_backend {
  server 10.0.0.97:80;
}
server {
  listen 443 ssl http2;
  server_name old.example.com;
  ssl_certificate /etc/nginx/cert.pem;
  location /api/ {
    proxy_pass http://api_backend;
  }
}"""


def test_dom_parse():
    assert dom_parse("10.0.0.1, 10.0.0.2\n10.0.0.3") == ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
    assert dom_parse("") == []


def test_apply_domains_replaces_all_server_name():
    raw, changed, orig = apply_domains("server_name old.example.com", "new.example.com")
    assert raw == "server_name new.example.com" and changed and orig == "server_name old.example.com"
    raw2, changed2, _ = apply_domains("server_name old.example.com", "")
    assert raw2 == "server_name old.example.com" and not changed2
    raw3, changed3, _ = apply_domains("listen 80", "new.example.com")
    assert raw3 == "listen 80" and not changed3


def test_up_name_and_key():
    root = parse("upstream api_backend { server 1.1.1.1; }", "http")
    g = root["children"][0]
    assert up_name_of(g) == "api_backend"
    assert up_key_of(g, "conf") == "conf:api_backend"


def test_derive_up_backends_keeps_port_and_params():
    root = parse("upstream api_backend { server 10.0.0.97:8080 weight=5 max_fails=2 fail_timeout=30s; }", "http")
    g = root["children"][0]
    rows = derive_up_backends(g, ["10.8.8.8"])
    assert rows == [
        {"text": "server 10.8.8.8:8080 weight=5 max_fails=2 fail_timeout=30s;",
         "orig": "server 10.0.0.97:8080 weight=5 max_fails=2 fail_timeout=30s"}
    ]


def test_ips_for_group_exception_first_then_default():
    exceptions = [{"grp": "conf:web_backend", "ips": "10.8.8.8"}]
    assert ips_for_group("conf:web_backend", exceptions, "10.1.1.1, 10.1.1.2") == "10.8.8.8"
    assert ips_for_group("conf:api_backend", exceptions, "10.1.1.1, 10.1.1.2") == "10.1.1.1, 10.1.1.2"


def test_export_lines_ssl_off_drops_ssl_and_rewrites_listen():
    root = parse(UPSTREAM_CONF, "http")
    lines = export_lines(root, ctx="conf", ssl_on=False, dom_new=None, default_ips="", exceptions=[])
    text = "\n".join(l["text"] for l in lines)
    assert "ssl_certificate" not in text
    assert "listen 443 http2;" in text
    assert "listen 443 ssl http2;" not in text


def test_export_lines_domain_and_upstream_replace():
    root = parse(UPSTREAM_CONF, "http")
    lines = export_lines(
        root,
        ctx="conf",
        ssl_on=True,
        dom_new="new.example.com",
        default_ips="10.8.8.8, 10.8.8.9",
        exceptions=[],
    )
    changed = [l for l in lines if l["changed"]]
    text = "\n".join(l["text"] for l in lines)
    assert "server_name new.example.com;" in text
    assert "server 10.8.8.8:8080 weight=5 max_fails=2 fail_timeout=30s;" in text
    assert "server 10.8.8.9:8080 weight=5 max_fails=2 fail_timeout=30s;" in text
    assert "server 10.0.0.97:8080" not in text
    # web_backend 无端口，补默认 80 沿用原
    assert "server 10.8.8.8:80;" in text
    # 4 处命中：1 域名 + 2 api_backend 节点 + 1 web_backend 节点
    assert len(changed) == 4


def test_export_lines_exception_overrides_group():
    root = parse(UPSTREAM_CONF, "http")
    lines = export_lines(
        root,
        ctx="conf",
        ssl_on=True,
        dom_new=None,
        default_ips="10.1.1.1, 10.1.1.2",
        exceptions=[{"grp": "conf:api_backend", "ips": "10.9.9.9"}],
    )
    text = "\n".join(l["text"] for l in lines)
    assert "server 10.9.9.9:8080 weight=5 max_fails=2 fail_timeout=30s;" in text
    assert "server 10.1.1.1:80;" in text  # web_backend 走默认
    assert "server 10.1.1.1:8080" not in text
```

- [ ] **Step 2: 运行测试确认失败**

Run: `.\.venv\Scripts\python -m pytest tests/test_export.py -q`
Expected: FAIL —— `ModuleNotFoundError: No module named 'app.services.nginx_export'`

- [ ] **Step 3: 实现导出服务**

新建 `backend/app/services/nginx_export.py`（逐字移植 mock L1908-2021）：

```python
"""导出中心算法（移植 mock plan-c-real-conf.html L1908-2021）：

① server_name 域名整体替换（dom_new 单一输入）；② upstream 后端整组替换（默认 + 例外覆盖，纯 IP）。
SSL 关闭时丢弃 ssl_* 指令并改写 listen 去掉 ssl 标记。全部为纯函数。
"""

import re

INDENT = "    "
SSL_DROP = re.compile(
    r"^(ssl_protocols|ssl_certificate|ssl_certificate_key|ssl_session_cache|"
    r"ssl_session_timeout|ssl_ciphers|ssl_prefer_server_ciphers)$"
)
SERVER_NAME_RE = re.compile(r"^server_name\s+(.+)$")
IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
PORT_RE = re.compile(r":(\d+)$")


def dom_parse(s: str) -> list[str]:
    """文本 → IP 数组：逗号/换行拆分、trim、去空。"""
    return [e.strip() for e in re.split(r"[,\n]+", s or "") if e.strip()]


def apply_domains(raw: str, dom_new: str) -> tuple[str, bool, str | None]:
    """server_name 行整体替换为新域名；留空或非 server_name 行不替换。"""
    v = (dom_new or "").strip()
    if not v:
        return raw, False, None
    m = SERVER_NAME_RE.match(raw.rstrip(";").strip())
    if not m:
        return raw, False, None
    return "server_name " + v, True, "server_name " + m.group(1)


def up_name_of(n: dict) -> str:
    return re.sub(r"^upstream\s+", "", n.get("header") or "").strip()


def up_key_of(n: dict, ctx: str) -> str:
    return ctx + ":" + up_name_of(n)


def _server_rows(n: dict) -> list[dict]:
    return [o for o in n.get("options", []) if o.get("directive") == "server"]


def _server_raw(o: dict) -> str:
    raw = o.get("raw")
    if raw is None:
        raw = o.get("directive", "") + ((" " + o.get("value", "")) if o.get("value") else "")
    return raw.rstrip(";").strip()


def up_node_ports(n: dict) -> list[str]:
    out = []
    for o in _server_rows(n):
        m = re.match(r"^server\s+(\S+)", _server_raw(o))
        p = ""
        if m:
            pm = PORT_RE.search(m.group(1))
            p = pm.group(1) if pm else ""
        out.append(p)
    return out


def up_node_params(n: dict) -> list[str]:
    out = []
    for o in _server_rows(n):
        m = re.match(r"^server\s+(\S+)(.*)$", _server_raw(o))
        out.append(m.group(2).strip() if m else "")
    return out


def up_node_raws(n: dict) -> list[str]:
    return [_server_raw(o) for o in _server_rows(n)]


def derive_up_backends(n: dict, ips: list[str]) -> list[dict]:
    """整组替换：一个 IP = 一个节点；只补端口、端口后参数沿原对应位置；去尾分号防双分号。"""
    ports = up_node_ports(n)
    params = up_node_params(n)
    raws = up_node_raws(n)
    out = []
    for j, ip in enumerate(ips):
        ip = ip.strip()
        if not PORT_RE.search(ip) and not ip.startswith("unix:"):
            if ports:
                p = ports[j % len(ports)]
                if p:
                    ip = ip + ":" + p
        prm = params[j % len(params)] if params else ""
        return_text = "server " + ip + ((" " + prm) if prm else "") + ";"
        out.append(
            {
                "text": return_text,
                "orig": raws[j % len(raws)] if raws else None,
            }
        )
    return out


def ips_for_group(k: str, exceptions: list[dict], default_ips: str) -> str:
    """先查例外（e.grp===k 首个命中且非空），否则回退默认。"""
    for e in exceptions or []:
        if e and e.get("grp") == k and dom_parse(e.get("ips", "")):
            return e.get("ips", "")
    return default_ips or ""


def derived_for(n: dict, ctx: str, exceptions: list[dict], default_ips: str) -> list[dict] | None:
    """该组替换后的新后端行；清单为空则该组不替换（返回 None）。"""
    ips = ips_for_group(up_key_of(n, ctx), exceptions, default_ips)
    parsed = dom_parse(ips)
    return derive_up_backends(n, parsed) if parsed else None


def export_lines(
    root: dict,
    *,
    ctx: str,
    ssl_on: bool,
    dom_new: str | None,
    default_ips: str,
    exceptions: list[dict],
) -> list[dict]:
    """逐行导出：{text, changed, orig}；复刻 mock exportLines/walkEx。"""
    out = []

    def emit(text: str, changed: bool = False, orig: str | None = None) -> None:
        out.append({"text": text, "changed": changed, "orig": orig})

    def walk_ex(n: dict, d: int) -> None:
        ind = INDENT * d
        if n.get("scope") == "comment":
            emit(ind + "# " + n.get("header", ""))
            return
        if n.get("scope") == "if":
            emit(ind + "# 建议少用 if")
        emit(ind + (n.get("header") or "") + " {")
        up_rep = derived_for(n, ctx, exceptions, default_ips) if n.get("scope") == "upstream" else None
        body = []
        for o in n.get("options", []):
            dd = o.get("directive", "")
            raw = o.get("raw")
            if raw is None:
                raw = dd + ((" " + o.get("value", "")) if o.get("value") else "")
            if up_rep and dd == "server":
                continue
            val = o.get("value", "")
            if not ssl_on:
                if SSL_DROP.match(dd):
                    continue
                if dd == "listen":
                    raw = re.sub(r"\s+", " ", re.sub(r"\bssl\b", " ", val)).strip()
            is_def = dd == "default"
            if dd == "server_name":
                r, changed, orig = apply_domains(raw.rstrip(";").strip(), dom_new)
            else:
                r, changed, orig = raw.rstrip(";").strip(), False, None
            body.append({"raw": r, "is_default": is_def, "changed": changed, "orig": orig})
        norm = [b for b in body if not b["is_default"]]
        defs = [b for b in body if b["is_default"]]
        for b in norm + defs:
            emit(ind + INDENT + b["raw"] + ";", b["changed"], b["orig"])
        if up_rep:
            for b in up_rep:
                emit(ind + INDENT + b["text"], True, b["orig"])
        for c in n.get("children", []):
            walk_ex(c, d + 1)
        emit(ind + "}")

    walk_ex(root, 0)
    return out


def export_config_text(
    root: dict,
    *,
    ctx: str,
    ssl_on: bool,
    dom_new: str | None,
    default_ips: str,
    exceptions: list[dict],
) -> str:
    return "\n".join(l["text"] for l in export_lines(
        root, ctx=ctx, ssl_on=ssl_on, dom_new=dom_new,
        default_ips=default_ips, exceptions=exceptions,
    ))
```

- [ ] **Step 4: 追加 export schemas + 端点**

在 `backend/app/schemas/nginx_inner.py` 末尾追加：

```python
# ---- 导出中心 ----

class UpstreamException(BaseModel):
    """例外覆盖：grp=<CTX>:<组名>，每条例外只针对单个 upstream 组。"""

    grp: str
    ips: str


class ExportRequest(BaseModel):
    ssl_enabled: bool = True
    server_name_domain: str | None = None
    upstream_default_ips: str | None = None
    upstream_exceptions: list[UpstreamException] = []
    context: str = "conf"
```

在 `backend/app/api/nginx_inner.py` 末尾追加：

```python
from app.schemas.nginx_inner import ExportRequest
from app.services.nginx_export import export_config_text
from app.services.nginx_render import build_config_dict


@config_actions_router.post("/{config_id}/export")
def export_config(
    config_id: int,
    payload: ExportRequest,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    root = build_config_dict(db, config_id, context=payload.context)
    exceptions = [e.model_dump() for e in payload.upstream_exceptions]
    content = export_config_text(
        root,
        ctx=payload.context,
        ssl_on=payload.ssl_enabled,
        dom_new=payload.server_name_domain,
        default_ips=payload.upstream_default_ips or "",
        exceptions=exceptions,
    )
    return {"content": content}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `.\.venv\Scripts\python -m pytest tests/test_export.py -q`
Expected: PASS（7 passed）

Run: `.\.venv\Scripts\python -m pytest tests/ -q`
Expected: 全绿（约 57 passed）

- [ ] **Step 6: 提交**

```bash
git add backend/app/services/nginx_export.py backend/app/schemas/nginx_inner.py backend/app/api/nginx_inner.py backend/tests/test_export.py
git commit -m "feat(export): 导出中心算法移植 + POST export 端点"
```

---

### Task 6: 安全子进程工具 + test / reload / validate 端点

**Files:**
- Create: `backend/app/services/nginx_ops.py`
- Modify: `backend/app/api/nginx_inner.py`（追加动作端点）
- Modify: `backend/app/schemas/nginx_inner.py`（追加 ValidateRequest）
- Test: `backend/tests/test_nginx_ops.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_nginx_ops.py`：

```python
"""安全子进程工具与动作端点：路径白名单 / SSRF 防护 / test / reload / validate。"""

from app.services.nginx_ops import (
    probe_target_allowed,
    tcp_probe,
    validate_safe_path,
)


def test_validate_safe_path_whitelist():
    assert validate_safe_path("businesscenter_nginx_CD_master.conf") == "businesscenter_nginx_CD_master.conf"
    assert validate_safe_path("a/b-c_d.e") == "a/b-c_d.e"
    for bad in ("../etc/passwd", "a b.conf", "a;rm.conf"):
        try:
            validate_safe_path(bad)
            assert False, f"应拒绝 {bad!r}"
        except ValueError:
            pass


def test_probe_target_allowed_blocks_public():
    assert probe_target_allowed("127.0.0.1")
    assert probe_target_allowed("10.0.0.97")
    assert probe_target_allowed("192.168.1.1")
    assert not probe_target_allowed("8.8.8.8")
    assert not probe_target_allowed("api.example.com")


def test_tcp_probe_closed_port_fails(client, auth_headers):
    """探测本地未监听端口返回 ok=False（不抛异常）。"""
    r = client.post(
        "/api/forward-ports/1/test",
        headers=auth_headers,
    )
    # 未创建 forward port → 404；创建后再测连接失败路径由 service 单测覆盖
    assert r.status_code == 404


def test_tcp_probe_service_unit():
    res = tcp_probe("127.0.0.1", 1, timeout=0.2)
    assert res["ok"] is False
    res2 = tcp_probe("8.8.8.8", 80, timeout=0.2)
    assert res2["ok"] is False and "SSRF" in res2.get("error", "")


def test_nginx_validate_via_monkeypatch(client, auth_headers, monkeypatch):
    """monkeypatch subprocess.run 模拟 nginx -t 成功/失败，端点返回解析结果。"""
    ind = client.post(
        "/api/industries", json={"code": "op", "name": "op"}, headers=auth_headers
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "conf", "config_text": "server{}"},
        headers=auth_headers,
    ).json()

    class FakeProc:
        def __init__(self, rc, out):
            self.returncode = rc
            self.stdout = out
            self.stderr = ""

    import subprocess

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeProc(0, "syntax is ok"))
    ok = client.post(
        f"/api/nginx-configs/{cfg['id']}/validate",
        json={"content": "server { listen 80; }"},
        headers=auth_headers,
    )
    assert ok.status_code == 200 and ok.json()["ok"] is True

    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: FakeProc(1, 'nginx: [emerg] unknown directive in /tmp/x.conf:12'),
    )
    bad = client.post(
        f"/api/nginx-configs/{cfg['id']}/validate",
        json={"content": "server {"},
        headers=auth_headers,
    )
    assert bad.status_code == 200 and bad.json()["ok"] is False
    assert bad.json()["error_line"] == 12


def test_reload_via_monkeypatch(client, auth_headers, monkeypatch):
    import subprocess

    class FakeProc:
        returncode = 0
        stdout = "signal process started"
        stderr = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeProc())
    ind = client.post(
        "/api/industries", json={"code": "op2", "name": "op2"}, headers=auth_headers
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "conf", "config_text": "server{}"},
        headers=auth_headers,
    ).json()
    r = client.post(f"/api/nginx-configs/{cfg['id']}/reload", headers=auth_headers)
    assert r.status_code == 200 and r.json()["ok"] is True


def test_forward_test_resolves_upstream(client, auth_headers):
    """forward test 引用 upstream 组时探测组内首个启用节点（service 单测覆盖 probe 本身）。"""
    ind = client.post(
        "/api/industries", json={"code": "op3", "name": "op3"}, headers=auth_headers
    ).json()
    up = client.post(
        "/api/upstreams",
        json={"industry_id": ind["id"], "name": "web_backend"},
        headers=auth_headers,
    ).json()
    client.post(
        f"/api/upstreams/{up['id']}/servers",
        json={"addr": "10.0.0.1", "port": 80},
        headers=auth_headers,
    )
    fp = client.post(
        "/api/forward-ports",
        json={
            "industry_id": ind["id"],
            "upstream_id": up["id"],
            "listen_port": 8080,
            "upstream_target": "web_backend",
        },
        headers=auth_headers,
    )
    assert fp.status_code == 201
    r = client.post(f"/api/forward-ports/{fp.json()['id']}/test", headers=auth_headers)
    # 10.0.0.1:80 无服务 → ok False，但返回结构完整
    assert r.status_code == 200 and r.json()["ok"] is False
```

- [ ] **Step 2: 运行测试确认失败**

Run: `.\.venv\Scripts\python -m pytest tests/test_nginx_ops.py -q`
Expected: FAIL —— `ModuleNotFoundError: No module named 'app.services.nginx_ops'`

- [ ] **Step 3: 实现工具服务**

新建 `backend/app/services/nginx_ops.py`：

```python
"""安全子进程工具：路径白名单 / SSRF 防护 / nginx -t / reload / TCP 探测。

命令一律 subprocess.run([...], shell=False)，配置写临时文件后以路径作参数。
"""

import re
import socket
import subprocess
import tempfile
import time
from pathlib import Path

SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
_PRIVATE_RANGES = [
    ("10.0.0.0", "10.255.255.255"),
    ("172.16.0.0", "172.31.255.255"),
    ("192.168.0.0", "192.168.255.255"),
    ("127.0.0.0", "127.255.255.255"),
]


def _ipv4_to_int(ip: str) -> int:
    parts = [int(p) for p in ip.split(".")]
    return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]


def validate_safe_path(name: str) -> str:
    """文件名白名单（字母数字 -_./），拒绝路径遍历。"""
    if not name or not SAFE_NAME_RE.match(name) or ".." in name:
        raise ValueError("非法路径")
    return name


def probe_target_allowed(host: str) -> bool:
    """仅允许内网/回环 IPv4，拒绝域名与公网 IP（防 SSRF）。"""
    if not IPV4_RE.match(host):
        return False
    v = _ipv4_to_int(host)
    return any(
        _ipv4_to_int(lo) <= v <= _ipv4_to_int(hi)
        for lo, hi in _PRIVATE_RANGES
    )


def tcp_probe(host: str, port: int, timeout: float = 3.0) -> dict:
    if not probe_target_allowed(host):
        return {"ok": False, "host": host, "port": port, "error": "仅允许探测内网 IP（防 SSRF）"}
    start = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            latency_ms = round((time.monotonic() - start) * 1000, 1)
            return {"ok": True, "host": host, "port": port, "latency_ms": latency_ms}
    except OSError as exc:
        return {"ok": False, "host": host, "port": port, "error": str(exc)}


def nginx_validate(content: str) -> dict:
    """写临时文件 → nginx -t -c <path>；解析错误行号。"""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "nginx_validate.conf"
        path.write_text(content, encoding="utf-8")
        try:
            proc = subprocess.run(
                ["nginx", "-t", "-c", str(path)],
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"ok": False, "output": str(exc), "error_line": None}
        output = (proc.stdout or "") + (proc.stderr or "")
        line = None
        m = re.search(r":(\d+)\s*$", output.strip(), re.M)
        if m:
            line = int(m.group(1))
        return {"ok": proc.returncode == 0, "output": output, "error_line": line}


def nginx_reload() -> dict:
    try:
        proc = subprocess.run(
            ["nginx", "-s", "reload"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "output": str(exc)}
    output = (proc.stdout or "") + (proc.stderr or "")
    return {"ok": proc.returncode == 0, "output": output}


def build_validation_wrapper(fragment: str) -> str:
    """把片段包成合法主配置（events + http），供 nginx -t 语法校验。"""
    return "events {}\nhttp {\n" + fragment + "\n}\n"
```

- [ ] **Step 4: 追加动作端点**

在 `backend/app/schemas/nginx_inner.py` 末尾追加：

```python
class ValidateRequest(BaseModel):
    content: str
```

在 `backend/app/api/nginx_inner.py` 末尾追加：

```python
from app.models.nginx import ForwardPort
from app.schemas.nginx_inner import ValidateRequest
from app.services.nginx_ops import (
    build_validation_wrapper,
    nginx_reload,
    nginx_validate,
    tcp_probe,
)
from app.services.nginx_render import build_config_dict, render_config_text


@config_actions_router.post("/{config_id}/validate")
def validate_config(
    config_id: int,
    payload: ValidateRequest,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    return nginx_validate(build_validation_wrapper(payload.content))


@config_actions_router.post("/{config_id}/reload")
def reload_config(
    config_id: int,
    _current_user: User = Depends(get_current_user),
) -> dict:
    return nginx_reload()


@config_actions_router.post("/{config_id}/test")
def test_config(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """对配置内所有 server 块的 proxy_pass 直连目标做连通性探测。"""
    from app.services.nginx_render import build_config_dict

    root = build_config_dict(db, config_id, context="conf")
    results = []
    seen = set()

    def walk(n: dict) -> None:
        for o in n.get("options", []):
            if o.get("directive") == "proxy_pass":
                raw = o.get("raw") or ""
                m = re.match(r"^\s*([^/:\s]+):(\d+)", raw)
                if not m:
                    continue
                host, port = m.group(1), int(m.group(2))
                key = f"{host}:{port}"
                if key in seen:
                    continue
                seen.add(key)
                results.append({"host": host, "port": port, **tcp_probe(host, port)})
        for c in n.get("children", []):
            walk(c)

    walk(root)
    return {"results": results}


@config_actions_router.post("/forward-ports/{forward_id}/test")
def test_forward_port(
    forward_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    fp = db.execute(
        select(ForwardPort).where(ForwardPort.id == forward_id)
    ).scalar_one_or_none()
    if fp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="转发端口不存在")
    host, port = None, None
    if fp.upstream_id is not None:
        srv = db.execute(
            select(UpstreamServer)
            .where(UpstreamServer.upstream_id == fp.upstream_id, UpstreamServer.enable.is_(True))
            .order_by(UpstreamServer.id)
        ).scalars().first()
        if srv is not None:
            host, port = srv.addr, srv.port or 80
    else:
        m = re.match(r"^\s*([^:/\s]+):(\d+)\s*$", fp.upstream_target or "")
        if m:
            host, port = m.group(1), int(m.group(2))
    if not host or not port:
        return {"ok": False, "error": "无法解析探测目标"}
    return tcp_probe(host, port)


@upstream_router.post("/{upstream_id}/validate")
def validate_upstream(
    upstream_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    up = _get_upstream(db, upstream_id)
    servers = list(
        db.execute(
            select(UpstreamServer)
            .where(UpstreamServer.upstream_id == upstream_id)
            .order_by(UpstreamServer.id)
        ).scalars().all()
    )
    fragment = _upstream_preview_text(up, servers)
    return nginx_validate(build_validation_wrapper(fragment))
```

> `re` 已在文件顶部导入；`config_actions_router` 已在 Task 4 定义。

- [ ] **Step 5: 运行测试确认通过**

Run: `.\.venv\Scripts\python -m pytest tests/test_nginx_ops.py -q`
Expected: PASS（8 passed）

Run: `.\.venv\Scripts\python -m pytest tests/ -q`
Expected: 全绿（约 65 passed）

- [ ] **Step 6: 提交**

```bash
git add backend/app/services/nginx_ops.py backend/app/schemas/nginx_inner.py backend/app/api/nginx_inner.py backend/tests/test_nginx_ops.py
git commit -m "feat(ops): 安全子进程工具 + test/reload/validate 端点"
```

---

### Task 7: 全局拓扑聚合端点

**Files:**
- Modify: `backend/app/api/nginx_inner.py`（追加 topology_router）
- Test: `backend/tests/test_topology.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_topology.py`：

```python
"""全局拓扑：四层聚合数据（域名 / 监听点 / upstream / 后端节点）。"""

from app.services.nginx_render import build_config_dict


def _seed_tree(client, headers):
    ind = client.post(
        "/api/industries", json={"code": "tp", "name": "拓扑"}, headers=headers
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "conf", "config_text": "server {}"},
        headers=headers,
    ).json()
    srv = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=headers,
    ).json()
    client.post(
        "/api/config-options",
        json={"block_id": srv["id"], "directive": "listen", "value": "443 ssl http2", "sort_order": 0},
        headers=headers,
    )
    client.post(
        "/api/config-options",
        json={"block_id": srv["id"], "directive": "server_name", "value": "freight.example.com", "sort_order": 1},
        headers=headers,
    )
    loc = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "parent_id": srv["id"], "scope": "location", "header": "location /api/ {", "sort_order": 0},
        headers=headers,
    ).json()
    client.post(
        "/api/config-options",
        json={"block_id": loc["id"], "directive": "proxy_pass", "value": "http://api_backend", "sort_order": 0},
        headers=headers,
    )
    up = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "upstream", "header": "upstream api_backend {", "sort_order": 1},
        headers=headers,
    ).json()
    for addr, port in (("10.0.0.97", 8080), ("10.0.0.193", 8080)):
        client.post(
            "/api/config-options",
            json={"block_id": up["id"], "directive": "server", "value": f"{addr}:{port} weight=5", "sort_order": 0},
            headers=headers,
        )
    return ind, cfg


def test_topology_aggregates_four_layers(client, auth_headers):
    _, cfg = _seed_tree(client, auth_headers)
    r = client.get(f"/api/topology?config_id={cfg['id']}", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["domains"] == ["freight.example.com"]
    assert body["listeners"][0]["listen_plain"] == "443"
    assert body["listeners"][0]["server_name"] == "freight.example.com"
    assert body["listeners"][0]["location_count"] == 1
    assert body["upstreams"][0]["name"] == "api_backend"
    assert [b["addr"] for b in body["upstreams"][0]["backends"]] == ["10.0.0.97", "10.0.0.193"]
    assert body["links"] == [{"listen": "443", "upstream": "api_backend"}]


def test_build_config_dict_listen_plain():
    """拓扑用 listenPlain 语义：剥离 ssl/http2 修饰词。"""
    from app.services.nginx_render import parse

    root = parse("server { listen 443 ssl http2; }", "http")
    assert root["children"][0]["options"][0]["value"] == "443 ssl http2"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `.\.venv\Scripts\python -m pytest tests/test_topology.py -q`
Expected: FAIL —— `404`（topology 路由未注册）

- [ ] **Step 3: 实现拓扑端点**

在 `backend/app/api/nginx_inner.py` 末尾追加：

```python
import re as _re

from app.services.nginx_render import build_config_dict

topology_router = APIRouter(prefix="/api/topology", tags=["拓扑"])

_LISTEN_PLAIN_RE = _re.compile(r"^unix:")
_SERVER_ROW_RE = _re.compile(r"^server\s+(\S+)(.*)$")


def _listen_plain(value: str) -> str:
    """剥离 ssl/http2 等修饰词（复刻 mock listenPlain L1098-1103）。"""
    t = (value or "").strip().rstrip(";").strip()
    if _LISTEN_PLAIN_RE.match(t):
        return t
    if " " in t:
        return t.split()[0]
    return t


def _proxy_targets(node: dict) -> list[str]:
    """聚合 location 内 proxy_pass 的 upstream 组名（复刻 proxyTargets L1073-1077）。"""
    out, seen = [], set()
    for c in node.get("children", []):
        if c.get("scope") != "location":
            continue
        for o in c.get("options", []):
            if o.get("directive") == "proxy_pass":
                raw = o.get("raw") or ""
                m = _re.match(r"http://([^/:]+)", raw)
                if m and m.group(1) not in seen and not _re.match(r"^\d{1,3}(\.\d{1,3}){3}$", m.group(1)):
                    seen.add(m.group(1))
                    out.append(m.group(1))
    return out


@topology_router.get("")
def get_topology(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    root = build_config_dict(db, config_id, context="conf")
    listeners = []
    upstreams = []
    links = []
    domains = []
    for top in root.get("children", []):
        if top.get("scope") == "server":
            listen_value = next(
                (o.get("value", "") for o in top.get("options", []) if o.get("directive") == "listen"),
                "",
            )
            sname = next(
                (o.get("value", "").rstrip(";") for o in top.get("options", []) if o.get("directive") == "server_name"),
                "-",
            )
            listen_plain = _listen_plain(listen_value)
            targets = _proxy_targets(top)
            listeners.append(
                {
                    "id": top.get("id"),
                    "listen": listen_value,
                    "listen_plain": listen_plain,
                    "server_name": sname,
                    "location_count": len([c for c in top.get("children", []) if c.get("scope") == "location"]),
                    "proxy_targets": targets,
                }
            )
            if sname not in ("-",) and sname not in domains:
                domains.append(sname)
            for t in targets:
                links.append({"listen": listen_plain, "upstream": t})
        elif top.get("scope") == "upstream":
            backends = []
            for o in top.get("options", []):
                if o.get("directive") != "server":
                    continue
                raw = o.get("raw") or ""
                m = _SERVER_ROW_RE.match(raw)
                addr = port = None
                if m:
                    node_addr = m.group(1)
                    if ":" in node_addr:
                        addr, _, port = node_addr.rpartition(":")
                    else:
                        addr = node_addr
                backends.append({"addr": addr, "port": port, "raw": raw})
            upstreams.append({"id": top.get("id"), "name": _re.sub(r"^upstream\s+", "", top.get("header", "")).strip(), "backends": backends})
    return {"domains": domains, "listeners": listeners, "upstreams": upstreams, "links": links}
```

修改 `backend/app/main.py`：

```python
from app.api.nginx_inner import (
    blocks_router,
    config_actions_router,
    config_tree_router,
    options_router,
    topology_router,
    upstream_router,
)
...
app.include_router(topology_router)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `.\.venv\Scripts\python -m pytest tests/test_topology.py -q`
Expected: PASS（2 passed）

- [ ] **Step 5: 提交**

```bash
git add backend/app/api/nginx_inner.py backend/app/main.py backend/tests/test_topology.py
git commit -m "feat(api): 全局拓扑四层聚合端点"
```

---

### Task 8: 指令字典端点

**Files:**
- Modify: `backend/app/api/nginx_inner.py`（追加 directives_router + 静态字典）
- Test: `backend/tests/test_directives.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_directives.py`：

```python
"""指令字典端点。"""


def test_directives_list_nonempty(client, auth_headers):
    r = client.get("/api/directives", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert len(body) > 10
    names = {d["name"] for d in body}
    assert {"listen", "proxy_pass", "server_name"} <= names
    for d in body:
        assert d["name"] and d["description"] and d["context"]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `.\.venv\Scripts\python -m pytest tests/test_directives.py -q`
Expected: FAIL —— `404`

- [ ] **Step 3: 实现字典端点**

在 `backend/app/api/nginx_inner.py` 末尾追加：

```python
directives_router = APIRouter(prefix="/api/directives", tags=["指令字典"])

_DIRECTIVES = [
    {"name": "listen", "description": "监听地址:端口，可带 ssl/http2 修饰词", "context": "server"},
    {"name": "server_name", "description": "虚拟主机域名（可多个，空格分隔）", "context": "server"},
    {"name": "proxy_pass", "description": "反向代理目标：upstream 组名 / IP:端口 / URL", "context": "location"},
    {"name": "server", "description": "upstream 组内后端节点（IP:端口 参数）", "context": "upstream"},
    {"name": "upstream", "description": "负载均衡组声明", "context": "http"},
    {"name": "location", "description": "URI 匹配块", "context": "server"},
    {"name": "map", "description": "变量映射块", "context": "http"},
    {"name": "geo", "description": "IP 网段映射变量", "context": "http"},
    {"name": "if", "description": "条件判断块（建议少用）", "context": "location"},
    {"name": "log_format", "description": "自定义访问日志格式", "context": "http"},
    {"name": "split_clients", "description": "按比例分发变量（A/B 测试）", "context": "http"},
    {"name": "limit_except", "description": "限制允许的 HTTP 方法", "context": "location"},
    {"name": "include", "description": "引入其它配置文件", "context": "http"},
    {"name": "keepalive", "description": "upstream 空闲连接数", "context": "upstream"},
    {"name": "least_conn", "description": "最少连接负载均衡策略", "context": "upstream"},
    {"name": "ip_hash", "description": "按客户端 IP 哈希均衡策略", "context": "upstream"},
    {"name": "ssl_certificate", "description": "SSL 证书路径", "context": "server"},
    {"name": "ssl_certificate_key", "description": "SSL 私钥路径", "context": "server"},
    {"name": "ssl_protocols", "description": "允许的 TLS 版本", "context": "server"},
    {"name": "client_max_body_size", "description": "客户端请求体上限", "context": "server"},
    {"name": "root", "description": "静态文件根目录", "context": "server"},
    {"name": "index", "description": "默认索引文件", "context": "server"},
    {"name": "return", "description": "直接返回状态码/URL", "context": "server"},
    {"name": "rewrite", "description": "URL 重写规则", "context": "server"},
    {"name": "try_files", "description": "按序尝试文件并回退", "context": "location"},
    {"name": "add_header", "description": "追加响应头", "context": "server"},
    {"name": "access_log", "description": "访问日志路径", "context": "server"},
    {"name": "error_log", "description": "错误日志路径", "context": "main"},
    {"name": "worker_connections", "description": "单 worker 最大连接数", "context": "events"},
]


@directives_router.get("")
def list_directives(
    _current_user: User = Depends(get_current_user),
) -> list[dict]:
    return _DIRECTIVES
```

修改 `backend/app/main.py`：

```python
from app.api.nginx_inner import (
    blocks_router,
    config_actions_router,
    config_tree_router,
    directives_router,
    options_router,
    topology_router,
    upstream_router,
)
...
app.include_router(directives_router)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `.\.venv\Scripts\python -m pytest tests/test_directives.py -q`
Expected: PASS（1 passed）

- [ ] **Step 5: 提交**

```bash
git add backend/app/api/nginx_inner.py backend/app/main.py backend/tests/test_directives.py
git commit -m "feat(api): 指令字典端点"
```

---

### Task 9: 行业克隆扩展为整套深拷贝

**Files:**
- Modify: `backend/app/services/industry_clone.py`
- Modify: `backend/tests/test_clone.py`（追加内页①深拷贝用例）

- [ ] **Step 1: 写失败测试**

在 `backend/tests/test_clone.py` 末尾追加：

```python
def _seed_inner_source(client, headers):
    """带块树 / upstream / 映射 / 转发 / 业务端口的源行业。"""
    src = client.post(
        "/api/industries",
        json={"code": "inner_src", "name": "内页源", "is_template": True},
        headers=headers,
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": src["id"], "name": "conf", "config_text": "server {}"},
        headers=headers,
    ).json()
    srv = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=headers,
    ).json()
    client.post(
        "/api/config-options",
        json={"block_id": srv["id"], "directive": "listen", "value": "443", "sort_order": 0},
        headers=headers,
    )
    loc = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "parent_id": srv["id"], "scope": "location", "header": "location /api/ {", "sort_order": 0},
        headers=headers,
    ).json()
    client.post(
        "/api/config-options",
        json={"block_id": loc["id"], "directive": "proxy_pass", "value": "http://api_backend", "sort_order": 0},
        headers=headers,
    )
    up = client.post(
        "/api/upstreams",
        json={"industry_id": src["id"], "name": "api_backend"},
        headers=headers,
    ).json()
    client.post(
        f"/api/upstreams/{up['id']}/servers",
        json={"addr": "10.0.0.97", "port": 8080, "weight": 5},
        headers=headers,
    )
    client.post(
        "/api/domain-mappings",
        json={"industry_id": src["id"], "domain": "a.example.com", "forward_tos": "10.0.0.1:80"},
        headers=headers,
    )
    client.post(
        "/api/forward-ports",
        json={"industry_id": src["id"], "listen_port": 8080, "upstream_target": "api_backend", "upstream_id": up["id"]},
        headers=headers,
    )
    client.post(
        "/api/biz-ports",
        json={"industry_id": src["id"], "service_name": "web", "port": 8080},
        headers=headers,
    )
    return src


def test_clone_deep_copies_inner_tables(client, auth_headers):
    """克隆后：块树整棵（含子块/options）、upstream+servers、映射/转发/业务端口计数一致；upstream_id 重映射。"""
    hdrs = auth_headers
    src = _seed_inner_source(client, hdrs)
    r = client.post(
        "/api/industries/clone",
        json={"source_industry_id": src["id"], "name": "克隆内页"},
        headers=hdrs,
    )
    assert r.status_code == 201
    new = r.json()

    src_cfg = client.get(f"/api/nginx-configs?industry_id={src['id']}", headers=hdrs).json()[0]
    new_cfg = client.get(f"/api/nginx-configs?industry_id={new['id']}", headers=hdrs).json()[0]
    src_tree = client.get(f"/api/nginx-configs/{src_cfg['id']}/tree", headers=hdrs).json()
    new_tree = client.get(f"/api/nginx-configs/{new_cfg['id']}/tree", headers=hdrs).json()
    assert len(new_tree["blocks"]) == len(src_tree["blocks"]) == 1
    assert new_tree["blocks"][0]["scope"] == "server"
    assert new_tree["blocks"][0]["children"][0]["scope"] == "location"
    assert new_tree["blocks"][0]["children"][0]["options"][0]["directive"] == "proxy_pass"

    src_ups = client.get(f"/api/upstreams?industry_id={src['id']}", headers=hdrs).json()
    new_ups = client.get(f"/api/upstreams?industry_id={new['id']}", headers=hdrs).json()
    assert len(new_ups) == len(src_ups) == 1
    new_srv = client.get(f"/api/upstreams/{new_ups[0]['id']}/servers", headers=hdrs).json()
    assert len(new_srv) == 1 and new_srv[0]["addr"] == "10.0.0.97"

    # forward_ports 的 upstream_id 已重映射到新行业的新组
    src_fp = client.get("/api/forward-ports?industry_id={}".format(src["id"]), headers=hdrs)
    new_fp = client.get("/api/forward-ports?industry_id={}".format(new["id"]), headers=hdrs)
    assert src_fp.status_code == 200 and new_fp.status_code == 200
    new_fp_body = new_fp.json()
    assert len(new_fp_body) == 1
    assert new_fp_body[0]["upstream_id"] == new_ups[0]["id"]
    assert new_fp_body[0]["industry_id"] == new["id"]

    assert len(client.get(f"/api/domain-mappings?industry_id={new['id']}", headers=hdrs).json()) == 1
    assert len(client.get(f"/api/biz-ports?industry_id={new['id']}", headers=hdrs).json()) == 1
```

> 注：`/api/domain-mappings`、`/api/forward-ports`、`/api/biz-ports` 列表端点当前不按 industry_id 过滤 —— T9 步骤 3 会给出它们的行业过滤实现说明；若运行用例时列表返回全局数据，请按步骤 3 提示先完成过滤改造。**（见下方实现说明）**

- [ ] **Step 2: 运行测试确认失败**

Run: `.\.venv\Scripts\python -m pytest tests/test_clone.py -q`
Expected: FAIL —— 新用例 `test_clone_deep_copies_inner_tables` 断言失败（克隆后无块树 / upstream_id 未重映射）

- [ ] **Step 3: 实现克隆深拷贝 + 既有列表端点行业过滤**

替换 `backend/app/services/industry_clone.py` 全文：

```python
"""行业克隆事务 service：把源行业整套配置（配置 + 块树 + upstream + 映射/转发/业务端口）深拷贝到新行业。"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.industry import Industry
from app.models.nginx import (
    BizPort,
    ConfigBlock,
    ConfigOption,
    DomainMapping,
    ForwardPort,
    NginxConfig,
    Upstream,
    UpstreamServer,
)
from app.schemas.industry import CloneIndustryRequest


def derive_code(name: str) -> str:
    """由行业名派生唯一 code：转小写、空白转下划线、去非法字符，截断 40。"""
    code = "_".join(part for part in name.lower().split() if part)
    code = "".join(c for c in code if c.isalnum() or c == "_")
    return (code or "industry")[:40]


def clone_industry(
    db: Session, *, payload: CloneIndustryRequest
) -> Industry:
    """事务内新建行业并深拷源行业全部数据；任一步失败整体回滚。"""
    source = db.execute(
        select(Industry).where(Industry.id == payload.source_industry_id)
    ).scalar_one_or_none()
    if source is None:
        raise ValueError("source_industry_not_found")

    new_industry = Industry(
        code=derive_code(payload.name),
        name=payload.name,
        owner=payload.owner,
        is_template=False,
        cloned_from_id=source.id,
    )
    db.add(new_industry)
    db.flush()  # 生成 new_industry.id，供外键引用

    # 1. nginx_configs + config_blocks(整棵 parent_id 树) + config_options
    source_configs = list(
        db.execute(
            select(NginxConfig).where(NginxConfig.industry_id == source.id)
        ).scalars().all()
    )
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
        _copy_block_tree(db, new_cfg.id, cfg.id)

    # 2. upstreams + upstream_servers（行业级），构建旧→新 id 映射供 forward_ports 重映射
    up_map: dict[int, int] = {}
    for up in db.execute(
        select(Upstream).where(Upstream.industry_id == source.id)
    ).scalars().all():
        new_up = Upstream(
            industry_id=new_industry.id,
            name=up.name,
            strategy=up.strategy,
            keepalive=up.keepalive,
        )
        db.add(new_up)
        db.flush()
        up_map[up.id] = new_up.id
        for s in db.execute(
            select(UpstreamServer).where(UpstreamServer.upstream_id == up.id)
        ).scalars().all():
            db.add(
                UpstreamServer(
                    upstream_id=new_up.id,
                    addr=s.addr,
                    port=s.port,
                    weight=s.weight,
                    health_status=s.health_status,
                    enable=s.enable,
                )
            )

    # 3. domain_mappings / forward_ports / biz_ports（行业级）
    for dm in db.execute(
        select(DomainMapping).where(DomainMapping.industry_id == source.id)
    ).scalars().all():
        db.add(
            DomainMapping(
                industry_id=new_industry.id,
                domain=dm.domain,
                forward_tos=dm.forward_tos,
                protocol=dm.protocol,
                description=dm.description,
                enabled=dm.enabled,
            )
        )
    for fp in db.execute(
        select(ForwardPort).where(ForwardPort.industry_id == source.id)
    ).scalars().all():
        db.add(
            ForwardPort(
                industry_id=new_industry.id,
                listen_port=fp.listen_port,
                upstream_target=fp.upstream_target,
                service_name=fp.service_name,
                protocol=fp.protocol,
                enabled=fp.enabled,
                upstream_id=up_map.get(fp.upstream_id),
            )
        )
    for bp in db.execute(
        select(BizPort).where(BizPort.industry_id == source.id)
    ).scalars().all():
        db.add(
            BizPort(
                industry_id=new_industry.id,
                service_name=bp.service_name,
                port=bp.port,
                protocol=bp.protocol,
                public_exposed=bp.public_exposed,
                note=bp.note,
            )
        )

    db.commit()
    db.refresh(new_industry)
    return new_industry


def _copy_block_tree(db: Session, new_config_id: int, source_config_id: int) -> None:
    """按 parent_id 递归拷贝块树（保持嵌套），并拷贝每块的 options。"""
    rows = list(
        db.execute(
            select(ConfigBlock)
            .where(ConfigBlock.nginx_config_id == source_config_id)
            .order_by(ConfigBlock.sort_order, ConfigBlock.id)
        ).scalars().all()
    )
    child_map: dict[int | None, list[ConfigBlock]] = {}
    for b in rows:
        child_map.setdefault(b.parent_id, []).append(b)
    opt_map: dict[int, list[ConfigOption]] = {}
    if rows:
        ids = [b.id for b in rows]
        for o in db.execute(
            select(ConfigOption).where(ConfigOption.block_id.in_(ids))
        ).scalars().all():
            opt_map.setdefault(o.block_id, []).append(o)
    old_to_new: dict[int, int] = {}

    def add_children(old_parent_id: int | None, new_parent_id: int | None) -> None:
        for b in child_map.get(old_parent_id, []):
            nb = ConfigBlock(
                nginx_config_id=new_config_id,
                parent_id=new_parent_id,
                scope=b.scope,
                header=b.header,
                belongs_to_file=b.belongs_to_file,
                sort_order=b.sort_order,
            )
            db.add(nb)
            db.flush()
            old_to_new[b.id] = nb.id
            for o in opt_map.get(b.id, []):
                db.add(
                    ConfigOption(
                        block_id=nb.id,
                        directive=o.directive,
                        value=o.value,
                        row_type=o.row_type,
                        is_free_text=o.is_free_text,
                        sort_order=o.sort_order,
                    )
                )
            add_children(b.id, nb.id)

    add_children(None, None)
```

**既有列表端点行业过滤改造**：`backend/app/api/nginx.py` 中 `mapping_router / forward_router / biz_router` 由 `_make_router` 工厂生成（全局列表，无过滤）。把这三个路由改为**显式端点**，列表带 `industry_id` 过滤。替换 `nginx.py` 中 `mapping_router = _make_router(...)` 起至文件末尾的全部内容：

```python
def _list_scoped(db: Session, model: type[Base], industry_id: int) -> list[Any]:
    return list(
        db.execute(
            select(model)
            .where(model.industry_id == industry_id)
            .order_by(model.id)
        ).scalars().all()
    )


def _create_scoped(
    db: Session, model: type[Base], payload: BaseModel, detail: str
) -> Any:
    row = model(**payload.model_dump())
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)
    db.refresh(row)
    return row


mapping_router = APIRouter(prefix="/api/domain-mappings", tags=["域名映射"])


@mapping_router.get("", response_model=list[DomainMappingOut])
def list_mappings(
    industry_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[Any]:
    return _list_scoped(db, DomainMapping, industry_id)


@mapping_router.post("", response_model=DomainMappingOut, status_code=status.HTTP_201_CREATED)
def create_mapping(
    payload: DomainMappingCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Any:
    return _create_scoped(db, DomainMapping, payload, "该行业下域名已存在")


@mapping_router.get("/{item_id}", response_model=DomainMappingOut)
def get_mapping(
    item_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Any:
    return _get_by_id(db, DomainMapping, item_id)


@mapping_router.put("/{item_id}", response_model=DomainMappingOut)
def update_mapping(
    item_id: int,
    payload: DomainMappingUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Any:
    row = _get_by_id(db, DomainMapping, item_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@mapping_router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mapping(
    item_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    db.delete(_get_by_id(db, DomainMapping, item_id))
    db.commit()


forward_router = APIRouter(prefix="/api/forward-ports", tags=["转发端口"])


@forward_router.get("", response_model=list[ForwardPortOut])
def list_forward_ports(
    industry_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[Any]:
    return _list_scoped(db, ForwardPort, industry_id)


@forward_router.post("", response_model=ForwardPortOut, status_code=status.HTTP_201_CREATED)
def create_forward_port(
    payload: ForwardPortCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Any:
    return _create_scoped(db, ForwardPort, payload, "转发端口创建失败")


@forward_router.get("/{item_id}", response_model=ForwardPortOut)
def get_forward_port(
    item_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Any:
    return _get_by_id(db, ForwardPort, item_id)


@forward_router.put("/{item_id}", response_model=ForwardPortOut)
def update_forward_port(
    item_id: int,
    payload: ForwardPortUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Any:
    row = _get_by_id(db, ForwardPort, item_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@forward_router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_forward_port(
    item_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    db.delete(_get_by_id(db, ForwardPort, item_id))
    db.commit()


biz_router = APIRouter(prefix="/api/biz-ports", tags=["业务端口"])


@biz_router.get("", response_model=list[BizPortOut])
def list_biz_ports(
    industry_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[Any]:
    return _list_scoped(db, BizPort, industry_id)


@biz_router.post("", response_model=BizPortOut, status_code=status.HTTP_201_CREATED)
def create_biz_port(
    payload: BizPortCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Any:
    return _create_scoped(db, BizPort, payload, "业务端口创建失败")


@biz_router.get("/{item_id}", response_model=BizPortOut)
def get_biz_port(
    item_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Any:
    return _get_by_id(db, BizPort, item_id)


@biz_router.put("/{item_id}", response_model=BizPortOut)
def update_biz_port(
    item_id: int,
    payload: BizPortUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Any:
    row = _get_by_id(db, BizPort, item_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@biz_router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_biz_port(
    item_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    db.delete(_get_by_id(db, BizPort, item_id))
    db.commit()
```

> `Base`、`IntegrityError`、`Any`、三个 Create/Update/Out schema 在 `nginx.py` 顶部已导入（`from app.models.base import Base`、`from sqlalchemy.exc import IntegrityError`、`from typing import Any`、schemas 导入均在）。`_make_router` 工厂若已无调用方可删除；为最小改动保留原函数不动亦可（未使用的工厂不影响运行）。**（推荐删除 `_make_router` 定义以保持整洁；删除后 `Base` 仍被 `_list_scoped` 使用）**

**注意**：三个既有列表端点变为必传 `industry_id`，会破坏外壳②前端 `listDomainMappings()/listForwardPorts()/listBizPorts()` 的无参调用 —— 前端修复在「内页①-前端」计划 T1 处理，本 Task 只做后端。

- [ ] **Step 4: 运行测试确认通过**

Run: `.\.venv\Scripts\python -m pytest tests/test_clone.py -q`
Expected: PASS（5 passed，含新增深拷贝用例）

Run: `.\.venv\Scripts\python -m pytest tests/ -q`
Expected: 全绿（约 70 passed）

- [ ] **Step 5: 提交**

```bash
git add backend/app/services/industry_clone.py backend/app/api/nginx.py backend/tests/test_clone.py
git commit -m "feat(clone): 克隆深拷整棵块树/upstream/映射/转发/业务端口 + 列表端点行业过滤"
```

---

### Task 10: seed 演示数据（模板行业带块树/upstream）+ 端到端校验

**Files:**
- Modify: `backend/app/seed.py`
- Modify: `backend/app/services/nginx_render.py`（若需补 `persist_tree` 已有则不改）
- Test: `backend/tests/test_seed_inner.py`（新建）

- [ ] **Step 1: 写失败测试**

新建 `backend/tests/test_seed_inner.py`：

```python
"""seed 演示数据：persist_tree 落库 + 渲染/拓扑端到端。"""

from app.services.nginx_export import export_config_text
from app.services.nginx_render import (
    build_config_dict,
    parse,
    persist_tree,
    render_config_text,
)
from app.services.nginx_export import export_lines

DEMO = """server {
  listen 443 ssl http2;
  server_name freight.example.com;
  location /api/ {
    proxy_pass http://api_backend;
  }
}
server {
  listen 20551 ssl http2;
  server_name freight.example.com;
  location / {
    proxy_pass http://web_backend;
  }
}
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}
upstream api_backend {
  server 10.0.0.97:8080 weight=5 max_fails=2 fail_timeout=30s;
  server 10.0.0.193:8080 weight=5 max_fails=2 fail_timeout=30s;
  server 10.0.0.18:8080 weight=5 max_fails=2 fail_timeout=30s;
}
upstream web_backend {
  server 10.0.0.97:80;
  server 10.0.0.193:80;
}"""


def test_persist_tree_roundtrip(db_session_factory):
    """parse → persist_tree → build_config_dict → render 往返一致。"""
    from app.models import Industry, NginxConfig

    db = db_session_factory()
    ind = Industry(code="seed", name="种子")
    db.add(ind)
    db.flush()
    cfg = NginxConfig(industry_id=ind.id, name="conf", config_text=DEMO, version=1)
    db.add(cfg)
    db.flush()
    persist_tree(db, cfg.id, parse(DEMO, "http"))

    root = build_config_dict(db, cfg.id, context="conf")
    text = render_config_text(root)
    assert "listen 443 ssl http2;" in text
    assert "server_name freight.example.com;" in text
    assert "default upgrade;" in text
    assert "'' close;" in text
    db.close()


def test_seed_template_blocks_helper(db_session_factory):
    """seed 的块树落库助手：为模板行业配置写入块树，落库后可渲染/导出。"""
    from app.models import Industry, NginxConfig
    from app.seed import seed_template_blocks

    db = db_session_factory()
    ind = Industry(code="overseas_freight", name="海外货运", is_template=True)
    db.add(ind)
    db.flush()
    cfg = NginxConfig(industry_id=ind.id, name="overseas_http", config_text=DEMO, version=1)
    db.add(cfg)
    db.commit()
    seed_template_blocks(db, cfg.id)

    root = build_config_dict(db, cfg.id, context="conf")
    text = render_config_text(root)
    assert "listen 443 ssl http2;" in text
    assert "server_name freight.example.com;" in text
    assert "default upgrade;" in text
    # SSL 关闭导出：丢 ssl_* 并改写 listen
    lines = export_lines(root, ctx="conf", ssl_on=False, dom_new=None, default_ips="", exceptions=[])
    nonssl = "\n".join(l["text"] for l in lines)
    assert "listen 443 http2;" in nonssl
    assert "ssl_certificate" not in nonssl
    db.close()


def test_seed_render_and_export_via_api(client, auth_headers):
    """通过 API 建块树后 render/export 端到端（模拟前端落库路径）。"""
    ind = client.post(
        "/api/industries", json={"code": "seed2", "name": "种子2"}, headers=auth_headers
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "conf", "config_text": DEMO},
        headers=auth_headers,
    ).json()
    root = parse(DEMO, "http")

    def add_children(nodes, parent_id):
        for idx, n in enumerate(nodes):
            created = client.post(
                "/api/config-blocks",
                json={
                    "nginx_config_id": cfg["id"],
                    "parent_id": parent_id,
                    "scope": n["scope"],
                    "header": n.get("header", ""),
                    "sort_order": idx,
                },
                headers=auth_headers,
            ).json()
            for oi, o in enumerate(n.get("options", [])):
                client.post(
                    "/api/config-options",
                    json={
                        "block_id": created["id"],
                        "directive": o["directive"],
                        "value": o["value"],
                        "row_type": "kv",
                        "sort_order": oi,
                    },
                    headers=auth_headers,
                )
            add_children(n.get("children", []), created["id"])

    add_children(root["children"], None)

    r = client.get(f"/api/nginx-configs/{cfg['id']}/render", headers=auth_headers)
    assert r.status_code == 200
    assert "listen 443 ssl http2;" in r.json()["content"]

    exp = client.post(
        f"/api/nginx-configs/{cfg['id']}/export",
        json={
            "ssl_enabled": False,
            "server_name_domain": "new.example.com",
            "upstream_default_ips": "10.8.8.8, 10.8.8.9",
            "upstream_exceptions": [],
            "context": "conf",
        },
        headers=auth_headers,
    )
    assert exp.status_code == 200
    content = exp.json()["content"]
    assert "server_name new.example.com;" in content
    assert "server 10.8.8.8:8080 weight=5 max_fails=2 fail_timeout=30s;" in content
    assert "listen 443 http2;" in content
```

- [ ] **Step 2: 运行测试确认失败**

Run: `.\.venv\Scripts\python -m pytest tests/test_seed_inner.py -q`
Expected: FAIL —— `ImportError: cannot import name 'seed_template_blocks' from 'app.seed'`

- [ ] **Step 3: 实现 seed**

修改 `backend/app/seed.py`：

```python
"""启动初始化：建表 + 演示数据（幂等，已有数据不重复写入）。"""

from sqlalchemy import select

from app.core.logging import logger
from app.core.security import hash_password
from app.database import SessionLocal, engine
from app.models import (
    Base,
    BizPort,
    ConfigBlock,
    ConfigOption,
    DomainMapping,
    ForwardPort,
    Industry,
    Item,
    NginxConfig,
    Upstream,
    UpstreamServer,
    User,
)
from app.services.nginx_render import parse, persist_tree

# 模板行业演示配置（海外货运）：双 server + map + 两个 upstream 组
DEMO_CONF = """server {
  listen 443 ssl http2;
  server_name freight.example.com;
  location /api/ {
    proxy_pass http://api_backend;
  }
}
server {
  listen 20551 ssl http2;
  server_name freight.example.com;
  location / {
    proxy_pass http://web_backend;
  }
}
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}
upstream api_backend {
  server 10.0.0.97:8080 weight=5 max_fails=2 fail_timeout=30s;
  server 10.0.0.193:8080 weight=5 max_fails=2 fail_timeout=30s;
  server 10.0.0.18:8080 weight=5 max_fails=2 fail_timeout=30s;
}
upstream web_backend {
  server 10.0.0.97:80;
  server 10.0.0.193:80;
}"""


def seed_template_blocks(db, config_id: int) -> None:
    """把模板行业演示配置解析为块树并落库（幂等：已有块则跳过）。"""
    exists = db.execute(
        select(ConfigBlock).where(ConfigBlock.nginx_config_id == config_id)
    ).scalars().first()
    if exists is not None:
        return
    persist_tree(db, config_id, parse(DEMO_CONF, "http"))
    logger.info("已写入模板行业块树")


def init_db() -> None:
    """创建所有数据表；用户/模板行业为空时写入演示数据。"""
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        admin = db.execute(
            select(User).where(User.username == "admin")
        ).scalar_one_or_none()
        if admin is None:
            admin = User(
                username="admin",
                email="admin@example.com",
                hashed_password=hash_password("admin123"),
            )
            db.add(admin)
            db.flush()
            db.add_all(
                [
                    Item(title="演示物品 1", description="第一条演示数据", owner_id=admin.id),
                    Item(title="演示物品 2", description="第二条演示数据", owner_id=admin.id),
                ]
            )

        # 模板行业 seed（幂等）
        template_industry = db.execute(
            select(Industry).where(Industry.code == "overseas_freight")
        ).scalar_one_or_none()
        if template_industry is None:
            template_industry = Industry(
                code="overseas_freight",
                name="海外货运",
                owner="张工",
                is_template=True,
            )
            db.add(template_industry)
            db.flush()
            cfg = NginxConfig(
                industry_id=template_industry.id,
                name="overseas_http",
                domain="freight.example.com",
                config_text=DEMO_CONF,
                enabled=True,
                version=1,
            )
            db.add(cfg)
            db.flush()
            seed_template_blocks(db, cfg.id)
            db.add(
                Upstream(industry_id=template_industry.id, name="api_backend", strategy="round_robin", keepalive=32)
            )
            db.add(
                Upstream(industry_id=template_industry.id, name="web_backend", strategy="least_conn", keepalive=16)
            )
            db.add(
                DomainMapping(
                    industry_id=template_industry.id,
                    domain="freight.example.com",
                    forward_tos="https://10.0.0.97:443",
                    description="海外货运主站",
                )
            )
            db.add(
                ForwardPort(
                    industry_id=template_industry.id,
                    listen_port=443,
                    upstream_target="api_backend",
                    service_name="货运 API",
                )
            )
            db.add(
                BizPort(
                    industry_id=template_industry.id,
                    service_name="货运主站",
                    port=8080,
                    public_exposed=True,
                )
            )
            logger.info("已写入演示模板行业 overseas_freight + 1 条 nginx 配置（含块树）")

        db.commit()
        logger.info("演示数据初始化完成")
    finally:
        db.close()
```

> 说明：seed 里两个 `Upstream` 未挂 servers（保持简洁）；若需要可追加 `UpstreamServer`，但 T10 的端到端已由 `seed_template_blocks` + render/export 覆盖。

- [ ] **Step 4: 运行测试确认通过**

Run: `.\.venv\Scripts\python -m pytest tests/test_seed_inner.py -q`
Expected: PASS（3 passed）

Run: `.\.venv\Scripts\python -m pytest tests/ -q`
Expected: 全绿（约 73 passed）

**手工端到端（需先删库重建 schema）：**
1. 删除开发库：`Remove-Item backend\test_system.db -ErrorAction SilentlyContinue`（PowerShell）
2. 启动后端（`dangerouslyDisableSandbox=true`）：`.\.venv\Scripts\python -m uvicorn app.main:app --port 8001`
3. 登录拿 token 后请求：`GET /api/nginx-configs?industry_id=1` → 拿到模板行业配置 id；`GET /api/nginx-configs/{id}/tree` → 有 blocks；`GET /api/nginx-configs/{id}/render` → 文本含 `listen 443 ssl http2;`

- [ ] **Step 5: 提交**

```bash
git add backend/app/seed.py backend/tests/test_seed_inner.py
git commit -m "feat(seed): 模板行业演示块树/upstream/映射/转发/业务端口 + seed_template_blocks"
```

---

## 自审记录（Self-Review）

- **Spec 覆盖（2026-10-08 §3/§4 + 2026-10-13 §4/§6）**：§3 四张新表（T1）、forward_ports.upstream_id（T1）、upstreams/servers CRUD + preview（T2）、config-blocks/options CRUD + children + 树端点 + default 置底（T3）、render（T4）、export（T5）、forward test / config reload / upstream validate / config validate（T6）、topology（T7）、directives（T8）、克隆深拷（T9）、seed（T10）。§4「GET /api/nginx-configs/{id} 返回其块树」以 `GET /{id}/tree` 实现（避免与既有详情端点冲突）；「blocks/{id}/children 取子块」已实现。安全（§10 + 外壳 §10②）：subprocess 参数数组 + 临时文件 + 路径白名单 + SSRF 内网白名单 + validate/reload 不把内容拼 shell。
- **占位扫描**：无 TODO/TBD；每步含完整代码与期望输出。
- **类型一致**：`build_config_dict`/`render_config_text`/`export_lines` 签名在 T4/T5/T7/T10 一致；`up_key_of(n, ctx)` 形参顺序与调用一致；`dom_parse` 返回 `list[str]`；export 的 `exceptions` 统一为 `list[dict]`（端点用 `e.model_dump()`）。
- **遗留提醒（非阻塞）**：T9 把 mapping/forward/biz 三个列表端点改为必传 `industry_id`，前端 `api/nginx.js` 无参调用会在「内页①-前端」T1 一并修复。
