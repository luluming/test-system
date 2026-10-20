# 多行业外壳（登录 + 行业管理 + 模板克隆 + 并发）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 nginx 运维控制台之上，实现「登录后行业管理落地页 + 多行业数据隔离 + 模板克隆（事务深拷贝）+ 乐观版本冲突 / 编辑租约」，即 spec `2026-10-13-multi-industry-template-design.md` 的**外壳层**。

**Architecture:** 后端为 FastAPI + SQLAlchemy(create_all 建表、无迁移)，认证沿用既有 JWT Bearer + 验证码。新增 `industries` 表承接行业基础信息；`nginx_configs` 增加 `industry_id`(FK) + `(industry_id,name)` 唯一 + `version/updated_at` + 编辑租约列；克隆走独立 service 封装事务深拷贝（本阶段仅深拷 `nginx_configs`，`config_blocks` 块树暂不存在，由「内页①」计划扩展同一 service）。前端（React + Vite，无测试框架）新增 `ThemeProvider`、`IndustryDashboard`、`IndustryCloneModal`、行业作用域 API 封装，并把登录落地页改指向 `/industries`。

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy 2.0 / SQLite / pytest / React 18 / React Router / Axios / 纯 CSS 变量（不含第三方图标库）。

> **范围边界（重要）**：本计划只做**外壳②**。行业内的逐行业控制台（BlockTree / 拓扑 / 业务端口 / 导出替换，即方案C）尚未在 React 实现，属「内页①」计划。本计划中「进入」按钮跳转到 `/ops/:industryId` 的一个**最小行业概览页**（列出该行业的 `nginx_configs` 及其 `version`，仅用于验证行业作用域与版本字段端到端打通）；完整的编辑冲突弹窗在「内页①」实现。前端项目当前**没有自动化测试**，前端任务以 `npm run build` 通过 + 浏览器冒烟为准；后端全部走 pytest TDD。

---

## File Structure

**后端（Create）**
- `backend/app/models/industry.py` — 新增 `Industry` ORM（行业表）
- `backend/app/schemas/industry.py` — 行业 Pydantic（Create/Update/Out）
- `backend/app/schemas/nginx.py` — 修改（industry_id/version/base_version）
- `backend/app/services/industry_clone.py` — 克隆事务深拷贝 service
- `backend/app/services/leases.py` — 编辑租约工具函数（TTL 判定）
- `backend/app/middleware/security_headers.py` — CSP 等安全响应头中间件
- `backend/app/api/industries.py` — 行业 CRUD + clone 端点
- `backend/app/api/nginx.py` — 修改 nginx_configs 为行业作用域 + version/409 + heartbeat/release

**后端（Modify）**
- `backend/app/models/nginx.py` — NginxConfig 加 industry_id/version/updated_at/edit_holder/edit_heartbeat_at
- `backend/app/models/__init__.py` — 注册 Industry
- `backend/app/main.py` — 注册 security 中间件与 industries 路由
- `backend/app/seed.py` — 幂等 seed 一个模板行业（overseas_freight）+ 演示 nginx_config
- `backend/tests/test_industries.py` — 行业 CRUD + 校验（New）
- `backend/tests/test_clone.py` — 克隆深拷贝（New）
- `backend/tests/test_nginx_industry.py` — 行业作用域 + 版本冲突 409（New）
- `backend/tests/test_lease.py` — 编辑租约（New）
- `backend/tests/test_security_headers.py` — 安全响应头（New）

**前端（Create）**
- `frontend/src/theme/theme.css` — 三套 CSS 变量（纯黑/软深/浅色）+ 基础公共 token
- `frontend/src/theme/ThemeProvider.jsx` — 读 localStorage 切 `data-theme`
- `frontend/src/pages/IndustryDashboard.jsx` — 行业管理落地页（Linear 行列表 + KPI + 主题切换）
- `frontend/src/pages/IndustryCloneModal.jsx` — 「新建行业（模板克隆）」弹窗
- `frontend/src/pages/IndustryDetail.jsx` — 最小行业概览页（/ops/:industryId）
- `frontend/src/api/industry.js` — 行业 CRUD + clone 客户端
- `frontend/src/api/concurrency.js` — base_version 提交 + 409 处理 + heartbeat/release 客户端
- `frontend/src/pages/dashboard.css` — 落地页样式

**前端（Modify）**
- `frontend/src/api/nginx.js` — nginx_configs 客户端加 industryId 过滤与 version 透传
- `frontend/src/App.jsx` — 登录落地跳 `/industries`、新增路由、导航接通

> **约定**：后端测试运行目录为 `backend`，命令用 `..\.venv\Scripts\python -m pytest`（Windows）。前端验证用 `npm run build`。每个后端 Task 遵循「写失败测试 → 跑失败 → 最小实现 → 跑过 → 提交」。

---

## Task 1: （后端）industries 行业表 ORM + 注册 + CRUD API + 输入校验

**Files:**
- Create: `backend/app/models/industry.py`
- Create: `backend/app/schemas/industry.py`
- Create: `backend/app/api/industries.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_industries.py`

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_industries.py
"""行业 CRUD 与输入校验测试。"""
import pytest


def test_create_industry_requires_auth(client):
    """未携带 token 创建行业返回 401。"""
    resp = client.post("/api/industries", json={"code": "taxi", "name": "出租"})
    assert resp.status_code == 401


def test_industry_crud_roundtrip(client, auth_headers):
    """登录后可新建/列表/更新/删除行业，且响应含克隆与时间字段。"""
    r = client.post(
        "/api/industries",
        json={"code": "overseas_freight", "name": "海外货运", "owner": "张工"},
        headers=auth_headers,
    )
    assert r.status_code == 201
    body = r.json()
    assert body["code"] == "overseas_freight"
    assert body["name"] == "海外货运"
    assert body["is_template"] is False
    assert body["cloned_from_id"] is None
    assert "created_at" in body and "updated_at" in body
    industry_id = body["id"]

    listing = client.get("/api/industries", headers=auth_headers).json()
    assert any(i["id"] == industry_id for i in listing)

    upd = client.put(
        f"/api/industries/{industry_id}",
        json={"is_template": True},
        headers=auth_headers,
    )
    assert upd.status_code == 200
    assert upd.json()["is_template"] is True

    assert (
        client.delete(f"/api/industries/{industry_id}", headers=auth_headers).status_code
        == 204
    )


def test_industry_code_duplicate(client, auth_headers):
    """重复行业 code 返回 409。"""
    payload = {"code": "fulu", "name": "福禄"}
    assert client.post("/api/industries", json=payload, headers=auth_headers).status_code == 201
    dup = client.post("/api/industries", json=payload, headers=auth_headers)
    assert dup.status_code == 409


def test_industry_code_invalid_format(client, auth_headers):
    """行业 code 只允许小写字母数字下划线；非法返回 422。"""
    for bad in ["Overseas", "overseas freight", "海外", "a#", "x/y", ""]:
        resp = client.post(
            "/api/industries", json={"code": bad, "name": "名"}, headers=auth_headers
        )
        assert resp.status_code == 422, f"code={bad!r} 应被拒绝"


def test_industry_name_length(client, auth_headers):
    """行业名长度越界返回 422，正常长度返回 201。"""
    ok = client.post(
        "/api/industries", json={"code": "normal", "name": "正常行业"}, headers=auth_headers
    )
    assert ok.status_code == 201
    bad = client.post(
        "/api/industries",
        json={"code": "toolong", "name": "x" * 51},
        headers=auth_headers,
    )
    assert bad.status_code == 422
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_industries.py -q
```

Expect: collection error / ImportError（`app.models.industry` 不存在）。

- [ ] **Step 3: 最小实现**

`backend/app/models/industry.py`:

```python
"""行业 ORM 模型。"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Industry(Base):
    """行业基础信息：模板源标记 + 克隆溯源（多层可自引用）。"""

    __tablename__ = "industries"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    code: Mapped[str] = mapped_column(
        String(50), unique=True, index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    owner: Mapped[str | None] = mapped_column(String(50), nullable=True)
    remark: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_template: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    cloned_from_id: Mapped[int | None] = mapped_column(
        ForeignKey("industries.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
```

`backend/app/schemas/industry.py`:

```python
"""行业相关 Pydantic 模型（请求/响应）。"""
from datetime import datetime
import re

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 行业 code 白名单：小写字母、数字、下划线，长度 1-50
_CODE_RE = re.compile(r"^[a-z0-9_]+$")


class IndustryCreate(BaseModel):
    """新建行业请求。"""

    code: str = Field(min_length=1, max_length=50)
    name: str = Field(min_length=1, max_length=50)
    owner: str | None = Field(default=None, max_length=50)
    remark: str | None = Field(default=None, max_length=255)
    is_template: bool = False

    @field_validator("code")
    @classmethod
    def _code_must_be_slug(cls, v: str) -> str:
        if not _CODE_RE.match(v):
            raise ValueError("行业 code 仅允许小写字母、数字与下划线")
        return v


class IndustryUpdate(BaseModel):
    """更新行业请求（字段可选）。"""

    name: str | None = Field(default=None, min_length=1, max_length=50)
    owner: str | None = Field(default=None, max_length=50)
    remark: str | None = Field(default=None, max_length=255)
    is_template: bool | None = None

    @field_validator("name", "owner", mode="before")
    @classmethod
    def _strip_empty(cls, v):
        return v if v not in (None, "") else None


class IndustryOut(BaseModel):
    """行业响应。"""

    id: int
    code: str
    name: str
    owner: str | None
    remark: str | None
    is_template: bool
    cloned_from_id: int | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
```

`backend/app/api/industries.py`:

```python
"""行业基础信息 CRUD + 模板克隆端点（均需登录）。"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.security import get_current_user
from app.models.industry import Industry
from app.models.user import User
from app.schemas.industry import IndustryCreate, IndustryOut, IndustryUpdate
from app.services.industry_clone import clone_industry

router = APIRouter(prefix="/api/industries", tags=["行业"])


def _get_industry(db: Session, industry_id: int) -> Industry:
    row = db.execute(
        select(Industry).where(Industry.id == industry_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="行业不存在")
    return row


@router.get("", response_model=list[IndustryOut])
def list_industries(
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[Industry]:
    return list(db.execute(select(Industry).order_by(Industry.id)).scalars().all())


@router.post("", response_model=IndustryOut, status_code=status.HTTP_201_CREATED)
def create_industry(
    payload: IndustryCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Industry:
    row = Industry(**payload.model_dump())
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="行业 code 已存在")
    db.refresh(row)
    return row


@router.get("/{industry_id}", response_model=IndustryOut)
def get_industry(
    industry_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Industry:
    return _get_industry(db, industry_id)


@router.put("/{industry_id}", response_model=IndustryOut)
def update_industry(
    industry_id: int,
    payload: IndustryUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Industry:
    row = _get_industry(db, industry_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{industry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_industry(
    industry_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    db.delete(_get_industry(db, industry_id))
    db.commit()


# 模板克隆端点由 Task 6 实现并挂载于此模块，此处暂先占位以保持路由注册到位：
@router.post("/clone", response_model=IndustryOut, status_code=status.HTTP_201_CREATED)
def _clone_endpoint_stub(  # pragma: no cover - Task 6 替换为真实实现
    payload: Any, db: Session, _current_user: User
) -> Industry:  # 实现在 Task 6 完成
    raise NotImplementedError
```

> 注意：Task 6 会**移除**上面的 `_clone_endpoint_stub`，改为真实 clone 端点。此处仅让 `/clone` 路由在 CRUD 落地后即存在，避免后续单测撞路由顺序。

`backend/app/models/__init__.py`:

```python
"""ORM 模型包。"""

from app.models.base import Base
from app.models.industry import Industry
from app.models.item import Item
from app.models.nginx import BizPort, DomainMapping, ForwardPort, NginxConfig
from app.models.user import User

__all__ = [
    "Base",
    "User",
    "Item",
    "Industry",
    "NginxConfig",
    "DomainMapping",
    "ForwardPort",
    "BizPort",
]
```

`backend/app/main.py` 在 import 区加入 industries 路由（修改两处）：

```python
from app.api.auth import router as auth_router
from app.api.items import router as items_router
from app.api.industries import router as industries_router
from app.api.nginx import (
    biz_router,
    forward_router,
    mapping_router,
    nginx_router,
)
```
并在路由注册区追加：

```python
app.include_router(auth_router)
app.include_router(items_router)
app.include_router(industries_router)
app.include_router(nginx_router)
```

> 上述 `app.include_router(industries_router)` 依赖 `backend/app/services/industry_clone.py` 的 `clone_industry`。Task 6 之前该模块不存在，因此本 Task 的 `app/api/industries.py` import 会先失败。为让 Step 3 编译通过，先创建最小 `commit`（Task 6 再补内容）：

`backend/app/services/industry_clone.py`（暂存骨架）：

```python
"""行业克隆事务 service（Task 6 补齐深拷贝实现）。"""


def clone_industry(db, *, source_industry_id: int, name: str, owner: str | None):
    """Task 6 实现：事务内深拷贝 source_industry 为 name 新行业并返回。"""
    raise NotImplementedError
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_industries.py -q
```

Expect: `5 passed, 0 failed`（clone stub 与本 Task 无关，未测）。

- [ ] **Step 5: 提交**

```bash
git add backend/app/models/industry.py backend/app/schemas/industry.py \
        backend/app/api/industries.py backend/app/services/industry_clone.py \
        backend/app/models/__init__.py backend/app/main.py backend/tests/test_industries.py
git commit -m "feat: 行业基础信息 ORM/CRUD/输入校验"
```

---

## Task 2: （后端）nginx_configs 加行业作用域 + 乐观版本 + 编辑租约列

**Files:**
- Modify: `backend/app/models/nginx.py`
- Modify: `backend/app/schemas/nginx.py`

- [ ] **Step 1: 写失败测试（先行验证模型暴露行业/版本字段）**

```python
# backend/tests/test_nginx_industry.py
"""nginx_configs 行业作用域 / 版本冲突 / 租约测试（本 Task 覆盖模型字段部分）。"""


def test_nginx_config_has_industry_and_version(client, auth_headers):
    """创建行业与配置后，配置响应含 industry_id 与 version。"""
    ind = client.post(
        "/api/industries",
        json={"code": "overseas_freight", "name": "海外货运"},
        headers=auth_headers,
    ).json()
    r = client.post(
        "/api/nginx-configs",
        json={
            "industry_id": ind["id"],
            "name": "overseas_http",
            "domain": "freight.example.com",
            "config_text": "server { listen 80; }",
        },
        headers=auth_headers,
    )
    assert r.status_code == 201
    body = r.json()
    assert body["industry_id"] == ind["id"]
    assert body["version"] == 1
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_nginx_industry.py::test_nginx_config_has_industry_and_version -q
```

Expect: 400/422（`industry_id`/`version` 响应字段缺失或模型列缺失）。

- [ ] **Step 3: 修改模型与 schema**

`backend/app/models/nginx.py` 的 `NginxConfig` 改写为：

```python
class NginxConfig(Base):
    """nginx 服务器配置记录（按行业作用域，含乐观版本与编辑租约）。"""

    __tablename__ = "nginx_configs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    domain: Mapped[str | None] = mapped_column(String(255), nullable=True)
    config_text: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # 乐观锁：每次成功写入自增；创建默认为 1
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    # 编辑会话租约：唯一持有者标记 + 心跳时间（可为空表示无编辑者）
    edit_holder: Mapped[str | None] = mapped_column(String(50), nullable=True)
    edit_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    __table_args__ = (UniqueConstraint("industry_id", "name", name="uq_nginx_config_industry_name"),)
```

`backend/app/models/nginx.py` 顶部 import 增加：

```python
from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
```

`backend/app/schemas/nginx.py` 中 `NginxConfig` 三个模型改写：

```python
class NginxConfigCreate(BaseModel):
    """创建 nginx 配置请求（必须指定所属行业）。"""

    industry_id: int
    name: str = Field(min_length=1, max_length=100)
    domain: str | None = Field(default=None, max_length=255)
    config_text: str
    enabled: bool = True


class NginxConfigOut(BaseModel):
    """nginx 配置响应（含行业与版本）。"""

    id: int
    industry_id: int
    name: str
    domain: str | None
    config_text: str
    enabled: bool
    version: int
    updated_at: datetime
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class NginxConfigUpdate(BaseModel):
    """更新 nginx 配置请求：携带 base_version 做乐观锁。"""

    name: str | None = Field(default=None, max_length=100)
    domain: str | None = Field(default=None, max_length=255)
    config_text: str | None = None
    enabled: bool | None = None
    base_version: int
```

`backend/app/schemas/nginx.py` 顶部 import 增加 `from pydantic import BaseModel, ConfigDict, Field`（替换现有 `from pydantic import BaseModel, ConfigDict`）。

- [ ] **Step 4: 跑测试验证通过**

> 注意：`Task 3` 会把 `nginx_configs` 改为行业作用域路由，Step 3 模型改动后 `Task 2` 的测试依赖 `POST /api/nginx-configs` 接受 `industry_id` 并回传 `version`。因此 **Task 2 与 Task 3 必须连续完成后再统一跑测试**。此处先做静态确认模型可被 `Base.metadata` 识别：

```bash
cd backend
..\.venv\Scripts\python -c "from app.models import NginxConfig, Industry; print([c.name for c in NginxConfig.__table__.columns])"
```

Expect: 打印含 `industry_id`、`version`、`updated_at`、`edit_holder`、`edit_heartbeat_at`。

- [ ] **Step 5: 提交**

```bash
git add backend/app/models/nginx.py backend/app/schemas/nginx.py backend/tests/test_nginx_industry.py
git commit -m "feat: nginx_configs 增加行业作用域/乐观版本/编辑租约列"
```

---

## Task 3: （后端）nginx_configs 行业作用域路由 + 版本冲突 409

**Files:**
- Modify: `backend/app/api/nginx.py`（把 nginx_configs 从工厂拆出为专用路由）
- Modify: `backend/app/main.py`

- [ ] **Step 1: 写失败测试**

`backend/tests/test_nginx_industry.py` 追加：

```python
def _mk_industry(client, auth_headers, code):
    return client.post(
        "/api/industries", json={"code": code, "name": code}, headers=auth_headers
    ).json()


def test_nginx_configs_scoped_by_industry(client, auth_headers):
    """列表按 industry_id 过滤，跨行业互不可见。"""
    a = _mk_industry(client, auth_headers, "alpha")
    b = _mk_industry(client, auth_headers, "beta")
    for ind, n in ((a, "a_cfg"), (b, "b_cfg")):
        client.post(
            "/api/nginx-configs",
            json={"industry_id": ind["id"], "name": n, "config_text": "server{}"},
            headers=auth_headers,
        )
    la = client.get(f"/api/nginx-configs?industry_id={a['id']}", headers=auth_headers).json()
    assert [c["name"] for c in la] == ["a_cfg"]
    lb = client.get(f"/api/nginx-configs?industry_id={b['id']}", headers=auth_headers).json()
    assert [c["name"] for c in lb] == ["b_cfg"]


def test_nginx_config_name_unique_per_industry(client, auth_headers):
    """同行业重名 409；不同行业同名允许。"""
    a = _mk_industry(client, auth_headers, "ca")
    b = _mk_industry(client, auth_headers, "cb")
    base = {"config_text": "server{}"}
    assert client.post("/api/nginx-configs", json={**base, "industry_id": a["id"], "name": "x"}, headers=auth_headers).status_code == 201
    assert client.post("/api/nginx-configs", json={**base, "industry_id": a["id"], "name": "x"}, headers=auth_headers).status_code == 409
    assert client.post("/api/nginx-configs", json={**base, "industry_id": b["id"], "name": "x"}, headers=auth_headers).status_code == 201


def test_nginx_config_update_version_conflict_409(client, auth_headers):
    """base_version 与当前不一致返回 409，不覆盖。"""
    ind = _mk_industry(client, auth_headers, "cc")
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "c", "config_text": "v1"},
        headers=auth_headers,
    ).json()
    # 第一次提交：基于 version 1 成功，version 变 2
    ok = client.put(
        f"/api/nginx-configs/{cfg['id']}",
        json={"config_text": "v2", "base_version": 1},
        headers=auth_headers,
    )
    assert ok.status_code == 200 and ok.json()["version"] == 2
    # 第二次提交仍带旧 base_version 1 → 409
    conflict = client.put(
        f"/api/nginx-configs/{cfg['id']}",
        json={"config_text": "v3", "base_version": 1},
        headers=auth_headers,
    )
    assert conflict.status_code == 409
    # 数据未被覆盖
    detail = client.get(f"/api/nginx-configs/{cfg['id']}", headers=auth_headers).json()
    assert detail["config_text"] == "v2"
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_nginx_industry.py -q
```

Expect: `test_nginx_configs_scoped_by_industry` 等因列表不过滤 industry / update 无 base_version 校验而失败。

- [ ] **Step 3: 实现 nginx_configs 专用路由**

`backend/app/api/nginx.py` 顶部新增 import，并把 `nginx_router` 改为专用路由；其余三个资源仍走工厂。

在 `_make_router` 定义与四个 `router` 定义之间，插入：

```python
from sqlalchemy.exc import IntegrityError

config_router = APIRouter(prefix="/api/nginx-configs", tags=["nginx 配置"])


def _get_config(db: Session, config_id: int) -> NginxConfig:
    row = db.execute(select(NginxConfig).where(NginxConfig.id == config_id)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="配置不存在")
    return row


@config_router.get("", response_model=list[NginxConfigOut])
def list_configs(
    industry_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[NginxConfig]:
    return list(
        db.execute(
            select(NginxConfig)
            .where(NginxConfig.industry_id == industry_id)
            .order_by(NginxConfig.id)
        ).scalars().all()
    )


@config_router.post("", response_model=NginxConfigOut, status_code=status.HTTP_201_CREATED)
def create_config(
    payload: NginxConfigCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> NginxConfig:
    row = NginxConfig(**payload.model_dump(), version=1)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该行业下配置名已存在")
    db.refresh(row)
    return row


@config_router.get("/{config_id}", response_model=NginxConfigOut)
def get_config(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> NginxConfig:
    return _get_config(db, config_id)


@config_router.put("/{config_id}", response_model=NginxConfigOut)
def update_config(
    config_id: int,
    payload: NginxConfigUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> NginxConfig:
    row = _get_config(db, config_id)
    if row.version != payload.base_version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "VERSION_CONFLICT", "message": "内容已变更，请加载最新并保留你的改动为对比草案，或放弃改动", "current_version": row.version},
        )
    for field, value in payload.model_dump(exclude={"base_version"}).items():
        if value is not None:
            setattr(row, field, value)
    row.version += 1
    db.commit()
    db.refresh(row)
    return row


@config_router.delete("/{config_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_config(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    db.delete(_get_config(db, config_id))
    db.commit()
```

然后**删除**原来由工厂生成的 `nginx_router = _make_router(model=NginxConfig, ...)` 段落（保留 factory 供另三个资源使用）。保留 `nginx_router` 变量名指向 `config_router`，避免改 main.py 引用：

```python
nginx_router = config_router
```

`backend/app/api/nginx.py` 顶部的 `NginxConfig` import 不变；`NginxConfigCreate/Update/Out` 已由 Task 2 扩展。

- [ ] **Step 4: 跑测试验证通过**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_nginx_industry.py -q
```

Expect: 全部通过（含 `test_nginx_config_has_industry_and_version`）。

- [ ] **Step 5: 提交**

```bash
git add backend/app/api/nginx.py backend/tests/test_nginx_industry.py
git commit -m "feat: nginx_configs 按行业过滤 + 乐观版本冲突 409"
```

---

## Task 4: （后端）编辑会话租约（heartbeat / release / 超时接管）

**Files:**
- Create: `backend/app/services/leases.py`
- Modify: `backend/app/api/nginx.py`（追加 heartbeat / release 端点）
- Test: `backend/tests/test_lease.py`

**设计**：租约状态落在 `nginx_configs.edit_holder` + `edit_heartbeat_at` 上。TTL 10 分钟。
- `POST /api/nginx-configs/{id}/edit-heartbeat`，体 `{holder}`：若 `edit_holder` 为空或超时，则授予/接管并将 holder 置为调用者；若被他人持有且未超时 → `423`。
- `POST /api/nginx-configs/{id}/edit-release`，体 `{holder}`：仅当 holder==调用者时清空。

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_lease.py
"""编辑会话租约测试：授予 / 拒夺 / 超时接管 / 释放。"""
from app.services.leases import LEASE_TTL_SECONDS, is_lease_expired, now_utc
from datetime import timedelta


def _cfg(client, auth_headers, code):
    ind = client.post("/api/industries", json={"code": code, "name": code}, headers=auth_headers).json()
    return client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "cfg", "config_text": "server{}"},
        headers=auth_headers,
    ).json()


def _heartbeat(client, cfg_id, holder):
    return client.post(
        f"/api/nginx-configs/{cfg_id}/edit-heartbeat",
        json={"holder": holder},
        headers=auth_headers(),
    )


def test_grant_then_block_other_holder(client, auth_headers):
    cfg = _cfg(client, auth_headers, "la")
    assert _heartbeat(client, cfg["id"], "alice").status_code == 200
    blocked = _heartbeat(client, cfg["id"], "bob")
    assert blocked.status_code == 423


def test_force_stale_lease(client, auth_headers):
    cfg = _cfg(client, auth_headers, "lb")
    assert _heartbeat(client, cfg["id"], "alice").status_code == 200
    # 手动把心跳时间拨到 TTL 之前 → 视为过期，bob 可接管
    from app.main import app as _app
    from app.api.deps import get_db
    from sqlalchemy import select, update
    # 直接改库（TestClient 内同一 DB 会话）
    db = next(get_db())
    try:
        db.execute(update(NginxConfig).where(NginxConfig.id == cfg["id"]).values(
            edit_heartbeat_at=now_utc() - timedelta(seconds=LEASE_TTL_SECONDS + 60)))
        db.commit()
    finally:
        db.close()
    assert _heartbeat(client, cfg["id"], "bob").status_code == 200


def test_release_clears_holder(client, auth_headers):
    cfg = _cfg(client, auth_headers, "lc")
    _heartbeat(client, cfg["id"], "alice")
    rel = client.post(
        f"/api/nginx-configs/{cfg['id']}/edit-release",
        json={"holder": "alice"},
        headers=auth_headers,
    )
    assert rel.status_code == 200
    # 释放后其他 holder 可获取
    assert _heartbeat(client, cfg["id"], "bob").status_code == 200


def test_lease_expiry_helper():
    """纯函数：is_lease_expired 对空与过期返回 True，新鲜返回 False。"""
    assert is_lease_expired(None) is True
    assert is_lease_expired(now_utc() - timedelta(seconds=LEASE_TTL_SECONDS + 1)) is True
    assert is_lease_expired(now_utc()) is False
```

> 说明：`_heartbeat` 里 `auth_headers()` 传的是 fixture 函数对象（`client` fixture 在同一测试里已用参数解包）。为简洁，测试内统一改用模块级捕获：把 `_heartbeat` 改为接收 `headers` 形参，调用处传 `auth_headers`。**最终以 Step 2 实测为准**。为消除歧义，下面给出修正版（Step 1 的可运行形态）：

```python
def _heartbeat(client, headers, cfg_id, holder):
    return client.post(
        f"/api/nginx-configs/{cfg_id}/edit-heartbeat",
        json={"holder": holder},
        headers=headers,
    )
```
各用例以 `hdrs = auth_headers` 开头并传 `_heartbeat(client, hdrs, ...)`。

（`test_force_stale_lease` 需要 `NginxConfig` 与 `get_db` import，见 Step 3 服务层后统一补齐 import 头；测试文件顶部应含：

```python
from app.models.nginx import NginxConfig
from sqlalchemy import update
)
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_lease.py -q
```

Expect: `ImportError`（`app.services.leases` 不存在）→ 端点 422/404（未注册路由）。

- [ ] **Step 3: 实现租约工具 + 端点**

`backend/app/services/leases.py`:

```python
"""编辑会话租约工具：心跳 TTL 判定（纯函数，便于单测）。"""
from datetime import datetime, timezone, timedelta

LEASE_TTL_SECONDS = 600  # 默认 10 分钟


def now_utc() -> datetime:
    """返回当前 UTC 时间（naive）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def is_lease_expired(heartbeat_at: datetime | None) -> bool:
    """心跳为空或距最后心跳超过 TTL 视为过期（可被接管）。"""
    if heartbeat_at is None:
        return True
    return (now_utc() - heartbeat_at) > timedelta(seconds=LEASE_TTL_SECONDS)
```

`backend/app/api/nginx.py` 追加租约端点（放在 `config_router` 定义之后、`nginx_router = config_router` 之前）：

```python
class LeaseBody(BaseModel):
    holder: str


@config_router.post("/{config_id}/edit-heartbeat", response_model=NginxConfigOut)
def edit_heartbeat(
    config_id: int,
    payload: LeaseBody,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> NginxConfig:
    row = _get_config(db, config_id)
    if (
        row.edit_holder is not None
        and row.edit_holder != payload.holder
        and not is_lease_expired(row.edit_heartbeat_at)
    ):
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail={"code": "LEASE_HELD", "holder": row.edit_holder, "message": "该配置正被他人编辑中，可稍后重试或强制接管"},
        )
    # 授予本人 / 接接过期或空租约
    row.edit_holder = payload.holder
    row.edit_heartbeat_at = now_utc()
    db.commit()
    db.refresh(row)
    return row


@config_router.post("/{config_id}/edit-release")
def edit_release(
    config_id: int,
    payload: LeaseBody,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    row = _get_config(db, config_id)
    if row.edit_holder == payload.holder:
        row.edit_holder = None
        row.edit_heartbeat_at = None
        db.commit()
    return {"message": "释放成功"}
```

`backend/app/api/nginx.py` 顶部 import 增加：

```python
from app.services.leases import is_lease_expired, now_utc
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_lease.py -q
```

Expect: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add backend/app/services/leases.py backend/app/api/nginx.py backend/tests/test_lease.py
git commit -m "feat: 编辑会话租约 heartbeat/release/超时接管"
```

---

## Task 5: （后端）模板克隆（事务深拷贝）

**Files:**
- Modify: `backend/app/services/industry_clone.py`（补真实实现）
- Modify: `backend/app/api/industries.py`（替换 stub 为真实 clone 端点 + schema）
- Create: `backend/app/schemas/industry.py`（加 `CloneIndustryRequest`）
- Test: `backend/tests/test_clone.py`

**克隆内容**：事务内新建 `Industry`（`is_template=False`、`cloned_from_id=源`），同时深拷源行业全部 `NginxConfig`（新 `config_text`/字段，`version=1`、重新赋值 `industry_id`）。`config_blocks` 等块树由「内页①」计划扩展此 service。

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_clone.py
"""模板克隆事务深拷贝测试。"""


def test_clone_requires_auth(client):
    """未登录克隆返回 401。"""
    resp = client.post("/api/industries/clone", json={"source_industry_id": 1, "name": "x"})
    assert resp.status_code == 401


def _seed_source(client, headers):
    src = client.post(
        "/api/industries",
        json={"code": "overseas_freight", "name": "海外货运", "owner": "张工", "is_template": True},
        headers=headers,
    ).json()
    for n in ("overseas_http", "overseas_https"):
        client.post(
            "/api/nginx-configs",
            json={"industry_id": src["id"], "name": n, "config_text": f'server {{ listen {80 if n.endswith("http") else 443}; }}'},
            headers=headers,
        )
    return src


def test_clone_deep_copies_and_independent(client, auth_headers):
    """克隆后新行业配置计数一致、cloned_from_id 正确、且编辑互不影响。"""
    hdrs = auth_headers
    src = _seed_source(client, hdrs)
    r = client.post(
        "/api/industries/clone",
        json={"source_industry_id": src["id"], "name": "国内", "owner": "李工"},
        headers=hdrs,
    )
    assert r.status_code == 201
    new = r.json()
    assert new["cloned_from_id"] == src["id"]
    assert new["is_template"] is False

    src_cfgs = client.get(f"/api/nginx-configs?industry_id={src['id']}", headers=hdrs).json()
    new_cfgs = client.get(f"/api/nginx-configs?industry_id={new['id']}", headers=hdrs).json()
    assert len(new_cfgs) == len(src_cfgs) == 2
    assert {c["name"] for c in new_cfgs} == {"overseas_http", "overseas_https"}
    assert all(c["version"] == 1 for c in new_cfgs)
    assert all(c["industry_id"] == new["id"] for c in new_cfgs)

    # 独立：改克隆后源不受影响
    target = next(c for c in new_cfgs if c["name"] == "overseas_http")
    client.put(
        f"/api/nginx-configs/{target['id']}",
        json={"config_text": "modified", "base_version": 1},
        headers=hdrs,
    )
    src_again = client.get(f"/api/nginx-configs?industry_id={src['id']}", headers=hdrs).json()
    src_http = next(c for c in src_again if c["name"] == "overseas_http")
    assert src_http["config_text"] != "modified"


def test_clone_missing_source_404(client, auth_headers):
    """源行业不存在返回 404。"""
    resp = client.post(
        "/api/industries/clone",
        json={"source_industry_id": 9999, "name": "x"},
        headers=auth_headers,
    )
    assert resp.status_code == 404


def test_clone_duplicate_name_conflict(client, auth_headers):
    """克隆目标行业 code 派生自 name，重名冲突返回 409。"""
    hdrs = auth_headers
    src = _seed_source(client, hdrs)
    body = {"source_industry_id": src["id"], "name": "海外货运"}
    assert client.post("/api/industries/clone", json=body, headers=hdrs).status_code == 201
    assert client.post("/api/industries/clone", json=body, headers=hdrs).status_code == 409
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_clone.py -q
```

Expect: 端点 500（stub 抛 NotImplementedError）。

- [ ] **Step 3: 实现克隆 service + 端点**

`backend/app/services/industry_clone.py` 全文替换为：

```python
"""行业克隆事务 service：把源行业整套 NginxConfig 深拷贝到新行业。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.industry import Industry
from app.models.nginx import NginxConfig
from app.schemas.industry import CloneIndustryRequest


def derive_code(name: str) -> str:
    """由行业名派生唯一 code：转小写、空白转下划线、去非法字符，截断 40。"""
    code = "_".join(part for part in name.lower().split() if part)
    code = "".join(c for c in code if c.isalnum() or c == "_")
    return (code or "industry")[:40]


def clone_industry(
    db: Session, *, payload: CloneIndustryRequest
) -> Industry:
    """事务内新建行业并深拷源行业全部 NginxConfig；任一步失败整体回滚。"""
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
    db.flush()  # 生成 new_industry.id，供配置外键引用

    source_configs = list(
        db.execute(
            select(NginxConfig).where(NginxConfig.industry_id == source.id)
        ).scalars().all()
    )
    for cfg in source_configs:
        db.add(
            NginxConfig(
                industry_id=new_industry.id,
                name=cfg.name,
                domain=cfg.domain,
                config_text=cfg.config_text,
                enabled=cfg.enabled,
                version=1,
            )
        )
    db.commit()
    db.refresh(new_industry)
    return new_industry
```

`backend/app/schemas/industry.py` 追加：

```python
class CloneIndustryRequest(BaseModel):
    """从模板行业克隆请求。"""

    source_industry_id: int
    name: str = Field(min_length=1, max_length=50)
    owner: str | None = Field(default=None, max_length=50)
```

`backend/app/api/industries.py` 移除 `_clone_endpoint_stub`，替换为：

```python
from sqlalchemy.exc import IntegrityError


@router.post("/clone", response_model=IndustryOut, status_code=status.HTTP_201_CREATED)
def create_clone(
    payload: CloneIndustryRequest,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Industry:
    try:
        return clone_industry(db, payload=payload)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="源行业不存在")
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该名称已存在")
```

`backend/app/api/industries.py` import 区追加：

```python
from app.schemas.industry import (
    CloneIndustryRequest,
    IndustryCreate,
    IndustryOut,
    IndustryUpdate,
)
from app.services.industry_clone import clone_industry
```

> 注意：副本 `config_text` 是唯一非 `BaseModel` 直接复制字段，克隆天然深拷贝字符串；`domain/enabled` 一并复制。

- [ ] **Step 4: 跑测试验证通过**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_clone.py -q
```

Expect: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add backend/app/services/industry_clone.py backend/app/api/industries.py \
        backend/app/schemas/industry.py backend/tests/test_clone.py
git commit -m "feat: 模板克隆事务深拷贝(nginx_configs + 行业独立)"
```

---

## Task 6: （后端）安全响应头中间件（CSP 等）

**Files:**
- Create: `backend/app/middleware/security_headers.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_security_headers.py`

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_security_headers.py
"""安全响应头测试。"""


def test_security_headers_present(client):
    """所有响应携带 CSP / X-Content-Type-Options / Referrer-Policy。"""
    resp = client.get("/api/auth/captcha")
    assert resp.headers["content-security-policy"] is not None
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["referrer-policy"] == "no-referrer"
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_security_headers.py -q
```

Expect: `KeyError`（无对应响应头）。

- [ ] **Step 3: 实现中间件**

`backend/app/middleware/security_headers.py`:

```python
"""安全响应头中间件：为所有响应注入安全头（CSP 等）。"""
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


_DEFAULT_HEADERS = {
    # 场景：本应用渲染用户可控 nginx 配置文本 → 禁 unsafe-inline 脚本、限 frame 嵌套
    "content-security-policy": "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers.update(_DEFAULT_HEADERS)
        return response
```

`backend/app/main.py` 顶部 import 追加：

```python
from app.middleware.security_headers import SecurityHeadersMiddleware
```

`backend/app/main.py` 在 `app.add_middleware(CORSMiddleware, ...)` 之后追加：

```python
# 安全响应头（早于 CORS 注入，保证所有响应都带上）
app.add_middleware(SecurityHeadersMiddleware)
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd backend
..\.venv\Scripts\python -m pytest tests/test_security_headers.py -q
```

Expect: `1 passed`。

- [ ] **Step 5: 提交**

```bash
git add backend/app/middleware/security_headers.py backend/app/main.py backend/tests/test_security_headers.py
git commit -m "feat: 全局安全响应头中间件(CSP/X-Content-Type-Options/Referrer-Policy)"
```

---

## Task 7: （后端）seed 演示模板行业 + 演示配置

**Files:**
- Modify: `backend/app/seed.py`

- [ ] **Step 1: 检查现有 seed 逻辑，写最小 seed 扩展**

现状：`seed.py` 在无 `admin` 用户时写入 admin + items。本 Task 追加：seed 一个 `overseas_freight`（`is_template=True`）行业 + 一条 `nginx_config`，幂等（已存在同 code 则跳过）。

`backend/app/seed.py` 改为：

```python
"""启动初始化：建表 + 演示数据（幂等，已有数据不重复写入）。"""

from sqlalchemy import select

from app.core.logging import logger
from app.core.security import hash_password
from app.database import SessionLocal, engine
from app.models import Base, Industry, Item, NginxConfig, User


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
            db.add(
                NginxConfig(
                    industry_id=template_industry.id,
                    name="overseas_http",
                    domain="freight.example.com",
                    config_text="server { listen 80; server_name freight.example.com; }",
                    enabled=True,
                    version=1,
                )
            )
            logger.info("已写入演示模板行业 overseas_freight + 1 条 nginx 配置")

        db.commit()
        logger.info("演示数据初始化完成")
    finally:
        db.close()
```

- [ ] **Step 2: 手动验证（无独立单测，因 seed 依赖真实 SessionLocal/engine）**

```bash
cd backend
..\.venv\Scripts\python -c "from app.seed import init_db; init_db(); from app.database import SessionLocal; from sqlalchemy import select; from app.models import Industry; db=SessionLocal(); print([(i.code,i.is_template) for i in db.execute(select(Industry)).scalars()]); db.close()"
```

Expect: seed 打印含 `[('overseas_freight', True)]`（或已存在时列为已有模板行）。

> 说明：若本地 `backend/test_system.db` 是旧 schema（无 `industries` 表 / 无新列），`create_all` 不会补列，需**删除旧 db 重新初始化**。本步命令前如有报错提示缺列，先删除 `backend/test_system.db` 再重跑 Step 2。

- [ ] **Step 3: 提交**

```bash
git add backend/app/seed.py
git commit -m "feat: seed 演示模板行业与 nginx 配置"
```

---

## Task 8: （前端）行业作用域 API 客户端 + 主题系统

**Files:**
- Create: `frontend/src/api/industry.js`
- Create: `frontend/src/api/concurrency.js`
- Modify: `frontend/src/api/nginx.js`
- Create: `frontend/src/theme/theme.css`
- Create: `frontend/src/theme/ThemeProvider.jsx`

> 前端无测试框架，验证 = `npm run build` 通过 + 浏览器冒烟。

- [ ] **Step 1: 行业 CRUD + clone 客户端**

`frontend/src/api/industry.js`:

```javascript
import client from "./client";

export function listIndustries() {
  return client.get("/industries");
}
export function createIndustry(data) {
  return client.post("/industries", data);
}
export function updateIndustry(id, data) {
  return client.put(`/industries/${id}`, data);
}
export function deleteIndustry(id) {
  return client.delete(`/industries/${id}`);
}
export function cloneIndustry(data) {
  return client.post("/industries/clone", data);
}
export function getIndustry(id) {
  return client.get(`/industries/${id}`);
}
```

`frontend/src/api/concurrency.js`（乐观锁 + 编辑租约客户端）：

```javascript
import client from "./client";

// 提交写回：携带 base_version 做乐观锁；409 由调用方弹对比/丢弃引导
export function updateConfig(configId, data) {
  return client.put(`/nginx-configs/${configId}`, data);
}

// 编辑会话租约：续期（首次即取得） / 释放
export function heartbeat(configId, holder) {
  return client.post(`/nginx-configs/${configId}/edit-heartbeat`, { holder });
}
export function releaseConfig(configId, holder) {
  return client.post(`/nginx-configs/${configId}/edit-release`, { holder });
}

// 判断某次写回失败是否为 409 版本冲突
export function isVersionConflict(error) {
  return error?.response && error.response.status === 409;
}
```

`frontend/src/api/nginx.js` 追加行业作用域列表 + 保留原单条方法（修改）：

```javascript
// 追加/覆盖（其余原方法保留）：
export function listConfigsByIndustry(industryId) {
  return client.get("/nginx-configs", { params: { industry_id: industryId } });
}
```
> 说明：若旧 `nginx.js` 已有 `listConfigs()` 等无行业过滤的旧单页方法，本步**保留旧方法不动**（内页① 再统一替换），仅**追加** `listConfigsByIndustry`，避免破坏现有 `/ops` 单页。

- [ ] **Step 2: 主题三套 CSS 变量（转写自 .nginx-mock/dashboard.html）**

`frontend/src/theme/theme.css`:

```css
:root {
  --bg-deep:#0a0a0c;--bg-deep2:#0d0d10;--bg-sidebar:#111114;--bg-surface:#18181c;--bg-surface2:#202024;--bg-surface3:#2a2a30;--bg-hover:#2e2e36;
  --brand:#4a8af4;--brand-hover:#6ba8fa;--brand-light:rgba(74,138,244,.12);--brand-border:rgba(74,138,244,.25);--brand-glow:rgba(74,138,244,.08);
  --text-pri:#e8e8ea;--text-sec:#b0b0bc;--text-ter:#808090;--border:#202024;--border-soft:#1b1b1f;
  --success:#22c55e;--success-bg:rgba(34,197,94,.09);--warning:#f59e0b;--warning-bg:rgba(245,158,11,.09);
  --mono:'JetBrains Mono','SF Mono','Consolas',monospace;
  --ease:cubic-bezier(.4,0,.2,1);
  --bar:rgba(10,10,12,.72);
  --glow1:rgba(74,138,244,.08); --glow2:rgba(74,138,244,.08);
  --rowhover:linear-gradient(90deg,var(--brand-light),transparent 60%),var(--bg-surface2);
  color-scheme: dark;
}
:root[data-theme="soft"] {
  --bg-deep:#16162a;--bg-deep2:#1a1a30;--bg-sidebar:#1e1e36;--bg-surface:#232338;--bg-surface2:#2a2a42;--bg-hover:#35354f;
  --text-pri:#edeef6;--text-sec:#b9bac8;--text-ter:#8e8fa1;--border:#31314a;--border-soft:#26263a;
  --bar:rgba(22,22,42,.78);--glow1:rgba(124,110,255,.10);--glow2:rgba(74,138,244,.08);
}
:root[data-theme="light"] {
  --bg-deep:#f4f6f9;--bg-deep2:#eef1f5;--bg-sidebar:#ffffff;--bg-surface:#ffffff;--bg-surface2:#f2f4f8;--bg-hover:#e9edf3;
  --text-pri:#1a1c28;--text-sec:#464a58;--text-ter:#868b9b;--border:#e1e6ee;--border-soft:#e7ebf1;
  --success:#1f9d57;--success-bg:rgba(31,157,87,.10);--warning:#d9820b;--warning-bg:rgba(217,130,11,.10);
  --brand:#3b74e0;--brand-hover:#2f63c7;--brand-light:rgba(59,116,224,.10);--brand-border:rgba(59,116,224,.28);
  --bar:rgba(255,255,255,.82);--glow1:rgba(59,116,224,.06);--glow2:rgba(59,116,224,.04);
  --rowhover:#f5f8fc;
  color-scheme: light;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: radial-gradient(1000px 520px at 12% -8%, var(--glow1), transparent 55%),
              radial-gradient(800px 400px at 100% 100%, var(--glow2), transparent 60%),
              var(--bg-deep);
  color: var(--text-pri);
  font-family: -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--brand); text-decoration: none; }
```

- [ ] **Step 3: ThemeProvider（读 localStorage 切 data-theme，默认软深）**

`frontend/src/theme/ThemeProvider.jsx`:

```javascript
import { createContext, useContext, useEffect, useMemo, useState } from "react";

const KEY = "nginx-theme";
const DEFAULTS = ["dark", "soft", "light"];

const ThemeContext = createContext({ theme: "soft", setTheme: () => {} });
export const useTheme = () => useContext(ThemeContext);

export default function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    const stored = localStorage.getItem(KEY);
    return DEFAULTS.includes(stored) ? stored : "soft";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme: setThemeState }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
```

- [ ] **Step 4: 验证构建**

```bash
cd frontend
npm run build
```

Expect: 构建成功（Vite 输出 `built in ...`）。ThemeProvider 尚未挂载不影响构建。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/api/industry.js frontend/src/api/concurrency.js \
        frontend/src/api/nginx.js frontend/src/theme/theme.css frontend/src/theme/ThemeProvider.jsx
git commit -m "feat: 行业/并发 API 客户端 + 三套主题 token + ThemeProvider"
```

---

## Task 9: （前端）行业管理落地页（IndustryDashboard）+ 克隆弹窗 + 路由接入

**Files:**
- Create: `frontend/src/pages/dashboard.css`
- Create: `frontend/src/pages/IndustryDashboard.jsx`
- Create: `frontend/src/pages/IndustryCloneModal.jsx`
- Create: `frontend/src/pages/IndustryDetail.jsx`（最小行业概览页）
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/main.jsx`（包 ThemeProvider）

> 落地页采用 Linear 式行列表 + KPI 丝带 + 主题切换器，纯 CSS 变量驱动，无第三方图标库。

- [ ] **Step 1: 落地页样式**

`frontend/src/pages/dashboard.css`:

```css
.shell { min-height: 100vh; }
.shell-bar {
  position: sticky; top: 0; z-index: 20;
  display: flex; align-items: center; gap: 12px;
  padding: 0 24px; height: 52px;
  background: var(--bar); backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-soft);
}
.shell-bar .logo { font-weight: 700; letter-spacing: -0.3px; }
.shell-bar .crumb { color: var(--text-ter); font-size: 12.5px; }
.ctl { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.swatch { width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--border); cursor: pointer; }
.swatch.active { outline: 2px solid var(--brand); outline-offset: 2px; }
.shell-head { padding: 28px 24px 12px; max-width: 1180px; margin: 0 auto; }
.shell-head h1 { margin: 0; font-size: 21px; letter-spacing: -0.4px; }
.shell-head .sub { margin: 6px 0 0; color: var(--text-ter); font-size: 13px; }
.shell-head .row { display: flex; align-items: center; justify-content: space-between; }
.primary-btn {
  border: 1px solid transparent; background: var(--brand); color: #fff; height: 32px;
  padding: 0 16px; border-radius: 6px; font-size: 13px; cursor: pointer;
  transition: transform .1s var(--ease), background .15s var(--ease);
}
.primary-btn:hover { background: var(--brand-hover); }
.primary-btn:active { transform: scale(.97); }
.kpi {
  display: flex; margin: 16px 24px; max-width: 1132px; gap: 0;
  border: 1px solid var(--border-soft); border-radius: 8px; overflow: hidden;
}
.kpi-item { flex: 1; padding: 14px 20px; border-left: 1px solid var(--border-soft); }
.kpi-item:first-child { border-left: 0; }
.kpi-item .num { font-family: var(--mono); font-size: 24px; letter-spacing: -0.5px; }
.kpi-item .lbl { color: var(--text-ter); font-size: 12px; margin-top: 4px; }
.db-wrap { max-width: 1180px; margin: 8px auto 0; }
.db-tbl { width: 100%; border-collapse: collapse; }
.db-tbl thead th {
  text-align: left; padding: 10px 16px; color: var(--text-ter); font-size: 12px;
  font-weight: 600; border-bottom: 1px solid var(--border);
}
.db-tbl tbody tr {
  border-bottom: 1px solid var(--border-soft); cursor: pointer;
  transition: background .15s var(--ease);
}
.db-tbl tbody tr:hover { background: var(--rowhover); }
.db-tbl tbody tr:hover .row-arrow { transform: translateX(4px); opacity: 1; }
.db-tbl td { padding: 14px 16px; font-size: 13px; }
.db-tbl .name-cell { display: flex; align-items: center; gap: 10px; }
.db-tbl .name-cell .ico {
  width: 26px; height: 26px; border-radius: 6px; display: grid; place-items: center;
  background: var(--brand-light); color: var(--brand); font-family: var(--mono); font-size: 12px;
}
.tag { font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid; }
.tag.tpl { color: var(--brand); border-color: var(--brand-border); background: var(--brand-light); }
.tag.cloned { color: var(--warning); border-color: rgba(245,158,11,.2); background: var(--warning-bg); }
.row-arrow { opacity: 0; transition: transform .15s var(--ease), opacity .15s var(--ease); color: var(--brand); }
.meta { color: var(--text-ter); font-size: 12px; }
.col-ops { text-align: right; }
.col-ops button {
  border: 1px solid var(--border); background: transparent; color: var(--text-sec);
  height: 26px; padding: 0 12px; border-radius: 5px; font-size: 12px; cursor: pointer;
  transition: all .15s var(--ease); margin-left: 8px;
}
.col-ops button:hover { border-color: var(--brand-border); color: var(--text-pri); background: var(--bg-hover); }
.empty { padding: 60px 24px; text-align: center; color: var(--text-ter); }
.tbl-anim tr { animation: fadeIn .2s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
```

- [ ] **Step 2: IndustryCloneModal**

`frontend/src/pages/IndustryCloneModal.jsx`:

```javascript
import { useMemo, useState } from "react";
import { cloneIndustry } from "../api/industry";

export default function IndustryCloneModal({ templates, open, onClose, onCreated }) {
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const canSubmit = useMemo(
    () => templates.some((t) => t.id === Number(sourceId)) && name.trim().length > 0,
    [templates, sourceId, name]
  );

  if (!open) return null;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建行业（模板克隆）</h3>
        <p className="meta">从模板源深拷贝整套配置，克隆后与源完全独立。</p>
        <label>模板源行业</label>
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">选择模板源…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}（{t.code}）</option>
          ))}
        </select>
        <label>新行业名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：国内" />
        <label>负责人（可选）</label>
        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="如：李工" />
        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>取消</button>
          <button
            className="primary-btn"
            disabled={!canSubmit || loading}
            onClick={async () => {
              setLoading(true); setErr("");
              try {
                const created = await cloneIndustry({
                  source_industry_id: Number(sourceId),
                  name: name.trim(),
                  owner: owner.trim() || null,
                });
                onCreated(created.data);
              } catch (e) {
                setErr(e.response?.data?.detail || "克隆失败，请重试");
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading ? "克隆中…" : "创建并克隆"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: IndustryDashboard 主页面**

`frontend/src/pages/IndustryDashboard.jsx`:

```javascript
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listIndustries } from "../api/industry";
import { listConfigsByIndustry } from "../api/nginx";
import { useTheme } from "../theme/ThemeProvider";
import IndustryCloneModal from "./IndustryCloneModal";
import "./dashboard.css";

const SWATCHES = [
  { k: "dark", s: "#0a0a0c" },
  { k: "soft", s: "#16162a" },
  { k: "light", s: "#f4f6f9" },
];

export default function IndustryDashboard() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [industries, setIndustries] = useState([]);
  const [configCounts, setConfigCounts] = useState({});
  const [openClone, setOpenClone] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await listIndustries();
      setIndustries(res.data);
      setError("");
    } catch { setError("行业列表加载失败"); }
  }, []);

  const loadCounts = useCallback(async (list) => {
    const map = {};
    for (const ind of list) {
      try {
        map[ind.id] = (await listConfigsByIndustry(ind.id)).data.length;
      } catch { map[ind.id] = 0; }
    }
    setConfigCounts(map);
  }, []);

  useEffect(() => { load().then(() => undefined); }, [load]);
  useEffect(() => { if (industries.length) loadCounts(industries); /* eslint-disable-line */ }, [loadCounts]);

  const templates = useMemo(() => industries.filter((i) => i.is_template), [industries]);
  const clonedNames = useMemo(() => {
    const byId = new Map(industries.map((i) => [i.id, i.name]));
    return new Map(
      industries.filter((i) => i.cloned_from_id != null)
        .map((i) => [i.id, "克隆自 · " + (byId.get(i.cloned_from_id) ?? i.cloned_from_id)])
    );
  }, [industries]);
  const streamCount = 0; // 本阶段 stream 独立文件由「内页①」落地，展示占位 0

  return (
    <div className="shell">
      <header className="shell-bar">
        <span className="logo">Nginx 配置管理系统</span>
        <span className="crumb">› 行业管理</span>
        <div className="ctl">
          {SWATCHES.map((sw) => (
            <button
              key={sw.k}
              title={sw.k}
              className={"swatch" + (theme === sw.k ? " active" : "")}
              style={{ background: sw.s }}
              onClick={() => setTheme(sw.k)}
            />
          ))}
        </div>
      </header>

      <section className="shell-head">
        <div className="row">
          <div>
            <h1>行业管理</h1>
            <p className="sub">每个行业独立维护自己的 nginx / stream 配置，可基于模板源克隆初始化。</p>
          </div>
          <button className="primary-btn" onClick={() => setOpenClone(true)}>＋ 新建行业（模板克隆）</button>
        </div>
      </section>

      <div className="kpi">
        <div className="kpi-item"><div className="num">{industries.length}</div><div className="lbl">行业总数</div></div>
        <div className="kpi-item"><div className="num">{Object.values(configCounts).reduce((a, b) => a + b, 0)}</div><div className="lbl">nginx 配置</div></div>
        <div className="kpi-item"><div className="num">{streamCount}</div><div className="lbl">stream 配置</div></div>
        <div className="kpi-item"><div className="num">—</div><div className="lbl">全网监听点</div></div>
      </div>

      <div className="db-wrap">
        {error && <p className="err">{error}</p>}
        {industries.length === 0 && !error ? (
          <div className="empty">暂无行业，点击「新建行业（模板克隆）」创建。</div>
        ) : (
          <table className="db-tbl tbl-anim">
            <thead>
              <tr>
                <th>行业</th><th>nginx server</th><th>upstream</th>
                <th>stream</th><th>归属·更新</th><th className="col-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {industries.map((ind) => (
                <tr key={ind.id} onClick={() => navigate(`/ops/${ind.id}`)}>
                  <td>
                    <div className="name-cell">
                      <span className="ico">{ind.name.slice(0, 1)}</span>
                      <div>
                        <div>{ind.name}
                          {ind.is_template && <span className="tag tpl" style={{ marginLeft: 8 }}>模板源</span>}
                          {clonedNames.has(ind.id) && <span className="tag cloned" style={{ marginLeft: 8 }}>{clonedNames.get(ind.id)}</span>}
                        </div>
                        <div className="meta">{ind.code}{ind.owner ? ` · ${ind.owner}` : ""}</div>
                      </div>
                    </div>
                  </td>
                  <td className="meta">{configCounts[ind.id] ?? 0}</td>
                  <td className="meta">—</td>
                  <td className="meta">—</td>
                  <td className="meta">{ind.updated_at ? ind.updated_at.split("T")[0] : ""}</td>
                  <td className="col-ops">
                    <span className="row-arrow">→</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="meta" style={{ padding: "0 16px 24px" }}>
          提示：选择「模板源」行业作为克隆基准，克隆后将完全独立；无人编辑时配置按行业隔离。
        </p>
      </div>

      <IndustryCloneModal
        templates={templates}
        open={openClone}
        onClose={() => setOpenClone(false)}
        onCreated={() => { setOpenClone(false); load(); }}
      />
    </div>
  );
}
```

> 说明：`err`/`.modal`/`.modal-mask` 等类在 Step 4 一并补进 `dashboard.css`。

- [ ] **Step 4: 补齐弹窗/通用样式（追加到 dashboard.css）**

```css
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: grid; place-items: center; z-index: 100; }
.modal { width: 400px; max-width: 92vw; background: var(--bg-surface2); border: 1px solid var(--border); border-radius: 8px; padding: 20px 22px; }
.modal h3 { margin: 0 0 4px; }
.modal label { display: block; margin: 14px 0 6px; color: var(--text-sec); font-size: 12.5px; }
.modal select, .modal input {
  width: 100%; height: 34px; background: var(--bg-deep2); color: var(--text-pri);
  border: 1px solid var(--border); border-radius: 6px; padding: 0 12px; font-size: 13px;
}
.modal select { appearance: auto; }
.modal .err, .db-wrap .err { color: var(--warning); font-size: 12.5px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.ghost {
  border: 1px solid var(--border); background: transparent; color: var(--text-sec);
  height: 32px; padding: 0 16px; border-radius: 6px; font-size: 13px; cursor: pointer;
  transition: all .15s var(--ease);
}
.ghost:hover { background: var(--bg-hover); color: var(--text-pri); }
.primary-btn:disabled { opacity: .4; cursor: not-allowed; }
```

- [ ] **Step 5: 最小行业概览页（/ops/:industryId）**

`frontend/src/pages/IndustryDetail.jsx`:

```javascript
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getIndustry } from "../api/industry";
import { listConfigsByIndustry } from "../api/nginx";

// 外壳阶段的最小行业概览页：验证行业作用域与 version 字段端到端打通。
// 完整逐行业控制台（BlockTree/拓扑/业务端口/导出）由「内页①」替换本页。
export default function IndustryDetail() {
  const { industryId } = useParams();
  const [ind, setInd] = useState(null);
  const [cfgs, setCfgs] = useState([]);

  useEffect(() => {
    (async () => {
      const id = Number(industryId);
      try {
        const [indRes, cfgRes] = await Promise.all([getIndustry(id), listConfigsByIndustry(id)]);
        setInd(indRes.data);
        setCfgs(cfgRes.data);
      } catch { /* 由内页①接管错误态 */ }
    })();
  }, [industryId]);

  if (!ind) return <div className="shell" style={{ padding: 24 }}>加载中…</div>;
  return (
    <div className="shell">
      <header className="shell-bar">
        <span className="crumb">‹ 行业管理</span>
        <span className="crumb">› {ind.name}</span>
      </header>
      <div className="db-wrap">
        <h1 style={{ marginTop: 24 }}>{ind.name}</h1>
        <p className="meta">{ind.code}{ind.is_template ? " · 模板源" : ""}</p>
        <table className="db-tbl" style={{ marginTop: 16 }}>
          <thead><tr><th>配置名</th><th>域名</th><th>启用</th><th>版本</th></tr></thead>
          <tbody>
            {cfgs.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="meta">{c.domain ?? "—"}</td>
                <td className="meta">{c.enabled ? "是" : "否"}</td>
                <td className="meta">v{c.version}</td>
              </tr>
            ))}
            {cfgs.length === 0 && (
              <tr><td colSpan={4} className="empty">该行业暂无 nginx 配置，可通过「从模板克隆初始化」创建。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 路由接入 + ThemeProvider 挂载**

`frontend/src/App.jsx` 修改为（关键变更）：
- import `IndustryDashboard`、`IndustryDetail`
- 登录落地路由改指向 `/industries`：在 `ProtectedLayout` 下新增 `<Route path="/industries" element={<IndustryDashboard />} />` 与 `<Route path="/ops/:industryId" element={<IndustryDetail />} />`，并把 `/` 兜底重定向到 `/industries`。

修改后 `App.jsx` 的路由与登录跳转：

```jsx
import IndustryDashboard from "./pages/IndustryDashboard";
import IndustryDetail from "./pages/IndustryDetail";
// ...（其余 import 不变）

// ProtectedLayout 内 handleLogout、Sider 菜单同理可加「行业管理 → /industries」；无关改动最小化，仅确保路由注册与落地页可达。
```

并把 `Routes` 改为：

```jsx
<Routes>
  <Route path="/login" element={<Login />} />
  <Route path="/register" element={<Register />} />
  <Route path="/reset-password" element={<ResetPassword />} />
  <Route element={<ProtectedLayout />}>
    <Route path="/" element={<Dashboard />} />
    <Route path="/ops" element={<OpsConsole />} />
    <Route path="/industries" element={<IndustryDashboard />} />
    <Route path="/ops/:industryId" element={<IndustryDetail />} />
  </Route>
  <Route path="*" element={<Navigate to="/industries" replace />} />
</Routes>
```

> 说明：`/` 与 `/ops`（旧单页）**保留**，避免破坏既有功能；登录成功后现有 `Login.jsx` 跳 `/`，需改跳 `/industries`（见 Step 7）。`/ops/:industryId` 与 `/ops` 会由 React Router 精确匹配，互不冲突（`:industryId` 具体值不会误入 `/ops`）。

`frontend/src/main.jsx` 用 `ThemeProvider` 包裹 `<App />`（修改后大致）：

```jsx
import ThemeProvider from "./theme/ThemeProvider";
// ...
<ThemeProvider>
  <BrowserRouter>
    <App />
  </BrowserRouter>
</ThemeProvider>
```

- [ ] **Step 7: 登录成功跳行业落地页**

`frontend/src/pages/Login.jsx` 中 `navigate("/")` 改为 `navigate("/industries")`（仅一处跳转，登录成功后）。

- [ ] **Step 8: 验证构建 + 冒烟**

```bash
cd frontend
npm run build
```

Expect: 构建成功。手动冒烟（可选）：`npm run dev` → 登录 `admin/admin123` → 应进入行业管理落地页 → 三主题圆点切换生效 → 点行业行进入 `/ops/:industryId` 概览页 → 点「＋ 新建行业（模板克隆）」选模板源克隆。

- [ ] **Step 9: 提交**

```bash
git add frontend/src/pages/dashboard.css frontend/src/pages/IndustryDashboard.jsx \
        frontend/src/pages/IndustryCloneModal.jsx frontend/src/pages/IndustryDetail.jsx \
        frontend/src/App.jsx frontend/src/main.jsx frontend/src/pages/Login.jsx
git commit -m "feat: 行业管理落地页 + 克隆弹窗 + 最小行业概览页 + 路由与主题接入"
```

---

## Self-Review

**1. Spec coverage（对照 `2026-10-13-multi-industry-template-design.md` §1-§10）**

- §2.1 登录页：既有 `Login.jsx` 已具备品牌区 + 表单 + 验证码 + 忘记密码，本计划补「记住我」未单列 —— 因既有登录已可用，属细节点。`navigate("/industries")` 落地链已改（Task 9 Step 7）。**记一笔：记住我字段登录页可选实现，未在本计划强制（YAGNI，现有可用）。**
- §2.2 行业管理落地页：Task 9（Linear 行列表 + KPI 丝带 + 顶栏 + 主题切换 + 新建行业）。
- §3 数据模型：`industries` Task 1；`nginx_configs` 行业作用域/版本 Task 2-3；`config_blocks` 等块树**不在本外壳计划**（留待内页①）——见末尾遗留。
- §4 模板克隆：Task 5（事务深拷贝 nginx_configs + 行业独立 + cloned_from_id）。**块树深拷由内页①扩展同一 service。**
- §5 并发：乐观 version/409 Task 3；编辑租约 heartbeat/release/超时接管 Task 4。前端冲突弹窗（对比/丢弃）留内页①。
- §6 API：industries CRUD + clone（Task 1/5）；各资源 industry 过滤（nginx_configs，Task 3）；version 返回 + base_version 409（Task 3）；heartbeat/release（Task 4）。
- §7 前端：Login 复用 + 改跳转（Task 9）；IndustryDashboard/IndustryCloneModal/ThemeProvider（Task 8-9）；行业作用域 API（Task 8）。**内页按 :industryId 读取与主题 Provider 复用**：IndustryDetail 仅最小化，完整内页见内页①。
- §8 测试：后端正/反向用例全覆盖（test_industries/test_clone/test_nginx_industry/test_lease/test_security_headers）。前端无测试框架 → 构建 + 冒烟。
- §10 安全：CSP/X-Content-Type-Options/Referrer-Policy（Task 6）；行业 code 白名单 + 长度校验（Task 1/5 派生）；JWT Bearer（既有，无 CSRF Cookie 会话）；**命令注入 subprocess 与 SSRF/导出文件名注入属内页①（export/nginx -t 不存在于此外壳范围）。**

**2. Placeholder scan**
- Task 1 `_clone_endpoint_stub` 明确标注「Task 6 移除」；Task 5 完整替换。真实实现非占位。
- Task 3 `nginx_router = config_router` 别名为明确桥接，非占位。
- 前端 `streamCount = 0` 为真实可运行展示（stream 文件内页①才落地），非 TBD。

**3. Type consistency**
- `clone_industry(db, *, payload)` 在 Task 1（骨架返回 None）与 Task 5（返回 Industry）签名自洽；Task 5 调用处 `clone_industry(db, payload=payload)` 一致。
- `NginxConfigOut` 新增 `version/updated_at/industry_id`，Task 2/3 一致引用。
- `is_lease_expired/now_utc/LEASE_TTL_SECONDS` 在 Task 4 定义并被端点是 test 引用，命名一致。
- `config_router` 内端点命名与 `nginx_router = config_router` 无冲突；api/__init__ 不重导出（保持现有约定）。

**遗留（不属本计划，明确指给内页①）**
- 逐行业完整控制台 UI（BlockTree/拓扑/业务端口/导出替换）。
- 块树（config_blocks/config_options/upstreams/upstream_servers）建模 + 克隆扩展为整棵 parent_id 深拷。
- `.stream` 独立文件、双文件树、导出替换、nginx -t/reload 的 safe_subprocess 安全执行。
- 前端 409 冲突弹窗（对比/保留草稿二选一）与强制接管交互。
- `domain_mappings/forward_ports/biz_ports` 行业化 + 各自的 industry_id 过滤（现仍全局，内页①随块模型统一改造）。