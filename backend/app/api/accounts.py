"""账号管理接口（PRD FR-01）：仅系统管理员可增删改账号，普通用户无自助注册。

- 创建账号：角色固定为普通用户，用户名/邮箱唯一，密码需满足强度规则；
- 停用账号：登录态立即失效（token_version 自增使旧 JWT 作废）；
- 重置密码：同停用，旧登录态失效，返回新密码供管理员转告；
- 删除账号：名下有项目时禁止删除，其共享授权记录一并清除。
"""

import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.permissions import require_admin
from app.core.security import get_current_user, hash_password
from app.models import Project, ShareGrant, User
from app.schemas.user import (
    AccountCreate,
    AccountOut,
    AccountPasswordReset,
    AccountSearchItem,
    AccountStatusUpdate,
)

router = APIRouter(prefix="/api/accounts", tags=["账号管理"])

USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{2,49}$")
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
PASSWORD_RE = re.compile(r"^(?=.*[A-Za-z])(?=.*\d).{8,}$")


def _validate_account_fields(username: str, email: str) -> None:
    if not USERNAME_RE.match(username):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="用户名需以字母开头，仅含字母/数字/下划线，长度 3-50",
        )
    if not EMAIL_RE.match(email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="邮箱格式不正确"
        )


def _validate_password(password: str) -> None:
    if not PASSWORD_RE.match(password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="密码长度至少 8 位，且需同时包含字母和数字",
        )


def _get_account(db: Session, user_id: int) -> User:
    row = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="账号不存在")
    return row


def _project_counts(db: Session) -> dict[int, int]:
    rows = db.execute(
        select(Project.owner_id, func.count()).group_by(Project.owner_id)
    ).all()
    return {owner_id: cnt for owner_id, cnt in rows}


@router.get("", response_model=list[AccountOut])
def list_accounts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[AccountOut]:
    """账号列表（仅管理员）：按 id 排序，附带名下项目数。"""
    require_admin(current_user)
    users = list(db.execute(select(User).order_by(User.id)).scalars().all())
    counts = _project_counts(db)
    return [
        AccountOut(
            id=u.id,
            username=u.username,
            email=u.email,
            role=u.role,
            is_active=u.is_active,
            project_count=counts.get(u.id, 0),
            created_at=u.created_at,
        )
        for u in users
    ]


@router.post("", response_model=AccountOut, status_code=status.HTTP_201_CREATED)
def create_account(
    payload: AccountCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AccountOut:
    """创建账号（仅管理员）：角色固定为普通用户。"""
    require_admin(current_user)
    _validate_account_fields(payload.username, payload.email)
    _validate_password(payload.password)
    if db.execute(
        select(User).where(User.username == payload.username)
    ).scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="用户名已存在")
    if db.execute(
        select(User).where(User.email == payload.email)
    ).scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="邮箱已被使用")
    user = User(
        username=payload.username,
        email=payload.email,
        hashed_password=hash_password(payload.password),
        role="user",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return AccountOut(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
        project_count=0,
        created_at=user.created_at,
    )


@router.put("/{user_id}/status", response_model=AccountOut)
def update_account_status(
    user_id: int,
    payload: AccountStatusUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AccountOut:
    """启用/停用账号（仅管理员）：停用时登录态立即失效。"""
    require_admin(current_user)
    target = _get_account(db, user_id)
    if target.id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="不能停用/启用自己的账号"
        )
    if target.role == "admin":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="系统管理员账号不可停用"
        )
    target.is_active = payload.is_active
    if not payload.is_active:
        target.token_version += 1
    db.commit()
    db.refresh(target)
    counts = _project_counts(db)
    return AccountOut(
        id=target.id,
        username=target.username,
        email=target.email,
        role=target.role,
        is_active=target.is_active,
        project_count=counts.get(target.id, 0),
        created_at=target.created_at,
    )


@router.put("/{user_id}/password")
def reset_account_password(
    user_id: int,
    payload: AccountPasswordReset,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """重置账号密码（仅管理员）：旧登录态立即失效，返回新密码供转告。"""
    require_admin(current_user)
    target = _get_account(db, user_id)
    _validate_password(payload.new_password)
    target.hashed_password = hash_password(payload.new_password)
    target.token_version += 1
    db.commit()
    return {"password": payload.new_password}


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """删除账号（仅管理员）：名下有项目时禁止；其共享授权一并清除。"""
    require_admin(current_user)
    target = _get_account(db, user_id)
    if target.id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="不能删除自己的账号"
        )
    if target.role == "admin":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="系统管理员账号不可删除"
        )
    owned = db.execute(
        select(func.count()).select_from(Project).where(Project.owner_id == target.id)
    ).scalar_one()
    if owned > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"该账号名下有 {owned} 个项目，请先转移或删除",
        )
    for grant in db.execute(
        select(ShareGrant).where(ShareGrant.user_id == target.id)
    ).scalars().all():
        db.delete(grant)
    db.delete(target)
    db.commit()


@router.get("/search", response_model=list[AccountSearchItem])
def search_accounts(
    q: str = "",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[User]:
    """账号搜索（任意登录用户）：共享授权选人用，用户名/邮箱模糊匹配。"""
    pattern = f"%{q.strip()}%"
    stmt = select(User).order_by(User.id).limit(10)
    if q.strip():
        stmt = select(User).where(
            or_(User.username.like(pattern), User.email.like(pattern))
        ).order_by(User.id).limit(10)
    return list(db.execute(stmt).scalars().all())
