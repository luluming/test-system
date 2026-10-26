"""一次性导入：把 .nginx-mock/plan-c-real-conf.html 的真实 nginx 配置写入正式系统。

复用 app.services.nginx_render.parse + persist_tree 落库管线。
幂等：行业 business_center 已存在且两条配置均有块树则跳过；缺则补建。
用法：cd backend && .venv\\Scripts\\python.exe import_mock_data.py
"""

import re
from pathlib import Path

from sqlalchemy import select

from app.core.logging import logger
from app.database import SessionLocal
from app.models import ConfigBlock, Industry, NginxConfig
from app.services.nginx_render import parse, persist_tree

MOCK_HTML = Path(__file__).resolve().parent.parent / ".nginx-mock" / "plan-c-real-conf.html"
CONF_NAME = "businesscenter_nginx_CD_master.conf"
STREAM_NAME = "businesscenter_nginx_CD_master.stream"


def extract_block(html: str, block_id: str) -> str:
    m = re.search(rf'<script[^>]*id="{block_id}"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise RuntimeError(f"未找到 {block_id} 块")
    return m.group(1).strip()


def _fill_config(db, industry_id: int, name: str, src: str, scope: str) -> None:
    cfg = db.execute(
        select(NginxConfig).where(
            NginxConfig.industry_id == industry_id, NginxConfig.name == name
        )
    ).scalar_one_or_none()
    if cfg is None:
        cfg = NginxConfig(
            industry_id=industry_id,
            name=name,
            config_text=src,
            enabled=True,
            version=1,
        )
        db.add(cfg)
        db.flush()
    has_blocks = (
        db.execute(
            select(ConfigBlock).where(ConfigBlock.nginx_config_id == cfg.id)
        ).scalars().first()
    ) is not None
    if not has_blocks:
        persist_tree(db, cfg.id, parse(src, scope))
        logger.info("已写入 %s（scope=%s）", name, scope)


def main() -> None:
    html = MOCK_HTML.read_text(encoding="utf-8")
    src_conf = extract_block(html, "nginx-src")
    src_stream = extract_block(html, "nginx-stream-src")
    logger.info(
        "提取原文 conf=%d 行 / stream=%d 行",
        len(src_conf.splitlines()),
        len(src_stream.splitlines()),
    )

    db = SessionLocal()
    try:
        industry = db.execute(
            select(Industry).where(Industry.code == "business_center")
        ).scalar_one_or_none()
        if industry is None:
            industry = Industry(code="business_center", name="业务中心", owner="admin")
            db.add(industry)
            db.flush()
            logger.info("新建行业 business_center（业务中心）")

        _fill_config(db, industry.id, CONF_NAME, src_conf, "http")
        _fill_config(db, industry.id, STREAM_NAME, src_stream, "stream")

        db.commit()
        logger.info("导入完成")
    finally:
        db.close()


if __name__ == "__main__":
    main()
