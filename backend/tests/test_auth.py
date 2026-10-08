"""认证接口测试：注册 / 登录 / 密码重置与修改 / 鉴权。"""

from app.core.captcha import generate_captcha


def test_register_success(client):
    """注册成功返回 201，且响应不含任何密码字段。"""
    resp = client.post(
        "/api/auth/register",
        json={"username": "alice", "email": "alice@example.com", "password": "secret123"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["username"] == "alice"
    assert "password" not in body
    assert "hashed_password" not in body


def test_register_duplicate_username(client):
    """重复用户名注册返回 400。"""
    payload = {"username": "bob", "email": "bob@example.com", "password": "secret123"}
    assert client.post("/api/auth/register", json=payload).status_code == 201

    duplicate = {"username": "bob", "email": "bob2@example.com", "password": "secret123"}
    resp = client.post("/api/auth/register", json=duplicate)
    assert resp.status_code == 400


def test_login_success_returns_token(client):
    """验证码正确且密码正确时登录成功，返回 JWT 访问令牌。"""
    client.post(
        "/api/auth/register",
        json={"username": "carol", "email": "carol@example.com", "password": "secret123"},
    )
    captcha = generate_captcha()
    resp = client.post(
        "/api/auth/login",
        json={
            "username": "carol",
            "password": "secret123",
            "captcha_id": captcha["captcha_id"],
            "captcha_code": captcha["code"],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]


def test_login_wrong_password(client):
    """验证码正确但密码错误时登录返回 401。"""
    client.post(
        "/api/auth/register",
        json={"username": "dave", "email": "dave@example.com", "password": "secret123"},
    )
    captcha = generate_captcha()
    resp = client.post(
        "/api/auth/login",
        json={
            "username": "dave",
            "password": "wrong-pass",
            "captcha_id": captcha["captcha_id"],
            "captcha_code": captcha["code"],
        },
    )
    assert resp.status_code == 401


def test_reset_password_success(client):
    """验证码正确且用户名邮箱匹配时重置密码成功，新密码可登录。"""
    client.post(
        "/api/auth/register",
        json={"username": "eve", "email": "eve@example.com", "password": "secret123"},
    )
    captcha = generate_captcha()
    resp = client.post(
        "/api/auth/reset-password",
        json={
            "username": "eve",
            "email": "eve@example.com",
            "captcha_id": captcha["captcha_id"],
            "captcha_code": captcha["code"],
            "new_password": "newpass456",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["message"] == "密码重置成功"

    login_captcha = generate_captcha()
    login = client.post(
        "/api/auth/login",
        json={
            "username": "eve",
            "password": "newpass456",
            "captcha_id": login_captcha["captcha_id"],
            "captcha_code": login_captcha["code"],
        },
    )
    assert login.status_code == 200


def test_reset_password_email_mismatch(client):
    """用户名与邮箱不匹配时返回 400 统一提示，不泄露用户是否存在。"""
    client.post(
        "/api/auth/register",
        json={"username": "frank", "email": "frank@example.com", "password": "secret123"},
    )
    captcha = generate_captcha()
    resp = client.post(
        "/api/auth/reset-password",
        json={
            "username": "frank",
            "email": "wrong@example.com",
            "captcha_id": captcha["captcha_id"],
            "captcha_code": captcha["code"],
            "new_password": "newpass456",
        },
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "用户名与邮箱不匹配"


def test_change_password_success(client, auth_headers):
    """原密码正确时修改密码成功，新密码可登录。"""
    resp = client.post(
        "/api/auth/change-password",
        json={"old_password": "testpass123", "new_password": "changed456"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["message"] == "密码修改成功"

    captcha = generate_captcha()
    login = client.post(
        "/api/auth/login",
        json={
            "username": "tester",
            "password": "changed456",
            "captcha_id": captcha["captcha_id"],
            "captcha_code": captcha["code"],
        },
    )
    assert login.status_code == 200


def test_change_password_wrong_old(client, auth_headers):
    """原密码错误时修改密码返回 400。"""
    resp = client.post(
        "/api/auth/change-password",
        json={"old_password": "wrong-old", "new_password": "changed456"},
        headers=auth_headers,
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "原密码不正确"


def test_me_requires_auth(client):
    """未携带 token 访问 /api/auth/me 返回 401。"""
    assert client.get("/api/auth/me").status_code == 401


def test_me_with_token(client, auth_headers):
    """携带有效 token 可获取当前用户信息。"""
    resp = client.get("/api/auth/me", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["username"] == "tester"


def test_items_requires_auth(client):
    """未携带 token 访问 /api/items 返回 401。"""
    resp = client.get("/api/items")
    assert resp.status_code == 401


def test_create_item_with_token(client, auth_headers):
    """携带 token 可创建物品，且归属当前用户。"""
    resp = client.post(
        "/api/items",
        json={"title": "任务一", "description": "这是描述"},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["title"] == "任务一"
    assert body["owner_id"] > 0
