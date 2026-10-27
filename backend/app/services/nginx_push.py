"""nginx 配置推送服务：本地原文解析 + 差异比对 + 事务内应用（替换/新建 + 镜像联动）。

解析为「无法映射即全拒」的严格模式：只接受结构完整（括号配对）的文本；
解析失败返回行号清单，不产生任何落库写入。
"""

import re

from sqlalchemy import select

from app.models.nginx import ConfigBlock, ConfigOption, NginxMirrorPair
from app.services.nginx_render import kvify, render_text, scope_of

# 可作为独立差异单元的结构块（server 按端口、upstream 按组名、其余按 header）
DIFF_SCOPES = {
    "server", "upstream", "map", "geo", "split_clients", "log_format",
    "limit_req", "limit_conn", "types", "include", "events",
}


# ---- 文本扫描辅助（引号感知：花括号/分号不在引号内计数）----

def _strip_quoted(s: str) -> str:
    out, in_q = [], None
    for ch in s:
        if in_q:
            if ch == in_q:
                in_q = None
        else:
            if ch in "\"'":
                in_q = ch
            else:
                out.append(ch)
    return "".join(out)


def _strip_inline_comment(s: str) -> tuple[str, str]:
    """剔除引号外的行内注释（nginx 语义：# 在外层引号外即开始注释）。

    返回 (代码部分, 注释部分含 #)；整行均为注释时代码部分为空串。
    例如 ``add_header X; # 备注`` → (``add_header X;``, ``# 备注``)。
    """
    out, in_q, cmt = [], None, []
    in_comment = False
    for ch in s:
        if in_comment:
            cmt.append(ch)
            continue
        if in_q:
            out.append(ch)
            if ch == in_q:
                in_q = None
        else:
            if ch in "\"'":
                in_q = ch
                out.append(ch)
            elif ch == "#":
                in_comment = True
                cmt.append(ch)
            else:
                out.append(ch)
    return "".join(out), "".join(cmt)


def _split_terms(s: str) -> list[str]:
    """按分号切分（忽略引号内的分号），丢弃空段。"""
    out, buf, in_q = [], [], None
    for ch in s:
        if in_q:
            buf.append(ch)
            if ch == in_q:
                in_q = None
        else:
            if ch in "\"'":
                in_q = ch
                buf.append(ch)
            elif ch == ";":
                seg = "".join(buf).strip()
                if seg:
                    out.append(seg)
                buf = []
            else:
                buf.append(ch)
    seg = "".join(buf).strip()
    if seg:
        out.append(seg)
    return out


# ---- 解析：原文 → 规范化块树（与 build_config_dict 同形）----

def _comment_option(text: str, ln: int) -> dict:
    """整行/行内注释 → 父块 options 中的 comment 行（非子块，保证往返渲染保真）。"""
    t = text[1:].strip()
    return {"directive": "#", "value": t, "row_type": "comment", "raw": "# " + t, "_line": ln}


def parse_nginx(src: str) -> tuple[dict | None, list[dict]]:
    """原文 → 块树；结构不完整返回 (None, [{line, reason}])。

    注释位置保真规则：
    - 行内注释（引号外的 #）剥离为指令后的 comment 选项行（块内位置不变）；
    - 整行注释在父块尚无子块时作 comment 选项行（处于块体 options 区，
      render 先渲染 options 再渲染 children，块内位置不变）；
    - 整行注释在父块已有子块时作 scope="comment" 的子节点，靠 sort_order
      与兄弟块交错，保住「块与块之间」的文件位置。
    """
    errors: list[dict] = []
    root: dict = {"scope": "http", "header": "http", "children": [], "options": []}
    stack: list[tuple[dict, int]] = [(root, 0)]
    for ln, line in enumerate(src.splitlines(), start=1):
        trimmed = line.strip()
        if not trimmed:
            continue
        body, cmt = _strip_inline_comment(trimmed)
        cur = stack[-1][0]
        if not body.strip():
            # 整行均为注释：父块已有子块时作块间注释子节点（保住块间位置），
            # 否则作父块 body 内的 comment 选项行（块内位置不变）
            if cmt:
                if cur["children"]:
                    cur["children"].append(
                        {"scope": "comment", "header": cmt[1:].strip(), "children": [], "options": [], "_line": ln}
                    )
                else:
                    cur["options"].append(_comment_option(cmt, ln))
            continue
        clean = _strip_quoted(body)
        opens = clean.count("{")
        closes = clean.count("}")
        if opens == 0 and closes == 0:
            cur["options"].append({**kvify(body), "_line": ln})
            if cmt:
                cur["options"].append(_comment_option(cmt, ln))
            continue
        if closes > 0 and opens == 0:
            pops = closes
            while pops > 0 and len(stack) > 1:
                stack.pop()
                pops -= 1
            if pops > 0:
                errors.append({"line": ln, "reason": "多余的右括号 }（无对应的块头）"})
            continue
        if opens > 0:
            col = body.find("{")
            head = _strip_inline_comment(body[:col])[0].strip()
            after = re.sub(r"}.*$", "", _strip_quoted(body[col + 1:]))
            after, _ = _strip_inline_comment(after)
            sc = scope_of(head)
            child: dict = {"scope": sc or "raw", "header": head, "children": [], "options": [], "_line": ln}
            cur["children"].append(child)
            for s in _split_terms(after):
                child["options"].append({**kvify(s), "_line": ln})
            if cmt:
                child["options"].append(_comment_option(cmt, ln))
            if closes < opens:
                stack.append((child, ln))
            continue
    for node, start_ln in stack[1:]:
        errors.append(
            {"line": start_ln, "reason": f"块「{node.get('header') or node.get('scope')}」未闭合（缺少右括号 }}）"}
        )
    if errors:
        return None, errors
    return root, []


# ---- 差异单元：递归收集可独立同步的结构块 ----

def diffable_nodes(root: dict) -> list[dict]:
    out: list[dict] = []

    def walk(node: dict) -> None:
        for c in node.get("children", []):
            if c.get("scope") in DIFF_SCOPES:
                out.append(c)
            walk(c)

    walk(root)
    return out


def first_listen_plain(node: dict) -> str:
    """server 首个 listen 的纯端口（剥离 ssl/http2 等修饰词）。"""
    for o in node.get("options", []):
        if o.get("directive") == "listen":
            v = (o.get("value") or "").strip().rstrip(";")
            return v.split()[0] if " " in v else v
    return ""


def identity_of(node: dict) -> tuple[tuple[str, str], str]:
    """块主键 + 展示名：server→端口、upstream→组名、其余→header。"""
    sc = node.get("scope")
    if sc == "server":
        port = first_listen_plain(node)
        key = port or f"server@L{node.get('_line', 0)}"
        return (sc, key), (f"端口 {port}" if port else "server（无 listen）")
    if sc == "upstream":
        name = re.sub(r"^upstream\s+", "", node.get("header") or "").strip()
        return (sc, name), f"upstream {name}"
    head = (node.get("header") or "").strip()
    return (sc, head), head or sc


def render_equal(a: dict, b: dict) -> bool:
    """子树内容等价：render_text 对 if 块会注入「# 建议少用 if」提示行（非幂等），
    比较前剔除该提示行，避免同内容因往返渲染差异被误判为 replace。"""
    def canon(node: dict) -> list[str]:
        return [
            l for l in render_text(node)
            if not l.strip().startswith("# 建议少用 if")
        ]

    return canon(a) == canon(b)


def compute_diff(file_root: dict, db_root: dict) -> tuple[list[dict], list[dict]]:
    """按块主键比对：同键同内容=none；同键异内容=replace；仅文件=new；仅系统=keep。

    返回 (entries, 错误清单)，错误清单非空时调用方应整体拒绝。
    """
    f_index: dict = {}
    dup_errors: list[dict] = []
    for n in diffable_nodes(file_root):
        k, _ = identity_of(n)
        if k in f_index:
            _, disp = identity_of(n)
            dup_errors.append({"line": n.get("_line", 0), "reason": f"文件内重复定义：{disp}"})
        else:
            f_index[k] = n
    db_index: dict = {}
    for n in diffable_nodes(db_root):
        k, _ = identity_of(n)
        db_index[k] = n
    entries: list[dict] = []
    for k, fn in f_index.items():
        _, disp = identity_of(fn)
        if k in db_index:
            action = "none" if render_equal(fn, db_index[k]) else "replace"
        else:
            action = "new"
        entries.append({"scope": k[0], "key": k[1], "display": disp, "action": action})
    for k, dn in db_index.items():
        if k not in f_index:
            _, disp = identity_of(dn)
            entries.append({"scope": k[0], "key": k[1], "display": disp, "action": "keep"})
    order = {"replace": 0, "new": 1, "none": 2, "keep": 3}
    entries.sort(key=lambda e: order[e["action"]])
    return entries, dup_errors


# ---- 落库应用（调用方负责外层事务与提交/回滚）----

def _block_rows(db, config_id: int) -> tuple[list[ConfigBlock], dict[int, list[ConfigOption]]]:
    rows = list(
        db.execute(
            select(ConfigBlock)
            .where(ConfigBlock.nginx_config_id == config_id)
            .order_by(ConfigBlock.sort_order, ConfigBlock.id)
        ).scalars().all()
    )
    ids = [b.id for b in rows]
    opt_map: dict[int, list[ConfigOption]] = {}
    if ids:
        for o in db.execute(
            select(ConfigOption)
            .where(ConfigOption.block_id.in_(ids))
            .order_by(ConfigOption.sort_order, ConfigOption.id)
        ).scalars().all():
            opt_map.setdefault(o.block_id, []).append(o)
    return rows, opt_map


def _subtree_ids(rows: list[ConfigBlock], block_id: int) -> list[int]:
    children: dict[int | None, list[int]] = {}
    for b in rows:
        children.setdefault(b.parent_id, []).append(b.id)
    out = [block_id]
    stack = [block_id]
    while stack:
        pid = stack.pop()
        for cid in children.get(pid, []):
            out.append(cid)
            stack.append(cid)
    return out


def _node_dict(b: ConfigBlock, opt_map: dict[int, list[ConfigOption]]) -> dict:
    return {
        "scope": b.scope,
        "header": b.header,
        "options": [{"directive": o.directive, "value": o.value} for o in opt_map.get(b.id, [])],
        "children": [],
    }


def _copy_node_into(db, config_id: int, block_id: int, node: dict, listen_override: str | None = None) -> None:
    for o in node.get("options", []):
        directive = o.get("directive", "")
        value = o.get("value", "")
        if directive == "listen" and listen_override is not None:
            value = listen_override
        db.add(
            ConfigOption(
                block_id=block_id,
                directive=directive,
                value=value,
                row_type=o.get("row_type", "kv"),
                is_free_text=bool(o.get("is_free_text")),
                sort_order=o.get("sort_order", 0),
            )
        )
    for idx, child in enumerate(node.get("children", [])):
        c = ConfigBlock(
            nginx_config_id=config_id,
            parent_id=block_id,
            scope=child.get("scope", "raw"),
            header=child.get("header", ""),
            belongs_to_file=None,
            sort_order=idx,
        )
        db.add(c)
        db.flush()
        _copy_node_into(db, config_id, c.id, child, listen_override)


def _delete_subtree(db, opt_map: dict[int, list[ConfigOption]], rows: list[ConfigBlock], block_id: int) -> None:
    """用 ORM 删除整棵子树（先 options 后 blocks），保持 identity map 干净。"""
    ids = _subtree_ids(rows, block_id)
    by_id = {b.id: b for b in rows}
    for oid in ids:
        for o in opt_map.get(oid, []):
            db.delete(o)
    for bid in reversed(ids):
        db.delete(by_id[bid])
    db.flush()


def _replace_with_file(db, config_id: int, b: ConfigBlock, fn: dict, opt_map, rows) -> ConfigBlock:
    """把 DB 块整棵子树替换为文件块子树，保留 DB 的父级/位置信息。"""
    parent_id, scope, header, file_, order = (
        b.parent_id, b.scope, b.header, b.belongs_to_file, b.sort_order,
    )
    _delete_subtree(db, opt_map, rows, b.id)
    ndst = ConfigBlock(
        nginx_config_id=config_id,
        parent_id=parent_id,
        scope=scope,
        header=header,
        belongs_to_file=file_,
        sort_order=order,
    )
    db.add(ndst)
    db.flush()
    _copy_node_into(db, config_id, ndst.id, fn)
    return ndst


def _create_from_file(db, config_id: int, fn: dict, order: int) -> ConfigBlock:
    ndst = ConfigBlock(
        nginx_config_id=config_id,
        parent_id=None,
        scope=fn.get("scope", "raw"),
        header=fn.get("header", ""),
        belongs_to_file=None,
        sort_order=order,
    )
    db.add(ndst)
    db.flush()
    _copy_node_into(db, config_id, ndst.id, fn)
    return ndst


def _rebuild_dst_from_src(db, config_id: int, dst_id: int, src_id: int) -> ConfigBlock:
    """镜像同步：dst 整棵子树 ← src（保留 dst 自身的 listen 整值）。"""
    rows, opt_map = _block_rows(db, config_id)
    by_id = {b.id: b for b in rows}
    dst, src = by_id[dst_id], by_id[src_id]
    dst_listen = next((o.value for o in opt_map.get(dst.id, []) if o.directive == "listen"), None)
    parent_id, scope, header, file_, order = (
        dst.parent_id, dst.scope, dst.header, dst.belongs_to_file, dst.sort_order,
    )
    _delete_subtree(db, opt_map, rows, dst_id)
    ndst = ConfigBlock(
        nginx_config_id=config_id,
        parent_id=parent_id,
        scope=scope,
        header=header,
        belongs_to_file=file_,
        sort_order=order,
    )
    db.add(ndst)
    db.flush()

    def copy(node_b: ConfigBlock, new_block_id: int, override: str | None) -> None:
        for o in opt_map.get(node_b.id, []):
            val = o.value
            if o.directive == "listen" and override is not None:
                val = override
            db.add(
                ConfigOption(
                    block_id=new_block_id,
                    directive=o.directive,
                    value=val,
                    row_type=o.row_type,
                    is_free_text=o.is_free_text,
                    sort_order=o.sort_order,
                )
            )
        for c in [x for x in rows if x.parent_id == node_b.id]:
            nb = ConfigBlock(
                nginx_config_id=config_id,
                parent_id=new_block_id,
                scope=c.scope,
                header=c.header,
                belongs_to_file=c.belongs_to_file,
                sort_order=c.sort_order,
            )
            db.add(nb)
            db.flush()
            copy(c, nb.id, None)

    copy(src, ndst.id, override=dst_listen)
    return ndst


def _sync_mirrors(db, config_id: int, touched: set[int]) -> list[dict]:
    pairs = list(
        db.execute(
            select(NginxMirrorPair).where(NginxMirrorPair.nginx_config_id == config_id)
        ).scalars().all()
    )
    if not pairs:
        return []
    rows, opt_map = _block_rows(db, config_id)

    def find_by_listen(port: str) -> ConfigBlock | None:
        for b in rows:
            if first_listen_plain(_node_dict(b, opt_map)) == port:
                return b
        return None

    mirrored: list[dict] = []
    for p in pairs:
        src = find_by_listen(p.src_listen)
        dst = find_by_listen(p.dst_listen)
        if not src or not dst or src.id not in touched:
            continue
        if dst.id in touched:
            # dst 本次也被文件替换/新建：文件内容为准，镜像不覆盖（保住 dst 自身内容与注释位置）
            continue
        _rebuild_dst_from_src(db, config_id, dst.id, src.id)
        mirrored.append({"src": p.src_listen, "dst": p.dst_listen})
    return mirrored


def _sync_root_level(db, config_id: int, file_root: dict) -> None:
    """根级内容与文件对齐（diff 只覆盖 diffable 块，顶层指令/注释在此单独同步）。

    - 顶层 options（含顶层注释）归并进 header="" 的根 options 块，
      build_config_dict 会并入 root.options 渲染在最前；
    - 顶层注释按文件序创建/保留为 parent_id=None 的 comment 块，与顶层 diffable 块
      的 sort_order 交错，保住「块与块之间」的文件位置；
    - 顶层 sort_order 按文件顶层序列重排，DB 独有块（keep）追加在文件序列之后。
    """
    rows, opt_map = _block_rows(db, config_id)
    root_scope = file_root.get("scope", "http")
    top_rows = [b for b in rows if b.parent_id is None]
    root_block = next((b for b in top_rows if b.header == "" and b.scope == root_scope), None)

    # 1) 顶层 options → 根 options 块（镜像文件；无文件内容则清空既有块）
    file_opts = file_root.get("options", [])
    if root_block is None and file_opts:
        root_block = ConfigBlock(
            nginx_config_id=config_id, parent_id=None, scope=root_scope,
            header="", belongs_to_file=None, sort_order=0,
        )
        db.add(root_block)
        db.flush()
    if root_block is not None:
        for o in opt_map.get(root_block.id, []):
            db.delete(o)
        for o in file_opts:
            db.add(
                ConfigOption(
                    block_id=root_block.id,
                    directive=o.get("directive", ""),
                    value=o.get("value", ""),
                    row_type=o.get("row_type", "kv"),
                    is_free_text=bool(o.get("is_free_text")),
                    sort_order=o.get("sort_order", 0),
                )
            )
        db.flush()

    # 2) 文件顶层项 → DB 行映射（diffable 按主键、注释按 header 贪心匹配）
    db_index: dict = {}
    for b in top_rows:
        k, _ = identity_of(_node_dict(b, opt_map))
        db_index.setdefault(k, b)
    db_cmts = [b for b in top_rows if b.scope == "comment"]
    used: set[int] = set()
    file_to_row: list[tuple[dict, ConfigBlock | None]] = []
    for c in file_root.get("children", []):
        if c.get("scope") == "comment":
            row = next((b for b in db_cmts if b.header == c.get("header", "") and b.id not in used), None)
        else:
            k, _ = identity_of(c)
            row = db_index.get(k)
        if row is not None:
            used.add(row.id)
        file_to_row.append((c, row))

    # 3) 新建缺失的注释块，并按文件序重排顶层 sort_order（keep 块追加在后）
    order = 0
    assigned: set[int] = set()
    for c, row in file_to_row:
        if c.get("scope") == "comment" and row is None:
            row = ConfigBlock(
                nginx_config_id=config_id, parent_id=None, scope="comment",
                header=c.get("header", ""), belongs_to_file=None, sort_order=0,
            )
            db.add(row)
            db.flush()
        if row is not None:
            order += 1
            row.sort_order = order
            assigned.add(row.id)
    for b in top_rows:
        if b.id in assigned or b is root_block:
            continue
        order += 1
        b.sort_order = order
    db.flush()


def perform_apply(db, config_id: int, file_root: dict, entries: list[dict]) -> dict:
    """把预览确认的差异应用到 DB（不提交，由调用方统一事务）。

    replace 整棵子树替换（保留 DB 位置）；new 追加到顶级末尾；
    顶层指令/注释经 _sync_root_level 按文件序对齐（注释在块与块之间的位置不变）；
    被替换/新建的镜像母本自动同步镜像目标（保留 dst 自身 listen）。
    """
    to_apply = [e for e in entries if e["action"] in ("replace", "new")]
    if not to_apply:
        raise ValueError("无变更可提交（仅存在无变化/保留项）")
    rows, opt_map = _block_rows(db, config_id)
    f_index: dict = {}
    for n in diffable_nodes(file_root):
        k, _ = identity_of(n)
        f_index.setdefault(k, n)
    db_index: dict = {}
    for b in rows:
        k, _ = identity_of(_node_dict(b, opt_map))
        db_index[k] = b
    top_order = max((b.sort_order for b in rows if b.parent_id is None), default=0)
    touched: set[int] = set()
    for e in to_apply:
        k = (e["scope"], e["key"])
        fn = f_index.get(k)
        if fn is None:
            raise ValueError(f"差异条目「{e['display']}」在文件原文中找不到，请重新预览")
        if e["action"] == "replace":
            b = db_index.get(k)
            if b is None:
                raise ValueError(f"差异条目「{e['display']}」标注为替换但系统内不存在，请重新预览")
            ndst = _replace_with_file(db, config_id, b, fn, opt_map, rows)
        else:
            top_order += 1
            ndst = _create_from_file(db, config_id, fn, top_order)
        touched.add(ndst.id)
    db.flush()
    _sync_root_level(db, config_id, file_root)
    mirrored = _sync_mirrors(db, config_id, touched)
    return {"applied": to_apply, "mirrored": mirrored}
