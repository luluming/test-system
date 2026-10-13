"""行业克隆事务 service：把源行业整套 NginxConfig 深拷贝到新行业。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.industry import Industry
from app.models.nginx import NginxConfig
from app.schemas.industry import CloneIndustryRequest


def derive_code(name: str) -> str:
    """由行业名派生唯一 code：转小写、空白转下划线、去非法字符，截断 40。"""
    code = "_".join(part for part in name.lower().split() if part)
    code = "".join(c for c in code if c.isalnum() or c == "_")
    return (code or "industry")[:40]


def clone_industry(
    db: Session, *, payload: CloneIndustryRequest
) -> Industry:
    """事务内新建行业并深拷源行业全部 NginxConfig；任一步失败整体回滚。"""
    source = db.execute(
        select(Industry).where(Industry.id == payload.source_industry_id)
    ).scalar_one_or_none()
    if source is None:
        raise ValueError("source_industry_not_found")

    new_industry = Industry(
        code=derive_code(payload.name),
        name=payload.name,
        owner=payload.owner,
        is_template=False,
        cloned_from_id=source.id,
    )
    db.add(new_industry)
    db.flush()  # 生成 new_industry.id，供配置外键引用

    source_configs = list(
        db.execute(
            select(NginxConfig).where(NginxConfig.industry_id == source.id)
        ).scalars().all()
    )
    for cfg in source_configs:
        db.add(
            NginxConfig(
                industry_id=new_industry.id,
                name=cfg.name,
                domain=cfg.domain,
                config_text=cfg.config_text,
                enabled=cfg.enabled,
                version=1,
            )
        )
    db.commit()
    db.refresh(new_industry)
    return new_industry