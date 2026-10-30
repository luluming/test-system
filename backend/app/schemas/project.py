"""项目 / 共享授权 / 环境变量 Pydantic 模型（PRD FR-02 / FR-03 / FR-05）。"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ProjectCreate(BaseModel):
    """新建项目：归属行业 + 名称 + 标识 + 可选备注。"""

    industry_id: int
    name: str = Field(min_length=1, max_length=50)
    code: str = Field(min_length=1, max_length=50)
    remark: str | None = Field(default=None, max_length=255)


class ProjectUpdate(BaseModel):
    """更新项目：仅名称与备注可改（归属行业/创建人不可变更）。"""

    name: str | None = Field(default=None, min_length=1, max_length=50)
    remark: str | None = Field(default=None, max_length=255)


class ProjectOut(BaseModel):
    """项目响应：附带当前用户有效权限、负责人名与各配置计数。"""

    id: int
    industry_id: int
    industry_name: str = ""
    name: str
    code: str
    owner_id: int
    owner_name: str = ""
    remark: str | None
    share_all: bool
    my_perm: str = "none"
    nginx_count: int = 0
    yml_count: int = 0
    env_count: int = 0
    grant_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ShareGrantIn(BaseModel):
    """单条指定人授权（perm 仅 view | edit）。"""

    user_id: int
    perm: str = Field(pattern="^(view|edit)$")


class ShareUpdate(BaseModel):
    """共享设置全量替换：全员开关 + 指定人授权清单。"""

    share_all: bool = False
    grants: list[ShareGrantIn] = []


class ShareGrantOut(BaseModel):
    user_id: int
    username: str
    email: str
    perm: str


class ShareOut(BaseModel):
    share_all: bool
    grants: list[ShareGrantOut]


class EnvVarCreate(BaseModel):
    """新建环境变量：键项目内唯一，值支持多行。"""

    key: str = Field(min_length=1, max_length=128)
    value: str = Field(default="", max_length=4096)
    remark: str | None = Field(default=None, max_length=255)


class EnvVarUpdate(BaseModel):
    """更新环境变量：键不可改，仅值与备注。"""

    value: str | None = Field(default=None, max_length=4096)
    remark: str | None = Field(default=None, max_length=255)


class EnvVarOut(BaseModel):
    id: int
    project_id: int
    key: str
    value: str
    remark: str | None
    updated_by: str | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
