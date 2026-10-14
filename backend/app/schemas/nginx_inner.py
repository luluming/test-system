"""内页① Pydantic 模型：upstream / upstream_servers / config_blocks / config_options 与动作请求。

沿用 schemas/nginx.py 的 Create/Update/Out 三件套 + ConfigDict(from_attributes=True) 约定。
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# ---- upstream ----

class UpstreamCreate(BaseModel):
    industry_id: int
    name: str = Field(min_length=1, max_length=100)
    strategy: str = "round_robin"
    keepalive: int = 32


class UpstreamUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    strategy: str | None = None
    keepalive: int | None = None


class UpstreamOut(BaseModel):
    id: int
    industry_id: int
    name: str
    strategy: str
    keepalive: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class UpstreamServerCreate(BaseModel):
    addr: str = Field(min_length=1, max_length=255)
    port: int | None = None
    weight: int = 1
    health_status: str = "checking"
    enable: bool = True


class UpstreamServerUpdate(BaseModel):
    addr: str | None = Field(default=None, min_length=1, max_length=255)
    port: int | None = None
    weight: int | None = None
    health_status: str | None = None
    enable: bool | None = None


class UpstreamServerOut(BaseModel):
    id: int
    upstream_id: int
    addr: str
    port: int | None
    weight: int
    health_status: str
    enable: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ---- config_blocks ----

class ConfigBlockCreate(BaseModel):
    nginx_config_id: int
    parent_id: int | None = None
    scope: str = Field(min_length=1, max_length=32)
    header: str = ""
    belongs_to_file: str | None = None
    sort_order: int = 0


class ConfigBlockUpdate(BaseModel):
    scope: str | None = None
    header: str | None = None
    parent_id: int | None = None
    belongs_to_file: str | None = None
    sort_order: int | None = None


class ConfigBlockOut(BaseModel):
    id: int
    nginx_config_id: int
    parent_id: int | None
    scope: str
    header: str
    belongs_to_file: str | None
    sort_order: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ---- config_options ----

class ConfigOptionCreate(BaseModel):
    block_id: int
    directive: str
    value: str = ""
    row_type: str = "kv"
    is_free_text: bool = False
    sort_order: int = 0


class ConfigOptionUpdate(BaseModel):
    directive: str | None = None
    value: str | None = None
    row_type: str | None = None
    is_free_text: bool | None = None
    sort_order: int | None = None


class ConfigOptionOut(BaseModel):
    id: int
    block_id: int
    directive: str
    value: str
    row_type: str
    is_free_text: bool
    sort_order: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class OptionReorderRequest(BaseModel):
    block_id: int
    ids: list[int]


# ---- 导出中心 ----

class UpstreamException(BaseModel):
    """例外覆盖：grp=<CTX>:<组名>，每条例外只针对单个 upstream 组。"""

    grp: str
    ips: str


class ExportRequest(BaseModel):
    ssl_enabled: bool = True
    server_name_domain: str | None = None
    upstream_default_ips: str | None = None
    upstream_exceptions: list[UpstreamException] = []
    context: str = "conf"
