"""upstream 组与节点 CRUD（行业作用域）+ preview。"""


def _mk_industry(client, auth_headers, code):
    return client.post(
        "/api/industries", json={"code": code, "name": code}, headers=auth_headers
    ).json()


def test_upstream_crud_scoped_by_industry(client, auth_headers):
    """创建组、按行业过滤列表、更新、删除；跨行业隔离。"""
    a = _mk_industry(client, auth_headers, "ua")
    b = _mk_industry(client, auth_headers, "ub")
    created = client.post(
        "/api/upstreams",
        json={"industry_id": a["id"], "name": "api_backend", "strategy": "least_conn", "keepalive": 64},
        headers=auth_headers,
    )
    assert created.status_code == 201
    up = created.json()
    assert up["industry_id"] == a["id"] and up["strategy"] == "least_conn" and up["keepalive"] == 64

    la = client.get(f"/api/upstreams?industry_id={a['id']}", headers=auth_headers).json()
    lb = client.get(f"/api/upstreams?industry_id={b['id']}", headers=auth_headers).json()
    assert [u["name"] for u in la] == ["api_backend"]
    assert lb == []

    upd = client.put(
        f"/api/upstreams/{up['id']}",
        json={"strategy": "ip_hash", "keepalive": 16},
        headers=auth_headers,
    )
    assert upd.status_code == 200 and upd.json()["strategy"] == "ip_hash" and upd.json()["keepalive"] == 16

    assert client.delete(f"/api/upstreams/{up['id']}", headers=auth_headers).status_code == 204
    assert client.get(f"/api/upstreams?industry_id={a['id']}", headers=auth_headers).json() == []


def test_upstream_name_unique_per_industry(client, auth_headers):
    """同行业重名 409；跨行业允许。"""
    a = _mk_industry(client, auth_headers, "uc")
    b = _mk_industry(client, auth_headers, "ud")
    body = {"industry_id": a["id"], "name": "shared"}
    assert client.post("/api/upstreams", json=body, headers=auth_headers).status_code == 201
    assert client.post("/api/upstreams", json=body, headers=auth_headers).status_code == 409
    assert client.post("/api/upstreams", json={**body, "industry_id": b["id"]}, headers=auth_headers).status_code == 201


def test_upstream_servers_nested_crud(client, auth_headers):
    """组内节点增删改 + 列表。"""
    ind = _mk_industry(client, auth_headers, "ue")
    up = client.post(
        "/api/upstreams",
        json={"industry_id": ind["id"], "name": "api_backend"},
        headers=auth_headers,
    ).json()
    s1 = client.post(
        f"/api/upstreams/{up['id']}/servers",
        json={"addr": "10.0.0.97", "port": 8080, "weight": 5},
        headers=auth_headers,
    )
    assert s1.status_code == 201
    s2 = client.post(
        f"/api/upstreams/{up['id']}/servers",
        json={"addr": "10.0.0.193", "port": 8080, "weight": 5},
        headers=auth_headers,
    )
    servers = client.get(f"/api/upstreams/{up['id']}/servers", headers=auth_headers).json()
    assert [s["addr"] for s in servers] == ["10.0.0.97", "10.0.0.193"]

    upd = client.put(
        f"/api/upstreams/{up['id']}/servers/{s1.json()['id']}",
        json={"weight": 10, "health_status": "up"},
        headers=auth_headers,
    )
    assert upd.status_code == 200 and upd.json()["weight"] == 10

    assert client.delete(
        f"/api/upstreams/{up['id']}/servers/{s2.json()['id']}", headers=auth_headers
    ).status_code == 204
    servers = client.get(f"/api/upstreams/{up['id']}/servers", headers=auth_headers).json()
    assert len(servers) == 1


def test_upstream_preview(client, auth_headers):
    """preview 生成 upstream {} 片段：策略指令 + 节点行 + keepalive。"""
    ind = _mk_industry(client, auth_headers, "uf")
    up = client.post(
        "/api/upstreams",
        json={"industry_id": ind["id"], "name": "api_backend", "strategy": "least_conn", "keepalive": 32},
        headers=auth_headers,
    ).json()
    client.post(
        f"/api/upstreams/{up['id']}/servers",
        json={"addr": "10.0.0.97", "port": 8080, "weight": 5},
        headers=auth_headers,
    )
    r = client.get(f"/api/upstreams/{up['id']}/preview", headers=auth_headers)
    assert r.status_code == 200
    text = r.json()["content"]
    assert text == (
        "upstream api_backend {\n"
        "    least_conn;\n"
        "    server 10.0.0.97:8080 weight=5;\n"
        "    keepalive 32;\n"
        "}"
    )
