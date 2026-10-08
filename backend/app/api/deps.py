"""API 公共依赖。

get_db 提供请求级数据库会话；所有数据库访问一律通过该会话，
并使用 SQLAlchemy ORM（select/add/commit 等），严禁字符串拼接 SQL。
"""

from collections.abc import Generator

from sqlalchemy.orm import Session

from app.database import SessionLocal


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖：按请求创建会话，请求结束后关闭。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
