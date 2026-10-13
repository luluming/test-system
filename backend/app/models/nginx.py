"""运维配置 ORM 模型：nginx 配置、域名映射、转发端口、业务端口公网开关。

均为系统级全局配置（无需 owner 隔离），仿照 Item/User 的写法约定。
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class NginxConfig(Base):
    """nginx 服务器配置记录（按行业作用域，含乐观版本与编辑租约）。"""

    __tablename__ = "nginx_configs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    domain: Mapped[str | None] = mapped_column(String(255), nullable=True)
    config_text: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # 乐观锁：每次成功写入自增；创建默认为 1
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
    # 编辑会话租约：唯一持有者标记 + 心跳时间（可为空表示无编辑者）
    edit_holder: Mapped[str | None] = mapped_column(String(50), nullable=True)
    edit_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    __table_args__ = (UniqueConstraint("industry_id", "name", name="uq_nginx_config_industry_name"),)


class DomainMapping(Base):
    """域名到转发目标的映射关系。"""

    __tablename__ = "domain_mappings"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    domain: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    forward_tos: Mapped[str] = mapped_column(String(255), nullable=False)
    protocol: Mapped[str] = mapped_column(String(16), default="http", nullable=False)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class ForwardPort(Base):
    """nginx 转发端口：监听端口 → 上游目标。"""

    __tablename__ = "forward_ports"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    listen_port: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    upstream_target: Mapped[str] = mapped_column(String(255), nullable=False)
    service_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    protocol: Mapped[str] = mapped_column(String(16), default="http", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class BizPort(Base):
    """业务启动端口，含是否开放到公网开关。"""

    __tablename__ = "biz_ports"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    service_name: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    port: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    protocol: Mapped[str] = mapped_column(String(16), default="tcp", nullable=False)
    public_exposed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )