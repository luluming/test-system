"""渲染服务：parse 移植 + 深度优先 render（复刻 mock renderPreview / orderedOptions）。"""

from app.services.nginx_render import parse, render_text


DEMO = """server {
  listen 443 ssl http2;
  server_name freight.example.com;
  location /api/ {
    proxy_pass http://api_backend;
  }
}
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}"""


def test_parse_builds_generalized_tree():
    root = parse(DEMO, "http")
    scopes = [c["scope"] for c in root["children"]]
    assert scopes == ["server", "map"]
    srv = root["children"][0]
    assert srv["header"] == "server"
    listens = [o for o in srv["options"] if o["directive"] == "listen"]
    assert listens[0]["value"] == "443 ssl http2"
    loc = srv["children"][0]
    assert loc["scope"] == "location" and loc["header"] == "location /api/"
    assert loc["options"][0]["directive"] == "proxy_pass"
    mp = root["children"][1]
    assert [o["directive"] for o in mp["options"]] == ["default", "''"]


def test_render_text_replicates_render_preview():
    root = parse(DEMO, "http")
    lines = render_text(root)
    assert lines == [
        "http {",
        "    server {",
        "        listen 443 ssl http2;",
        "        server_name freight.example.com;",
        "        location /api/ {",
        "            proxy_pass http://api_backend;",
        "        }",
        "    }",
        "    map $http_upgrade $connection_upgrade {",
        "        '' close;",
        "        default upgrade;",
        "    }",
        "}",
    ]


def test_render_comment_and_if():
    root = parse("# 这是注释\nif ($x) { return 404; }\nserver { listen 80; }", "http")
    lines = render_text(root)
    assert "# 这是注释" in lines
    assert "    # 建议少用 if" in lines
