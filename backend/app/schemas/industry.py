"""行业相关 Pydantic 模型（请求/响应）。"""
from datetime import datetime
import re

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 行业 code 白名单：小写字母、数字、下划线，长度 1-50
_CODE_RE = re.compile(r"^[a-z0-9_]+$")


class IndustryCreate(BaseModel):
    """新建行业请求。"""

    code: str = Field(min_length=1, max_length=50)
    name: str = Field(min_length=1, max_length=50)
    owner: str | None = Field(default=None, max_length=50)
    remark: str | None = Field(default=None, max_length=255)
    is_template: bool = False

    @field_validator("code")
    @classmethod
    def _code_must_be_slug(cls, v: str) -> str:
        if not _CODE_RE.match(v):
            raise ValueError("行业 code 仅允许小写字母、数字与下划线")
        return v


class IndustryUpdate(BaseModel):
    """更新行业请求（字段可选）。"""

    name: str | None = Field(default=None, min_length=1, max_length=50)
    owner: str | None = Field(default=None, max_length=50)
    remark: str | None = Field(default=None, max_length=255)
    is_template: bool | None = None

    @field_validator("name", "owner", mode="before")
    @classmethod
    def _strip_empty(cls, v):
        return v if v not in (None, "") else None


class IndustryOut(BaseModel):
    """行业响应。"""

    id: int
    code: str
    name: str
    owner: str | None
    remark: str | None
    is_template: bool
    cloned_from_id: int | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)