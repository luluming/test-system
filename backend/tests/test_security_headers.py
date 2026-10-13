"""安全响应头测试。"""


def test_security_headers_present(client):
    """所有响应携带 CSP / X-Content-Type-Options / Referrer-Policy。"""
    resp = client.get("/api/auth/captcha")
    assert resp.headers["content-security-policy"] is not None
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["referrer-policy"] == "no-referrer"