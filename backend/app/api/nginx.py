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
from app.services.leases import is_lease_expired, now_utc


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


nginx_router = config_router


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