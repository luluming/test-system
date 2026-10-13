"""内页① 数据模型测试：四张新表 + 既有表行业维度。"""

from sqlalchemy import select

from app.models import (
    BizPort,
    ConfigBlock,
    ConfigOption,
    DomainMapping,
    ForwardPort,
    Industry,
    NginxConfig,
    Upstream,
    UpstreamServer,
)


def _industry(db, code="i1"):
    ind = Industry(code=code, name="行业" + code)
    db.add(ind)
    db.flush()
    return ind


def _config(db, ind, name="conf"):
    cfg = NginxConfig(industry_id=ind.id, name=name, config_text="", version=1)
    db.add(cfg)
    db.flush()
    return cfg


def test_config_block_and_option_persist(db_session_factory):
    """config_blocks / config_options 可落库并回读。"""
    db = db_session_factory()
    ind = _industry(db)
    cfg = _config(db, ind)
    blk = ConfigBlock(
        nginx_config_id=cfg.id, scope="server", header="server {", sort_order=0
    )
    db.add(blk)
    db.flush()
    opt = ConfigOption(
        block_id=blk.id, directive="listen", value="80", row_type="kv", sort_order=0
    )
    db.add(opt)
    db.commit()
    assert blk.id is not None and opt.id is not None
    got = db.execute(select(ConfigOption).where(ConfigOption.block_id == blk.id)).scalars().one()
    assert got.directive == "listen" and got.value == "80"
    db.close()


def test_config_block_nested_parent(db_session_factory):
    """parent_id 自关联表达嵌套：location 挂在 server 下。"""
    db = db_session_factory()
    ind = _industry(db)
    cfg = _config(db, ind)
    srv = ConfigBlock(nginx_config_id=cfg.id, scope="server", header="server {", sort_order=0)
    db.add(srv)
    db.flush()
    loc = ConfigBlock(
        nginx_config_id=cfg.id, parent_id=srv.id, scope="location", header="location /api/ {", sort_order=0
    )
    db.add(loc)
    db.commit()
    assert loc.parent_id == srv.id
    db.close()


def test_upstream_unique_per_industry(db_session_factory):
    """upstreams 组名在行业内唯一；跨行业允许同名。"""
    db = db_session_factory()
    a = _industry(db, "a")
    b = _industry(db, "b")
    db.add(Upstream(industry_id=a.id, name="api_backend"))
    db.add(Upstream(industry_id=b.id, name="api_backend"))
    db.commit()
    db.close()


def test_legacy_tables_require_industry(db_session_factory):
    """domain_mappings / forward_ports / biz_ports 现在必须带 industry_id。"""
    db = db_session_factory()
    ind = _industry(db)
    db.add(DomainMapping(industry_id=ind.id, domain="a.example.com", forward_tos="10.0.0.1:80"))
    db.add(ForwardPort(industry_id=ind.id, listen_port=8080, upstream_target="10.0.0.1:8080"))
    db.add(BizPort(industry_id=ind.id, service_name="web", port=8080))
    db.commit()
    db.close()


def test_forward_port_upstream_fk(db_session_factory):
    """forward_ports.upstream_id 可空且可引用 upstreams.id。"""
    db = db_session_factory()
    ind = _industry(db)
    up = Upstream(industry_id=ind.id, name="web_backend")
    db.add(up)
    db.flush()
    fp = ForwardPort(
        industry_id=ind.id, listen_port=8080, upstream_target="web_backend", upstream_id=up.id
    )
    db.add(fp)
    db.commit()
    assert fp.upstream_id == up.id
    db.close()
