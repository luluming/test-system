"""运维配置 CRUD 接口：nginx 配置、域名映射、转发端口、业务端口（均需登录）。

数据为系统级全局配置，无需 owner 隔离；crud 用工厂函数生成，
避免为四个同构资源重复编写相同逻辑。
"""

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.security import get_current_user
from app.models.nginx import BizPort, DomainMapping, ForwardPort, NginxConfig
from app.models.user import User
from app.schemas.nginx import (
    BizPortCreate,
    BizPortOut,
    BizPortUpdate,
    DomainMappingCreate,
    DomainMappingOut,
    DomainMappingUpdate,
    ForwardPortCreate,
    ForwardPortOut,
    ForwardPortUpdate,
    NginxConfigCreate,
    NginxConfigOut,
    NginxConfigUpdate,
)
from app.models.base import Base


def _make_router(
    *,
    model: type[Base],
    create_schema: type[BaseModel],
    update_schema: type[BaseModel],
    out_schema: type[BaseModel],
    prefix: str,
    tag: str,
) -> APIRouter:
    """为一类资源生成一套标准 CRUD 路由。"""

    router = APIRouter(prefix=prefix, tags=[tag])

    @router.get("", response_model=list[out_schema])
    def list_items(
        db: Session = Depends(get_db),
        _current_user: User = Depends(get_current_user),
    ) -> list[Any]:
        rows = db.execute(select(model).order_by(model.id)).scalars().all()
        return list(rows)

    @router.post("", response_model=out_schema, status_code=status.HTTP_201_CREATED)
    def create_item(
        payload: create_schema,
        db: Session = Depends(get_db),
        _current_user: User = Depends(get_current_user),
    ) -> Any:
        row = model(**payload.model_dump())
        db.add(row)
        db.commit()
        db.refresh(row)
        return row

    @router.get("/{item_id}", response_model=out_schema)
    def get_item(
        item_id: int,
        db: Session = Depends(get_db),
        _current_user: User = Depends(get_current_user),
    ) -> Any:
        return _get_by_id(db, model, item_id)

    @router.put("/{item_id}", response_model=out_schema)
    def update_item(
        item_id: int,
        payload: update_schema,
        db: Session = Depends(get_db),
        _current_user: User = Depends(get_current_user),
    ) -> Any:
        row = _get_by_id(db, model, item_id)
        # 仅更新调用方显式传入的字段
        for field, value in payload.model_dump(exclude_unset=True).items():
            setattr(row, field, value)
        db.commit()
        db.refresh(row)
        return row

    @router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_item(
        item_id: int,
        db: Session = Depends(get_db),
        _current_user: User = Depends(get_current_user),
    ) -> None:
        row = _get_by_id(db, model, item_id)
        db.delete(row)
        db.commit()

    return router


def _get_by_id(db: Session, model: type[Base], item_id: int) -> Any:
    """按 ID 查询；不存在时返回 404。"""
    row = db.execute(select(model).where(model.id == item_id)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="记录不存在")
    return row


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


nginx_router = config_router

mapping_router = _make_router(
    model=DomainMapping,
    create_schema=DomainMappingCreate,
    update_schema=DomainMappingUpdate,
    out_schema=DomainMappingOut,
    prefix="/api/domain-mappings",
    tag="域名映射",
)

forward_router = _make_router(
    model=ForwardPort,
    create_schema=ForwardPortCreate,
    update_schema=ForwardPortUpdate,
    out_schema=ForwardPortOut,
    prefix="/api/forward-ports",
    tag="转发端口",
)

biz_router = _make_router(
    model=BizPort,
    create_schema=BizPortCreate,
    update_schema=BizPortUpdate,
    out_schema=BizPortOut,
    prefix="/api/biz-ports",
    tag="业务端口",
)