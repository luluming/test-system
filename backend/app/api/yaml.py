"""YAML 配置管理 API：行业作用域 CRUD + 版本/回滚 + 结构树 + 两阶段推送。

复用 nginx 推送范式（preview 只算不改、apply 落库留痕、一次性 token、
乐观版本快照），仅存储单元为通用 YAML 原文 content_text。
"""

import difflib
import hashlib
import io
import json
import logging
import re
import secrets
import tarfile
import zipfile
from collections import Counter
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
from fastapi.responses import PlainTextResponse, StreamingResponse
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.permissions import (
    get_project_perm,
    require_project_edit,
    require_project_view,
    resolve_project_for_config,
    visible_project_ids,
)
from app.core.security import create_access_token, decode_token, get_current_user
from app.models import Industry
from app.models.project import Project
from app.models.user import User
from app.models.yaml import (
    YamlConfig,
    YamlConfigVersion,
    YamlPushDiff,
    YamlPushTask,
    YamlPushToken,
)
from app.schemas.yaml import (
    ImportZipResult,
    NacosViewRow,
    PushDiffResolveRequest,
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
from app.seed import seed_yaml_configs

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
    """删除配置及其全部版本/任务/令牌（无 ORM 关系，按外键依赖顺序显式删）。

    注意：必须用 SQL 级 delete 逐表顺序执行。若用 db.delete(对象) 依赖 unit-of-work
    推断顺序，而模型上未声明 relationship，会先删父表触发外键约束 500。
    """
    db.execute(delete(YamlPushToken).where(YamlPushToken.yaml_config_id == cfg.id))
    db.execute(delete(YamlPushTask).where(YamlPushTask.yaml_config_id == cfg.id))
    db.execute(delete(YamlPushDiff).where(YamlPushDiff.config_id == cfg.id))
    db.execute(delete(YamlConfigVersion).where(YamlConfigVersion.yaml_config_id == cfg.id))
    db.flush()
    db.execute(delete(YamlConfig).where(YamlConfig.id == cfg.id))


# ---- 基础 CRUD（按配置归属项目做权限控制）----


def _resolve_target_project(
    db: Session, user: User, industry_id: int, project_id: int | None
) -> Project:
    """新建配置的归属项目：指定则校验编辑权限与行业一致；否则落行业默认项目。"""
    if project_id is not None:
        project = require_project_edit(db, user, project_id)
        if project.industry_id != industry_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="所选项目不属于该行业",
            )
        return project
    from app.seed import get_or_create_default_project  # 延迟导入避免循环

    admin = db.execute(select(User).where(User.role == "admin")).scalars().first()
    project = get_or_create_default_project(
        db, industry_id, admin.id if admin else user.id
    )
    require_project_edit(db, user, project.id)
    return project


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
    current_user: User = Depends(get_current_user),
) -> dict:
    """批量统计：一次返回所有指定行业的真实 YAML 配置数、主机数、集群数。

    返回 {industry_id: {yml_count, hosts, clusters, total_nodes}} 映射。
    industry_ids 可选（逗号分隔数字）；不传则统计全部行业。
    非管理员仅统计其有权限查看的项目下的配置。
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

    visible_cache: dict[int, set[int] | None] = {}
    out: dict[int, dict] = {}
    for r in rows:
        if current_user.role != "admin":
            if r.industry_id not in visible_cache:
                visible_cache[r.industry_id] = visible_project_ids(
                    db, current_user, r.industry_id
                )
            vis = visible_cache[r.industry_id]
            if vis is not None and r.project_id not in vis:
                continue
        info = analyze(r.content_text, format_hint=_config_format(r.name))
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
    project_id: int | None = None,
    exclude_nacos_imported: bool = Query(
        default=False,
        description="为 True 时排除从 Nacos tenant-config-data 目录导入的配置（description 以 nacos: 开头），"
                    "仅返回项目原生 YAML。YML 工作台应传 True，Nacos 配置页传 False。",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """按行业列出 YAML 配置（含解析统计，供列表展示；不含全文）。

    project_id 可选：指定则仅列该项目（需可查看权限）；不指定时
    非管理员仅能看到其有权限项目下的配置。
    """
    stmt = select(YamlConfig).where(YamlConfig.industry_id == industry_id)
    if project_id is not None:
        require_project_view(db, current_user, project_id)
        stmt = stmt.where(YamlConfig.project_id == project_id)
    if exclude_nacos_imported:
        stmt = stmt.where(
            (YamlConfig.description.is_(None))
            | (~YamlConfig.description.like("nacos:%"))
        )
    rows = list(db.execute(stmt.order_by(YamlConfig.id)).scalars().all())
    if project_id is None and current_user.role != "admin":
        vis = visible_project_ids(db, current_user, industry_id) or set()
        rows = [r for r in rows if r.project_id in vis]
    out: list[dict] = []
    for r in rows:
        info = analyze(r.content_text, format_hint=_config_format(r.name))
        out.append(
            {
                "id": r.id,
                "industry_id": r.industry_id,
                "name": r.name,
                "group": r.group,
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
    """新建配置：携带内容则按语法校验定状态并生成 v1 快照；归属项目按权限解析。"""
    project = _resolve_target_project(
        db, current_user, payload.industry_id, payload.project_id
    )
    exists = db.execute(
        select(YamlConfig).where(
            YamlConfig.project_id == project.id,
            YamlConfig.name == payload.name,
        )
    ).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该项目下已存在同名 YAML 配置",
        )
    content = payload.content or ""
    # 仅 YAML 格式做语法校验：properties/json/text 原文不属于 YAML 语法
    errors = (
        validate_yaml(content)
        if _config_format(payload.name) == "yaml" and content.strip()
        else []
    )
    cfg = YamlConfig(
        industry_id=payload.industry_id,
        project_id=project.id,
        name=payload.name,
        group=payload.group or "DEFAULT_GROUP",
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


# ---- Nacos 风格配置管理（命名空间/分组/dataId，注册在 /{config_id} 之前）----


def _config_format(name: str) -> str:
    """按 dataId 后缀推断配置格式。"""
    low = name.lower()
    if low.endswith((".yml", ".yaml")):
        return "yaml"
    if low.endswith(".properties"):
        return "properties"
    if low.endswith(".json"):
        return "json"
    return "text"


@router.get("/nacos-view", response_model=list[NacosViewRow])
def nacos_view(
    project_id: int | None = None,
    industry_id: int | None = None,
    data_id: str = "",
    group: str = "",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[NacosViewRow]:
    """Nacos 控制台风格配置列表：命名空间（项目）→ group → dataId。

    project_id 指定命名空间；data_id / group 为模糊过滤；
    非管理员仅返回其有查看权限项目下的配置。
    """
    stmt = select(YamlConfig)
    if industry_id is not None:
        stmt = stmt.where(YamlConfig.industry_id == industry_id)
    if project_id is not None:
        stmt = stmt.where(YamlConfig.project_id == project_id)
    rows = list(
        db.execute(stmt.order_by(YamlConfig.project_id, YamlConfig.name)).scalars().all()
    )
    if current_user.role != "admin":
        vis_cache: dict[int, set[int] | None] = {}
        kept = []
        for r in rows:
            if r.industry_id not in vis_cache:
                vis_cache[r.industry_id] = visible_project_ids(
                    db, current_user, r.industry_id
                )
            vis = vis_cache[r.industry_id]
            if vis is not None and r.project_id not in vis:
                continue
            kept.append(r)
        rows = kept
    if data_id:
        rows = [r for r in rows if data_id.lower() in r.name.lower()]
    if group:
        rows = [r for r in rows if group.lower() in (r.group or "").lower()]

    pids = {r.project_id for r in rows if r.project_id}
    projects = (
        {p.id: p for p in db.execute(select(Project).where(Project.id.in_(pids))).scalars().all()}
        if pids
        else {}
    )
    return [
        NacosViewRow(
            id=r.id,
            project_id=r.project_id or 0,
            project_name=projects[r.project_id].name if r.project_id in projects else "",
            industry_id=r.industry_id,
            data_id=r.name,
            group=r.group or "DEFAULT_GROUP",
            format=_config_format(r.name),
            status=r.status,
            version=r.version,
            updated_at=r.updated_at,
            description=r.description,
        )
        for r in rows
    ]


@router.post("/import-zip", response_model=ImportZipResult)
async def import_nacos_zip(
    industry_id: int,
    file: UploadFile = File(...),
    project_id: int | None = None,
    conflict: str = "skip",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ImportZipResult:
    """导入 Nacos 配置 ZIP，兼容两种目录形态（自动识别）：

    - 三层：``tenant-config-data/{tenant}/{group}/{dataId}``（服务端磁盘快照）
      → 按命名空间（tenant）自动创建项目，group 记入配置分组；
    - 两层：``{group}/{dataId}``（Nacos 控制台导出格式）
      → 全部导入到 project_id 指定项目（命名空间）。

    conflict=skip 同名跳过 | overwrite 覆盖为新版本（可回滚）。
    """
    if conflict not in ("skip", "overwrite"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="conflict 仅支持 skip / overwrite"
        )
    industry = db.execute(
        select(Industry).where(Industry.id == industry_id)
    ).scalar_one_or_none()
    if industry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="行业不存在")

    raw = await file.read()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="ZIP 超过 20MB 上限"
        )
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="无效的 ZIP 文件")

    META_NAMES = {"meta.json", "meta.yaml", ".meta.yml"}
    entries: list[tuple[str | None, str, str, str]] = []
    skipped_files: list[str] = []
    for info in zf.infolist():
        if info.is_dir():
            continue
        path = info.filename.replace("\\", "/")
        segs = [s for s in path.split("/") if s]
        if not segs:
            continue
        base = segs[-1]
        if base.startswith(".") or base in META_NAMES or "~" in base:
            continue  # 隐藏文件 / 元信息 / beta~、tag~ 灰度数据
        if segs[0].endswith("-config-data"):
            segs = segs[1:]  # 去掉 tenant-config-data / config-data 根目录
        if len(segs) >= 3:
            tenant, grp, data_id = segs[0], segs[1], "/".join(segs[2:])
        elif len(segs) == 2:
            tenant, grp, data_id = None, segs[0], segs[1]
        else:
            continue  # 根目录散文件不构成 Nacos 结构，忽略
        if info.file_size > 1024 * 1024:
            skipped_files.append(f"{path}（超过 1MB）")
            continue
        if len(data_id) > 100:
            data_id = data_id[:97] + "..."
        try:
            content = zf.read(info).decode("utf-8")
        except UnicodeDecodeError:
            content = zf.read(info).decode("utf-8", errors="replace")
        entries.append((tenant, grp, data_id, content))

    if not entries:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ZIP 中未识别到任何 {group}/{dataId} 结构的配置文件",
        )
    if len(entries) > 500:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"单次最多导入 500 个文件（当前 {len(entries)} 个）",
        )

    has_tenant = any(e[0] for e in entries)
    if not has_tenant and project_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="两层结构 ZIP 需要指定目标项目（命名空间）",
        )
    target_project = None
    if project_id is not None:
        require_project_edit(db, current_user, project_id)
        target_project = db.get(Project, project_id)
        if target_project is None or target_project.industry_id != industry_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="目标项目不存在或不属于该行业"
            )

    result = ImportZipResult(total=len(entries), mode="tenant" if has_tenant else "group")
    proj_cache: dict[str, Project] = {}
    used_codes: set[str] = set()
    existing_codes = set(
        db.execute(
            select(Project.code).where(Project.industry_id == industry_id)
        ).scalars().all()
    )
    used_codes |= existing_codes

    for tenant, grp, data_id, content in entries:
        try:
            if has_tenant:
                ns = tenant or grp  # 三层中缺 tenant 时以 group 兜底
                proj = proj_cache.get(ns)
                if proj is None:
                    proj = db.execute(
                        select(Project).where(
                            Project.industry_id == industry_id, Project.name == ns
                        )
                    ).scalar_one_or_none()
                    if proj is None:
                        base_code = re.sub(r"[^a-z0-9-]+", "-", ns.lower()).strip("-") or "ns"
                        code = base_code[:50] or "ns"
                        i = 2
                        while code in used_codes:
                            code = f"{base_code[:46]}-{i}"
                            i += 1
                        proj = Project(
                            industry_id=industry_id,
                            name=ns[:100],
                            code=code,
                            owner_id=current_user.id,
                            remark="Nacos ZIP 导入：命名空间自动创建",
                        )
                        db.add(proj)
                        db.flush()
                        used_codes.add(code)
                        result.projects_created += 1
                    proj_cache[ns] = proj
            else:
                proj = target_project

            exists = db.execute(
                select(YamlConfig).where(
                    YamlConfig.project_id == proj.id, YamlConfig.name == data_id
                )
            ).scalar_one_or_none()
            desc = f"nacos:tenant={tenant or ''},group={grp}"
            is_yaml = data_id.lower().endswith((".yml", ".yaml"))
            errors = (
                validate_yaml(content)
                if is_yaml and content.strip()
                else []
            )
            new_status = "invalid" if errors else "enabled"
            if exists is not None:
                if conflict == "skip":
                    result.skipped += 1
                    continue
                exists.content_text = content
                exists.description = desc
                exists.group = grp or "DEFAULT_GROUP"
                exists.status = new_status
                exists.version += 1
                _snapshot(
                    db,
                    exists.id,
                    exists.version,
                    content,
                    note="Nacos ZIP 导入覆盖",
                    created_by=current_user.username,
                )
                result.updated += 1
            else:
                cfg = YamlConfig(
                    industry_id=industry_id,
                    project_id=proj.id,
                    name=data_id,
                    group=grp or "DEFAULT_GROUP",
                    description=desc,
                    content_text=content,
                    status=new_status,
                    version=1,
                    created_by=current_user.username,
                )
                db.add(cfg)
                db.flush()
                _snapshot(
                    db,
                    cfg.id,
                    1,
                    content,
                    note="Nacos ZIP 导入",
                    created_by=current_user.username,
                )
                result.created += 1
        except Exception as exc:  # 单文件失败不阻断整体导入
            result.failed.append({"name": data_id, "reason": str(exc)[:120]})
    if skipped_files:
        result.failed.extend({"name": f, "reason": "文件超限跳过"} for f in skipped_files)
    db.commit()
    return result


@router.get("/export-zip")
def export_nacos_zip(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """按 Nacos 控制台导入格式导出项目配置：``{group}/{dataId}`` ZIP。

    恢复时在 Nacos 控制台选择目标命名空间导入该 ZIP 即可。
    """
    require_project_view(db, current_user, project_id)
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    rows = list(
        db.execute(select(YamlConfig).where(YamlConfig.project_id == project_id)).scalars().all()
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for r in rows:
            grp = (r.group or "DEFAULT_GROUP").strip() or "DEFAULT_GROUP"
            zf.writestr(f"{grp}/{r.name}", r.content_text)
    buf.seek(0)
    filename = f"nacos-{project.code or project.id}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/push-diffs")
def list_push_diffs(
    project_id: int | None = Query(None, description="只看某个命名空间"),
    status_: str = Query("pending", alias="status", description="pending | applied | ignored"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """推送差异统计：按 命名空间 → 分组 → 组件 聚合，返回总数与 +N -M。"""
    stmt = select(YamlPushDiff).where(YamlPushDiff.status == status_)
    if project_id:
        stmt = stmt.where(YamlPushDiff.project_id == project_id)
    rows = list(
        db.execute(
            stmt.order_by(
                YamlPushDiff.project_id, YamlPushDiff.group, YamlPushDiff.name
            )
        ).scalars().all()
    )
    projects = {p.id: p for p in db.execute(select(Project)).scalars().all()}
    if current_user.role == "admin":
        editable = set(projects)
    else:
        perms = {pid: get_project_perm(db, current_user, p) for pid, p in projects.items()}
        rows = [r for r in rows if perms.get(r.project_id) != "none"]
        editable = {pid for pid, perm in perms.items() if perm in ("owner", "edit", "admin")}

    by_project: dict[int, dict] = {}
    for r in rows:
        proj = projects.get(r.project_id)
        bucket = by_project.setdefault(
            r.project_id,
            {
                "project_id": r.project_id,
                "project_name": proj.name if proj else f"#{r.project_id}",
                "total": 0,
                "added": 0,
                "removed": 0,
                "groups": {},
            },
        )
        bucket["total"] += 1
        bucket["added"] += r.added
        bucket["removed"] += r.removed
        cfg = db.get(YamlConfig, r.config_id)
        bucket["groups"].setdefault(r.group or "DEFAULT_GROUP", []).append(
            {
                "id": r.id,
                "config_id": r.config_id,
                "name": r.name,
                "tenant": r.tenant,
                "group": r.group or "DEFAULT_GROUP",
                "added": r.added,
                "removed": r.removed,
                "base_version": r.base_version,
                "current_version": cfg.version if cfg else None,
                "batch_id": r.batch_id,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "can_edit": r.project_id in editable,
            }
        )

    out = []
    for b in by_project.values():
        b["groups"] = [
            {"group": g, "items": items} for g, items in b["groups"].items()
        ]
        out.append(b)
    out.sort(key=lambda x: x["project_name"])
    return {"total": len(rows), "by_project": out}


@router.post("/push-diffs/resolve")
def resolve_push_diffs(
    payload: PushDiffResolveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """批量处理推送差异：采用新推送（incoming）或保留当前（keep）。

    - 按 ids 精确处理，或 all=true 全部处理（可再按命名空间/分组收敛）；
    - 采用新推送时按 base_version 做乐观校验，期间被人工改过的配置跳过；
    - 无编辑权限的差异跳过并在结果中返回原因，不阻断同批其他项。
    """
    stmt = select(YamlPushDiff).where(YamlPushDiff.status == "pending")
    if payload.ids:
        stmt = stmt.where(YamlPushDiff.id.in_(payload.ids))
    elif payload.all:
        if payload.project_id:
            stmt = stmt.where(YamlPushDiff.project_id == payload.project_id)
        if payload.group:
            stmt = stmt.where(YamlPushDiff.group == payload.group)
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请选择要处理的差异，或指定全部处理",
        )

    rows = list(db.execute(stmt).scalars().all())
    applied = ignored = 0
    skipped: list[dict] = []
    for r in rows:
        try:
            require_project_edit(db, current_user, r.project_id)
        except HTTPException:
            skipped.append({"id": r.id, "name": r.name, "reason": "无编辑权限"})
            continue
        if payload.mode == "keep":
            r.status = "ignored"
            ignored += 1
            continue

        cfg = db.get(YamlConfig, r.config_id)
        if cfg is None:
            r.status = "ignored"
            skipped.append({"id": r.id, "name": r.name, "reason": "配置已不存在"})
            continue
        if cfg.version != r.base_version:
            skipped.append(
                {
                    "id": r.id,
                    "name": r.name,
                    "reason": f"配置已被修改（v{cfg.version} ≠ v{r.base_version}），请刷新或选择保留当前",
                }
            )
            continue
        cfg.content_text = r.incoming_content
        cfg.group = r.group or "DEFAULT_GROUP"
        cfg.description = f"nacos:tenant={r.tenant},group={cfg.group}"
        cfg.version += 1
        _snapshot(
            db,
            cfg.id,
            cfg.version,
            cfg.content_text,
            f"推送差异合并 · {r.batch_id or '-'} · +{r.added} -{r.removed}",
            current_user.username,
        )
        r.status = "applied"
        applied += 1

    db.commit()
    logger.info(
        "推送差异处理 mode=%s by=%s 采用=%s 保留=%s 跳过=%s",
        payload.mode, current_user.username, applied, ignored, len(skipped),
    )
    return {
        "total": len(rows),
        "applied": applied,
        "ignored": ignored,
        "skipped": skipped,
    }


@router.get("/{config_id}", response_model=YamlConfigOut)
def get_yaml_config(
    config_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> YamlConfig:
    cfg = _get_config(db, config_id)
    resolve_project_for_config(db, cfg, current_user, "view")
    return cfg


@router.put("/{config_id}", response_model=YamlConfigOut)
def save_yaml_config(
    config_id: int,
    payload: YamlConfigSave,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> YamlConfig:
    """全文编辑保存：乐观锁 + 语法校验；校验失败且未强制草稿时 422 拦截。"""
    cfg = _get_config(db, config_id)
    resolve_project_for_config(db, cfg, current_user, "edit")
    if cfg.version != payload.expected_version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="内容已被他人修改（版本号不匹配），请刷新后重试",
        )
    # 仅 YAML 格式校验语法；properties/json/text 直接按原文保存
    errors = validate_yaml(payload.content) if _config_format(cfg.name) == "yaml" else []
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
    current_user: User = Depends(get_current_user),
) -> None:
    cfg = _get_config(db, config_id)
    resolve_project_for_config(db, cfg, current_user, "edit")
    _delete_config_cascade(db, cfg)
    db.commit()


# ---- 版本快照：列表 / 回滚 ----


@router.get("/{config_id}/versions")
def list_yaml_versions(
    config_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """版本快照列表：附带与前一版的 diff 摘要（变更计数 + 前 5 个变更键路径）。

    前端用摘要在版本卡片上做轻量标记；点击打开弹窗再看全文详情。
    """
    cfg = _get_config(db, config_id)
    resolve_project_for_config(db, cfg, current_user, "view")
    versions = list(
        db.execute(
            select(YamlConfigVersion)
            .where(YamlConfigVersion.yaml_config_id == config_id)
            .order_by(YamlConfigVersion.version.desc())
        ).scalars().all()
    )
    # 按版本号升序建 map，方便取"前一版快照"
    prev_map = {v.version: v for v in versions}
    out: list[dict] = []
    for v in versions:
        entry, counts = [], {"replace": 0, "new": 0, "delete": 0, "keep": 0}
        prev = prev_map.get(v.version - 1)
        line_diff: list[dict] = []  # line-level diff [{type: 'keep'|'add'|'del', text}]
        if prev is not None:
            try:
                entry, counts = compute_diff(v.content, prev.content)
            except Exception:  # noqa: BLE001 解析失败时跳过摘要，不阻断列表
                entry, counts = [], {"replace": 0, "new": 0, "delete": 0, "keep": 0}
            # line-level unified diff：弹窗里按行高亮变更
            prev_lines = prev.content.splitlines(keepends=True)
            cur_lines = v.content.splitlines(keepends=True)
            sm = difflib.SequenceMatcher(a=prev_lines, b=cur_lines)
            for tag, i1, i2, j1, j2 in sm.get_opcodes():
                if tag == "equal":
                    line_diff.append({"type": "keep", "lines": cur_lines[j1:j2]})
                elif tag == "replace":
                    line_diff.append({"type": "del", "lines": prev_lines[i1:i2]})
                    line_diff.append({"type": "add", "lines": cur_lines[j1:j2]})
                elif tag == "delete":
                    line_diff.append({"type": "del", "lines": prev_lines[i1:i2]})
                elif tag == "insert":
                    line_diff.append({"type": "add", "lines": cur_lines[j1:j2]})
        changed = [e for e in entry if e["action"] != "keep"]
        # 截断：版本列表 hover tooltip 显示前 15 个变更键路径，弹窗可看完整 diff_preview
        preview_top = changed[:15]
        out.append(
            {
                "id": v.id,
                "version": v.version,
                "note": v.note,
                "content": v.content,
                "created_by": v.created_by,
                "created_at": v.created_at.isoformat() if v.created_at else None,
                "is_first": prev is None,
                "diff_counts": counts,
                "diff_preview": [{"path": e["path"], "action": e["action"]} for e in preview_top],
                "diff_preview_total": len(changed),
                "line_diff": line_diff,  # 弹窗中按行高亮
            }
        )
    return out


@router.post("/{config_id}/rollback", response_model=YamlConfigOut)
def rollback_yaml_config(
    config_id: int,
    payload: YamlRollbackRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> YamlConfig:
    """回滚到指定版本：以该版本原文生成一次保存（生成新版本，而非覆盖历史）。"""
    cfg = _get_config(db, config_id)
    resolve_project_for_config(db, cfg, current_user, "edit")
    target = db.execute(
        select(YamlConfigVersion).where(
            YamlConfigVersion.yaml_config_id == config_id,
            YamlConfigVersion.version == payload.version,
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="目标版本不存在，请从版本列表重新选择")
    errors = validate_yaml(target.content) if _config_format(cfg.name) == "yaml" else []
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
    current_user: User = Depends(get_current_user),
) -> dict:
    """原文 → 结构化树；语法非法时返回错误清单（宽松模式：原文照常可浏览/编辑）。"""
    cfg = _get_config(db, config_id)
    resolve_project_for_config(db, cfg, current_user, "view")
    # 非 YAML 格式（properties/json/text）不参与 YAML 语法解析，直接按纯文本展示
    if _config_format(cfg.name) != "yaml":
        return {"valid": True, "errors": [], "tree": [], "line_count": len((cfg.content_text or "").splitlines()), "text_mode": True}
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


def _resolve_push_actor(
    db: Session, config_id: int, purpose: str, authorization: str | None
) -> tuple[str, YamlPushToken | None]:
    """推送接口认证：优先 JWT 用户名；否则校验一次性 token（匹配 config+purpose、未用、未过期）。

    只做验证，不消耗 token；消耗延迟到操作成功后由调用方执行。
    返回 (actor_str, token_row_or_None)，后者为 None 表示走 JWT 认证。
    均失败抛 401。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="缺少认证信息")
    raw = authorization.split(" ", 1)[1].strip()
    try:
        payload = decode_token(raw)
        return f"user:{payload.get('sub', '')}", None
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
    return f"pushtoken:{row.id}", row


def _consume_token(db: Session, row: YamlPushToken | None) -> None:
    """一次性 token 延迟消耗：仅当业务操作成功后标记 used_at 并 commit。"""
    if row is None:
        return  # JWT 认证无 token 需消耗
    row.used_at = datetime.utcnow()
    db.commit()


@router.post("/{config_id}/push-tokens")
def create_yaml_push_token(
    config_id: int,
    purpose: str = Query(..., pattern="^(preview|apply)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """签发一次性推送 token（需 JWT + 项目可编辑权限）；同 config+purpose 的旧未用 token 立即作废。"""
    cfg = _get_config(db, config_id)
    resolve_project_for_config(db, cfg, current_user, "edit")
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
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    cfg = _get_config(db, config_id)
    resolve_project_for_config(db, cfg, current_user, "view")
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
    actor, token_row = _resolve_push_actor(db, config_id, "preview", authorization)
    raw = file.file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")
    cfg = _get_config(db, config_id)
    is_yaml = _config_format(cfg.name) == "yaml"
    if is_yaml:
        errors = validate_yaml(text)
        if errors:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"errors": errors, "message": "YAML 语法校验未通过，文件整体拒绝，不产生任何入库副作用"},
            )
        entries, counts = compute_diff(text, cfg.content_text)
    else:
        # properties / json / text：按纯文本逐行比对，不做 YAML 结构解析
        added, removed = _line_diff(cfg.content_text or "", text)
        entries, counts = [], {"replace": removed, "new": added, "delete": 0, "keep": 0}
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
    _consume_token(db, token_row)  # ← 仅 preview 成功落库后消耗
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


def _apply_pending_task(db: Session, config_id: int, task_id: int, note: str) -> dict:
    """校验 pending 任务并提交：更新原文 + 版本号 +1 + 快照；失败整体回滚。"""
    task = _get_push_task(db, config_id, task_id)
    if task.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"任务状态为 {task.status}，不可提交",
        )
    cfg = _get_config(db, config_id)
    if _config_format(cfg.name) == "yaml":
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
    else:
        # 非 YAML：按原文整体替换，只做「是否有变化」的竞态保护
        if (cfg.content_text or "") == task.raw_text:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="该任务无任何变更（文件与线上配置一致），无需提交",
            )
        added, removed = _line_diff(cfg.content_text or "", task.raw_text)
        entries, counts = [], {"replace": removed, "new": added, "delete": 0, "keep": 0}
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
        _snapshot(db, cfg.id, cfg.version, cfg.content_text, note, task.created_by)
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


@router.post("/{config_id}/push")
def yaml_push_direct(
    config_id: int,
    file: UploadFile = File(...),
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    """一步推送：上传文件 → 校验 → diff → 立即提交，等价于 preview + apply 合并为一次请求。

    认证支持 JWT 或一次性 apply token（使用即消耗）。文件与线上一致时返回 changed=false。
    """
    actor, token_row = _resolve_push_actor(db, config_id, "apply", authorization)
    raw = file.file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("gbk", errors="replace")
    cfg = _get_config(db, config_id)
    if _config_format(cfg.name) == "yaml":
        errors = validate_yaml(text)
        if errors:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"errors": errors, "message": "YAML 语法校验未通过，文件整体拒绝，不产生任何入库副作用"},
            )
        try:
            entries, counts = compute_diff(text, cfg.content_text)
        except Exception as e:  # noqa: BLE001 compose_yaml 可能与 validate_yaml 解析器不一致
            logger.warning("compute_diff 失败 config_id=%s err=%s", config_id, e)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"message": f"YAML 结构解析失败：{e!s}"},
            )
    else:
        # properties / json / text：纯文本逐行比对，不做 YAML 解析
        added, removed = _line_diff(cfg.content_text or "", text)
        entries, counts = [], {"replace": removed, "new": added, "delete": 0, "keep": 0}
    if counts["replace"] == 0 and counts["new"] == 0 and counts["delete"] == 0:
        return {
            "ok": True,
            "changed": False,
            "diff": entries,
            "counts": counts,
            "message": "文件与当前配置一致，无变更点，未做任何修改",
        }
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
    try:
        result = _apply_pending_task(db, config_id, task.id, "一步推送")
    except Exception as e:  # noqa: BLE001 回滚 DB 异常 → 任务标记 failed，整体返回 500 但带明确信息
        logger.exception("一步推送 apply 失败 config_id=%s task_id=%s", config_id, task.id)
        task.status = "failed"
        task.error_msg = f"apply 阶段异常：{e!s}"
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"message": f"推送应用失败（任务 #{task.id} 已标记失败）：{e!s}", "task_id": task.id},
        )
    _consume_token(db, token_row)  # ← 仅 apply 成功后消耗
    result["changed"] = True
    result["counts"] = counts
    result["message"] = (
        f"已推送：替换 {counts['replace']} 个、新建 {counts['new']} 个、"
        f"删除 {counts['delete']} 个，生成版本快照 v{result['new_version']}"
    )
    logger.info("YAML 一步推送成功 config_id=%s task_id=%s by=%s", config_id, task.id, actor)
    return result


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
    _actor, token_row = _resolve_push_actor(db, config_id, "apply", authorization)
    result = _apply_pending_task(db, config_id, task_id, payload.note or "推送提交")
    _consume_token(db, token_row)  # ← 仅 apply 成功后消耗
    return result


# ---- 整目录推送（curl + tar.gz）：一条命令把 Nacos 落盘目录全部同步进系统 ----


def _iter_tar_entries(raw: bytes) -> list[tuple[str, str, str, str]]:
    """解析 tar.gz，返回 (tenant, group, data_id, content)。

    兼容两种目录形态：
      ① tenant-config-data/{tenant}/{group}/{dataId}  （Nacos 服务端磁盘缓存）
      ② {group}/{dataId}                              （控制台导出）
    以「/」开头、隐藏文件、非普通文件一律忽略。
    """
    try:
        tar = tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz")
    except tarfile.ReadError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="无法解析 tar.gz 数据流；请确认使用 --data-binary @- 传递 tar -czf - 的输出",
        )
    entries: list[tuple[str, str, str, str]] = []
    try:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            parts = [p for p in member.name.split("/") if p not in ("", ".")]
            if len(parts) < 2:
                continue
            if parts[0] == "tenant-config-data":
                parts = parts[1:]  # 允许把整个 data 根目录一起打包
            if len(parts) < 2 or parts[-1].startswith("."):
                continue
            data_id = parts[-1]
            group = parts[-2]
            tenant = "/".join(parts[:-2]) or "public"
            fh = tar.extractfile(member)
            if fh is None:
                continue
            content = fh.read().decode("utf-8", errors="replace")
            entries.append((tenant, group, data_id, content))
    finally:
        tar.close()
    return entries


def _line_diff(prev: str, cur: str) -> tuple[int, int]:
    """返回 (新增行数, 删除行数)，基于行级 difflib。"""
    added = removed = 0
    for line in difflib.unified_diff(
        prev.splitlines(), cur.splitlines(), lineterm="", n=0
    ):
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return added, removed


def _stage_diff(
    db: Session,
    cfg: YamlConfig,
    tenant: str,
    group: str,
    name: str,
    incoming: str,
    batch_id: str,
    created_by: str | None,
) -> tuple[int, int]:
    """把「既有配置 vs 新推送」的差异落一条待处理记录（同配置旧的 pending 直接作废）。

    返回 (新增行数, 删除行数)。不修改配置正文，等用户在差异面板决定采用或保留。
    """
    added, removed = _line_diff(cfg.content_text or "", incoming)
    db.execute(
        delete(YamlPushDiff).where(
            YamlPushDiff.config_id == cfg.id,
            YamlPushDiff.status == "pending",
        )
    )
    db.add(
        YamlPushDiff(
            project_id=cfg.project_id,
            config_id=cfg.id,
            tenant=tenant,
            group=group or "DEFAULT_GROUP",
            name=name[:100],
            base_version=cfg.version,
            base_content=cfg.content_text or "",
            incoming_content=incoming,
            added=added,
            removed=removed,
            batch_id=batch_id,
            created_by=created_by,
        )
    )
    db.flush()
    return added, removed


@router.post("/push-directory-token")
def push_directory_token(
    project_id: int = Query(..., description="目标项目（命名空间）"),
    hours: int = Query(24, ge=1, le=168, description="令牌有效小时数"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """签发「整目录推送」用的短期 JWT（需项目可编辑权限）。"""
    require_project_edit(db, current_user, project_id)
    token = create_access_token(
        current_user.username,
        expires_delta=timedelta(hours=hours),
        token_version=current_user.token_version,
    )
    return {
        "token": token,
        "expires_in": hours * 3600,
        "project_id": project_id,
        "username": current_user.username,
    }


@router.post("/push-directory")
async def push_directory(
    request: Request,
    project_id: int = Query(..., description="目标项目（命名空间）"),
    dry_run: bool = Query(False, description="true 时只比对、不落库"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """整目录推送：解包 tar.gz → 逐文件与线上比对 → 变更落库并留版本快照。

    返回逐文件明细（新增/修改/未变/失败、增删行数、版本号），便于在页面上查看。
    """
    project = require_project_edit(db, current_user, project_id)
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请求体为空：请通过 --data-binary @- 传入 tar.gz")

    entries = _iter_tar_entries(raw)
    if not entries:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="压缩包内未找到配置文件（期望 tenant-config-data/{命名空间}/{分组}/{dataId}）",
        )

    # 同一项目内 dataId 重名时，用「命名空间/dataId」区分，避免唯一约束冲突
    dup_names = {
        d for d, c in Counter(e[2] for e in entries).items() if c > 1
    }

    batch_id = f"dirpush-{datetime.utcnow():%Y%m%d%H%M%S}-{secrets.token_hex(3)}"
    rows: list[dict] = []
    created = staged = unchanged = failed = 0

    for tenant, group, data_id, content in entries:
        name = f"{tenant}/{data_id}" if data_id in dup_names else data_id
        try:
            exists = db.execute(
                select(YamlConfig).where(
                    YamlConfig.project_id == project.id, YamlConfig.name == name
                )
            ).scalar_one_or_none()
            if exists is None:
                added, removed = len(content.splitlines()), 0
                if not dry_run:
                    cfg = YamlConfig(
                        industry_id=project.industry_id,
                        project_id=project.id,
                        name=name[:100],
                        group=group or "DEFAULT_GROUP",
                        description=f"nacos:tenant={tenant},group={group}",
                        content_text=content,
                        status="enabled",
                        version=1,
                        created_by=current_user.username,
                    )
                    db.add(cfg)
                    db.flush()
                    _snapshot(
                        db,
                        cfg.id,
                        1,
                        content,
                        note=f"目录推送·新建 · {tenant}/{group}/{data_id} · {batch_id} · +{added}",
                        created_by=current_user.username,
                    )
                created += 1
                rows.append({
                    "path": f"{tenant}/{group}/{data_id}",
                    "name": name,
                    "group": group,
                    "action": "created",
                    "added": added,
                    "removed": 0,
                    "version": 1,
                })
                continue

            if exists.content_text == content:
                if not dry_run:
                    # 推送内容已与线上一致：此前暂存的待处理差异自动失效
                    db.execute(
                        delete(YamlPushDiff).where(
                            YamlPushDiff.config_id == exists.id,
                            YamlPushDiff.status == "pending",
                        )
                    )
                unchanged += 1
                rows.append({
                    "path": f"{tenant}/{group}/{data_id}",
                    "name": name,
                    "group": group,
                    "action": "unchanged",
                    "added": 0,
                    "removed": 0,
                    "version": exists.version,
                })
                continue

            added, removed = _line_diff(exists.content_text or "", content)
            if not dry_run:
                # 既有配置不直接覆盖：先暂存差异，等用户在「推送差异」面板批量处理
                _stage_diff(
                    db,
                    exists,
                    tenant,
                    group,
                    name,
                    content,
                    batch_id,
                    current_user.username,
                )
            staged += 1
            rows.append({
                "path": f"{tenant}/{group}/{data_id}",
                "name": name,
                "group": group,
                "action": "staged",
                "added": added,
                "removed": removed,
                "version": exists.version,
            })
        except Exception as exc:  # noqa: BLE001 单文件失败不阻断整批
            db.rollback()
            failed += 1
            rows.append({
                "path": f"{tenant}/{group}/{data_id}",
                "name": name,
                "group": group,
                "action": "failed",
                "error": str(exc)[:200],
            })

    if not dry_run:
        db.commit()

    logger.info(
        "整目录推送完成 batch=%s project=%s by=%s 新建=%s 待处理差异=%s 未变=%s 失败=%s dry_run=%s",
        batch_id, project.id, current_user.username, created, staged, unchanged, failed, dry_run,
    )
    return {
        "batch_id": batch_id,
        "project_id": project.id,
        "project_name": project.name,
        "dry_run": dry_run,
        "total": len(entries),
        "created": created,
        "staged": staged,
        "unchanged": unchanged,
        "failed": failed,
        "rows": rows[:2000],
    }


@router.get("/{config_id}/versions/{version}/raw", response_class=PlainTextResponse)
def get_version_raw(
    config_id: int,
    version: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> PlainTextResponse:
    """按版本号取配置原文，用于 curl 一键还原到磁盘。"""
    cfg = _get_config(db, config_id)
    resolve_project_for_config(db, cfg, current_user, "view")
    row = db.execute(
        select(YamlConfigVersion).where(
            YamlConfigVersion.yaml_config_id == config_id,
            YamlConfigVersion.version == version,
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="版本不存在")
    return PlainTextResponse(
        row.content or "",
        headers={"X-Config-Name": cfg.name, "X-Config-Group": cfg.group or ""},
    )
