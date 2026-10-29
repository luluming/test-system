#!/usr/bin/env python3
"""SQLite → MySQL 全量数据迁移脚本。

用法：
    1. 先在 MySQL 上建库建表（见下方 "MySQL 初始化" 部分）
    2. 运行：  python3 -m scripts.sqlite_to_mysql \
               --sqlite  backend/test_system.db \
               --mysql   "mysql+pymysql://root:PASSWORD@127.0.0.1:3306/test_system?charset=utf8mb4"
    3. 迁移成功后，把 backend/.env 里 DATABASE_URL 改为上面的 MySQL 串，重启后端即可

脚本特性：
- 以「每张表」为单位做事务；某张表失败会整体回滚，源 SQLite 不动
- 保留所有原自增 id，外键依赖按拓扑顺序（先主表、后子表）
- 已存在目标表且不为空 → 默认拒绝，防止误覆盖（--overwrite 可强制清表重灌）
- 大字段（BLOB/TEXT）批量 INSERT，避免 MySQL 连接包溢出
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Iterable

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine, inspect, text

# 外键拓扑序：父表先、子表后，保证 INSERT 不会 FK 报错
#（以 models/__init__.py 中注册顺序为准；若将来新表需加入 FK，这里也要同步）
TABLE_ORDER = [
    "users",
    "industries",
    "nginx_configs",
    "yaml_configs",
    "config_blocks",
    "config_options",
    "upstreams",
    "domain_mappings",
    "forward_ports",
    "biz_ports",
    "nginx_versions",
    "yaml_versions",
    "nginx_push_tasks",
    "yaml_push_tasks",
    "push_tokens",
]


def _read_tables(src_url: str) -> dict[str, list[dict]]:
    """按拓扑序从 SQLite 读出每张表的全部行。"""
    src = create_engine(src_url)
    insp = inspect(src)
    present = set(insp.get_table_names())
    data: dict[str, list[dict]] = {}
    with src.connect() as conn:
        for t in TABLE_ORDER:
            if t not in present:
                continue
            cols = [c["name"] for c in insp.get_columns(t)]
            rows = conn.execute(text(f"SELECT {', '.join(cols)} FROM {t}")).mappings().all()
            data[t] = [dict(r) for r in rows]
    return data


def _chunked(seq: list, size: int = 200) -> Iterable[list]:
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def _write_tables(dst_url: str, data: dict[str, list[dict]], overwrite: bool) -> None:
    dst = create_engine(dst_url, pool_pre_ping=True)
    insp = inspect(dst)
    present = set(insp.get_table_names())

    with dst.begin() as conn:
        # 外键检查暂时关掉（批量迁移过程中先父后子，临时关避免约束时序问题）
        conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
        try:
            for t in TABLE_ORDER:
                if t not in present:
                    print(f"  ⚠️  目标库缺失表 {t}，跳过")
                    continue
                if t not in data or not data[t]:
                    print(f"  · {t} （源为空）")
                    continue

                rows = data[t]
                col_names = list(rows[0].keys())

                if overwrite:
                    conn.execute(text(f"TRUNCATE TABLE {t}"))
                else:
                    cnt = conn.execute(text(f"SELECT COUNT(*) FROM {t}")).scalar_one()
                    if cnt > 0:
                        raise RuntimeError(
                            f"目标表 {t} 已有 {cnt} 行，拒绝覆盖（加 --overwrite 强制）"
                        )

                placeholders = ", ".join(f":{c}" for c in col_names)
                col_sql = ", ".join(col_names)
                stmt = text(f"INSERT INTO {t} ({col_sql}) VALUES ({placeholders})")

                for chunk in _chunked(rows, 200):
                    conn.execute(stmt, chunk)

                print(f"  ✓ {t}: {len(rows)} 行")
        finally:
            conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))


def _verify(src_url: str, dst_url: str, data: dict[str, list[dict]]) -> None:
    src = create_engine(src_url)
    dst = create_engine(dst_url, pool_pre_ping=True)
    errors = []
    with src.connect() as s, dst.connect() as d:
        for t, rows in data.items():
            sc = s.execute(text(f"SELECT COUNT(*) FROM {t}")).scalar_one()
            dc = d.execute(text(f"SELECT COUNT(*) FROM {t}")).scalar_one()
            flag = "✓" if sc == dc else "✗"
            print(f"    {flag} {t}: 源 {sc} / 目标 {dc}")
            if sc != dc:
                errors.append((t, sc, dc))
    if errors:
        raise SystemExit(f"迁移不完整：{errors}")


def main() -> None:
    ap = argparse.ArgumentParser(description="SQLite → MySQL 全量迁移")
    ap.add_argument("--sqlite", required=True, help="SQLite 文件路径（如 backend/test_system.db）")
    ap.add_argument("--mysql", required=True, help="MySQL SQLAlchemy URL（mysql+pymysql://...）")
    ap.add_argument("--overwrite", action="store_true", help="目标库非空时强制清空再导入")
    args = ap.parse_args()

    sqlite_url = f"sqlite:///{os.path.abspath(args.sqlite)}"
    print(f"源 SQLite: {args.sqlite}")
    print(f"目标 MySQL: {args.mysql}")

    # 预检查 PyMySQL
    try:
        import pymysql  # noqa: F401
    except ImportError:
        raise SystemExit("缺少 PyMySQL：pip install pymysql>=1.1")

    print("\n① 读取 SQLite 数据…")
    data = _read_tables(sqlite_url)
    total = sum(len(v) for v in data.values())
    print(f"   共 {len(data)} 张表，{total} 行")

    print("\n② 写入 MySQL（事务内）…")
    _write_tables(args.mysql, data, overwrite=args.overwrite)

    print("\n③ 校验行数…")
    _verify(sqlite_url, args.mysql, data)

    print("\n迁移完成 ✓")


if __name__ == "__main__":
    main()
