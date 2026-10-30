"""项目、共享授权、环境变量 ORM 模型。

层级：行业 Industry 1─n 项目 Project 1─n（Nginx 配置 / YML 配置 / 环境变量）。
项目是共享与权限控制的基本单位；共享授权记录「项目 × 指定账号 × 权限档位」，
全员可见（固定只读）由 Project.share_all 开关表达。
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Project(Base):
    """项目：行业下的配置分组，归属创建后不可变更。"""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), index=True, nullable=False
    )
    remark: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 全员可见开关：开启后所有启用账号以「可查看」权限看到本项目
    share_all: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("industry_id", "name", name="uq_project_industry_name"),
        UniqueConstraint("industry_id", "code", name="uq_project_industry_code"),
    )


class ShareGrant(Base):
    """指定人共享授权：一个项目对同一账号仅一条记录，重复添加视为修改档位。"""

    __tablename__ = "share_grants"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id"), index=True, nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), index=True, nullable=False
    )
    # 权限档位：view（可查看）| edit（可编辑）
    perm: Mapped[str] = mapped_column(String(8), nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("project_id", "user_id", name="uq_share_grant_project_user"),
    )


class EnvVar(Base):
    """项目级环境变量键值对（不区分环境，不做模板引用）。"""

    __tablename__ = "env_vars"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id"), index=True, nullable=False
    )
    key: Mapped[str] = mapped_column(String(128), nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    remark: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("project_id", "key", name="uq_env_var_project_key"),
    )
