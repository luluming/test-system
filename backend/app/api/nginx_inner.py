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


@options_router.delete("/{option_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_option(
    option_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    db.delete(get_option(option_id, db=db))
    db.commit()


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


import re

from app.api.nginx import forward_router
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


@forward_router.post("/{forward_id}/test")
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
