"""数据库连接模块。

基于 SQLAlchemy 2.0 创建 engine 与 SessionLocal。
数据库文件默认位于 backend 目录下的 ./test_system.db。
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings

# SQLite 跨线程访问需关闭 check_same_thread（FastAPI 为多线程处理请求）
_connect_args = (
    {"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite") else {}
)

engine = create_engine(settings.DATABASE_URL, connect_args=_connect_args)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
