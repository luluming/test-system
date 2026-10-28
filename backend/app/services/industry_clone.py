"""行业克隆事务 service：把源行业整套配置（配置 + 块树 + upstream + 映射/转发/业务端口）深拷贝到新行业。"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.industry import Industry
from app.models.nginx import (
    BizPort,
    ConfigBlock,
    ConfigOption,
    DomainMapping,
    ForwardPort,
    NginxConfig,
    NginxMirrorPair,
    Upstream,
    UpstreamServer,
)
from app.models.yaml import YamlConfig, YamlConfigVersion
from app.schemas.industry import CloneIndustryRequest


def derive_code(name: str) -> str:
    """由行业名派生唯一 code：转小写、空白转下划线、去非法字符，截断 40。"""
    code = "_".join(part for part in name.lower().split() if part)
    code = "".join(c for c in code if c.isalnum() or c == "_")
    return (code or "industry")[:40]


def clone_industry(
    db: Session, *, payload: CloneIndustryRequest
) -> Industry:
    """事务内新建行业并按 scope 深拷源行业对应的数据；任一步失败整体回滚。

    clone_scope 可选：both（默认）、nginx、yml。
    source_industry_id 为空时仅创建空行业（code 手填或自动派生），不拷贝任何数据。
    """
    if payload.source_industry_id is None:
        new_industry = Industry(
            code=payload.code or derive_code(payload.name),
            name=payload.name,
            owner=payload.owner,
            is_template=False,
            cloned_from_id=None,
            scope=payload.clone_scope or "both",
        )
        db.add(new_industry)
        db.commit()
        db.refresh(new_industry)
        return new_industry

    source = db.execute(
        select(Industry).where(Industry.id == payload.source_industry_id)
    ).scalar_one_or_none()
    if source is None:
        raise ValueError("source_industry_not_found")

    scope = payload.clone_scope or "both"

    new_industry = Industry(
        code=derive_code(payload.name),
        name=payload.name,
        owner=payload.owner,
        is_template=False,
        cloned_from_id=source.id,
        scope=scope,
    )
    db.add(new_industry)
    db.flush()  # 生成 new_industry.id，供外键引用

    if scope in ("both", "nginx"):
        _clone_nginx_from_source(db, source.id, new_industry.id)
    if scope in ("both", "yml"):
        _clone_yaml_from_source(db, source.id, new_industry.id)

    db.commit()
    db.refresh(new_industry)
    return new_industry


def _clone_nginx_from_source(db: Session, source_id: int, target_id: int) -> None:
    """把源行业全部 Nginx 配置拷贝到目标行业（配置块树 + Upstream + 映射/端口/BizPort）。"""
    # 1. nginx_configs + config_blocks(整棵 parent_id 树) + config_options
    source_configs = list(
        db.execute(
            select(NginxConfig).where(NginxConfig.industry_id == source_id)
        ).scalars().all()
    )
    cfg_id_map: dict[int, int] = {}
    for cfg in source_configs:
        new_cfg = NginxConfig(
            industry_id=target_id,
            name=cfg.name,
            domain=cfg.domain,
            config_text=cfg.config_text,
            enabled=cfg.enabled,
            version=1,
        )
        db.add(new_cfg)
        db.flush()
        cfg_id_map[cfg.id] = new_cfg.id
        _copy_block_tree(db, new_cfg.id, cfg.id)

    # 1.5 镜像对（旧 config id → 新 config id 重映射）
    for mp in db.execute(
        select(NginxMirrorPair).where(NginxMirrorPair.nginx_config_id.in_(cfg_id_map))
    ).scalars().all():
        db.add(
            NginxMirrorPair(
                nginx_config_id=cfg_id_map[mp.nginx_config_id],
                src_listen=mp.src_listen,
                dst_listen=mp.dst_listen,
            )
        )

    # 2. upstreams + upstream_servers（行业级），构建旧→新 id 映射供 forward_ports 重映射
    up_map: dict[int, int] = {}
    for up in db.execute(
        select(Upstream).where(Upstream.industry_id == source_id)
    ).scalars().all():
        new_up = Upstream(
            industry_id=target_id,
            name=up.name,
            strategy=up.strategy,
            keepalive=up.keepalive,
        )
        db.add(new_up)
        db.flush()
        up_map[up.id] = new_up.id
        for s in db.execute(
            select(UpstreamServer).where(UpstreamServer.upstream_id == up.id)
        ).scalars().all():
            db.add(
                UpstreamServer(
                    upstream_id=new_up.id,
                    addr=s.addr,
                    port=s.port,
                    weight=s.weight,
                    health_status=s.health_status,
                    enable=s.enable,
                )
            )

    # 3. domain_mappings / forward_ports / biz_ports（行业级）
    for dm in db.execute(
        select(DomainMapping).where(DomainMapping.industry_id == source_id)
    ).scalars().all():
        db.add(
            DomainMapping(
                industry_id=target_id,
                domain=dm.domain,
                forward_tos=dm.forward_tos,
                protocol=dm.protocol,
                description=dm.description,
                enabled=dm.enabled,
            )
        )
    for fp in db.execute(
        select(ForwardPort).where(ForwardPort.industry_id == source_id)
    ).scalars().all():
        db.add(
            ForwardPort(
                industry_id=target_id,
                listen_port=fp.listen_port,
                upstream_target=fp.upstream_target,
                service_name=fp.service_name,
                protocol=fp.protocol,
                enabled=fp.enabled,
                upstream_id=up_map.get(fp.upstream_id),
            )
        )
    for bp in db.execute(
        select(BizPort).where(BizPort.industry_id == source_id)
    ).scalars().all():
        db.add(
            BizPort(
                industry_id=target_id,
                service_name=bp.service_name,
                port=bp.port,
                protocol=bp.protocol,
                public_exposed=bp.public_exposed,
                note=bp.note,
            )
        )


def _clone_yaml_from_source(db: Session, source_id: int, target_id: int) -> None:
    """把源行业全部 YAML 配置 + 版本快照深拷贝到目标行业（version 从 1 起）。"""
    for yc in db.execute(
        select(YamlConfig).where(YamlConfig.industry_id == source_id)
    ).scalars().all():
        new_yc = YamlConfig(
            industry_id=target_id,
            name=yc.name,
            description=yc.description,
            content_text=yc.content_text,
            status=yc.status,
            version=1,
            created_by=yc.created_by,
        )
        db.add(new_yc)
        db.flush()
        db.add(
            YamlConfigVersion(
                yaml_config_id=new_yc.id,
                version=1,
                content=yc.content_text,
                note="克隆自源行业",
                created_by=yc.created_by,
            )
        )


def _copy_block_tree(db: Session, new_config_id: int, source_config_id: int) -> None:
    """按 parent_id 递归拷贝块树（保持嵌套），并拷贝每块的 options。"""
    rows = list(
        db.execute(
            select(ConfigBlock)
            .where(ConfigBlock.nginx_config_id == source_config_id)
            .order_by(ConfigBlock.sort_order, ConfigBlock.id)
        ).scalars().all()
    )
    child_map: dict[int | None, list[ConfigBlock]] = {}
    for b in rows:
        child_map.setdefault(b.parent_id, []).append(b)
    opt_map: dict[int, list[ConfigOption]] = {}
    if rows:
        ids = [b.id for b in rows]
        for o in db.execute(
            select(ConfigOption).where(ConfigOption.block_id.in_(ids))
        ).scalars().all():
            opt_map.setdefault(o.block_id, []).append(o)
    old_to_new: dict[int, int] = {}

    def add_children(old_parent_id: int | None, new_parent_id: int | None) -> None:
        for b in child_map.get(old_parent_id, []):
            nb = ConfigBlock(
                nginx_config_id=new_config_id,
                parent_id=new_parent_id,
                scope=b.scope,
                header=b.header,
                belongs_to_file=b.belongs_to_file,
                sort_order=b.sort_order,
            )
            db.add(nb)
            db.flush()
            old_to_new[b.id] = nb.id
            for o in opt_map.get(b.id, []):
                db.add(
                    ConfigOption(
                        block_id=nb.id,
                        directive=o.directive,
                        value=o.value,
                        row_type=o.row_type,
                        is_free_text=o.is_free_text,
                        sort_order=o.sort_order,
                    )
                )
            add_children(b.id, nb.id)

    add_children(None, None)
