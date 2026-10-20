"""模板克隆事务深拷贝测试。"""


def test_clone_requires_auth(client):
    """未登录克隆返回 401。"""
    resp = client.post("/api/industries/clone", json={"source_industry_id": 1, "name": "x"})
    assert resp.status_code == 401


def _seed_source(client, headers):
    src = client.post(
        "/api/industries",
        json={"code": "overseas_freight", "name": "海外货运", "owner": "张工", "is_template": True},
        headers=headers,
    ).json()
    for n in ("overseas_http", "overseas_https"):
        client.post(
            "/api/nginx-configs",
            json={"industry_id": src["id"], "name": n, "config_text": f'server {{ listen {80 if n.endswith("http") else 443}; }}'},
            headers=headers,
        )
    return src


def test_clone_deep_copies_and_independent(client, auth_headers):
    """克隆后新行业配置计数一致、cloned_from_id 正确、且编辑互不影响。"""
    hdrs = auth_headers
    src = _seed_source(client, hdrs)
    r = client.post(
        "/api/industries/clone",
        json={"source_industry_id": src["id"], "name": "国内", "owner": "李工"},
        headers=hdrs,
    )
    assert r.status_code == 201
    new = r.json()
    assert new["cloned_from_id"] == src["id"]
    assert new["is_template"] is False

    src_cfgs = client.get(f"/api/nginx-configs?industry_id={src['id']}", headers=hdrs).json()
    new_cfgs = client.get(f"/api/nginx-configs?industry_id={new['id']}", headers=hdrs).json()
    assert len(new_cfgs) == len(src_cfgs) == 2
    assert {c["name"] for c in new_cfgs} == {"overseas_http", "overseas_https"}
    assert all(c["version"] == 1 for c in new_cfgs)
    assert all(c["industry_id"] == new["id"] for c in new_cfgs)

    # 独立：改克隆后源不受影响
    target = next(c for c in new_cfgs if c["name"] == "overseas_http")
    client.put(
        f"/api/nginx-configs/{target['id']}",
        json={"config_text": "modified", "base_version": 1},
        headers=hdrs,
    )
    src_again = client.get(f"/api/nginx-configs?industry_id={src['id']}", headers=hdrs).json()
    src_http = next(c for c in src_again if c["name"] == "overseas_http")
    assert src_http["config_text"] != "modified"


def test_clone_missing_source_404(client, auth_headers):
    """源行业不存在返回 404。"""
    resp = client.post(
        "/api/industries/clone",
        json={"source_industry_id": 9999, "name": "x"},
        headers=auth_headers,
    )
    assert resp.status_code == 404


def test_clone_duplicate_name_conflict(client, auth_headers):
    """克隆目标行业 code 派生自 name，重名冲突返回 409。"""
    hdrs = auth_headers
    src = _seed_source(client, hdrs)
    body = {"source_industry_id": src["id"], "name": "海外货运"}
    assert client.post("/api/industries/clone", json=body, headers=hdrs).status_code == 201
    assert client.post("/api/industries/clone", json=body, headers=hdrs).status_code == 409


def _seed_inner_source(client, headers):
    """带块树 / upstream / 映射 / 转发 / 业务端口的源行业。"""
    src = client.post(
        "/api/industries",
        json={"code": "inner_src", "name": "内页源", "is_template": True},
        headers=headers,
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": src["id"], "name": "conf", "config_text": "server {}"},
        headers=headers,
    ).json()
    srv = client.post(
        "/api/config-blocks",
        json={"nginx_config_id": cfg["id"], "scope": "server", "header": "server {", "sort_order": 0},
        headers=headers,
    ).json()
    client.post(
        "/api/config-options",
        json={"block_id": srv["id"], "directive": "listen", "value": "443", "sort_order": 0},
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
        "/api/upstreams",
        json={"industry_id": src["id"], "name": "api_backend"},
        headers=headers,
    ).json()
    client.post(
        f"/api/upstreams/{up['id']}/servers",
        json={"addr": "10.0.0.97", "port": 8080, "weight": 5},
        headers=headers,
    )
    client.post(
        "/api/domain-mappings",
        json={"industry_id": src["id"], "domain": "a.example.com", "forward_tos": "10.0.0.1:80"},
        headers=headers,
    )
    client.post(
        "/api/forward-ports",
        json={"industry_id": src["id"], "listen_port": 8080, "upstream_target": "api_backend", "upstream_id": up["id"]},
        headers=headers,
    )
    client.post(
        "/api/biz-ports",
        json={"industry_id": src["id"], "service_name": "web", "port": 8080},
        headers=headers,
    )
    return src


def test_clone_deep_copies_inner_tables(client, auth_headers):
    """克隆后：块树整棵（含子块/options）、upstream+servers、映射/转发/业务端口计数一致；upstream_id 重映射。"""
    hdrs = auth_headers
    src = _seed_inner_source(client, hdrs)
    r = client.post(
        "/api/industries/clone",
        json={"source_industry_id": src["id"], "name": "克隆内页"},
        headers=hdrs,
    )
    assert r.status_code == 201
    new = r.json()

    src_cfg = client.get(f"/api/nginx-configs?industry_id={src['id']}", headers=hdrs).json()[0]
    new_cfg = client.get(f"/api/nginx-configs?industry_id={new['id']}", headers=hdrs).json()[0]
    src_tree = client.get(f"/api/nginx-configs/{src_cfg['id']}/tree", headers=hdrs).json()
    new_tree = client.get(f"/api/nginx-configs/{new_cfg['id']}/tree", headers=hdrs).json()
    assert len(new_tree["blocks"]) == len(src_tree["blocks"]) == 1
    assert new_tree["blocks"][0]["scope"] == "server"
    assert new_tree["blocks"][0]["children"][0]["scope"] == "location"
    assert new_tree["blocks"][0]["children"][0]["options"][0]["directive"] == "proxy_pass"

    src_ups = client.get(f"/api/upstreams?industry_id={src['id']}", headers=hdrs).json()
    new_ups = client.get(f"/api/upstreams?industry_id={new['id']}", headers=hdrs).json()
    assert len(new_ups) == len(src_ups) == 1
    new_srv = client.get(f"/api/upstreams/{new_ups[0]['id']}/servers", headers=hdrs).json()
    assert len(new_srv) == 1 and new_srv[0]["addr"] == "10.0.0.97"

    # forward_ports 的 upstream_id 已重映射到新行业的新组
    src_fp = client.get("/api/forward-ports?industry_id={}".format(src["id"]), headers=hdrs)
    new_fp = client.get("/api/forward-ports?industry_id={}".format(new["id"]), headers=hdrs)
    assert src_fp.status_code == 200 and new_fp.status_code == 200
    new_fp_body = new_fp.json()
    assert len(new_fp_body) == 1
    assert new_fp_body[0]["upstream_id"] == new_ups[0]["id"]
    assert new_fp_body[0]["industry_id"] == new["id"]

    assert len(client.get(f"/api/domain-mappings?industry_id={new['id']}", headers=hdrs).json()) == 1
    assert len(client.get(f"/api/biz-ports?industry_id={new['id']}", headers=hdrs).json()) == 1