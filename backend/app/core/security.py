"""安全模块：密码哈希、JWT 编解码、当前用户依赖、SQL 注入模式扫描。"""

import re
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.config import settings
from app.models.user import User

# bcrypt 密码哈希上下文
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# OAuth2 Bearer Token 方案，tokenUrl 指向登录接口
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(password: str) -> str:
    """使用 bcrypt 对明文密码做不可逆哈希。"""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """校验明文密码与哈希是否匹配。"""
    return pwd_context.verify(plain_password, hashed_password)


def create_access_token(subject: str, expires_delta: timedelta | None = None) -> str:
    """签发 JWT 访问令牌，subject 为用户唯一标识（用户名）。"""
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    payload = {"sub": subject, "exp": expire}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> dict:
    """解码并校验 JWT；无效或过期时抛出 401 HTTPException。"""
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="无效或过期的登录凭证",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """FastAPI 依赖：解析 Bearer Token 并返回当前登录用户。"""
    payload = decode_token(token)
    username: str | None = payload.get("sub")
    if username is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="无效的登录凭证",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = db.execute(
        select(User).where(User.username == username)
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户不存在",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


# 常见 SQL 注入模式（审计用）：注释符 --、DROP TABLE、UNION SELECT、OR 1=1、1=1 等
_SQL_INJECTION_PATTERNS = re.compile(
    r"(--|;?\s*DROP\s+TABLE|UNION\s+SELECT|['\"]?\s*OR\s+['\"]?1\s*=\s*1|1\s*=\s*1)",
    re.IGNORECASE,
)


def assert_no_sql_injection(text: str) -> bool:
    """扫描文本是否包含常见 SQL 注入模式。

    Returns:
        未命中任何可疑模式返回 True（安全）；命中返回 False。
        供代码审计引用：外部输入进入任何查询前应先经本函数检查。
    """
    return not bool(_SQL_INJECTION_PATTERNS.search(text or ""))
