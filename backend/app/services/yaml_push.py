"""YAML 配置服务：语法校验（含重复键检测）、结构化树、键路径 diff、统计信息。

设计要点（PRD 2026-10-27-yaml-config-manager）：
- 「宽松保存原文 + 显式校验」：校验失败返回行号/列位置/可读说明，但不改写原文；
- 键路径（如 ``clusters[3].cluster-variables``）作为 diff 与导航的统一标识；
- 容器节点（映射/列表）按存在性 diff，标量按「类型|值」canonical diff，
  结构变化由其子节点各自产出条目，保证 diff 明细完整。
"""

import yaml

# ---- 重复键检测：同一映射内重复键立即报错（带行号）----


class UniqueKeyLoader(yaml.SafeLoader):
    """SafeLoader 扩展：构造映射时检测重复键，命中即抛 ConstructorError。"""

    def construct_mapping(self, node, deep: bool = False):
        mapping: dict = {}
        for key_node, _value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            try:
                if key in mapping:
                    raise yaml.constructor.ConstructorError(
                        "while constructing a mapping",
                        node.start_mark,
                        f"重复键：{key}",
                        key_node.start_mark,
                    )
                mapping[key] = True
            except TypeError:
                # 键不可哈希（如复杂键），跳过重复检测
                continue
        return super().construct_mapping(node, deep)


def _error_of(exc: yaml.YAMLError) -> dict:
    """把 PyYAML 异常转换为 {line, col, reason} 定位信息。"""
    mark = getattr(exc, "problem_mark", None)
    reason = (exc.problem or str(exc)).strip().splitlines()[0]
    if reason.startswith("重复键"):
        return {"line": (mark.line + 1) if mark else 0, "col": (mark.column + 1) if mark else 0, "reason": reason}
    return {
        "line": (mark.line + 1) if mark else 0,
        "col": (mark.column + 1) if mark else 0,
        "reason": reason,
    }


def validate_yaml(text: str) -> list[dict]:
    """严格校验原文：返回 [] 表示合法；否则返回错误清单（首个错误，行号+列+说明）。

    覆盖：语法错误（Scanner/Parser）、重复键（UniqueKeyLoader）、
    未定义锚点（Composer）、类型构造失败（Constructor）。
    """
    if not text or not text.strip():
        return [{"line": 0, "col": 0, "reason": "文件内容为空"}]
    try:
        yaml.load(text, Loader=UniqueKeyLoader)
        return []
    except yaml.YAMLError as exc:  # noqa: BLE001 覆盖全部 YAML 解析异常
        return [_error_of(exc)]


def compose_yaml(text: str) -> yaml.nodes.Node:
    """解析原文为节点图（映射/序列/标量）；语法非法时抛 yaml.YAMLError。"""
    return yaml.compose(text, Loader=UniqueKeyLoader)


def _scalar_canonical(node: yaml.ScalarNode) -> str:
    """标量 canonical 值：tag|value，用于 diff 比较（区分类型与字面量）。"""
    return f"{node.tag}|{node.value}"


def _scalar_display(node: yaml.ScalarNode) -> str:
    """展示值：标量原文（长值截断由前端负责）。"""
    return node.value or ""


def _key_of(node: yaml.Node) -> str:
    """映射键的字符串表示：标量键取原文，复杂键取类型占位。"""
    if isinstance(node, yaml.ScalarNode):
        return node.value if node.value is not None else ""
    return f"<{node.tag.split(':')[-1]}>"


def parse_tree(text: str) -> list[dict]:
    """原文 → 结构化树（递归，供结构面板渲染）。

    节点结构：{path, key, type: map|list|scalar, count?, value?, line?, children?}
    path 为完整键路径（如 ``clusters[3].cluster-variables.s3.public.secretKey``），
    key 为叶子片段（列表项为 ``[i]``），供树节点展示与导航。
    根容器本身不占条目，其子键平铺为顶层节点。
    """
    doc = compose_yaml(text)
    out: list[dict] = []
    if isinstance(doc, (yaml.MappingNode, yaml.SequenceNode)):
        _tree_into(doc, "", out, key="", is_root=True)
    else:
        _tree_into(doc, "", out)
    return out


def _tree_into(
    node: yaml.Node, path: str, out: list[dict], key: str | None = None, is_root: bool = False
) -> None:
    line = (node.start_mark.line + 1) if node.start_mark else None
    if isinstance(node, yaml.ScalarNode):
        out.append(
            {
                "path": path,
                "key": key if key is not None else path,
                "type": "scalar",
                "value": _scalar_display(node),
                "line": line,
            }
        )
        return
    if isinstance(node, yaml.SequenceNode):
        kids: list[dict] = []
        for i, item in enumerate(node.value):
            _tree_into(item, f"{path}[{i}]" if path else f"[{i}]", kids, key=f"[{i}]")
        if is_root:
            out.extend(kids)
            return
        out.append(
            {
                "path": path,
                "key": key if key is not None else path,
                "type": "list",
                "count": len(node.value),
                "line": line,
                "children": kids,
            }
        )
        return
    # MappingNode
    kids = []
    for key_node, val_node in node.value:
        k = _key_of(key_node)
        child_path = f"{path}.{k}" if path else k
        _tree_into(val_node, child_path, kids, key=k)
    if is_root:
        out.extend(kids)
        return
    out.append(
        {
            "path": path,
            "key": key if key is not None else path,
            "type": "map",
            "count": len(node.value),
            "line": line,
            "children": kids,
        }
    )


def _entries_into(node: yaml.Node, path: str, out: list[dict], is_root: bool = False) -> None:
    """把节点图摊平为键路径条目（diff 用），容器按存在性、标量按 canonical 值。

    根容器本身不产出条目（无键路径），其子节点逐层摊平。
    """
    if isinstance(node, yaml.ScalarNode):
        out.append(
            {"path": path, "type": "scalar", "value": _scalar_canonical(node)}
        )
        return
    if isinstance(node, yaml.SequenceNode):
        if not is_root:
            out.append({"path": path, "type": "list", "count": len(node.value)})
        for i, item in enumerate(node.value):
            _entries_into(item, f"{path}[{i}]" if path else f"[{i}]", out)
        return
    # MappingNode
    if not is_root:
        out.append({"path": path, "type": "map", "count": len(node.value)})
    for key_node, val_node in node.value:
        key = _key_of(key_node)
        child_path = f"{path}.{key}" if path else key
        _entries_into(val_node, child_path, out)


def compute_diff(new_text: str, old_text: str) -> tuple[list[dict], dict]:
    """两版原文按键路径 diff。

    动作语义（PRD FR-01）：new（库中不存在）、replace（同路径值/结构变化，标量级）、
    delete（库中存在、新文件已移除）、keep（无变化）。
    返回 (entries, counts)；counts 为各动作计数。
    """
    new_doc = compose_yaml(new_text)
    old_doc = compose_yaml(old_text)
    new_entries: list[dict] = []
    old_entries: list[dict] = []
    _entries_into(new_doc, "", new_entries, is_root=True)
    _entries_into(old_doc, "", old_entries, is_root=True)
    new_index = {e["path"]: e for e in new_entries}
    old_index = {e["path"]: e for e in old_entries}

    entries: list[dict] = []
    for path, e in new_index.items():
        o = old_index.get(path)
        if o is None:
            action = "new"
        elif e["type"] == "scalar" and o["type"] == "scalar":
            action = "keep" if e.get("value") == o.get("value") else "replace"
        else:
            # 容器结构变化由其子节点各自产出条目，容器本身按存在性 keep
            action = "keep"
        entries.append({"path": path, "action": action, "type": e["type"]})
    for path, o in old_index.items():
        if path not in new_index:
            entries.append({"path": path, "action": "delete", "type": o["type"]})

    order = {"replace": 0, "new": 1, "delete": 2, "keep": 3}
    entries.sort(key=lambda e: (order[e["action"]], e["path"]))
    counts = {"replace": 0, "new": 0, "delete": 0, "keep": 0}
    for e in entries:
        counts[e["action"]] += 1
    return entries, counts


def _count_nodes(node: yaml.Node) -> int:
    """统计节点总数（映射/序列/标量均计入）。"""
    if isinstance(node, yaml.ScalarNode):
        return 1
    if isinstance(node, yaml.SequenceNode):
        return 1 + sum(_count_nodes(n) for n in node.value)
    # MappingNode
    return 1 + sum(_count_nodes(k) + _count_nodes(v) for k, v in node.value)


def analyze(text: str) -> dict:
    """配置统计信息（列表视图用）：语法是否合法 + 行数 + 节点数 + 顶层键。"""
    line_count = len(text.splitlines())
    errors = validate_yaml(text)
    if errors:
        return {
            "valid": False,
            "line_count": line_count,
            "node_count": 0,
            "top_keys": [],
        }
    try:
        doc = compose_yaml(text)
    except yaml.YAMLError:  # noqa: BLE001 与 validate 结果兜底一致
        return {
            "valid": False,
            "line_count": line_count,
            "node_count": 0,
            "top_keys": [],
        }
    top_keys = (
        [_key_of(k) for k, _v in doc.value]
        if isinstance(doc, yaml.MappingNode)
        else []
    )
    return {
        "valid": True,
        "line_count": line_count,
        "node_count": _count_nodes(doc),
        "top_keys": top_keys,
    }
