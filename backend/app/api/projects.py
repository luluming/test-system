"""项目接口（PRD FR-02 / FR-03 / FR-05）：项目 CRUD、共享管理、环境变量。

权限：任何登录用户可在行业下创建项目（创建人即负责人）；
项目内能力按有效权限档位控制（owner/edit/view），共享变更即时生效。
"""

import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.permissions import (
    PERM_ORDER,
    get_project_perm,
    require_project_edit,
    require_project_owner,
    require_project_view,
)
from app.core.security import get_current_user
from app.models import (
    EnvVar,
    Industry,
    NginxConfig,
    Project,
    ShareGrant,
    User,
    YamlConfig,
)
from app.schemas.project import (
    EnvVarCreate,
    EnvVarOut,
    EnvVarUpdate,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
    ShareGrantOut,
    ShareOut,
    ShareUpdate,
)

router = APIRouter(prefix="/api/projects", tags=["项目"])

PROJECT_CODE_RE = re.compile(r"^[a-z0-9-]{1,50}$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


# ---- 装配辅助 ----


def _batch_counts(db: Session, project_ids: list[int]) -> dict[str, dict[int, int]]:
    """批量统计各项目下的 nginx/yml/env/授权计数，避免逐项目查询。"""

    def _count(model, key: str) -> dict[int, int]:
        if not project_ids:
            return {}
        rows = db.execute(
            select(model.project_id, func.count())
            .where(model.project_id.in_(project_ids))
            .group_by(model.project_id)
        ).all()
        return {pid: cnt for pid, cnt in rows}

    return {
        "nginx": _count(NginxConfig, "nginx"),
        "yml": _count(YamlConfig, "yml"),
        "env": _count(EnvVar, "env"),
        "grant": _count(ShareGrant, "grant"),
    }


def _to_out(
    project: Project,
    perm: str,
    industry_names: dict[int, str],
    owner_names: dict[int, str],
    counts: dict[str, dict[int, int]],
) -> ProjectOut:
    return ProjectOut(
        id=project.id,
        industry_id=project.industry_id,
        industry_name=industry_names.get(project.industry_id, ""),
        name=project.name,
        code=project.code,
        owner_id=project.owner_id,
        owner_name=owner_names.get(project.owner_id, ""),
        remark=project.remark,
        share_all=project.share_all,
        my_perm=perm,
        nginx_count=counts["nginx"].get(project.id, 0),
        yml_count=counts["yml"].get(project.id, 0),
        env_count=counts["env"].get(project.id, 0),
        grant_count=counts["grant"].get(project.id, 0),
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


def _names(db: Session, projects: list[Project]) -> tuple[dict[int, str], dict[int, str]]:
    industry_ids = {p.industry_id for p in projects}
    owner_ids = {p.owner_id for p in projects}
    industries = (
        db.execute(select(Industry).where(Industry.id.in_(industry_ids))).scalars().all()
        if industry_ids
        else []
    )
    owners = (
        db.execute(select(User).where(User.id.in_(owner_ids))).scalars().all()
        if owner_ids
        else []
    )
    return (
        {i.id: i.name for i in industries},
        {u.id: u.username for u in owners},
    )


def _to_out_list(
    db: Session, user: User, projects: list[Project]
) -> list[ProjectOut]:
    counts = _batch_counts(db, [p.id for p in projects])
    industry_names, owner_names = _names(db, projects)
    return [
        _to_out(p, get_project_perm(db, user, p), industry_names, owner_names, counts)
        for p in projects
    ]


# ---- 项目列表 / 创建 ----


@router.get("", response_model=list[ProjectOut])
def list_projects(
    industry_id: int | None = None,
    tab: str = "mine",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectOut]:
    """项目列表：tab=mine 我创建的 | shared 共享给我的 | all 全部（仅管理员）。"""
    if tab not in ("mine", "shared", "all"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="不支持的列表类型"
        )
    if tab == "all" and current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="仅系统管理员可查看全部项目"
        )
    stmt = select(Project).order_by(Project.id)
    if industry_id is not None:
        stmt = stmt.where(Project.industry_id == industry_id)
    projects = list(db.execute(stmt).scalars().all())

    if tab == "mine":
        projects = [p for p in projects if p.owner_id == current_user.id]
    elif tab == "shared":
        projects = [
            p
            for p in projects
            if p.owner_id != current_user.id
            and PERM_ORDER[get_project_perm(db, current_user, p)]
            >= PERM_ORDER["view"]
        ]
    return _to_out_list(db, current_user, projects)


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectOut:
    """创建项目：任何登录用户均可，创建人即项目负责人。"""
    if not PROJECT_CODE_RE.match(payload.code):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="项目标识仅支持小写字母、数字、中划线，长度 1-50",
        )
    industry = db.execute(
        select(Industry).where(Industry.id == payload.industry_id)
    ).scalar_one_or_none()
    if industry is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="行业不存在")
    if db.execute(
        select(Project).where(
            Project.industry_id == payload.industry_id,
            Project.name == payload.name,
        )
    ).scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="该行业下项目名称已存在"
        )
    if db.execute(
        select(Project).where(
            Project.industry_id == payload.industry_id,
            Project.code == payload.code,
        )
    ).scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="该行业下项目标识已存在"
        )
    project = Project(
        industry_id=payload.industry_id,
        name=payload.name,
        code=payload.code,
        owner_id=current_user.id,
        remark=payload.remark,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return _to_out_list(db, current_user, [project])[0]


# ---- 行业项目统计（放在 /{project_id} 之前注册）----


@router.get("/stats-by-industry")
def stats_by_industry(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[int, dict[str, int]]:
    """各行业项目数：非管理员仅统计其有权限查看的项目。"""
    projects = list(db.execute(select(Project)).scalars().all())
    result: dict[int, dict[str, int]] = {}
    for p in projects:
        if (
            current_user.role != "admin"
            and PERM_ORDER[get_project_perm(db, current_user, p)]
            < PERM_ORDER["view"]
        ):
            continue
        bucket = result.setdefault(p.industry_id, {"project_count": 0})
        bucket["project_count"] += 1
    return result


# ---- 项目详情 / 更新 / 删除 ----


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectOut:
    """项目详情：要求可查看及以上权限。"""
    project = require_project_view(db, current_user, project_id)
    return _to_out_list(db, current_user, [project])[0]


@router.put("/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectOut:
    """更新项目（仅负责人/管理员）：仅名称与备注可改。"""
    project = require_project_owner(db, current_user, project_id)
    if payload.name is not None and payload.name != project.name:
        if db.execute(
            select(Project).where(
                Project.industry_id == project.industry_id,
                Project.name == payload.name,
                Project.id != project.id,
            )
        ).scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="该行业下项目名称已存在"
            )
        project.name = payload.name
    if payload.remark is not None:
        project.remark = payload.remark
    db.commit()
    db.refresh(project)
    return _to_out_list(db, current_user, [project])[0]


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """删除项目（仅负责人/管理员）：非空项目禁止删除。"""
    project = require_project_owner(db, current_user, project_id)
    counts = _batch_counts(db, [project.id])
    if (
        counts["nginx"].get(project.id, 0) > 0
        or counts["yml"].get(project.id, 0) > 0
        or counts["env"].get(project.id, 0) > 0
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="请先清空项目下的配置与环境变量",
        )
    for grant in db.execute(
        select(ShareGrant).where(ShareGrant.project_id == project.id)
    ).scalars().all():
        db.delete(grant)
    db.delete(project)
    db.commit()


# ---- 共享管理 ----


def _share_out(db: Session, project: Project) -> ShareOut:
    grants = list(
        db.execute(
            select(ShareGrant).where(ShareGrant.project_id == project.id)
        ).scalars().all()
    )
    user_ids = {g.user_id for g in grants}
    users = (
        {u.id: u for u in db.execute(select(User).where(User.id.in_(user_ids))).scalars().all()}
        if user_ids
        else {}
    )
    return ShareOut(
        share_all=project.share_all,
        grants=[
            ShareGrantOut(
                user_id=g.user_id,
                username=users[g.user_id].username if g.user_id in users else "",
                email=users[g.user_id].email if g.user_id in users else "",
                perm=g.perm,
            )
            for g in grants
        ],
    )


@router.get("/{project_id}/share", response_model=ShareOut)
def get_share(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ShareOut:
    """查看共享设置（仅负责人/管理员）。"""
    project = require_project_owner(db, current_user, project_id)
    return _share_out(db, project)


@router.put("/{project_id}/share", response_model=ShareOut)
def update_share(
    project_id: int,
    payload: ShareUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ShareOut:
    """全量替换共享设置（仅负责人/管理员）：变更即时生效。"""
    project = require_project_owner(db, current_user, project_id)
    # 同一 user_id 重复出现时保留最后一条
    merged: dict[int, str] = {}
    for grant in payload.grants:
        merged[grant.user_id] = grant.perm
    for user_id in merged:
        if user_id == project.owner_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="不能添加项目负责人本人",
            )
        if not db.execute(select(User).where(User.id == user_id)).scalar_one_or_none():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="账号不存在"
            )
    project.share_all = payload.share_all
    for old in db.execute(
        select(ShareGrant).where(ShareGrant.project_id == project.id)
    ).scalars().all():
        db.delete(old)
    db.flush()
    for user_id, perm in merged.items():
        db.add(
            ShareGrant(
                project_id=project.id,
                user_id=user_id,
                perm=perm,
                created_by=current_user.username,
            )
        )
    db.commit()
    db.refresh(project)
    return _share_out(db, project)


# ---- 环境变量 ----


@router.get("/{project_id}/env-vars", response_model=list[EnvVarOut])
def list_env_vars(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[EnvVar]:
    """环境变量列表：要求可查看及以上权限。"""
    require_project_view(db, current_user, project_id)
    return list(
        db.execute(
            select(EnvVar)
            .where(EnvVar.project_id == project_id)
            .order_by(EnvVar.key)
        ).scalars().all()
    )


@router.post(
    "/{project_id}/env-vars",
    response_model=EnvVarOut,
    status_code=status.HTTP_201_CREATED,
)
def create_env_var(
    project_id: int,
    payload: EnvVarCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> EnvVar:
    """新建环境变量：要求可编辑及以上权限，键项目内唯一。"""
    require_project_edit(db, current_user, project_id)
    if not ENV_KEY_RE.match(payload.key):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="变量名需以字母或下划线开头，仅含字母/数字/下划线",
        )
    if db.execute(
        select(EnvVar).where(
            EnvVar.project_id == project_id, EnvVar.key == payload.key
        )
    ).scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="该变量已存在"
        )
    row = EnvVar(
        project_id=project_id,
        key=payload.key,
        value=payload.value,
        remark=payload.remark,
        updated_by=current_user.username,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.put("/{project_id}/env-vars/{var_id}", response_model=EnvVarOut)
def update_env_var(
    project_id: int,
    var_id: int,
    payload: EnvVarUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> EnvVar:
    """更新环境变量：键不可改，仅值与备注。"""
    require_project_edit(db, current_user, project_id)
    row = db.execute(
        select(EnvVar).where(EnvVar.id == var_id, EnvVar.project_id == project_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="环境变量不存在"
        )
    if payload.value is not None:
        row.value = payload.value
    if payload.remark is not None:
        row.remark = payload.remark
    row.updated_by = current_user.username
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{project_id}/env-vars/{var_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_env_var(
    project_id: int,
    var_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """删除环境变量：要求可编辑及以上权限。"""
    require_project_edit(db, current_user, project_id)
    row = db.execute(
        select(EnvVar).where(EnvVar.id == var_id, EnvVar.project_id == project_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="环境变量不存在"
        )
    db.delete(row)
    db.commit()
