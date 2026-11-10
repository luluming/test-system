"""YAML 配置管理 ORM 模型：配置、版本快照、推送任务、一次性推送令牌。

与 nginx 推送范式同构（两阶段 preview/apply + 一次性 token + 版本快照），
仅替换「存储单元」为通用 YAML 文本（content_text）。
"""

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.mysql import MEDIUMTEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# MySQL 的 TEXT 上限 64KB，1213 行 YAML 的完整 diff JSON / 原文可能超限；
# SQLite 无此限制，故仅对 MySQL 变体使用 MEDIUMTEXT（16MB）。
BigText = Text().with_variant(MEDIUMTEXT(), "mysql")


class YamlConfig(Base):
    """一个被管理的 YAML 配置文件（按行业作用域，含乐观版本号）。"""

    __tablename__ = "yaml_configs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    # 归属项目（权限判定依据）；历史数据由启动迁移挂到行业「默认项目」
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id"), index=True, nullable=True
    )
    name: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    # Nacos 风格分组（tenant-config-data 三级结构中的 group 层）；DB 列名
    # 用 config_group 以规避 MySQL 保留字 GROUP
    group: Mapped[str] = mapped_column(
        "config_group",
        String(100),
        default="DEFAULT_GROUP",
        server_default="DEFAULT_GROUP",
        nullable=False,
    )
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    content_text: Mapped[str] = mapped_column(BigText, nullable=False)
    # enabled | disabled | invalid（语法异常时置 invalid，保存成功自动清除）
    status: Mapped[str] = mapped_column(String(16), default="enabled", nullable=False)
    # 乐观锁：每次成功写入自增；创建默认为 1
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(50), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    # 配置文件名称在「项目」内唯一（不同项目可同名）
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_yaml_config_project_name"),)


class YamlConfigVersion(Base):
    """YAML 配置版本快照：每次「保存 / 推送 apply / 回滚」以完整原文存一版，用于历史对比。"""

    __tablename__ = "yaml_config_versions"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    yaml_config_id: Mapped[int] = mapped_column(
        ForeignKey("yaml_configs.id"), index=True, nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(BigText, nullable=False)
    note: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("yaml_config_id", "version", name="uq_yaml_config_version"),
    )


class YamlPushTask(Base):
    """YAML 推送任务：两阶段（预览 → 确认提交）记录。

    preview 阶段解析原文并按键路径比对差异后落一条 pending；apply 成功后置 applied，
    原文 raw_text 与 diff_json 双重留档（失败时 error_detail 记录原因）。
    """

    __tablename__ = "yaml_push_tasks"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    yaml_config_id: Mapped[int] = mapped_column(
        ForeignKey("yaml_configs.id"), index=True, nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(16), default="pending", nullable=False
    )  # pending | applied | failed
    raw_text: Mapped[str] = mapped_column(BigText, nullable=False)
    diff_json: Mapped[str] = mapped_column(BigText, default="[]", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    applied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_detail: Mapped[str | None] = mapped_column(BigText, nullable=True)


class YamlPushDiff(Base):
    """目录推送差异暂存：正文有变化的既有配置不直接覆盖，先落一条待处理差异。

    status: pending（待处理）| applied（已采用新推送）| ignored（保留当前）。
    处理时按 base_version 做乐观校验，避免覆盖期间被人工修改的配置。
    """

    __tablename__ = "yaml_push_diffs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id"), index=True, nullable=False
    )
    config_id: Mapped[int] = mapped_column(
        ForeignKey("yaml_configs.id"), index=True, nullable=False
    )
    tenant: Mapped[str] = mapped_column(String(100), default="public", nullable=False)
    group: Mapped[str] = mapped_column(
        "config_group",
        String(100),
        default="DEFAULT_GROUP",
        server_default="DEFAULT_GROUP",
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    base_version: Mapped[int] = mapped_column(Integer, nullable=False)
    base_content: Mapped[str] = mapped_column(BigText, nullable=False)
    incoming_content: Mapped[str] = mapped_column(BigText, nullable=False)
    added: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    removed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending", nullable=False
    )
    created_by: Mapped[str | None] = mapped_column(String(50), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    __table_args__ = (Index("ix_yaml_push_diffs_status_project", "status", "project_id"),)


class YamlPushToken(Base):
    """YAML 推送一次性 token：预览/提交各签发一枚，单次使用、短时过期。

    token 明文仅签发时返回一次，库中只存 SHA-256 哈希；
    同一 config+purpose 重新签发会立即作废旧未用 token。
    """

    __tablename__ = "yaml_push_tokens"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    yaml_config_id: Mapped[int] = mapped_column(
        ForeignKey("yaml_configs.id"), index=True, nullable=False
    )
    purpose: Mapped[str] = mapped_column(String(16), nullable=False)  # preview | apply
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
