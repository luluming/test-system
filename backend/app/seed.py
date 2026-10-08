"""启动初始化：建表 + 演示数据（幂等，已有数据不重复写入）。"""

from sqlalchemy import select

from app.core.logging import logger
from app.core.security import hash_password
from app.database import SessionLocal, engine
from app.models import Base, Item, User


def init_db() -> None:
    """创建所有数据表；用户表为空时写入演示用户与演示物品。"""
    # 建表（已存在则自动跳过）
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        # 幂等检查：已存在 admin 用户则跳过 seed
        admin = db.execute(
            select(User).where(User.username == "admin")
        ).scalar_one_or_none()
        if admin is not None:
            logger.info("演示数据已存在，跳过 seed")
            return

        admin = User(
            username="admin",
            email="admin@example.com",
            hashed_password=hash_password("admin123"),
        )
        db.add(admin)
        db.flush()  # 立即生成 admin.id 供物品外键引用

        db.add_all(
            [
                Item(
                    title="演示物品 1",
                    description="第一条演示数据",
                    owner_id=admin.id,
                ),
                Item(
                    title="演示物品 2",
                    description="第二条演示数据",
                    owner_id=admin.id,
                ),
            ]
        )
        db.commit()
        logger.info("已写入演示数据：admin / admin123 + 2 条物品")
    finally:
        db.close()
