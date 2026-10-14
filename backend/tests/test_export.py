"""导出中心：SSL 开关 + server_name 替换 + upstream 整组替换（默认+例外）。"""

from app.services.nginx_export import (
    apply_domains,
    derive_up_backends,
    dom_parse,
    export_lines,
    ips_for_group,
    up_key_of,
    up_name_of,
)
from app.services.nginx_render import parse

UPSTREAM_CONF = """upstream api_backend {
  server 10.0.0.97:8080 weight=5 max_fails=2 fail_timeout=30s;
  server 10.0.0.193:8080 weight=5 max_fails=2 fail_timeout=30s;
}
upstream web_backend {
  server 10.0.0.97:80;
}
server {
  listen 443 ssl http2;
  server_name old.example.com;
  ssl_certificate /etc/nginx/cert.pem;
  location /api/ {
    proxy_pass http://api_backend;
  }
}"""


def test_dom_parse():
    assert dom_parse("10.0.0.1, 10.0.0.2\n10.0.0.3") == ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
    assert dom_parse("") == []


def test_apply_domains_replaces_all_server_name():
    raw, changed, orig = apply_domains("server_name old.example.com", "new.example.com")
    assert raw == "server_name new.example.com" and changed and orig == "server_name old.example.com"
    raw2, changed2, _ = apply_domains("server_name old.example.com", "")
    assert raw2 == "server_name old.example.com" and not changed2
    raw3, changed3, _ = apply_domains("listen 80", "new.example.com")
    assert raw3 == "listen 80" and not changed3


def test_up_name_and_key():
    root = parse("upstream api_backend { server 1.1.1.1; }", "http")
    g = root["children"][0]
    assert up_name_of(g) == "api_backend"
    assert up_key_of(g, "conf") == "conf:api_backend"


def test_derive_up_backends_keeps_port_and_params():
    root = parse("upstream api_backend { server 10.0.0.97:8080 weight=5 max_fails=2 fail_timeout=30s; }", "http")
    g = root["children"][0]
    rows = derive_up_backends(g, ["10.8.8.8"])
    assert rows == [
        {"text": "server 10.8.8.8:8080 weight=5 max_fails=2 fail_timeout=30s;",
         "orig": "server 10.0.0.97:8080 weight=5 max_fails=2 fail_timeout=30s"}
    ]


def test_ips_for_group_exception_first_then_default():
    exceptions = [{"grp": "conf:web_backend", "ips": "10.8.8.8"}]
    assert ips_for_group("conf:web_backend", exceptions, "10.1.1.1, 10.1.1.2") == "10.8.8.8"
    assert ips_for_group("conf:api_backend", exceptions, "10.1.1.1, 10.1.1.2") == "10.1.1.1, 10.1.1.2"


def test_export_lines_ssl_off_drops_ssl_and_rewrites_listen():
    root = parse(UPSTREAM_CONF, "http")
    lines = export_lines(root, ctx="conf", ssl_on=False, dom_new=None, default_ips="", exceptions=[])
    text = "\n".join(l["text"] for l in lines)
    assert "ssl_certificate" not in text
    assert "listen 443 http2;" in text
    assert "listen 443 ssl http2;" not in text


def test_export_lines_domain_and_upstream_replace():
    root = parse(UPSTREAM_CONF, "http")
    lines = export_lines(
        root,
        ctx="conf",
        ssl_on=True,
        dom_new="new.example.com",
        default_ips="10.8.8.8, 10.8.8.9",
        exceptions=[],
    )
    changed = [l for l in lines if l["changed"]]
    text = "\n".join(l["text"] for l in lines)
    assert "server_name new.example.com;" in text
    assert "server 10.8.8.8:8080 weight=5 max_fails=2 fail_timeout=30s;" in text
    assert "server 10.8.8.9:8080 weight=5 max_fails=2 fail_timeout=30s;" in text
    assert "server 10.0.0.97:8080" not in text
    # web_backend 无端口，补默认 80 沿用原
    assert "server 10.8.8.8:80;" in text
    # 5 处命中：1 域名 + 2 api_backend 节点 + 2 web_backend 节点（默认 IP 两个各应用一组）
    assert len(changed) == 5


def test_export_lines_exception_overrides_group():
    root = parse(UPSTREAM_CONF, "http")
    lines = export_lines(
        root,
        ctx="conf",
        ssl_on=True,
        dom_new=None,
        default_ips="10.1.1.1, 10.1.1.2",
        exceptions=[{"grp": "conf:api_backend", "ips": "10.9.9.9"}],
    )
    text = "\n".join(l["text"] for l in lines)
    assert "server 10.9.9.9:8080 weight=5 max_fails=2 fail_timeout=30s;" in text
    assert "server 10.1.1.1:80;" in text  # web_backend 走默认
    assert "server 10.1.1.1:8080" not in text
