"""nginx_configs 行业作用域 / 版本冲突 / 租约测试。"""


def _mk_industry(client, auth_headers, code):
    return client.post(
        "/api/industries", json={"code": code, "name": code}, headers=auth_headers
    ).json()


def test_nginx_config_has_industry_and_version(client, auth_headers):
    """创建行业与配置后，配置响应含 industry_id 与 version。"""
    ind = client.post(
        "/api/industries",
        json={"code": "overseas_freight", "name": "海外货运"},
        headers=auth_headers,
    ).json()
    r = client.post(
        "/api/nginx-configs",
        json={
            "industry_id": ind["id"],
            "name": "overseas_http",
            "domain": "freight.example.com",
            "config_text": "server { listen 80; }",
        },
        headers=auth_headers,
    )
    assert r.status_code == 201
    body = r.json()
    assert body["industry_id"] == ind["id"]
    assert body["version"] == 1


def test_nginx_configs_scoped_by_industry(client, auth_headers):
    """列表按 industry_id 过滤，跨行业互不可见。"""
    a = _mk_industry(client, auth_headers, "alpha")
    b = _mk_industry(client, auth_headers, "beta")
    for ind, n in ((a, "a_cfg"), (b, "b_cfg")):
        client.post(
            "/api/nginx-configs",
            json={"industry_id": ind["id"], "name": n, "config_text": "server{}"},
            headers=auth_headers,
        )
    la = client.get(f"/api/nginx-configs?industry_id={a['id']}", headers=auth_headers).json()
    assert [c["name"] for c in la] == ["a_cfg"]
    lb = client.get(f"/api/nginx-configs?industry_id={b['id']}", headers=auth_headers).json()
    assert [c["name"] for c in lb] == ["b_cfg"]


def test_nginx_config_name_unique_per_industry(client, auth_headers):
    """同行业重名 409；不同行业同名允许。"""
    a = _mk_industry(client, auth_headers, "ca")
    b = _mk_industry(client, auth_headers, "cb")
    base = {"config_text": "server{}"}
    assert client.post("/api/nginx-configs", json={**base, "industry_id": a["id"], "name": "x"}, headers=auth_headers).status_code == 201
    assert client.post("/api/nginx-configs", json={**base, "industry_id": a["id"], "name": "x"}, headers=auth_headers).status_code == 409
    assert client.post("/api/nginx-configs", json={**base, "industry_id": b["id"], "name": "x"}, headers=auth_headers).status_code == 201


def test_nginx_config_update_version_conflict_409(client, auth_headers):
    """base_version 与当前不一致返回 409，不覆盖。"""
    ind = _mk_industry(client, auth_headers, "cc")
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "c", "config_text": "v1"},
        headers=auth_headers,
    ).json()
    # 第一次提交：基于 version 1 成功，version 变 2
    ok = client.put(
        f"/api/nginx-configs/{cfg['id']}",
        json={"config_text": "v2", "base_version": 1},
        headers=auth_headers,
    )
    assert ok.status_code == 200 and ok.json()["version"] == 2
    # 第二次提交仍带旧 base_version 1 → 409
    conflict = client.put(
        f"/api/nginx-configs/{cfg['id']}",
        json={"config_text": "v3", "base_version": 1},
        headers=auth_headers,
    )
    assert conflict.status_code == 409
    # 数据未被覆盖
    detail = client.get(f"/api/nginx-configs/{cfg['id']}", headers=auth_headers).json()
    assert detail["config_text"] == "v2"