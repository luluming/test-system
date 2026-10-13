"""config-blocks / config-options CRUD：嵌套、children、default 置底、删除子树。"""


def _mk(client, headers):
    ind = client.post(
        "/api/industries", json={"code": "bk", "name": "块"}, headers=headers
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "conf", "config_text": "server {}"},
        headers=headers,
    ).json()
    return ind, cfg


def test_block_tree_create_and_children(client, auth_headers):
    """建 server → location 子块；children 端点按 sort_order 返回。"""
    _, cfg = _mk(client, auth_headers)
    srv = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    loc = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "parent_id": srv["id"], "scope": "location", "header": "location /api/ {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    assert loc["parent_id"] == srv["id"]
    kids = client.get(f"/api/config-blocks/{srv['id']}/children", headers=auth_headers).json()
    assert [k["scope"] for k in kids] == ["location"]
    top = client.get(f"/api/config-blocks?nginx_config_id={cfg['id']}", headers=auth_headers).json()
    assert [t["scope"] for t in top] == ["server"]


def test_config_tree_endpoint(client, auth_headers):
    """GET /api/nginx-configs/{id}/tree 返回嵌套树。"""
    _, cfg = _mk(client, auth_headers)
    srv = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "parent_id": srv["id"], "scope": "location", "header": "location / {", "sort_order": 0},
        headers=auth_headers,
    )
    tree = client.get(f"/api/nginx-configs/{cfg['id']}/tree", headers=auth_headers).json()
    assert tree["blocks"][0]["scope"] == "server"
    assert tree["blocks"][0]["children"][0]["scope"] == "location"


def test_option_default_bottom(client, auth_headers):
    """options 列表：default 恒置底（即使 sort_order 靠前）。"""
    _, cfg = _mk(client, auth_headers)
    blk = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "map", "header": "map $a $b {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    client.post(
        "/api/config-options",
        json={"block_id": blk["id"], "directive": "default", "value": "upgrade", "row_type": "default", "sort_order": 0},
        headers=auth_headers,
    )
    client.post(
        "/api/config-options",
        json={"block_id": blk["id"], "directive": "~^\\\\.", "value": "1.0.0.1", "row_type": "regex", "sort_order": 1},
        headers=auth_headers,
    )
    opts = client.get(f"/api/config-options?block_id={blk['id']}", headers=auth_headers).json()
    assert [o["directive"] for o in opts] == ["~^\\\\.", "default"]


def test_option_reorder(client, auth_headers):
    """reorder 批量重排 sort_order；default 仍恒置底。"""
    _, cfg = _mk(client, auth_headers)
    blk = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    o1 = client.post("/api/config-options", json={"block_id": blk["id"], "directive": "listen", "value": "80", "sort_order": 0}, headers=auth_headers).json()
    o2 = client.post("/api/config-options", json={"block_id": blk["id"], "directive": "server_name", "value": "a.com", "sort_order": 1}, headers=auth_headers).json()
    r = client.put(
        "/api/config-options/reorder",
        json={"block_id": blk["id"], "ids": [o2["id"], o1["id"]]},
        headers=auth_headers,
    )
    assert r.status_code == 200
    opts = client.get(f"/api/config-options?block_id={blk['id']}", headers=auth_headers).json()
    assert [o["directive"] for o in opts] == ["server_name", "listen"]


def test_delete_block_prunes_subtree(client, auth_headers):
    """删除 server 块级联删掉其 location 子块与 options。"""
    _, cfg = _mk(client, auth_headers)
    srv = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    loc = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "parent_id": srv["id"], "scope": "location", "header": "location / {", "sort_order": 0},
        headers=auth_headers,
    ).json()
    client.post("/api/config-options", json={"block_id": loc["id"], "directive": "proxy_pass", "value": "http://x", "sort_order": 0}, headers=auth_headers)
    assert client.delete(f"/api/config-blocks/{srv['id']}", headers=auth_headers).status_code == 204
    assert client.get(f"/api/config-blocks/{loc['id']}", headers=auth_headers).status_code == 404
    assert client.get(f"/api/config-options?block_id={loc['id']}", headers=auth_headers).json() == []
