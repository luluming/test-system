"""启动初始化：建表 + 演示数据（幂等，已有数据不重复写入）。"""

from sqlalchemy import select

from app.core.logging import logger
from app.core.security import hash_password
from app.database import SessionLocal, engine
from app.models import (
    Base,
    BizPort,
    ConfigBlock,
    ConfigOption,
    DomainMapping,
    ForwardPort,
    Industry,
    Item,
    NginxConfig,
    Upstream,
    UpstreamServer,
    User,
)
from app.services.nginx_render import parse, persist_tree

# 模板行业演示配置（海外货运）：双 server + map + 两个 upstream 组
DEMO_CONF = """server {
  listen 443 ssl http2;
  server_name freight.example.com;
  location /api/ {
    proxy_pass http://api_backend;
  }
}
server {
  listen 20551 ssl http2;
  server_name freight.example.com;
  location / {
    proxy_pass http://web_backend;
  }
}
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}
upstream api_backend {
  server 10.0.0.97:8080 weight=5 max_fails=2 fail_timeout=30s;
  server 10.0.0.193:8080 weight=5 max_fails=2 fail_timeout=30s;
  server 10.0.0.18:8080 weight=5 max_fails=2 fail_timeout=30s;
}
upstream web_backend {
  server 10.0.0.97:80;
  server 10.0.0.193:80;
}"""


def seed_template_blocks(db, config_id: int) -> None:
    """把模板行业演示配置解析为块树并落库（幂等：已有块则跳过）。"""
    exists = db.execute(
        select(ConfigBlock).where(ConfigBlock.nginx_config_id == config_id)
    ).scalars().first()
    if exists is not None:
        return
    persist_tree(db, config_id, parse(DEMO_CONF, "http"))
    logger.info("已写入模板行业块树")


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
            cfg = NginxConfig(
                industry_id=template_industry.id,
                name="overseas_http",
                domain="freight.example.com",
                config_text=DEMO_CONF,
                enabled=True,
                version=1,
            )
            db.add(cfg)
            db.flush()
            seed_template_blocks(db, cfg.id)
            db.add(
                Upstream(industry_id=template_industry.id, name="api_backend", strategy="round_robin", keepalive=32)
            )
            db.add(
                Upstream(industry_id=template_industry.id, name="web_backend", strategy="least_conn", keepalive=16)
            )
            db.add(
                DomainMapping(
                    industry_id=template_industry.id,
                    domain="freight.example.com",
                    forward_tos="https://10.0.0.97:443",
                    description="海外货运主站",
                )
            )
            db.add(
                ForwardPort(
                    industry_id=template_industry.id,
                    listen_port=443,
                    upstream_target="api_backend",
                    service_name="货运 API",
                )
            )
            db.add(
                BizPort(
                    industry_id=template_industry.id,
                    service_name="货运主站",
                    port=8080,
                    public_exposed=True,
                )
            )
            logger.info("已写入演示模板行业 overseas_freight + 1 条 nginx 配置（含块树）")

        db.commit()
        logger.info("演示数据初始化完成")
    finally:
        db.close()
