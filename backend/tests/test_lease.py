"""编辑会话租约测试：授予 / 拒夺 / 超时接管 / 释放。"""
from datetime import timedelta

from sqlalchemy import update

from app.models.nginx import NginxConfig
from app.services.leases import LEASE_TTL_SECONDS, is_lease_expired, now_utc


def _cfg(client, auth_headers, code):
    ind = client.post("/api/industries", json={"code": code, "name": code}, headers=auth_headers).json()
    return client.post(
        "/api/nginx-configs",
        json={"industry_id": ind["id"], "name": "cfg", "config_text": "server{}"},
        headers=auth_headers,
    ).json()


def _heartbeat(client, headers, cfg_id, holder):
    return client.post(
        f"/api/nginx-configs/{cfg_id}/edit-heartbeat",
        json={"holder": holder},
        headers=headers,
    )


def test_grant_then_block_other_holder(client, auth_headers):
    hdrs = auth_headers
    cfg = _cfg(client, hdrs, "la")
    assert _heartbeat(client, hdrs, cfg["id"], "alice").status_code == 200
    blocked = _heartbeat(client, hdrs, cfg["id"], "bob")
    assert blocked.status_code == 423


def test_force_stale_lease(client, auth_headers, db_session_factory):
    hdrs = auth_headers
    cfg = _cfg(client, hdrs, "lb")
    assert _heartbeat(client, hdrs, cfg["id"], "alice").status_code == 200
    # 手动把心跳时间拨到 TTL 之前 → 视为过期，bob 可接管
    db = db_session_factory()
    try:
        db.execute(update(NginxConfig).where(NginxConfig.id == cfg["id"]).values(
            edit_heartbeat_at=now_utc() - timedelta(seconds=LEASE_TTL_SECONDS + 60)))
        db.commit()
    finally:
        db.close()
    assert _heartbeat(client, hdrs, cfg["id"], "bob").status_code == 200


def test_release_clears_holder(client, auth_headers):
    hdrs = auth_headers
    cfg = _cfg(client, hdrs, "lc")
    _heartbeat(client, hdrs, cfg["id"], "alice")
    rel = client.post(
        f"/api/nginx-configs/{cfg['id']}/edit-release",
        json={"holder": "alice"},
        headers=hdrs,
    )
    assert rel.status_code == 200
    # 释放后其他 holder 可获取
    assert _heartbeat(client, hdrs, cfg["id"], "bob").status_code == 200


def test_lease_expiry_helper():
    """纯函数：is_lease_expired 对空与过期返回 True，新鲜返回 False。"""
    assert is_lease_expired(None) is True
    assert is_lease_expired(now_utc() - timedelta(seconds=LEASE_TTL_SECONDS + 1)) is True
    assert is_lease_expired(now_utc()) is False