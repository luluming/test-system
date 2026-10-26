"""内页① 端点：upstream / config-blocks / config-options / render / export / topology / directives / test / reload / validate。

复用 app/api/nginx.py 的 _make_router 风格与 get_db/get_current_user 依赖。
"""

import hashlib
import json
import logging
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

logger = logging.getLogger("nginx_inner")

from app.api.deps import get_db
from app.core.security import decode_token, get_current_user
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


from app.models.nginx import ConfigBlock, ConfigOption, NginxConfigVersion, NginxMirrorPair, NginxPushTask, NginxPushToken
from app.schemas.nginx import MirrorPairCreate, MirrorPairOut
from app.schemas.nginx_inner import (
    BlockReorderRequest,
    ConfigBlockCreate,
    ConfigBlockOut,
    ConfigBlockUpdate,
    ConfigOptionCreate,
    ConfigOptionOut,
    ConfigOptionUpdate,
    NginxVersionCreate,
    NginxVersionOut,
    OptionReorderRequest,
    PushApplyRequest,
)
from app.services.nginx_push import compute_diff, parse_nginx, perform_apply
from app.services.nginx_snapshot import context_of_config, snapshot_config

blocks_router = APIRouter(prefix="/api/config-blocks", tags=["配置块"])
options_router = APIRouter(prefix="/api/config-options", tags=["配置选项"])
config_tree_router = APIRouter(prefix="/api/nginx-configs", tags=["nginx 配置树"])


def _auto_archive(db: Session, config_id: int) -> None:
    """落库成功后自动留档（渲染文本快照，5s 内合并）。失败不阻断业务请求。"""
    try:
        snapshot_config(db, config_id, context=context_of_config(db, config_id))
    except Exception:  # noqa: BLE001
        logger.warning("配置自动留档失败 config_id=%s", config_id, exc_info=True)


def _config_id_of_option(db: Session, option_id: int) -> int:
    opt = db.execute(select(ConfigOption).where(ConfigOption.id == option_id)).scalar_one_or_none()
    if opt is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="配置选项不存在")
    return _get_block(db, opt.block_id).nginx_config_id


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
    _auto_archive(db, row.nginx_config_id)
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


@blocks_router.put("/reorder")
def reorder_blocks(
    payload: BlockReorderRequest,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    rows = list(
        db.execute(
            select(ConfigBlock).where(ConfigBlock.parent_id == payload.parent_id)
        ).scalars().all()
    )
    by_id = {b.id: b for b in rows}
    # 事务原子性：任一 id 不存在即整体拒绝，避免部分块排序被更新
    missing = [oid for oid in payload.ids if oid not in by_id]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"重排失败：包含不存在的块 id：{missing}",
        )
    try:
        for index, oid in enumerate(payload.ids):
            by_id[oid].sort_order = index
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"重排保存失败：{exc}",
        )
    if payload.ids:
        _auto_archive(db, by_id[payload.ids[0]].nginx_config_id)
    return {"message": "重排成功"}


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
    _auto_archive(db, row.nginx_config_id)
    return row


@blocks_router.delete("/{block_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_block(
    block_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    cfg_id = _get_block(db, block_id).nginx_config_id
    ids = _collect_subtree_ids(db, block_id)
    db.execute(ConfigOption.__table__.delete().where(ConfigOption.block_id.in_(ids)))
    db.execute(ConfigBlock.__table__.delete().where(ConfigBlock.id.in_(ids)))
    db.commit()
    _auto_archive(db, cfg_id)


@blocks_router.post("/{block_id}/mirror/{dst_block_id}", response_model=ConfigBlockOut)
def mirror_block(
    block_id: int,
    dst_block_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ConfigBlock:
    """镜像同步：把 src 块整棵子树（含 options）覆盖复制到 dst 块。

    唯一保留项：dst 块自身的 listen 端口值（防止镜像把监听点端口覆盖掉）。
    """
    src = _get_block(db, block_id)
    dst = _get_block(db, dst_block_id)
    if src.nginx_config_id != dst.nginx_config_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="源块与目标块必须属于同一配置文件",
        )
    cfg_id = src.nginx_config_id

    # 1) 记录 dst 原 listen 值（同步后恢复，保证监听点端口不变）
    dst_listen = None
    for o in db.execute(
        select(ConfigOption).where(ConfigOption.block_id == dst.id)
    ).scalars().all():
        if o.directive == "listen":
            dst_listen = o.value
            break

    # 2) 级联删除 dst 现有子树（含 dst 自身 options），保留其 parent/位置信息
    dst_parent_id, dst_scope, dst_header, dst_file, dst_order = (
        dst.parent_id, dst.scope, dst.header, dst.belongs_to_file, dst.sort_order,
    )
    ids = _collect_subtree_ids(db, dst_block_id)
    db.execute(ConfigOption.__table__.delete().where(ConfigOption.block_id.in_(ids)))
    db.execute(ConfigBlock.__table__.delete().where(ConfigBlock.id.in_(ids)))
    db.flush()

    # 3) 重建 dst 本体，再深拷贝 src 的子树到 dst
    rows = _all_block_rows(db, cfg_id)
    child_map: dict[int | None, list[ConfigBlock]] = {}
    for b in rows:
        child_map.setdefault(b.parent_id, []).append(b)
    opt_map: dict[int, list[ConfigOption]] = {}
    if rows:
        rid = [b.id for b in rows]
        for o in db.execute(
            select(ConfigOption).where(ConfigOption.block_id.in_(rid))
        ).scalars().all():
            opt_map.setdefault(o.block_id, []).append(o)

    ndst = ConfigBlock(
        nginx_config_id=cfg_id,
        parent_id=dst_parent_id,
        scope=dst_scope,
        header=dst_header,
        belongs_to_file=dst_file,
        sort_order=dst_order,
    )
    db.add(ndst)
    db.flush()

    def copy_options(block_id: int, options: list[ConfigOption]) -> None:
        for o in options:
            val = o.value
            if o.directive == "listen" and dst_listen is not None:
                val = dst_listen
            db.add(
                ConfigOption(
                    block_id=block_id,
                    directive=o.directive,
                    value=val,
                    row_type=o.row_type,
                    is_free_text=o.is_free_text,
                    sort_order=o.sort_order,
                )
            )

    def copy_children(old_pid: int | None, new_pid: int | None) -> None:
        for b in child_map.get(old_pid, []):
            nb = ConfigBlock(
                nginx_config_id=cfg_id,
                parent_id=new_pid,
                scope=b.scope,
                header=b.header,
                belongs_to_file=b.belongs_to_file,
                sort_order=b.sort_order,
            )
            db.add(nb)
            db.flush()
            copy_options(nb.id, opt_map.get(b.id, []))
            copy_children(b.id, nb.id)

    copy_options(ndst.id, opt_map.get(src.id, []))
    copy_children(src.id, ndst.id)
    db.commit()
    db.refresh(ndst)
    _auto_archive(db, src.nginx_config_id)
    return ndst


# ---- 镜像对配置（配置文件级元数据：母本端口 → 镜像端口，内容同步走 mirror 接口）----
@config_tree_router.get("/{config_id}/mirror-pairs", response_model=list[MirrorPairOut])
def list_mirror_pairs(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[NginxMirrorPair]:
    return list(
        db.execute(
            select(NginxMirrorPair)
            .where(NginxMirrorPair.nginx_config_id == config_id)
            .order_by(NginxMirrorPair.id)
        ).scalars().all()
    )


@config_tree_router.post(
    "/{config_id}/mirror-pairs", response_model=MirrorPairOut, status_code=status.HTTP_201_CREATED
)
def create_mirror_pair(
    config_id: int,
    payload: MirrorPairCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> NginxMirrorPair:
    if payload.src_listen == payload.dst_listen:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="母本与镜像端口不能相同")
    row = NginxMirrorPair(
        nginx_config_id=config_id,
        src_listen=payload.src_listen,
        dst_listen=payload.dst_listen,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该镜像对已存在")
    db.refresh(row)
    return row


@config_tree_router.delete(
    "/{config_id}/mirror-pairs/{pair_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_mirror_pair(
    config_id: int,
    pair_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    row = db.execute(
        select(NginxMirrorPair).where(
            NginxMirrorPair.id == pair_id,
            NginxMirrorPair.nginx_config_id == config_id,
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="镜像对不存在")
    db.delete(row)
    db.commit()


# ---- 配置版本快照：保存 = 渲染文本存一版，用于历史对比 ----
@config_tree_router.get("/{config_id}/versions", response_model=list[NginxVersionOut])
def list_versions(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[NginxConfigVersion]:
    return list(
        db.execute(
            select(NginxConfigVersion)
            .where(NginxConfigVersion.nginx_config_id == config_id)
            .order_by(NginxConfigVersion.version.desc())
        ).scalars().all()
    )


@config_tree_router.post(
    "/{config_id}/versions", response_model=NginxVersionOut, status_code=status.HTTP_201_CREATED
)
def create_version(
    config_id: int,
    payload: NginxVersionCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> NginxConfigVersion:
    max_row = db.execute(
        select(func.max(NginxConfigVersion.version)).where(
            NginxConfigVersion.nginx_config_id == config_id
        )
    ).scalar()
    row = NginxConfigVersion(
        nginx_config_id=config_id,
        version=(max_row or 0) + 1,
        content=payload.content,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ---- 本地配置推送（两阶段：预览 → 确认提交）----

def _task_summary(t: NginxPushTask) -> dict:
    try:
        diff = json.loads(t.diff_json or "[]")
    except Exception:  # noqa: BLE001
        diff = []
    return {
        "id": t.id,
        "nginx_config_id": t.nginx_config_id,
        "status": t.status,
        "raw_len": len(t.raw_text or ""),
        "diff": diff,
        "created_by": t.created_by,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "applied_at": t.applied_at.isoformat() if t.applied_at else None,
        "error_detail": t.error_detail,
    }


def _get_push_task(db: Session, config_id: int, task_id: int) -> NginxPushTask:
    row = db.execute(
        select(NginxPushTask).where(
            NginxPushTask.id == task_id,
            NginxPushTask.nginx_config_id == config_id,
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="推送任务不存在")
    return row


def _resolve_push_actor(db: Session, config_id: int, purpose: str, authorization: str | None) -> str:
    """推送接口认证：优先 JWT 用户名；否则校验一次性 token（匹配 config+purpose、未用、未过期），
    使用后立即标记消耗。均失败抛 401。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="缺少认证信息")
    raw = authorization.split(" ", 1)[1].strip()
    try:
        payload = decode_token(raw)
        return f"user:{payload.get('sub', '')}"
    except Exception:  # noqa: BLE001 非 JWT → 尝试一次性 token
        pass
    row = db.execute(
        select(NginxPushToken).where(
            NginxPushToken.nginx_config_id == config_id,
            NginxPushToken.purpose == purpose,
            NginxPushToken.token_hash == hashlib.sha256(raw.encode()).hexdigest(),
            NginxPushToken.used_at.is_(None),
        )
    ).scalar_one_or_none()
    if row is None or row.expires_at < datetime.utcnow():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="一次性 token 无效、已使用或已过期")
    row.used_at = datetime.utcnow()
    db.commit()
    return f"pushtoken:{row.id}"


@config_tree_router.post("/{config_id}/push-tokens")
def create_push_token(
    config_id: int,
    purpose: str = Query(..., pattern="^(preview|apply)$"),
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """签发一次性推送 token（需 JWT）；同 config+purpose 的旧未用 token 立即作废。"""
    now = datetime.utcnow()
    for old in db.execute(
        select(NginxPushToken).where(
            NginxPushToken.nginx_config_id == config_id,
            NginxPushToken.purpose == purpose,
            NginxPushToken.used_at.is_(None),
        )
    ).scalars().all():
        old.used_at = now  # 作废旧 token
    raw = secrets.token_urlsafe(32)
    row = NginxPushToken(
        nginx_config_id=config_id,
        purpose=purpose,
        token_hash=hashlib.sha256(raw.encode()).hexdigest(),
        expires_at=now + timedelta(minutes=10),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"token": raw, "purpose": purpose, "expires_at": row.expires_at.isoformat()}


@config_tree_router.post("/{config_id}/push/preview")
def push_preview(
    config_id: int,
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """阶段一：只读解析 + 差异对比，落一条 pending 任务（不写入配置树）。
    认证支持 JWT 或一次性 preview token（使用即消耗）。"""
    actor = _resolve_push_actor(db, config_id, "preview", authorization)
    raw = file.file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")
    root, errors = parse_nginx(text)
    if errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"errors": errors},
        )
    ctx = context_of_config(db, config_id)
    db_root = build_config_dict(db, config_id, context=ctx)
    entries, dup_errors = compute_diff(root, db_root)
    if dup_errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"errors": dup_errors},
        )
    counts = {"replace": 0, "new": 0, "none": 0, "keep": 0}
    for e in entries:
        counts[e["action"]] += 1
    task = NginxPushTask(
        nginx_config_id=config_id,
        status="pending",
        raw_text=text,
        diff_json=json.dumps(entries, ensure_ascii=False),
        created_by=actor,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return {
        "ok": True,
        "task_id": task.id,
        "status": task.status,
        "diff": entries,
        "counts": counts,
        "message": (
            f"预览成功：将替换 {counts['replace']} 个、新建 {counts['new']} 个、"
            f"无变化 {counts['none']} 个；系统保留 {counts['keep']} 个"
        ),
    }


@config_tree_router.post("/{config_id}/push/{task_id}/apply")
def push_apply(
    config_id: int,
    task_id: int,
    payload: PushApplyRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """阶段二：确认提交。事务内替换/新建 + 镜像联动 + 强制新版本；失败整体回滚。
    认证支持 JWT 或一次性 apply token（使用即消耗）。"""
    _resolve_push_actor(db, config_id, "apply", authorization)
    task = _get_push_task(db, config_id, task_id)
    if task.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"任务状态为 {task.status}，不可提交",
        )
    ctx = context_of_config(db, config_id)
    root, errors = parse_nginx(task.raw_text)
    if errors:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="原文解析异常，任务无效")
    db_root = build_config_dict(db, config_id, context=ctx)
    entries, dup_errors = compute_diff(root, db_root)
    if dup_errors:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="原文重复定义，任务无效")
    # 竞态保护：预览后配置若被修改 → 差异变化 → 拒绝并要求重新预览
    if json.dumps(entries, ensure_ascii=False) != task.diff_json:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="配置在预览后已被修改，差异已变化，请重新预览后再提交",
        )
    if not any(e["action"] in ("replace", "new") for e in entries):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="无变更可提交（仅存在无变化/保留项）",
        )
    task.status = "applying"
    db.flush()
    try:
        applied = perform_apply(db, config_id, root, entries)
        snapshot_config(db, config_id, force_new=True, commit=False, context=ctx)
        task.status = "success"
        task.applied_at = datetime.utcnow()
        task.error_detail = None
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        db.expire_all()
        task = _get_push_task(db, config_id, task_id)
        task.status = "failed"
        task.error_detail = str(exc)
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"提交失败，已整体回滚：{exc}",
        )
    mirrored = applied["mirrored"]
    return {
        "ok": True,
        "task_id": task.id,
        "status": "success",
        "applied": [{"scope": e["scope"], "display": e["display"]} for e in applied["applied"]],
        "mirrored": mirrored,
        "message": (
            f"已提交：替换/新建 {len(applied['applied'])} 项"
            + (f"，镜像同步 {len(mirrored)} 对" if mirrored else "")
        ),
    }


@config_tree_router.get("/{config_id}/push-tasks")
def list_push_tasks(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[dict]:
    rows = list(
        db.execute(
            select(NginxPushTask)
            .where(NginxPushTask.nginx_config_id == config_id)
            .order_by(NginxPushTask.id.desc())
            .limit(50)
        ).scalars().all()
    )
    return [_task_summary(t) for t in rows]


@config_tree_router.get("/{config_id}/push-tasks/{task_id}")
def get_push_task(
    config_id: int,
    task_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    t = _get_push_task(db, config_id, task_id)
    summary = _task_summary(t)
    summary["raw_text"] = t.raw_text
    return summary


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
    _auto_archive(db, _get_block(db, row.block_id).nginx_config_id)
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
    _auto_archive(db, _get_block(db, payload.block_id).nginx_config_id)
    return {"message": "重排成功"}


@options_router.put("/{option_id}", response_model=ConfigOptionOut)
def update_option(
    option_id: int,
    payload: ConfigOptionUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> ConfigOption:
    row = get_option(option_id, db=db)
    cfg_id = _config_id_of_option(db, option_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(row, field, value)
    db.commit()
    db.refresh(row)
    _auto_archive(db, cfg_id)
    return row


@options_router.delete("/{option_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_option(
    option_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    cfg_id = _config_id_of_option(db, option_id)
    db.delete(get_option(option_id, db=db))
    db.commit()
    _auto_archive(db, cfg_id)


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
    """聚合 location 内 proxy_pass 引用的 upstream 组名（复刻 mock proxyTargets L1073-1077 + proxyHostOf L1079-1086）。"""
    out, seen = [], set()
    for c in node.get("children", []):
        if c.get("scope") != "location":
            continue
        for o in c.get("options", []):
            if o.get("directive") != "proxy_pass":
                continue
            m = _re.search(r"//([^/:$]+)", o.get("value") or "")
            if not m:
                continue
            host = m.group(1)
            # IP 直连 / 域名直连（含 . 或 /）不构成 upstream 组名引用
            if _re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host) or _re.search(r"[./]", host):
                continue
            if host not in seen:
                seen.add(host)
                out.append(host)
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
            up_name = _re.sub(r"^upstream\s+", "", top.get("header", "")).strip().rstrip("{").strip()
            upstreams.append({"id": top.get("id"), "name": up_name, "backends": backends})
    return {"domains": domains, "listeners": listeners, "upstreams": upstreams, "links": links}


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
