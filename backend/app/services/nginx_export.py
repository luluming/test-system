"""导出中心算法（移植 mock plan-c-real-conf.html L1908-2021）：

① server_name 域名整体替换（dom_new 单一输入）；② upstream 后端整组替换（默认 + 例外覆盖，纯 IP）。
SSL 关闭时丢弃 ssl_* 指令并改写 listen 去掉 ssl 标记。全部为纯函数。
"""

import re

INDENT = "    "
SSL_DROP = re.compile(
    r"^(ssl_protocols|ssl_certificate|ssl_certificate_key|ssl_session_cache|"
    r"ssl_session_timeout|ssl_ciphers|ssl_prefer_server_ciphers)$"
)
SERVER_NAME_RE = re.compile(r"^server_name\s+(.+)$")
IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
PORT_RE = re.compile(r":(\d+)$")


def dom_parse(s: str) -> list[str]:
    """文本 → IP 数组：逗号/换行拆分、trim、去空。"""
    return [e.strip() for e in re.split(r"[,\n]+", s or "") if e.strip()]


def apply_domains(raw: str, dom_new: str) -> tuple[str, bool, str | None]:
    """server_name 行整体替换为新域名；留空或非 server_name 行不替换。"""
    v = (dom_new or "").strip()
    if not v:
        return raw, False, None
    m = SERVER_NAME_RE.match(raw.rstrip(";").strip())
    if not m:
        return raw, False, None
    return "server_name " + v, True, "server_name " + m.group(1)


def up_name_of(n: dict) -> str:
    return re.sub(r"^upstream\s+", "", n.get("header") or "").strip()


def up_key_of(n: dict, ctx: str) -> str:
    return ctx + ":" + up_name_of(n)


def _server_rows(n: dict) -> list[dict]:
    return [o for o in n.get("options", []) if o.get("directive") == "server"]


def _server_raw(o: dict) -> str:
    raw = o.get("raw")
    if raw is None:
        raw = o.get("directive", "") + ((" " + o.get("value", "")) if o.get("value") else "")
    return raw.rstrip(";").strip()


def up_node_ports(n: dict) -> list[str]:
    out = []
    for o in _server_rows(n):
        m = re.match(r"^server\s+(\S+)", _server_raw(o))
        p = ""
        if m:
            pm = PORT_RE.search(m.group(1))
            p = pm.group(1) if pm else ""
        out.append(p)
    return out


def up_node_params(n: dict) -> list[str]:
    out = []
    for o in _server_rows(n):
        m = re.match(r"^server\s+(\S+)(.*)$", _server_raw(o))
        out.append(m.group(2).strip() if m else "")
    return out


def up_node_raws(n: dict) -> list[str]:
    return [_server_raw(o) for o in _server_rows(n)]


def derive_up_backends(n: dict, ips: list[str]) -> list[dict]:
    """整组替换：一个 IP = 一个节点；只补端口、端口后参数沿原对应位置；去尾分号防双分号。"""
    ports = up_node_ports(n)
    params = up_node_params(n)
    raws = up_node_raws(n)
    out = []
    for j, ip in enumerate(ips):
        ip = ip.strip()
        if not PORT_RE.search(ip) and not ip.startswith("unix:"):
            if ports:
                p = ports[j % len(ports)]
                if p:
                    ip = ip + ":" + p
        prm = params[j % len(params)] if params else ""
        return_text = "server " + ip + ((" " + prm) if prm else "") + ";"
        out.append(
            {
                "text": return_text,
                "orig": raws[j % len(raws)] if raws else None,
            }
        )
    return out


def ips_for_group(k: str, exceptions: list[dict], default_ips: str) -> str:
    """先查例外（e.grp===k 首个命中且非空），否则回退默认。"""
    for e in exceptions or []:
        if e and e.get("grp") == k and dom_parse(e.get("ips", "")):
            return e.get("ips", "")
    return default_ips or ""


def derived_for(n: dict, ctx: str, exceptions: list[dict], default_ips: str) -> list[dict] | None:
    """该组替换后的新后端行；清单为空则该组不替换（返回 None）。"""
    ips = ips_for_group(up_key_of(n, ctx), exceptions, default_ips)
    parsed = dom_parse(ips)
    return derive_up_backends(n, parsed) if parsed else None


def export_lines(
    root: dict,
    *,
    ctx: str,
    ssl_on: bool,
    dom_new: str | None,
    default_ips: str,
    exceptions: list[dict],
) -> list[dict]:
    """逐行导出：{text, changed, orig}；复刻 mock exportLines/walkEx。"""
    out = []

    def emit(text: str, changed: bool = False, orig: str | None = None) -> None:
        out.append({"text": text, "changed": changed, "orig": orig})

    def walk_ex(n: dict, d: int) -> None:
        ind = INDENT * d
        if n.get("scope") == "comment":
            emit(ind + "# " + n.get("header", ""))
            return
        if n.get("scope") == "if":
            emit(ind + "# 建议少用 if")
        emit(ind + (n.get("header") or "") + " {")
        up_rep = derived_for(n, ctx, exceptions, default_ips) if n.get("scope") == "upstream" else None
        body = []
        for o in n.get("options", []):
            dd = o.get("directive", "")
            raw = o.get("raw")
            if raw is None:
                raw = dd + ((" " + o.get("value", "")) if o.get("value") else "")
            if up_rep and dd == "server":
                continue
            val = o.get("value", "")
            if not ssl_on:
                if SSL_DROP.match(dd):
                    continue
                if dd == "listen":
                    # mock 注释意图 listen X ssl http2 -> listen X http2；val 覆盖 raw 会丢
                    # "listen" 前缀，故补回指令名（否则输出 443 http2; 为无效行）
                    cleaned = re.sub(r"\s+", " ", re.sub(r"\bssl\b", " ", val)).strip()
                    raw = dd + " " + cleaned if cleaned else dd
            elif dd == "listen":
                # SSL 开启时：listen 443 自动补 ssl http2（已有则不重复添加）
                m = re.match(r"^(\d+)\b(.*)$", (val or "").strip())
                if m and m.group(1) == "443":
                    parts = [p for p in re.split(r"\s+", m.group(2).strip()) if p]
                    if "ssl" not in parts:
                        parts.append("ssl")
                    if "http2" not in parts:
                        parts.append("http2")
                    raw = "listen " + m.group(1) + ((" " + " ".join(parts)) if parts else "")
            is_def = dd == "default"
            if dd == "server_name":
                r, changed, orig = apply_domains(raw.rstrip(";").strip(), dom_new)
            else:
                r, changed, orig = raw.rstrip(";").strip(), False, None
            body.append({"raw": r, "is_default": is_def, "changed": changed, "orig": orig})
        norm = [b for b in body if not b["is_default"]]
        defs = [b for b in body if b["is_default"]]
        for b in norm + defs:
            emit(ind + INDENT + b["raw"] + ";", b["changed"], b["orig"])
        if up_rep:
            for b in up_rep:
                emit(ind + INDENT + b["text"], True, b["orig"])
        for c in n.get("children", []):
            walk_ex(c, d + 1)
        emit(ind + "}")

    walk_ex(root, 0)
    return out


def export_config_text(
    root: dict,
    *,
    ctx: str,
    ssl_on: bool,
    dom_new: str | None,
    default_ips: str,
    exceptions: list[dict],
) -> str:
    return "\n".join(l["text"] for l in export_lines(
        root, ctx=ctx, ssl_on=ssl_on, dom_new=dom_new,
        default_ips=default_ips, exceptions=exceptions,
    ))
