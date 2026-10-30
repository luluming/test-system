"""项目级权限判定：角色 + 共享授权 → 有效权限档位。

有效档位：admin(4) > owner(3) > edit(2) > view(1) > none(0)。
- 系统管理员：全权（绕过一切项目校验）；
- 项目 owner：项目内全部能力 + 共享管理 + 删除项目；
- 指定人授权：view | edit（同一项目同一账号仅一条授权记录）；
- 全员可见 share_all：固定 view；
- 多来源命中取最高档；共享变更即时生效，服务端校验为准（前端隐藏仅为体验优化）。
"""

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.project import Project, ShareGrant
from app.models.user import User

PERM_ORDER = {"none": 0, "view": 1, "edit": 2, "owner": 3, "admin": 4}

FORBIDDEN_VIEW = "你没有该项目的访问权限"
FORBIDDEN_EDIT = "你的访问权限已变更，当前为只读"
FORBIDDEN_OWNER = "仅项目负责人或系统管理员可执行该操作"
FORBIDDEN_ADMIN = "仅系统管理员可执行该操作"


def get_project_perm(db: Session, user: User, project: Project) -> str:
    """计算用户对项目的有效权限档位（多来源取最高）。"""
    if user.role == "admin":
        return "admin"
    if project.owner_id == user.id:
        return "owner"
    perm = "none"
    grant = db.execute(
        select(ShareGrant).where(
            ShareGrant.project_id == project.id,
            ShareGrant.user_id == user.id,
        )
    ).scalar_one_or_none()
    if grant is not None:
        perm = grant.perm
    if project.share_all and PERM_ORDER[perm] < PERM_ORDER["view"]:
        perm = "view"
    return perm


def _forbidden(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def require_admin(user: User) -> None:
    """仅系统管理员可执行；否则 403。"""
    if user.role != "admin":
        raise _forbidden(FORBIDDEN_ADMIN)


def _get_project(db: Session, project_id: int) -> Project:
    row = db.execute(select(Project).where(Project.id == project_id)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return row


def _require_perm(
    db: Session, user: User, project_id: int, need: str, detail: str
) -> Project:
    project = _get_project(db, project_id)
    if PERM_ORDER[get_project_perm(db, user, project)] < PERM_ORDER[need]:
        raise _forbidden(detail)
    return project


def require_project_view(db: Session, user: User, project_id: int) -> Project:
    """要求「可查看」及以上；否则 403 无权限提示。"""
    return _require_perm(db, user, project_id, "view", FORBIDDEN_VIEW)


def require_project_edit(db: Session, user: User, project_id: int) -> Project:
    """要求「可编辑」及以上；否则 403 只读提示。"""
    return _require_perm(db, user, project_id, "edit", FORBIDDEN_EDIT)


def require_project_owner(db: Session, user: User, project_id: int) -> Project:
    """要求「项目负责人」及以上（含 admin）；否则 403。"""
    return _require_perm(db, user, project_id, "owner", FORBIDDEN_OWNER)


def resolve_project_for_config(db: Session, cfg, user: User, need: str) -> Project:
    """按配置（NginxConfig / YamlConfig）归属项目做权限校验。

    project_id 为空的历史配置先挂到行业默认项目（启动迁移已兜底，此处为防御）。
    need: "view" | "edit"。
    """
    project_id = cfg.project_id
    if project_id is None:
        from app.seed import get_or_create_default_project  # 延迟导入避免循环

        admin = db.execute(select(User).where(User.role == "admin")).scalars().first()
        project = get_or_create_default_project(
            db, cfg.industry_id, admin.id if admin else user.id
        )
        cfg.project_id = project.id
        db.flush()
        project_id = project.id
    if need == "edit":
        return require_project_edit(db, user, project_id)
    return require_project_view(db, user, project_id)


def visible_project_ids(db: Session, user: User, industry_id: int) -> set[int] | None:
    """返回用户在某行业下「可查看」的项目 id 集合；admin 返回 None 表示不过滤。"""
    if user.role == "admin":
        return None
    projects = list(
        db.execute(select(Project).where(Project.industry_id == industry_id))
        .scalars()
        .all()
    )
    return {
        p.id
        for p in projects
        if PERM_ORDER[get_project_perm(db, user, p)] >= PERM_ORDER["view"]
    }
