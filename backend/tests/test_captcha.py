"""验证码接口测试：生成 / 登录校验联动。"""

from app.core.captcha import generate_captcha


def test_captcha_generate(client):
    """验证码生成接口返回 200，且包含 captcha_id 与 SVG data URI 图片。"""
    resp = client.get("/api/auth/captcha")
    assert resp.status_code == 200
    body = resp.json()
    assert "captcha_id" in body
    assert body["captcha_image"].startswith("data:image/svg+xml;base64,")


def test_login_with_wrong_captcha(client):
    """验证码错误时登录返回 400，且提示验证码错误或已过期。"""
    client.post(
        "/api/auth/register",
        json={"username": "cat", "email": "cat@example.com", "password": "secret123"},
    )
    resp = client.post(
        "/api/auth/login",
        json={
            "username": "cat",
            "password": "secret123",
            "captcha_id": "nonexistent-id",
            "captcha_code": "0000",
        },
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "验证码错误或已过期"


def test_login_with_valid_captcha(client):
    """携带正确验证码（直接调用内部生成函数取明文）可正常登录。"""
    client.post(
        "/api/auth/register",
        json={"username": "fox", "email": "fox@example.com", "password": "secret123"},
    )
    captcha = generate_captcha()
    resp = client.post(
        "/api/auth/login",
        json={
            "username": "fox",
            "password": "secret123",
            "captcha_id": captcha["captcha_id"],
            "captcha_code": captcha["code"],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["access_token"]
