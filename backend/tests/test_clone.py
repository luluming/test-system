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