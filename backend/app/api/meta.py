"""全局元信息接口：暴露后端公网基址，供前端生成推送 curl 命令等。

基址优先级：.env 的 PUBLIC_BASE_URL > 自动探测服务器出口公网 IP（6h 缓存）> 空。
自动探测失败返回空串，由前端回退到浏览器 origin。
"""

import ipaddress
import logging
import re
import time
import urllib.request

from fastapi import APIRouter

from app.config import settings

logger = logging.getLogger("meta")

router = APIRouter(prefix="/api/meta", tags=["meta"])

# 出口公网 IP 探测服务（按顺序尝试，超时 3s）
_IP_SERVICES = (
    "https://api.ipify.org",
    "https://api.ip.sb/ip",
    "https://myip.ipip.net",
)
_detect_cache: dict = {"value": None, "ts": 0.0}
_DETECT_TTL_SECONDS = 6 * 3600  # 6 小时缓存，避免每次请求都外呼


def _detect_public_ip() -> str | None:
    """探测服务器出口公网 IP；全部失败返回 None。"""
    for url in _IP_SERVICES:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                text = resp.read().decode("utf-8", errors="replace").strip()
            m = re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", text)
            if m and ipaddress.ip_address(m.group(0)).is_global:
                return m.group(0)
        except Exception:  # noqa: BLE001 外呼失败换下一个服务
            logger.debug("公网 IP 探测失败 %s", url, exc_info=True)
            continue
    return None


@router.get("")
def meta() -> dict:
    """返回对外可用的基址：配置优先，否则探测公网 IP + API 端口。"""
    if settings.PUBLIC_BASE_URL:
        return {"base_url": settings.PUBLIC_BASE_URL.rstrip("/")}
    now = time.time()
    if _detect_cache["ts"] + _DETECT_TTL_SECONDS < now:
        _detect_cache["value"] = _detect_public_ip()
        _detect_cache["ts"] = now
    ip = _detect_cache["value"]
    if not ip:
        return {"base_url": ""}
    return {"base_url": f"http://{ip}:{settings.API_PORT}"}
