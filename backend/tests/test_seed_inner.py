"""seed 演示数据：persist_tree 落库 + 渲染/拓扑端到端。"""

from app.services.nginx_export import export_config_text
from app.services.nginx_render import (
    build_config_dict,
    parse,
    persist_tree,
    render_config_text,
)
from app.services.nginx_export import export_lines

DEMO = """server {
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


def test_persist_tree_roundtrip(db_session_factory):
    """parse → persist_tree → build_config_dict → render 往返一致。"""
    from app.models import Industry, NginxConfig

    db = db_session_factory()
    ind = Industry(code="seed", name="种子")
    db.add(ind)
    db.flush()
    cfg = NginxConfig(industry_id=ind.id, name="conf", config_text=DEMO, version=1)
    db.add(cfg)
    db.flush()
    persist_tree(db, cfg.id, parse(DEMO, "http"))

    root = build_config_dict(db, cfg.id, context="conf")
    text = render_config_text(root)
    assert "listen 443 ssl http2;" in text
    assert "server_name freight.example.com;" in text
    assert "default upgrade;" in text
    assert "'' close;" in text
    db.close()


def test_seed_template_blocks_helper(db_session_factory):
    """seed 的块树落库助手：为模板行业配置写入块树，落库后可渲染/导出。"""
    from app.models import Industry, NginxConfig
    from app.seed import seed_template_blocks

    db = db_session_factory()
    ind = Industry(code="overseas_freight", name="海外货运", is_template=True)
    db.add(ind)
    db.flush()
    cfg = NginxConfig(industry_id=ind.id, name="overseas_http", config_text=DEMO, version=1)
    db.add(cfg)
    db.commit()
    seed_template_blocks(db, cfg.id)

    root = build_config_dict(db, cfg.id, context="conf")
    text = render_config_text(root)
    assert "listen 443 ssl http2;" in text
    assert "server_name freight.example.com;" in text
    assert "default upgrade;" in text
    # SSL 关闭导出：丢 ssl_* 并改写 listen
    lines = export_lines(root, ctx="conf", ssl_on=False, dom_new=None, default_ips="", exceptions=[])
    nonssl = "\n".join(l["text"] for l in lines)
    assert "listen 443 http2;" in nonssl
    assert "ssl_certificate" not in nonssl
    db.close()


def test_seed_render_and_export_via_api(client, auth_headers):
    """通过 API 建块树后 render/export 端到端（模拟前端落库路径）。"""
    ind = client.post(
        "/api/industries", json={"code": "seed2", "name": "种子2"}, headers=auth_headers
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "conf", "config_text": DEMO},
        headers=auth_headers,
    ).json()
    root = parse(DEMO, "http")

    def add_children(nodes, parent_id):
        for idx, n in enumerate(nodes):
            created = client.post(
                "/api/config-blocks",
                json={
                    "nginx_config_id": cfg["id"],
                    "parent_id": parent_id,
                    "scope": n["scope"],
                    "header": n.get("header", ""),
                    "sort_order": idx,
                },
                headers=auth_headers,
            ).json()
            for oi, o in enumerate(n.get("options", [])):
                client.post(
                    "/api/config-options",
                    json={
                        "block_id": created["id"],
                        "directive": o["directive"],
                        "value": o["value"],
                        "row_type": "kv",
                        "sort_order": oi,
                    },
                    headers=auth_headers,
                )
            add_children(n.get("children", []), created["id"])

    add_children(root["children"], None)

    r = client.get(f"/api/nginx-configs/{cfg['id']}/render", headers=auth_headers)
    assert r.status_code == 200
    assert "listen 443 ssl http2;" in r.json()["content"]

    exp = client.post(
        f"/api/nginx-configs/{cfg['id']}/export",
        json={
            "ssl_enabled": False,
            "server_name_domain": "new.example.com",
            "upstream_default_ips": "10.8.8.8, 10.8.8.9",
            "upstream_exceptions": [],
            "context": "conf",
        },
        headers=auth_headers,
    )
    assert exp.status_code == 200
    content = exp.json()["content"]
    assert "server_name new.example.com;" in content
    assert "server 10.8.8.8:8080 weight=5 max_fails=2 fail_timeout=30s;" in content
    assert "listen 443 http2;" in content
