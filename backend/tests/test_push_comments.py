"""推送解析中的注释处理：整行注释 / 行内注释 → 父块 comment 选项行（非子块）。"""

import pytest

from app.services.nginx_push import parse_nginx
from app.services.nginx_render import render_text


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


def _find_server(root):
    for c in root["children"]:
        if c["scope"] == "server":
            return c
    raise AssertionError("server 块缺失")


def test_comments_become_options_not_children():
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
