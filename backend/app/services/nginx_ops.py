"""安全子进程工具：路径白名单 / SSRF 防护 / nginx -t / reload / TCP 探测。

命令一律 subprocess.run([...], shell=False)，配置写临时文件后以路径作参数。
"""

import re
import socket
import subprocess
import tempfile
import time
from pathlib import Path

SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._/-]+$")
IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
_PRIVATE_RANGES = [
    ("10.0.0.0", "10.255.255.255"),
    ("172.16.0.0", "172.31.255.255"),
    ("192.168.0.0", "192.168.255.255"),
    ("127.0.0.0", "127.255.255.255"),
]


def _ipv4_to_int(ip: str) -> int:
    parts = [int(p) for p in ip.split(".")]
    return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]


def validate_safe_path(name: str) -> str:
    """文件名白名单（字母数字 -_./），拒绝路径遍历。"""
    if not name or not SAFE_NAME_RE.match(name) or ".." in name:
        raise ValueError("非法路径")
    return name


def probe_target_allowed(host: str) -> bool:
    """仅允许内网/回环 IPv4，拒绝域名与公网 IP（防 SSRF）。"""
    if not IPV4_RE.match(host):
        return False
    v = _ipv4_to_int(host)
    return any(
        _ipv4_to_int(lo) <= v <= _ipv4_to_int(hi)
        for lo, hi in _PRIVATE_RANGES
    )


def tcp_probe(host: str, port: int, timeout: float = 3.0) -> dict:
    if not probe_target_allowed(host):
        return {"ok": False, "host": host, "port": port, "error": "仅允许探测内网 IP（防 SSRF）"}
    start = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            latency_ms = round((time.monotonic() - start) * 1000, 1)
            return {"ok": True, "host": host, "port": port, "latency_ms": latency_ms}
    except OSError as exc:
        return {"ok": False, "host": host, "port": port, "error": str(exc)}


def nginx_validate(content: str) -> dict:
    """写临时文件 → nginx -t -c <path>；解析错误行号。"""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "nginx_validate.conf"
        path.write_text(content, encoding="utf-8")
        try:
            proc = subprocess.run(
                ["nginx", "-t", "-c", str(path)],
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"ok": False, "output": str(exc), "error_line": None}
        output = (proc.stdout or "") + (proc.stderr or "")
        line = None
        m = re.search(r":(\d+)\s*$", output.strip(), re.M)
        if m:
            line = int(m.group(1))
        return {"ok": proc.returncode == 0, "output": output, "error_line": line}


def nginx_reload() -> dict:
    try:
        proc = subprocess.run(
            ["nginx", "-s", "reload"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "output": str(exc)}
    output = (proc.stdout or "") + (proc.stderr or "")
    return {"ok": proc.returncode == 0, "output": output}


def build_validation_wrapper(fragment: str) -> str:
    """把片段包成合法主配置（events + http），供 nginx -t 语法校验。"""
    return "events {}\nhttp {\n" + fragment + "\n}\n"
