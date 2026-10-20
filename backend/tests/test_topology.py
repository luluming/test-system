"""全局拓扑：四层聚合数据（域名 / 监听点 / upstream / 后端节点）。"""

from app.services.nginx_render import build_config_dict


def _seed_tree(client, headers):
    ind = client.post(
        "/api/industries", json={"code": "tp", "name": "拓扑"}, headers=headers
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "conf", "config_text": "server {}"},
        headers=headers,
    ).json()
    srv = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=headers,
    ).json()
    client.post(
        "/api/config-options",
        json={"block_id": srv["id"], "directive": "listen", "value": "443 ssl http2", "sort_order": 0},
        headers=headers,
    )
    client.post(
        "/api/config-options",
        json={"block_id": srv["id"], "directive": "server_name", "value": "freight.example.com", "sort_order": 1},
        headers=headers,
    )
    loc = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "parent_id": srv["id"], "scope": "location", "header": "location /api/ {", "sort_order": 0},
        headers=headers,
    ).json()
    client.post(
        "/api/config-options",
        json={"block_id": loc["id"], "directive": "proxy_pass", "value": "http://api_backend", "sort_order": 0},
        headers=headers,
    )
    up = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "upstream", "header": "upstream api_backend {", "sort_order": 1},
        headers=headers,
    ).json()
    for addr, port in (("10.0.0.97", 8080), ("10.0.0.193", 8080)):
        client.post(
            "/api/config-options",
            json={"block_id": up["id"], "directive": "server", "value": f"{addr}:{port} weight=5", "sort_order": 0},
            headers=headers,
        )
    return ind, cfg


def test_topology_aggregates_four_layers(client, auth_headers):
    _, cfg = _seed_tree(client, auth_headers)
    r = client.get(f"/api/topology?config_id={cfg['id']}", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["domains"] == ["freight.example.com"]
    assert body["listeners"][0]["listen_plain"] == "443"
    assert body["listeners"][0]["server_name"] == "freight.example.com"
    assert body["listeners"][0]["location_count"] == 1
    assert body["upstreams"][0]["name"] == "api_backend"
    assert [b["addr"] for b in body["upstreams"][0]["backends"]] == ["10.0.0.97", "10.0.0.193"]
    assert body["links"] == [{"listen": "443", "upstream": "api_backend"}]


def test_build_config_dict_listen_plain():
    """拓扑用 listenPlain 语义：剥离 ssl/http2 修饰词。"""
    from app.services.nginx_render import parse

    root = parse("server { listen 443 ssl http2; }", "http")
    assert root["children"][0]["options"][0]["value"] == "443 ssl http2"
