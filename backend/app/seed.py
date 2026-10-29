"""启动初始化：建表 + 演示数据（幂等，已有数据不重复写入）。"""

from pathlib import Path

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
    YamlConfig,
    YamlConfigVersion,
)
from app.services.nginx_render import parse, persist_tree
from app.services.yaml_push import analyze

SEED_YAML_DIR = Path(__file__).parent / "seed_data"

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


# ---- YAML 配置演示数据（幂等，每个行业补齐 3 个文件）----


def _read_prod_sample() -> str:
    """读取真实样例 deploy_config.yml（1213 行，逐字保真）。"""
    return (SEED_YAML_DIR / "deploy_config.yml").read_text(encoding="utf-8")


def _stage_yaml_content(industry_id: int) -> str:
    return f"""# ==================== 集群部署配置（预发） ====================
hosts:
  - ip: "10.192.{industry_id}.20.11"
    ssh-port: 22
service_mode:
  docker: true
clusters:
  - name: "jdk"
    group: "base"
    instances:
      - ip: "10.192.{industry_id}.20.11"
networking:
  vips: []
"""


def _test_yaml_content(industry_id: int) -> str:
    return f"""# ==================== 集群部署配置（测试） ====================
hosts:
  - ip: "10.192.{industry_id}.30.11"
    ssh-port: 22
clusters:
  - name: "jdk"
    group: "base"
    instances:
      - ip: "10.192.{industry_id}.30.11"
networking:
  vips: []
"""


def seed_yaml_configs(db, industry_id: int) -> None:
    """为行业补齐 3 个演示 YAML 文件（幂等：按 industry_id+name 判重）。

    deploy_config.yml 为真实样例原文；stage/test 为按行业 IP 生成的变体。
    每个文件首次入库时落一条 v1 版本快照。
    """
    demos = [
        ("deploy_config.yml", _read_prod_sample()),
        ("deploy_stage.yml", _stage_yaml_content(industry_id)),
        ("deploy_test.yml", _test_yaml_content(industry_id)),
    ]
    for name, content in demos:
        exists = db.execute(
            select(YamlConfig).where(
                YamlConfig.industry_id == industry_id,
                YamlConfig.name == name,
            )
        ).scalar_one_or_none()
        if exists is not None:
            continue
        cfg = YamlConfig(
            industry_id=industry_id,
            name=name,
            content_text=content,
            status="invalid" if not analyze(content)["valid"] else "enabled",
            version=1,
            created_by="sys-boot",
        )
        db.add(cfg)
        db.flush()
        db.add(
            YamlConfigVersion(
                yaml_config_id=cfg.id,
                version=1,
                content=content,
                note="首次推送入库",
                created_by="sys-boot",
            )
        )
    logger.info("已补齐行业 %s 的 YAML 演示配置", industry_id)


def _ensure_scope_column() -> None:
    """迁移兼容：industries 表若缺 scope 列则补一个（默认 'both'，旧行业双菜单可见）。

    SQLite 直接 ALTER 不支持多步；MySQL/PostgreSQL 通用；这里统一使用 SQLAlchemy
    inspect 判断，支持所有后端。
    """
    from sqlalchemy import inspect, text

    insp = inspect(engine)
    cols = {c["name"] for c in insp.get_columns("industries")}
    if "scope" not in cols:
        with engine.begin() as conn:
            conn.execute(
                text("ALTER TABLE industries ADD COLUMN scope VARCHAR(10) NOT NULL DEFAULT 'both'")
            )
        logger.info("已迁移 industries 表：补 scope 列")


def init_db() -> None:
    """创建所有数据表；用户/模板行业为空时写入演示数据。"""
    Base.metadata.create_all(bind=engine)
    _ensure_scope_column()

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

        # YAML 演示配置：只给归属 YAML 菜单的行业补齐（幂等，仅补缺失文件）
        # scope=nginx 的行业不应出现 YAML 数据，否则破坏两个菜单的数据隔离
        for ind in db.execute(
            select(Industry).where(Industry.scope.in_(["both", "yml"])).order_by(Industry.id)
        ).scalars().all():
            seed_yaml_configs(db, ind.id)

        db.commit()
        logger.info("演示数据初始化完成")
    finally:
        db.close()
