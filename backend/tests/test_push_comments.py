"""推送解析/应用中的注释位置保真：整行注释在父块尚无子块时作 comment 选项行，
父块已有子块时作 scope="comment" 子节点（与兄弟块按 sort_order 交错，保住文件位置）；
顶层指令/注释经 apply 持久化为根 options 块与顶层 comment 块。"""

import pytest
from sqlalchemy import select

from app.services.nginx_push import compute_diff, parse_nginx, perform_apply
from app.services.nginx_render import build_config_dict, render_text


SRC = """\
server {
    # 最开始新增拦截
    listen 80;
    add_header Last-Modified ""; # 新增请求ip到后端
    deny all; # 阻断客户端伪造
    location /api/ { # 后端接口
        proxy_pass http://backend;
    }
}
"""

SRC_INTERLEAVED = """\
server {
    listen 80;
    location /a {
        proxy_pass http://a;
    }
    # 在块之间的注释
    location /b {
        proxy_pass http://b;
    }
}
"""


def _find_server(root):
    for c in root["children"]:
        if c["scope"] == "server":
            return c
    raise AssertionError("server 块缺失")


def test_comments_become_options_not_children():
    """整行注释出现在首个子块之前 → 父块 comment 选项行（非子块）。"""
    root, errors = parse_nginx(SRC)
    assert not errors
    srv = _find_server(root)
    scopes = [c["scope"] for c in srv["children"]]
    # 无 comment 子块；location 是唯一子块
    assert scopes == ["location"]
    comments = [o for o in srv["options"] if o.get("row_type") == "comment"]
    assert [o["value"] for o in comments] == [
        "最开始新增拦截",
        "新增请求ip到后端",
        "阻断客户端伪造",
    ]
    assert all(o["directive"] == "#" for o in comments)
    # 引号内的 # 不被误判为注释
    last_modified = [o for o in srv["options"] if o["directive"] == "add_header"]
    assert last_modified[0]["value"] == 'Last-Modified ""'


def test_roundtrip_preserves_comments():
    root, errors = parse_nginx(SRC)
    assert not errors
    srv = _find_server(root)
    text = "\n".join(render_text(root))
    assert "# 最开始新增拦截" in text
    assert "# 新增请求ip到后端" in text
    assert "# 阻断客户端伪造" in text
    assert 'add_header Last-Modified "";' in text
    loc = srv["children"][0]
    assert [o["value"] for o in loc["options"] if o.get("row_type") == "comment"] == ["后端接口"]
    assert "# 后端接口" in text
    # 注释行不带尾分号
    assert "# 新增请求ip到后端;" not in text


def test_top_level_comment_goes_to_root_options():
    src = "# 顶部说明\nhttp {\n    server { listen 80; }\n}\n"
    root, errors = parse_nginx(src)
    assert not errors
    cmts = [o for o in root["options"] if o["row_type"] == "comment"]
    assert [o["value"] for o in cmts] == ["顶部说明"]


def test_interleaved_comment_becomes_child_node():
    """整行注释出现在子块之间 → scope=comment 子节点，渲染位置在兄弟块之间。"""
    root, errors = parse_nginx(SRC_INTERLEAVED)
    assert not errors
    srv = _find_server(root)
    assert [c["scope"] for c in srv["children"]] == ["location", "comment", "location"]
    cmt = srv["children"][1]
    assert cmt["header"] == "在块之间的注释"
    assert cmt["options"] == [] and cmt["children"] == []
    text = "\n".join(render_text(root))
    assert text.index("location /a {") < text.index("# 在块之间的注释") < text.index("location /b {")
    assert "# 在块之间的注释;" not in text


def test_mirror_does_not_clobber_file_dst(db_session_factory):
    """文件同时含 443/20551 时，apply 后镜像不覆盖 dst：20551 保留自身内容与注释位置。"""
    from app.models.nginx import NginxMirrorPair
    from app.models import ConfigBlock, Industry, NginxConfig

    src = """\
server {
    listen 443 ssl;
    # 443专属注释
    location /a {
        proxy_pass http://a;
    }
}
server {
    listen 20551;
    # 20551专属注释
    location /b {
        proxy_pass http://b;
    }
}
"""
    db = db_session_factory()
    ind = Industry(code="push2", name="推送2")
    db.add(ind)
    db.flush()
    cfg = NginxConfig(industry_id=ind.id, name="conf", config_text=src, version=1)
    db.add(cfg)
    db.flush()
    db.add(NginxMirrorPair(nginx_config_id=cfg.id, src_listen="443", dst_listen="20551"))
    db.flush()

    root, errors = parse_nginx(src)
    assert not errors
    entries, dup = compute_diff(root, {"scope": "http", "header": "http", "children": [], "options": []})
    assert not dup
    result = perform_apply(db, cfg.id, root, entries)
    db.commit()

    assert result["mirrored"] == []  # dst 也在文件中，不被 src 覆盖
    r = build_config_dict(db, cfg.id, context="conf")
    text = "\n".join(render_text(r))
    assert text.count("# 443专属注释") == 1
    assert text.count("# 20551专属注释") == 1
    db.close()


def test_apply_persists_root_level_and_positions(db_session_factory):
    """apply 后：顶层指令/注释进根 options 块；块间注释按文件序成块，渲染位置保真。"""
    from app.models import ConfigBlock, Industry, NginxConfig

    src = "# 顶部说明\nunderscores_in_headers on;\n" + SRC_INTERLEAVED + "# 顶部尾部注释\n"
    db = db_session_factory()
    ind = Industry(code="push", name="推送")
    db.add(ind)
    db.flush()
    cfg = NginxConfig(industry_id=ind.id, name="conf", config_text=src, version=1)
    db.add(cfg)
    db.flush()

    root, errors = parse_nginx(src)
    assert not errors
    empty_root = {"scope": "http", "header": "http", "children": [], "options": []}
    entries, dup = compute_diff(root, empty_root)
    assert not dup
    perform_apply(db, cfg.id, root, entries)
    db.commit()

    r = build_config_dict(db, cfg.id, context="conf")
    # 顶层 options：注释「顶部说明」+ underscores_in_headers 指令
    assert any(o["directive"] == "#" and o["value"] == "顶部说明" for o in r["options"])
    assert any(o["directive"] == "underscores_in_headers" and o["value"] == "on" for o in r["options"])

    # 渲染：块间注释保持在 location /a 与 location /b 之间
    text = "\n".join(render_text(r))
    assert text.index("listen 80;") < text.index("location /a {")
    assert text.index("location /a {") < text.index("# 在块之间的注释") < text.index("location /b {")
    assert text.index("# 顶部说明") < text.index("underscores_in_headers on;")
    assert "# 顶部尾部注释" in text

    # DB 形态：根 options 块（header="" 无子块）+ 顶层/块间 comment 块
    cmts = list(
        db.execute(
            select(ConfigBlock).where(ConfigBlock.nginx_config_id == cfg.id, ConfigBlock.scope == "comment")
        ).scalars().all()
    )
    assert {c.header for c in cmts} == {"在块之间的注释", "顶部尾部注释"}
    tail = next(c for c in cmts if c.header == "顶部尾部注释")
    assert tail.parent_id is None
    inner = next(c for c in cmts if c.header == "在块之间的注释")
    srv = list(
        db.execute(
            select(ConfigBlock).where(ConfigBlock.nginx_config_id == cfg.id, ConfigBlock.scope == "server")
        ).scalars().all()
    )
    assert inner.parent_id == srv[0].id
    # 根 options 块：header="" 且 scope=http、无子块
    rb = list(
        db.execute(
            select(ConfigBlock).where(
                ConfigBlock.nginx_config_id == cfg.id,
                ConfigBlock.parent_id.is_(None),
                ConfigBlock.scope == "http",
                ConfigBlock.header == "",
            )
        ).scalars().all()
    )
    assert len(rb) == 1 and not list(db.execute(select(ConfigBlock).where(ConfigBlock.parent_id == rb[0].id)).scalars().all())
    db.close()
