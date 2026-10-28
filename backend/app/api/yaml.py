"""YAML 配置管理 API：行业作用域 CRUD + 版本/回滚 + 结构树 + 两阶段推送。

复用 nginx 推送范式（preview 只算不改、apply 落库留痕、一次性 token、
乐观版本快照），仅存储单元为通用 YAML 原文 content_text。
"""

import hashlib
import json
import logging
import secrets
from datetime import datetime, timedelta

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.security import decode_token, get_current_user
from app.models.user import User
from app.models.yaml import (
    YamlConfig,
    YamlConfigVersion,
    YamlPushTask,
    YamlPushToken,
)
from app.schemas.yaml import (
    YamlConfigCreate,
    YamlConfigListItem,
    YamlConfigOut,
    YamlConfigSave,
    YamlConfigVersionOut,
    YamlPushApplyRequest,
    YamlRollbackRequest,
)
from app.services.yaml_push import (
    analyze,
    compose_yaml,
    compute_diff,
    parse_tree,
    validate_yaml,
)

logger = logging.getLogger("yaml")

router = APIRouter(prefix="/api/yaml-configs", tags=["YAML 配置"])


def _get_config(db: Session, config_id: int) -> YamlConfig:
    row = db.execute(
        select(YamlConfig).where(YamlConfig.id == config_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="YAML 配置不存在")
    return row


def _snapshot(
    db: Session,
    config_id: int,
    version: int,
    content: str,
    note: str,
    created_by: str | None,
) -> YamlConfigVersion:
    """落一条版本快照（version 为落库后的新版本号）。"""
    row = YamlConfigVersion(
        yaml_config_id=config_id,
        version=version,
        content=content,
        note=note or "",
        created_by=created_by,
    )
    db.add(row)
    db.flush()
    return row


def _delete_config_cascade(db: Session, cfg: YamlConfig) -> None:
    """删除配置及其全部版本/任务/令牌（无外键级联，手动按序清理）。"""
    for row in db.execute(
        select(YamlPushToken).where(YamlPushToken.yaml_config_id == cfg.id)
    ).scalars().all():
        db.delete(row)
    for row in db.execute(
        select(YamlPushTask).where(YamlPushTask.yaml_config_id == cfg.id)
    ).scalars().all():
        db.delete(row)
    for row in db.execute(
        select(YamlConfigVersion).where(YamlConfigVersion.yaml_config_id == cfg.id)
    ).scalars().all():
        db.delete(row)
    db.delete(cfg)


# ---- 基础 CRUD（均需登录）----


def _top_array_len(text: str, key: str) -> int:
    """从原文解析顶层指定键的数组长度（例如 hosts/clusters）。解析失败返回 0。"""
    errors = validate_yaml(text)
    if errors:
        return 0
    try:
        doc = compose_yaml(text)
    except Exception:  # noqa: BLE001
        return 0
    from yaml.nodes import MappingNode, SequenceNode, ScalarNode

    if not isinstance(doc, MappingNode):
        return 0
    for k, v in doc.value:
        if isinstance(k, ScalarNode) and k.value == key and isinstance(v, SequenceNode):
            return len(v.value)
    return 0


@router.get("/stats-by-industry")
def yaml_stats_by_industry(
    industry_ids: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """批量统计：一次返回所有指定行业的真实 YAML 配置数、主机数、集群数。

    返回 {industry_id: {yml_count, hosts, clusters, total_nodes}} 映射。
    industry_ids 可选（逗号分隔数字）；不传则统计全部行业。
    """
    rows = list(
        db.execute(select(YamlConfig)).scalars().all()
    )
    if industry_ids:
        wanted = set()
        for s in industry_ids.split(","):
            try:
                wanted.add(int(s.strip()))
            except ValueError:
                continue
        rows = [r for r in rows if r.industry_id in wanted]

    out: dict[int, dict] = {}
    for r in rows:
        info = analyze(r.content_text)
        agg = out.setdefault(
            r.industry_id,
            {"yml_count": 0, "hosts": 0, "clusters": 0, "total_nodes": 0},
        )
        agg["yml_count"] += 1
        agg["total_nodes"] += info["node_count"]
        agg["hosts"] = max(agg["hosts"], _top_array_len(r.content_text, "hosts"))
        agg["clusters"] = max(agg["clusters"], _top_array_len(r.content_text, "clusters"))
    return out


@router.get("", response_model=list[YamlConfigListItem])
def list_yaml_configs(
    industry_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[dict]:
    """按行业列出 YAML 配置（含解析统计，供列表展示；不含全文）。"""
    rows = list(
        db.execute(
            select(YamlConfig)
            .where(YamlConfig.industry_id == industry_id)
            .order_by(YamlConfig.id)
        ).scalars().all()
    )
    out: list[dict] = []
    for r in rows:
        info = analyze(r.content_text)
        out.append(
            {
                "id": r.id,
                "industry_id": r.industry_id,
                "name": r.name,
                "description": r.description,
                "status": r.status,
                "version": r.version,
                "updated_at": r.updated_at,
                "valid": info["valid"],
                "line_count": info["line_count"],
                "node_count": info["node_count"],
                "top_keys": info["top_keys"],
            }
        )
    return out


@router.post("", response_model=YamlConfigOut, status_code=status.HTTP_201_CREATED)
def create_yaml_config(
    payload: YamlConfigCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> YamlConfig:
    """新建配置：携带内容则按语法校验定状态并生成 v1 快照。"""
    exists = db.execute(
        select(YamlConfig).where(
            YamlConfig.industry_id == payload.industry_id,
            YamlConfig.name == payload.name,
        )
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该行业下已存在同名 YAML 配置",
        )
    content = payload.content or ""
    errors = validate_yaml(content) if content.strip() else []
    cfg = YamlConfig(
        industry_id=payload.industry_id,
        name=payload.name,
        description=payload.description,
        content_text=content,
        status="invalid" if errors else "enabled",
        version=1,
        created_by=current_user.username,
    )
    db.add(cfg)
    db.flush()
    _snapshot(db, cfg.id, 1, content, note="新建（首次入库）", created_by=current_user.username)
    db.commit()
    db.refresh(cfg)
    return cfg


@router.get("/{config_id}", response_model=YamlConfigOut)
def get_yaml_config(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> YamlConfig:
    return _get_config(db, config_id)


@router.put("/{config_id}", response_model=YamlConfigOut)
def save_yaml_config(
    config_id: int,
    payload: YamlConfigSave,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> YamlConfig:
    """全文编辑保存：乐观锁 + 语法校验；校验失败且未强制草稿时 422 拦截。"""
    cfg = _get_config(db, config_id)
    if cfg.version != payload.expected_version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="内容已被他人修改（版本号不匹配），请刷新后重试",
        )
    errors = validate_yaml(payload.content)
    if errors and not payload.force_draft:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"errors": errors, "message": "语法校验未通过，可返回原文选择「仍以原文保存为草稿」"},
        )
    cfg.content_text = payload.content
    cfg.status = "invalid" if errors else "enabled"
    cfg.version += 1
    note = payload.note or ("保存为草稿（语法异常）" if errors else "全文编辑保存")
    _snapshot(db, cfg.id, cfg.version, cfg.content_text, note, current_user.username)
    db.commit()
    db.refresh(cfg)
    return cfg


@router.delete("/{config_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_yaml_config(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    _delete_config_cascade(db, _get_config(db, config_id))
    db.commit()


# ---- 版本快照：列表 / 回滚 ----


@router.get("/{config_id}/versions", response_model=list[YamlConfigVersionOut])
def list_yaml_versions(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[YamlConfigVersion]:
    _get_config(db, config_id)
    return list(
        db.execute(
            select(YamlConfigVersion)
            .where(YamlConfigVersion.yaml_config_id == config_id)
            .order_by(YamlConfigVersion.version.desc())
        ).scalars().all()
    )


@router.post("/{config_id}/rollback", response_model=YamlConfigOut)
def rollback_yaml_config(
    config_id: int,
    payload: YamlRollbackRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> YamlConfig:
    """回滚到指定版本：以该版本原文生成一次保存（生成新版本，而非覆盖历史）。"""
    cfg = _get_config(db, config_id)
    target = db.execute(
        select(YamlConfigVersion).where(
            YamlConfigVersion.yaml_config_id == config_id,
            YamlConfigVersion.version == payload.version,
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="目标版本不存在，请从版本列表重新选择")
    errors = validate_yaml(target.content)
    cfg.content_text = target.content
    cfg.status = "invalid" if errors else "enabled"
    cfg.version += 1
    note = payload.note or f"回滚至 v{payload.version}"
    _snapshot(db, cfg.id, cfg.version, target.content, note, current_user.username)
    db.commit()
    db.refresh(cfg)
    return cfg


# ---- 结构化树（结构面板）----


@router.get("/{config_id}/tree")
def get_yaml_tree(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """原文 → 结构化树；语法非法时返回错误清单（宽松模式：原文照常可浏览/编辑）。"""
    cfg = _get_config(db, config_id)
    errors = validate_yaml(cfg.content_text)
    if errors:
        return {"valid": False, "errors": errors, "tree": []}
    try:
        tree = parse_tree(cfg.content_text)
    except Exception as exc:  # noqa: BLE001 解析兜底，不阻断页面
        logger.warning("YAML 结构解析失败 config_id=%s: %s", config_id, exc)
        return {
            "valid": False,
            "errors": [{"line": 0, "col": 0, "reason": f"结构解析失败：{exc}"}],
            "tree": [],
        }
    return {"valid": True, "errors": [], "tree": tree}


# ---- 推送（两阶段 preview/apply + 一次性 token）----


def _task_summary(t: YamlPushTask) -> dict:
    try:
        diff = json.loads(t.diff_json or "[]")
    except Exception:  # noqa: BLE001
        diff = []
    return {
        "id": t.id,
        "yaml_config_id": t.yaml_config_id,
        "status": t.status,
        "raw_len": len(t.raw_text or ""),
        "diff": diff,
        "created_by": t.created_by,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "applied_at": t.applied_at.isoformat() if t.applied_at else None,
        "error_detail": t.error_detail,
    }


def _get_push_task(db: Session, config_id: int, task_id: int) -> YamlPushTask:
    row = db.execute(
        select(YamlPushTask).where(
            YamlPushTask.id == task_id,
            YamlPushTask.yaml_config_id == config_id,
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
        select(YamlPushToken).where(
            YamlPushToken.yaml_config_id == config_id,
            YamlPushToken.purpose == purpose,
            YamlPushToken.token_hash == hashlib.sha256(raw.encode()).hexdigest(),
            YamlPushToken.used_at.is_(None),
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="一次性 token 无效或已使用，请在推送弹窗重新生成",
        )
    if row.expires_at < datetime.utcnow():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="一次性 token 已过期（签发后 30 分钟有效），请在推送弹窗重新生成",
        )
    row.used_at = datetime.utcnow()
    db.commit()
    return f"pushtoken:{row.id}"


@router.post("/{config_id}/push-tokens")
def create_yaml_push_token(
    config_id: int,
    purpose: str = Query(..., pattern="^(preview|apply)$"),
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> dict:
    """签发一次性推送 token（需 JWT）；同 config+purpose 的旧未用 token 立即作废。"""
    _get_config(db, config_id)
    now = datetime.utcnow()
    for old in db.execute(
        select(YamlPushToken).where(
            YamlPushToken.yaml_config_id == config_id,
            YamlPushToken.purpose == purpose,
            YamlPushToken.used_at.is_(None),
        )
    ).scalars().all():
        old.used_at = now  # 作废旧 token
    raw = secrets.token_urlsafe(32)
    row = YamlPushToken(
        yaml_config_id=config_id,
        purpose=purpose,
        token_hash=hashlib.sha256(raw.encode()).hexdigest(),
        expires_at=now + timedelta(minutes=30),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"token": raw, "purpose": purpose, "expires_at": row.expires_at.isoformat()}


@router.get("/{config_id}/push-tasks")
def list_yaml_push_tasks(
    config_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[dict]:
    rows = list(
        db.execute(
            select(YamlPushTask)
            .where(YamlPushTask.yaml_config_id == config_id)
            .order_by(YamlPushTask.id.desc())
        ).scalars().all()
    )
    return [_task_summary(t) for t in rows]


@router.post("/{config_id}/push/preview")
def yaml_push_preview(
    config_id: int,
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
    request: Request = None,
    db: Session = Depends(get_db),
) -> dict:
    """阶段一：只读解析 + 键路径 diff + 落 pending 任务。

    - 有变更（替换/新建/删除）：落一条 pending 任务，返回 task_id + apply 命令；
    - 无变更：不落任务，返回 changed=false。
    认证支持 JWT 或一次性 preview token（使用即消耗）。"""
    actor = _resolve_push_actor(db, config_id, "preview", authorization)
    raw = file.file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")
    errors = validate_yaml(text)
    if errors:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"errors": errors, "message": "YAML 语法校验未通过，文件整体拒绝，不产生任何入库副作用"},
        )
    cfg = _get_config(db, config_id)
    entries, counts = compute_diff(text, cfg.content_text)
    if counts["replace"] == 0 and counts["new"] == 0 and counts["delete"] == 0:
        return {
            "ok": True,
            "changed": False,
            "diff": entries,
            "counts": counts,
            "message": "文件与当前配置一致，无变更点，无需提交",
        }
    # 并发保护：同一配置同时只允许一个进行中的推送任务
    pending = db.execute(
        select(YamlPushTask).where(
            YamlPushTask.yaml_config_id == config_id,
            YamlPushTask.status == "pending",
        )
    ).scalar_one_or_none()
    if pending is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"已有待提交任务 #{pending.id}，请先完成或取消后再推送",
        )
    task = YamlPushTask(
        yaml_config_id=config_id,
        status="pending",
        raw_text=text,
        diff_json=json.dumps(entries, ensure_ascii=False),
        created_by=actor,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    base = str(request.base_url).rstrip("/") if request else ""
    apply_cmd = (
        f'curl -X POST "{base}/api/yaml-configs/{config_id}/push/{task.id}/apply" \\\n'
        f'  -H "Authorization: Bearer <APPLY_TOKEN>" \\\n'
        f'  -H "Content-Type: application/json" -d "{{}}"'
    )
    return {
        "ok": True,
        "changed": True,
        "task_id": task.id,
        "status": task.status,
        "diff": entries,
        "counts": counts,
        "apply_command": apply_cmd,
        "message": (
            f"预览成功：将替换 {counts['replace']} 个、新建 {counts['new']} 个、"
            f"删除 {counts['delete']} 个；无变化 {counts['keep']} 个"
        ),
    }


@router.post("/{config_id}/push/{task_id}/apply")
def yaml_push_apply(
    config_id: int,
    task_id: str,
    payload: YamlPushApplyRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """阶段二：确认提交。事务内更新原文 + 强制新版本快照；失败整体回滚。"""
    try:
        task_id = int(task_id)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="task_id 必须是预览返回的任务号（数字）；请把 URL 里的 <task_id> 占位符替换为实际任务号",
        )
    actor = _resolve_push_actor(db, config_id, "apply", authorization)
    task = _get_push_task(db, config_id, task_id)
    if task.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"任务状态为 {task.status}，不可提交",
        )
    cfg = _get_config(db, config_id)
    errors = validate_yaml(task.raw_text)
    if errors:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="原文解析异常，任务无效")
    entries, counts = compute_diff(task.raw_text, cfg.content_text)
    # 竞态保护：预览后配置若被修改 → 差异变化 → 拒绝并要求重新预览
    if json.dumps(entries, ensure_ascii=False) != task.diff_json:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="配置在预览后已被修改，差异已变化，请重新预览后再提交",
        )
    if counts["replace"] == 0 and counts["new"] == 0 and counts["delete"] == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="该任务无任何变更（文件与线上配置一致），无需提交",
        )
    task.status = "applying"
    db.flush()
    try:
        cfg.content_text = task.raw_text
        cfg.status = "enabled"
        cfg.version += 1
        _snapshot(db, cfg.id, cfg.version, cfg.content_text, payload.note or "推送提交", actor)
        task.status = "applied"
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
    return {
        "ok": True,
        "task_id": task.id,
        "status": "applied",
        "new_version": cfg.version,
        "message": (
            f"已提交：更新 {counts['replace'] + counts['new'] + counts['delete']} 个节点，"
            f"生成版本快照 v{cfg.version}"
        ),
    }
