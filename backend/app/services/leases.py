"""编辑会话租约工具：心跳 TTL 判定（纯函数，便于单测）。"""
from datetime import datetime, timezone, timedelta

LEASE_TTL_SECONDS = 600  # 默认 10 分钟


def now_utc() -> datetime:
    """返回当前 UTC 时间（naive）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def is_lease_expired(heartbeat_at: datetime | None) -> bool:
    """心跳为空或距最后心跳超过 TTL 视为过期（可被接管）。"""
    if heartbeat_at is None:
        return True
    return (now_utc() - heartbeat_at) > timedelta(seconds=LEASE_TTL_SECONDS)