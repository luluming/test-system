"""启动初始化：建表 + 演示数据（幂等，已有数据不重复写入）。"""

from sqlalchemy import select

from app.core.logging import logger
from app.core.security import hash_password
from app.database import SessionLocal, engine
from app.models import Base, Industry, Item, NginxConfig, User


def init_db() -> None:
    """创建所有数据表；用户/模板行业为空时写入演示数据。"""
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        admin = db.execute(
            select(User).where(User.username == "admin")
        ).scalar_one_or_none()
        if admin is None:
            admin = User(
                username="admin",
                email="admin@example.com",
                hashed_password=hash_password("admin123"),
            )
            db.add(admin)
            db.flush()
            db.add_all(
                [
                    Item(title="演示物品 1", description="第一条演示数据", owner_id=admin.id),
                    Item(title="演示物品 2", description="第二条演示数据", owner_id=admin.id),
                ]
            )

        # 模板行业 seed（幂等）
        template_industry = db.execute(
            select(Industry).where(Industry.code == "overseas_freight")
        ).scalar_one_or_none()
        if template_industry is None:
            template_industry = Industry(
                code="overseas_freight",
                name="海外货运",
                owner="张工",
                is_template=True,
            )
            db.add(template_industry)
            db.flush()
            db.add(
                NginxConfig(
                    industry_id=template_industry.id,
                    name="overseas_http",
                    domain="freight.example.com",
                    config_text="server { listen 80; server_name freight.example.com; }",
                    enabled=True,
                    version=1,
                )
            )
            logger.info("已写入演示模板行业 overseas_freight + 1 条 nginx 配置")

        db.commit()
        logger.info("演示数据初始化完成")
    finally:
        db.close()