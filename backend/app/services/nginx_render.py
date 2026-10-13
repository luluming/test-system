"""渲染服务：原文 → 泛化块树（parse 移植自 mock L925-955）+ 深度优先渲染（renderPreview L1535-1557）。

纯函数，供 seed 建块、render 端点、export 复用。
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.nginx import ConfigBlock, ConfigOption

INDENT = "    "

_SCOPES = {
    "server": "server",
    "location": "location",
    "upstream": "upstream",
    "map": "map",
    "geo": "geo",
    "if": "if",
    "stream": "stream",
    "events": "events",
    "http": "http",
    "log_format": "log_format",
    "split_clients": "split_clients",
    "limit_req": "limit_req",
    "limit_conn": "limit_conn",
    "limit_except": "limit_except",
    "types": "types",
    "include": "include",
}


def scope_of(header: str) -> str | None:
    """块头首词 → scope；未知返回 None（由调用方降级为 raw）。"""
    head = (header or "").strip()
    if not head:
        return None
    return _SCOPES.get(head.split()[0])


def kvify(line: str) -> dict:
    """一行指令 → {directive, value, raw}；无空格则 value 为空。"""
    t = line.strip().rstrip(";").strip()
    if " " not in t:
        return {"directive": t, "value": "", "raw": t}
    i = t.index(" ")
    return {"directive": t[:i].strip(), "value": t[i + 1:].strip(), "raw": t.strip()}


def parse(src: str, root_scope: str = "http") -> dict:
    """原文 → 泛化块树（通用虚拟根，http/stream/events 顶层块并列）。"""
    root = {
        "scope": root_scope,
        "header": "stream" if root_scope == "stream" else "http",
        "children": [],
        "options": [],
        "parent": None,
        "level": -1,
    }
    stack = [root]
    for line in src.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue
        cur = stack[-1]
        opens = trimmed.count("{")
        closes = trimmed.count("}")
        if opens == 0 and closes == 0 and cur:
            if trimmed.startswith("#"):
                cur["children"].append(
                    {
                        "scope": "comment",
                        "header": trimmed.replace("#", "", 1).lstrip(),
                        "children": [],
                        "options": [],
                        "parent": cur,
                    }
                )
            else:
                cur["options"].append(kvify(trimmed))
            continue
        if opens == 0 and closes > 0:
            pops = closes
            while pops > 0 and len(stack) > 1:
                stack.pop()
                pops -= 1
            continue
        if opens > 0:
            col = trimmed.index("{")
            head = trimmed[:col].strip()
            after = trimmed[col + 1:].rstrip("}").strip()
            sc = scope_of(head)
            child = {
                "scope": sc or "raw",
                "header": head,
                "children": [],
                "options": [],
                "parent": cur,
            }
            cur["children"].append(child)
            if after:
                for s in after.split(";"):
                    s = s.strip()
                    if s:
                        child["options"].append(kvify(s))
            if closes < opens:
                stack.append(child)
            continue
    return root


def ordered_options(options: list[dict]) -> list[dict]:
    """map default 恒置底；其余按书写/重排顺序。"""
    norm = [o for o in options if o.get("directive") != "default"]
    defs = [o for o in options if o.get("directive") == "default"]
    return norm + defs


def _option_raw(o: dict) -> str:
    raw = o.get("raw")
    if raw is None:
        raw = o.get("directive", "") + ((" " + o.get("value", "")) if o.get("value") else "")
    return raw


def render_text(node: dict) -> list[str]:
    """深度优先 + 缩进 + 按书写顺序输出选项 + comment/if 弱提示。"""
    lines = []

    def rb(n: dict, depth: int) -> None:
        ind = INDENT * depth
        if n.get("scope") == "comment":
            lines.append("# " + n.get("header", ""))
            return
        if n.get("scope") == "if":
            lines.append(ind + "# 建议少用 if")
        lines.append(ind + (n.get("header") or "") + " {")
        for o in ordered_options(n.get("options", [])):
            lines.append(ind + INDENT + _option_raw(o).rstrip(";").rstrip() + ";")
        for c in n.get("children", []):
            rb(c, depth + 1)
        lines.append(ind + "}")

    rb(node, 0)
    return lines


def render_config_text(node: dict) -> str:
    return "\n".join(render_text(node))


def persist_tree(db: Session, config_id: int, root: dict) -> None:
    """把 parse 出的泛化树落库（seed / 测试用），父块映射保持嵌套。"""

    def insert(parent_id: int | None, node: dict) -> None:
        row = ConfigBlock(
            nginx_config_id=config_id,
            parent_id=parent_id,
            scope=node["scope"],
            header=node.get("header", ""),
            sort_order=0,
        )
        db.add(row)
        db.flush()
        for o in node.get("options", []):
            db.add(
                ConfigOption(
                    block_id=row.id,
                    directive=o.get("directive", ""),
                    value=o.get("value", ""),
                    row_type=_row_type_of(o),
                    is_free_text=bool(o.get("is_free_text")),
                    sort_order=0,
                )
            )
        for idx, child in enumerate(node.get("children", [])):
            child["_sort"] = idx
            insert(row.id, child)

    for idx, child in enumerate(root.get("children", [])):
        child["_sort"] = idx
        insert(None, child)
    db.commit()


def _row_type_of(o: dict) -> str:
    if o.get("row_type"):
        return o["row_type"]
    raw = o.get("raw")
    if o.get("is_free_text"):
        return "raw"
    if o.get("directive") == "default":
        return "default"
    if o.get("directive", "").startswith(("~", "*")):
        return "regex"
    return "kv"


def build_config_dict(db: Session, config_id: int, context: str = "conf") -> dict:
    """从 DB 组装渲染/导出所需的泛化树 dict（虚拟根按上下文包 http/stream）。"""
    rows = list(
        db.execute(
            select(ConfigBlock)
            .where(ConfigBlock.nginx_config_id == config_id)
            .order_by(ConfigBlock.sort_order, ConfigBlock.id)
        ).scalars().all()
    )
    ids = [b.id for b in rows]
    options = (
        list(
            db.execute(
                select(ConfigOption)
                .where(ConfigOption.block_id.in_(ids))
                .order_by(ConfigOption.sort_order, ConfigOption.id)
            ).scalars().all()
        )
        if ids
        else []
    )
    opt_map: dict[int, list[ConfigOption]] = {}
    for o in options:
        opt_map.setdefault(o.block_id, []).append(o)
    child_map: dict[int | None, list[ConfigBlock]] = {}
    for b in rows:
        child_map.setdefault(b.parent_id, []).append(b)

    def to_dict(b: ConfigBlock) -> dict:
        return {
            "id": b.id,
            "scope": b.scope,
            "header": b.header,
            "children": [to_dict(c) for c in child_map.get(b.id, [])],
            "options": [_option_dict(o) for o in opt_map.get(b.id, [])],
        }

    root_header = "stream" if context == "stream" else "http"
    return {
        "scope": context,
        "header": root_header,
        "children": [to_dict(b) for b in child_map.get(None, [])],
        "options": [],
    }


def _option_dict(o: ConfigOption) -> dict:
    if o.is_free_text or o.row_type == "raw":
        return {"directive": o.directive, "value": o.value, "row_type": o.row_type, "raw": o.directive}
    raw = o.directive + ((" " + o.value) if o.value else "")
    return {"directive": o.directive, "value": o.value, "row_type": o.row_type, "raw": raw}
