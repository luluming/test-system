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
