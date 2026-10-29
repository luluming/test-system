"""数据库连接模块。

基于 SQLAlchemy 2.0 创建 engine 与 SessionLocal。
通过 DATABASE_URL 切换 SQLite / MySQL：
  - sqlite:///./test_system.db
  - mysql+pymysql://user:pass@host:3306/dbname?charset=utf8mb4
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings

_is_sqlite = settings.DATABASE_URL.startswith("sqlite")

if _is_sqlite:
    # SQLite：跨线程访问需关闭 check_same_thread；单文件无连接池
    _engine_kwargs = {"connect_args": {"check_same_thread": False}}
else:
    # MySQL：utf8mb4 全字符集；连接池复用 + 回收避免超时
    _engine_kwargs = {
        "pool_size": 10,
        "max_overflow": 20,
        "pool_recycle": 1800,
        "pool_pre_ping": True,
        "connect_args": {"charset": "utf8mb4"},
    }

engine = create_engine(settings.DATABASE_URL, **_engine_kwargs)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
