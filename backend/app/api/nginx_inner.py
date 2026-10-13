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
