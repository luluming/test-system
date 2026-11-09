"""项目接口（PRD FR-02 / FR-03 / FR-05）：项目 CRUD、共享管理、环境变量。

权限：任何登录用户可在行业下创建项目（创建人即负责人）；
项目内能力按有效权限档位控制（owner/edit/view），共享变更即时生效。
"""

import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, select
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
    ProjectAccessRequest,
    ShareGrant,
    User,
    YamlConfig,
)
from app.schemas.project import (
    AccessRequestCreate,
    AccessRequestDecision,
    AccessRequestOut,
    EnvVarCreate,
    EnvVarOut,
    EnvVarUpdate,
    ProjectConflictOut,
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
    """批量统计各项目下的 nginx/yml/nacos/env/授权计数，避免逐项目查询。

    yml 仅统计项目原生 YAML（description 不以 nacos: 开头）；
    nacos 统计从 Nacos tenant-config-data 导入的配置（description 以 nacos: 开头）。
    """

    def _count(model, key: str) -> dict[int, int]:
        if not project_ids:
            return {}
        rows = db.execute(
            select(model.project_id, func.count())
            .where(model.project_id.in_(project_ids))
            .group_by(model.project_id)
        ).all()
        return {pid: cnt for pid, cnt in rows}

    def _count_yaml(nacos_imported: bool) -> dict[int, int]:
        if not project_ids:
            return {}
        q = select(YamlConfig.project_id, func.count()).where(
            YamlConfig.project_id.in_(project_ids)
        )
        if nacos_imported:
            q = q.where(YamlConfig.description.like("nacos:%"))
        else:
            q = q.where(
                (YamlConfig.description.is_(None))
                | (~YamlConfig.description.like("nacos:%"))
            )
        rows = db.execute(q.group_by(YamlConfig.project_id)).all()
        return {pid: cnt for pid, cnt in rows}

    return {
        "nginx": _count(NginxConfig, "nginx"),
        "yml": _count_yaml(nacos_imported=False),
        "nacos": _count_yaml(nacos_imported=True),
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
        nacos_count=counts["nacos"].get(project.id, 0),
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


# ---- 项目访问申请（冲突查询 / 待审批列表需放在 /{project_id} 之前）----


def _access_out(db: Session, rows: list[ProjectAccessRequest]) -> list[AccessRequestOut]:
    """批量装配访问申请的项目名、行业名与申请人信息。"""
    if not rows:
        return []
    project_ids = {r.project_id for r in rows}
    user_ids = {r.requester_id for r in rows}
    projects = {
        p.id: p
        for p in db.execute(select(Project).where(Project.id.in_(project_ids))).scalars().all()
    }
    users = {
        u.id: u
        for u in db.execute(select(User).where(User.id.in_(user_ids))).scalars().all()
    }
    industry_ids = {p.industry_id for p in projects.values()}
    industries = (
        {
            i.id: i.name
            for i in db.execute(select(Industry).where(Industry.id.in_(industry_ids))).scalars().all()
        }
        if industry_ids
        else {}
    )
    result = []
    for r in rows:
        p = projects.get(r.project_id)
        u = users.get(r.requester_id)
        result.append(
            AccessRequestOut(
                id=r.id,
                project_id=r.project_id,
                project_name=p.name if p else "",
                industry_name=industries.get(p.industry_id, "") if p else "",
                requester_id=r.requester_id,
                requester_name=u.username if u else "",
                requester_email=u.email if u else None,
                status=r.status,
                message=r.message,
                created_at=r.created_at,
            )
        )
    return result


@router.get("/conflict", response_model=ProjectConflictOut)
def find_project_conflict(
    industry_id: int,
    name: str = "",
    code: str = "",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectConflictOut:
    """按名称/标识查询同行业已有项目：用于创建冲突时引导用户申请访问。"""
    if not name and not code:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="缺少查询条件")
    conditions = []
    if name:
        conditions.append(Project.name == name)
    if code:
        conditions.append(Project.code == code)
    project = db.execute(
        select(Project).where(Project.industry_id == industry_id, or_(*conditions))
    ).scalars().first()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="未找到同名项目")
    owner = db.execute(select(User).where(User.id == project.owner_id)).scalar_one_or_none()
    return ProjectConflictOut(
        id=project.id,
        name=project.name,
        code=project.code,
        owner_id=project.owner_id,
        owner_name=owner.username if owner else "",
        has_access=PERM_ORDER[get_project_perm(db, current_user, project)]
        >= PERM_ORDER["view"],
    )


@router.get("/access-requests/pending", response_model=list[AccessRequestOut])
def list_pending_access_requests(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[AccessRequestOut]:
    """待我审批的访问申请：管理员看全部，普通用户只看自己负责的项目。"""
    stmt = select(ProjectAccessRequest).where(ProjectAccessRequest.status == "pending")
    if current_user.role != "admin":
        owned_ids = select(Project.id).where(Project.owner_id == current_user.id)
        stmt = stmt.where(ProjectAccessRequest.project_id.in_(owned_ids))
    rows = list(
        db.execute(stmt.order_by(ProjectAccessRequest.created_at.desc())).scalars().all()
    )
    return _access_out(db, rows)


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
    for req in db.execute(
        select(ProjectAccessRequest).where(ProjectAccessRequest.project_id == project.id)
    ).scalars().all():
        db.delete(req)
    db.delete(project)
    db.commit()


# ---- 项目访问申请（发起 / 审批）----


@router.post(
    "/{project_id}/access-requests",
    response_model=AccessRequestOut,
    status_code=status.HTTP_201_CREATED,
)
def create_access_request(
    project_id: int,
    payload: AccessRequestCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AccessRequestOut:
    """向项目负责人申请只读访问；重复申请复用原记录并重新置为待审批。"""
    project = db.execute(select(Project).where(Project.id == project_id)).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    if project.owner_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="你是该项目负责人，无需申请"
        )
    if PERM_ORDER[get_project_perm(db, current_user, project)] >= PERM_ORDER["view"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="你已拥有该项目访问权限"
        )
    row = db.execute(
        select(ProjectAccessRequest).where(
            ProjectAccessRequest.project_id == project_id,
            ProjectAccessRequest.requester_id == current_user.id,
        )
    ).scalar_one_or_none()
    if row is None:
        row = ProjectAccessRequest(
            project_id=project_id,
            requester_id=current_user.id,
            message=payload.message,
            status="pending",
        )
        db.add(row)
    else:
        row.status = "pending"
        row.message = payload.message
    db.commit()
    db.refresh(row)
    return _access_out(db, [row])[0]


@router.get("/{project_id}/access-requests", response_model=list[AccessRequestOut])
def list_access_requests(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[AccessRequestOut]:
    """项目的全部访问申请（负责人/管理员）。"""
    require_project_owner(db, current_user, project_id)
    rows = list(
        db.execute(
            select(ProjectAccessRequest)
            .where(ProjectAccessRequest.project_id == project_id)
            .order_by(ProjectAccessRequest.created_at.desc())
        ).scalars().all()
    )
    return _access_out(db, rows)


@router.put(
    "/{project_id}/access-requests/{request_id}",
    response_model=AccessRequestOut,
)
def decide_access_request(
    project_id: int,
    request_id: int,
    payload: AccessRequestDecision,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AccessRequestOut:
    """审批访问申请：通过时写入 view 共享授权，即时获得项目只读权限。"""
    require_project_owner(db, current_user, project_id)
    row = db.execute(
        select(ProjectAccessRequest).where(
            ProjectAccessRequest.id == request_id,
            ProjectAccessRequest.project_id == project_id,
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="申请不存在")
    if row.status != "pending":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该申请已处理")
    if payload.action == "approve":
        grant = db.execute(
            select(ShareGrant).where(
                ShareGrant.project_id == project_id,
                ShareGrant.user_id == row.requester_id,
            )
        ).scalar_one_or_none()
        if grant is None:
            db.add(
                ShareGrant(
                    project_id=project_id,
                    user_id=row.requester_id,
                    perm="view",
                    created_by=current_user.username,
                )
            )
        elif PERM_ORDER[grant.perm] < PERM_ORDER["view"]:
            grant.perm = "view"
        row.status = "approved"
    else:
        row.status = "rejected"
    db.commit()
    db.refresh(row)
    return _access_out(db, [row])[0]


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
