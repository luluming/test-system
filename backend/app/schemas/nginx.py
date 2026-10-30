"""运维配置相关 Pydantic 模型（请求/响应）：nginx / 域名映射 / 转发端口 / 业务端口。

每个资源提供 Create / Update / Out 三件套，仿照 schemas/item.py。
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class NginxConfigCreate(BaseModel):
    """创建 nginx 配置请求（必须指定所属行业）。

    project_id 可选：指定则挂到该项目（需该项目可编辑权限，且行业须一致）；
    不指定则落到行业默认项目（兼容旧行为）。
    """

    industry_id: int
    name: str = Field(min_length=1, max_length=100)
    domain: str | None = Field(default=None, max_length=255)
    config_text: str
    enabled: bool = True
    project_id: int | None = None


class NginxConfigOut(BaseModel):
    """nginx 配置响应（含行业与版本）。"""

    id: int
    industry_id: int
    name: str
    domain: str | None
    config_text: str
    enabled: bool
    version: int
    updated_at: datetime
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class NginxConfigUpdate(BaseModel):
    """更新 nginx 配置请求：携带 base_version 做乐观锁。"""

    name: str | None = Field(default=None, max_length=100)
    domain: str | None = Field(default=None, max_length=255)
    config_text: str | None = None
    enabled: bool | None = None
    base_version: int


class DomainMappingCreate(BaseModel):
    """创建域名映射请求。"""

    industry_id: int
    domain: str
    forward_tos: str
    protocol: str = "http"
    description: str | None = None
    enabled: bool = True


class DomainMappingUpdate(BaseModel):
    """更新域名映射请求（字段可选）。"""

    domain: str | None = None
    forward_tos: str | None = None
    protocol: str | None = None
    description: str | None = None
    enabled: bool | None = None


class DomainMappingOut(BaseModel):
    """域名映射响应。"""

    id: int
    domain: str
    forward_tos: str
    protocol: str
    description: str | None
    enabled: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ForwardPortCreate(BaseModel):
    """创建转发端口请求。"""

    industry_id: int
    upstream_id: int | None = None
    listen_port: int
    upstream_target: str
    service_name: str | None = None
    protocol: str = "http"
    enabled: bool = True


class ForwardPortUpdate(BaseModel):
    """更新转发端口请求（字段可选）。"""

    listen_port: int | None = None
    upstream_target: str | None = None
    service_name: str | None = None
    protocol: str | None = None
    enabled: bool | None = None


class ForwardPortOut(BaseModel):
    """转发端口响应。"""

    id: int
    industry_id: int
    upstream_id: int | None
    listen_port: int
    upstream_target: str
    service_name: str | None
    protocol: str
    enabled: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BizPortCreate(BaseModel):
    """创建业务端口请求。"""

    industry_id: int
    service_name: str
    port: int
    protocol: str = "tcp"
    public_exposed: bool = False
    note: str | None = None


class BizPortUpdate(BaseModel):
    """更新业务端口请求（字段可选）。"""

    service_name: str | None = None
    port: int | None = None
    protocol: str | None = None
    public_exposed: bool | None = None
    note: str | None = None


class BizPortOut(BaseModel):
    """业务端口响应。"""

    id: int
    service_name: str
    port: int
    protocol: str
    public_exposed: bool
    note: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MirrorPairCreate(BaseModel):
    """创建镜像对请求：src_listen 为母本监听端口，dst_listen 为镜像端口。"""

    src_listen: str = Field(min_length=1, max_length=32)
    dst_listen: str = Field(min_length=1, max_length=32)


class MirrorPairOut(BaseModel):
    """镜像对响应。"""

    id: int
    nginx_config_id: int
    src_listen: str
    dst_listen: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)