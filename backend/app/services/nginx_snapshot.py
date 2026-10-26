"""配置版本自动留档：落库成功后生成渲染文本快照；高频编辑 5s 窗口内合并为一条。"""

from datetime import datetime

from sqlalchemy import func, select

from app.models.nginx import NginxConfig, NginxConfigVersion
from app.services.nginx_render import build_config_dict, render_config_text

# 高频编辑合并窗口：最近版本在窗口内则原地覆盖 content（不新增版本号）
SNAPSHOT_MERGE_SECONDS = 5


def context_of_config(db, config_id: int) -> str:
    """按配置名推断渲染上下文：含 .stream 视为 stream，否则 conf。"""
    name = db.execute(
        select(NginxConfig.name).where(NginxConfig.id == config_id)
    ).scalar()
    return "stream" if name and ".stream" in name else "conf"


def snapshot_config(db, config_id: int, *, force_new: bool = False, commit: bool = True, context: str | None = None) -> NginxConfigVersion:
    """生成一版渲染文本快照。

    - 非 force_new：最近版本在 5s 合并窗口内 → 覆盖其 content；
    - force_new（推送提交等关键事件）：总是新增一版。
    """
    ctx = context or context_of_config(db, config_id)
    text = render_config_text(build_config_dict(db, config_id, context=ctx))
    if not force_new:
        latest = db.execute(
            select(NginxConfigVersion)
            .where(NginxConfigVersion.nginx_config_id == config_id)
            .order_by(NginxConfigVersion.version.desc())
            .limit(1)
        ).scalar_one_or_none()
        if latest is not None:
            try:
                age = (datetime.utcnow() - latest.created_at).total_seconds()
            except TypeError:
                age = None  # created_at 缺失等异常，直接走新增
            if age is not None and 0 <= age < SNAPSHOT_MERGE_SECONDS:
                latest.content = text
                if commit:
                    db.commit()
                return latest
    max_row = db.execute(
        select(func.max(NginxConfigVersion.version)).where(
            NginxConfigVersion.nginx_config_id == config_id
        )
    ).scalar()
    row = NginxConfigVersion(
        nginx_config_id=config_id,
        version=(max_row or 0) + 1,
        content=text,
    )
    db.add(row)
    if commit:
        db.commit()
        db.refresh(row)
    return row
