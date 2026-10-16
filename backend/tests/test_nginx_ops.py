"""安全子进程工具与动作端点：路径白名单 / SSRF 防护 / test / reload / validate。"""

from app.services.nginx_ops import (
    probe_target_allowed,
    tcp_probe,
    validate_safe_path,
)


def test_validate_safe_path_whitelist():
    assert validate_safe_path("businesscenter_nginx_CD_master.conf") == "businesscenter_nginx_CD_master.conf"
    assert validate_safe_path("a/b-c_d.e") == "a/b-c_d.e"
    for bad in ("../etc/passwd", "a b.conf", "a;rm.conf"):
        try:
            validate_safe_path(bad)
            assert False, f"应拒绝 {bad!r}"
        except ValueError:
            pass


def test_probe_target_allowed_blocks_public():
    assert probe_target_allowed("127.0.0.1")
    assert probe_target_allowed("10.0.0.97")
    assert probe_target_allowed("192.168.1.1")
    assert not probe_target_allowed("8.8.8.8")
    assert not probe_target_allowed("api.example.com")


def test_tcp_probe_closed_port_fails(client, auth_headers):
    """探测本地未监听端口返回 ok=False（不抛异常）。"""
    r = client.post(
        "/api/forward-ports/1/test",
        headers=auth_headers,
    )
    # 未创建 forward port → 404；创建后再测连接失败路径由 service 单测覆盖
    assert r.status_code == 404


def test_tcp_probe_service_unit():
    res = tcp_probe("127.0.0.1", 1, timeout=0.2)
    assert res["ok"] is False
    res2 = tcp_probe("8.8.8.8", 80, timeout=0.2)
    assert res2["ok"] is False and "SSRF" in res2.get("error", "")


def test_nginx_validate_via_monkeypatch(client, auth_headers, monkeypatch):
    """monkeypatch subprocess.run 模拟 nginx -t 成功/失败，端点返回解析结果。"""
    ind = client.post(
        "/api/industries", json={"code": "op", "name": "op"}, headers=auth_headers
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "conf", "config_text": "server{}"},
        headers=auth_headers,
    ).json()

    class FakeProc:
        def __init__(self, rc, out):
            self.returncode = rc
            self.stdout = out
            self.stderr = ""

    import subprocess

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeProc(0, "syntax is ok"))
    ok = client.post(
        f"/api/nginx-configs/{cfg['id']}/validate",
        json={"content": "server { listen 80; }"},
        headers=auth_headers,
    )
    assert ok.status_code == 200 and ok.json()["ok"] is True

    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: FakeProc(1, 'nginx: [emerg] unknown directive in /tmp/x.conf:12'),
    )
    bad = client.post(
        f"/api/nginx-configs/{cfg['id']}/validate",
        json={"content": "server {"},
        headers=auth_headers,
    )
    assert bad.status_code == 200 and bad.json()["ok"] is False
    assert bad.json()["error_line"] == 12


def test_reload_via_monkeypatch(client, auth_headers, monkeypatch):
    import subprocess

    class FakeProc:
        returncode = 0
        stdout = "signal process started"
        stderr = ""

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeProc())
    ind = client.post(
        "/api/industries", json={"code": "op2", "name": "op2"}, headers=auth_headers
    ).json()
    cfg = client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "conf", "config_text": "server{}"},
        headers=auth_headers,
    ).json()
    r = client.post(f"/api/nginx-configs/{cfg['id']}/reload", headers=auth_headers)
    assert r.status_code == 200 and r.json()["ok"] is True


def test_forward_test_resolves_upstream(client, auth_headers):
    """forward test 引用 upstream 组时探测组内首个启用节点（service 单测覆盖 probe 本身）。"""
    ind = client.post(
        "/api/industries", json={"code": "op3", "name": "op3"}, headers=auth_headers
    ).json()
    up = client.post(
        "/api/upstreams",
        json={"industry_id": ind["id"], "name": "web_backend"},
        headers=auth_headers,
    ).json()
    client.post(
        f"/api/upstreams/{up['id']}/servers",
        json={"addr": "10.0.0.1", "port": 80},
        headers=auth_headers,
    )
    fp = client.post(
        "/api/forward-ports",
        json={
            "industry_id": ind["id"],
            "upstream_id": up["id"],
            "listen_port": 8080,
            "upstream_target": "web_backend",
        },
        headers=auth_headers,
    )
    assert fp.status_code == 201
    r = client.post(f"/api/forward-ports/{fp.json()['id']}/test", headers=auth_headers)
    # 10.0.0.1:80 无服务 → ok False，但返回结构完整
    assert r.status_code == 200 and r.json()["ok"] is False
