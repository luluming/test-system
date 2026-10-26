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


class NginxConfigVersion(Base):
    """配置文件版本快照：每次「保存」以渲染后的完整文本存一版，用于历史对比。

    version 从 1 起按配置自增；对比取两版的 content 逐行 diff。
    """

    __tablename__ = "nginx_config_versions"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    nginx_config_id: Mapped[int] = mapped_column(
        ForeignKey("nginx_configs.id"), index=True, nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint("nginx_config_id", "version", name="uq_nginx_config_version"),
    )


class ConfigBlock(Base):
    """泛化 nginx 块：靠 scope + parent_id 表达任意嵌套层级。

    server/location/upstream/map/geo/if/log_format/split_clients/include/comment/raw
    统一为一种块；层级完全由 parent_id 递归描述。
    """

    __tablename__ = "config_blocks"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    nginx_config_id: Mapped[int] = mapped_column(
        ForeignKey("nginx_configs.id"), index=True, nullable=False
    )
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("config_blocks.id"), index=True, nullable=True
    )
    scope: Mapped[str] = mapped_column(String(32), nullable=False)
    header: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    belongs_to_file: Mapped[str | None] = mapped_column(String(100), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class ConfigOption(Base):
    """块内通用 KV 行 + raw 原样行（指令顺序即输出顺序）。"""

    __tablename__ = "config_options"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    block_id: Mapped[int] = mapped_column(
        ForeignKey("config_blocks.id"), index=True, nullable=False
    )
    directive: Mapped[str] = mapped_column(String(100), nullable=False)
    value: Mapped[str] = mapped_column(String(1000), default="", nullable=False)
    row_type: Mapped[str] = mapped_column(String(16), default="kv", nullable=False)
    is_free_text: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class NginxMirrorPair(Base):
    """镜像同步对：src_listen 为母本监听端口，dst_listen 自动跟随。

    属于配置文件级元数据（按 nginx_config_id 隔离）；内容同步走
    POST /config-blocks/{src}/mirror/{dst} 接口。
    """

    __tablename__ = "nginx_mirror_pairs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    nginx_config_id: Mapped[int] = mapped_column(
        ForeignKey("nginx_configs.id"), index=True, nullable=False
    )
    src_listen: Mapped[str] = mapped_column(String(32), nullable=False)
    dst_listen: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    __table_args__ = (
        UniqueConstraint(
            "nginx_config_id", "src_listen", "dst_listen",
            name="uq_nginx_mirror_pair",
        ),
    )


class Upstream(Base):
    """nginx upstream 组（按行业作用域）。"""

    __tablename__ = "upstreams"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    strategy: Mapped[str] = mapped_column(
        String(32), default="round_robin", nullable=False
    )
    keepalive: Mapped[int] = mapped_column(Integer, default=32, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    __table_args__ = (UniqueConstraint("industry_id", "name"),)


class UpstreamServer(Base):
    """upstream 组内节点。"""

    __tablename__ = "upstream_servers"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    upstream_id: Mapped[int] = mapped_column(
        ForeignKey("upstreams.id"), index=True, nullable=False
    )
    addr: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    weight: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    health_status: Mapped[str] = mapped_column(
        String(16), default="checking", nullable=False
    )
    enable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class DomainMapping(Base):
    """域名到转发目标的映射关系。"""

    __tablename__ = "domain_mappings"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    domain: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    forward_tos: Mapped[str] = mapped_column(String(255), nullable=False)
    protocol: Mapped[str] = mapped_column(String(16), default="http", nullable=False)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    __table_args__ = (UniqueConstraint("industry_id", "domain"),)


class ForwardPort(Base):
    """nginx 转发端口：监听端口 → 上游目标。"""

    __tablename__ = "forward_ports"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    upstream_id: Mapped[int | None] = mapped_column(
        ForeignKey("upstreams.id"), index=True, nullable=True
    )
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
    industry_id: Mapped[int] = mapped_column(
        ForeignKey("industries.id"), index=True, nullable=False
    )
    service_name: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    port: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    protocol: Mapped[str] = mapped_column(String(16), default="tcp", nullable=False)
    public_exposed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )