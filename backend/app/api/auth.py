"""认证接口：登录 / 验证码 / 密码重置与修改 / 当前用户（无自助注册，账号由管理员创建）。"""

import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.captcha import generate_captcha, verify_captcha
from app.core.security import (
    create_access_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.models.user import User
from app.schemas.user import (
    ChangePasswordRequest,
    ResetPasswordRequest,
    Token,
    UserLogin,
    UserOut,
)

router = APIRouter(prefix="/api/auth", tags=["认证"])

# 密码强度：至少 8 位且同时包含字母和数字
PASSWORD_RE = re.compile(r"^(?=.*[A-Za-z])(?=.*\d).{8,}$")


def _check_password_rule(password: str) -> None:
    if not PASSWORD_RE.match(password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="密码长度至少 8 位，且需同时包含字母和数字",
        )


@router.get("/captcha")
def get_captcha() -> dict:
    """获取验证码：返回 captcha_id 与 base64 编码的 SVG 图片（data URI）。"""
    data = generate_captcha()
    return {"captcha_id": data["captcha_id"], "captcha_image": data["captcha_image"]}


@router.post("/login", response_model=Token)
def login(payload: UserLogin, db: Session = Depends(get_db)) -> Token:
    """登录：先校验验证码，再校验用户名与密码，成功则签发 JWT 访问令牌。"""
    if not verify_captcha(payload.captcha_id, payload.captcha_code):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="验证码错误或已过期"
        )
    user = db.execute(
        select(User).where(User.username == payload.username)
    ).scalar_one_or_none()
    if user is None or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="账号已被停用，请联系管理员",
        )
    return Token(
        access_token=create_access_token(
            subject=user.username, token_version=user.token_version
        )
    )


@router.post("/reset-password")
def reset_password(
    payload: ResetPasswordRequest, db: Session = Depends(get_db)
) -> dict:
    """重置密码（无需登录）：校验验证码与用户名/邮箱匹配后更新密码哈希。"""
    if not verify_captcha(payload.captcha_id, payload.captcha_code):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="验证码错误或已过期"
        )
    user = db.execute(
        select(User).where(User.username == payload.username)
    ).scalar_one_or_none()
    if user is None or user.email != payload.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="用户名与邮箱不匹配"
        )
    _check_password_rule(payload.new_password)
    user.hashed_password = hash_password(payload.new_password)
    user.token_version += 1
    db.commit()
    return {"message": "密码重置成功"}


@router.post("/change-password")
def change_password(
    payload: ChangePasswordRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """修改密码（需登录）：校验原密码后更新；旧登录态失效，返回新令牌保持当前会话。"""
    if not verify_password(payload.old_password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="原密码不正确"
        )
    _check_password_rule(payload.new_password)
    current_user.hashed_password = hash_password(payload.new_password)
    current_user.token_version += 1
    db.commit()
    return {
        "message": "密码修改成功",
        "access_token": create_access_token(
            subject=current_user.username,
            token_version=current_user.token_version,
        ),
    }


@router.get("/me", response_model=UserOut)
def read_me(current_user: User = Depends(get_current_user)) -> User:
    """返回当前登录用户信息。"""
    return current_user
