"""行业 CRUD 与输入校验测试。"""
import pytest


def test_create_industry_requires_auth(client):
    """未携带 token 创建行业返回 401。"""
    resp = client.post("/api/industries", json={"code": "taxi", "name": "出租"})
    assert resp.status_code == 401


def test_industry_crud_roundtrip(client, auth_headers):
    """登录后可新建/列表/更新/删除行业，且响应含克隆与时间字段。"""
    r = client.post(
        "/api/industries",
        json={"code": "overseas_freight", "name": "海外货运", "owner": "张工"},
        headers=auth_headers,
    )
    assert r.status_code == 201
    body = r.json()
    assert body["code"] == "overseas_freight"
    assert body["name"] == "海外货运"
    assert body["is_template"] is False
    assert body["cloned_from_id"] is None
    assert "created_at" in body and "updated_at" in body
    industry_id = body["id"]

    listing = client.get("/api/industries", headers=auth_headers).json()
    assert any(i["id"] == industry_id for i in listing)

    upd = client.put(
        f"/api/industries/{industry_id}",
        json={"is_template": True},
        headers=auth_headers,
    )
    assert upd.status_code == 200
    assert upd.json()["is_template"] is True

    assert (
        client.delete(f"/api/industries/{industry_id}", headers=auth_headers).status_code
        == 204
    )


def test_industry_code_duplicate(client, auth_headers):
    """重复行业 code 返回 409。"""
    payload = {"code": "fulu", "name": "福禄"}
    assert client.post("/api/industries", json=payload, headers=auth_headers).status_code == 201
    dup = client.post("/api/industries", json=payload, headers=auth_headers)
    assert dup.status_code == 409


def test_industry_code_invalid_format(client, auth_headers):
    """行业 code 只允许小写字母数字下划线；非法返回 422。"""
    for bad in ["Overseas", "overseas freight", "海外", "a#", "x/y", ""]:
        resp = client.post(
            "/api/industries", json={"code": bad, "name": "名"}, headers=auth_headers
        )
        assert resp.status_code == 422, f"code={bad!r} 应被拒绝"


def test_industry_name_length(client, auth_headers):
    """行业名长度越界返回 422，正常长度返回 201。"""
    ok = client.post(
        "/api/industries", json={"code": "normal", "name": "正常行业"}, headers=auth_headers
    )
    assert ok.status_code == 201
    bad = client.post(
        "/api/industries",
        json={"code": "toolong", "name": "x" * 51},
        headers=auth_headers,
    )
    assert bad.status_code == 422