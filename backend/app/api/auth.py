"""认证接口：注册 / 登录 / 验证码 / 密码重置与修改 / 当前用户。"""

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
    UserCreate,
    UserLogin,
    UserOut,
)

router = APIRouter(prefix="/api/auth", tags=["认证"])


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def register(payload: UserCreate, db: Session = Depends(get_db)) -> User:
    """注册新用户：密码经 bcrypt 哈希后入库，响应不含任何密码字段。"""
    if db.execute(
        select(User).where(User.username == payload.username)
    ).scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="用户名已存在")
    if db.execute(
        select(User).where(User.email == payload.email)
    ).scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="邮箱已被注册")

    user = User(
        username=payload.username,
        email=payload.email,
        hashed_password=hash_password(payload.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


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
    return Token(access_token=create_access_token(subject=user.username))


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
    if len(payload.new_password) < 6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="新密码长度不能少于 6 位"
        )
    user.hashed_password = hash_password(payload.new_password)
    db.commit()
    return {"message": "密码重置成功"}


@router.post("/change-password")
def change_password(
    payload: ChangePasswordRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """修改密码（需登录）：校验原密码正确后更新为新密码哈希。"""
    if not verify_password(payload.old_password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="原密码不正确"
        )
    if len(payload.new_password) < 6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="新密码长度不能少于 6 位"
        )
    current_user.hashed_password = hash_password(payload.new_password)
    db.commit()
    return {"message": "密码修改成功"}


@router.get("/me", response_model=UserOut)
def read_me(current_user: User = Depends(get_current_user)) -> User:
    """返回当前登录用户信息。"""
    return current_user
