"""行业相关 Pydantic 模型（请求/响应）。"""
from datetime import datetime
import re

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 行业 code 白名单：字母、数字、下划线、连字符；校验时统一转小写
_CODE_RE = re.compile(r"^[A-Za-z0-9_-]+$")


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
            raise ValueError("行业 code 仅允许字母、数字、下划线与连字符")
        return v.lower()


class CloneIndustryRequest(BaseModel):
    """从模板行业克隆请求；source_industry_id 可选，不填则创建空行业。

    clone_scope 决定从源行业拷贝哪些配置：
      both  — 同时克隆 Nginx + YAML（默认，保持兼容）
      nginx — 仅克隆 Nginx 配置块树/Upstream/映射/端口等行业内运维配置
      yml   — 仅克隆 YAML 配置及其版本快照
    """

    source_industry_id: int | None = None
    name: str = Field(min_length=1, max_length=50)
    owner: str | None = Field(default=None, max_length=50)
    code: str | None = Field(default=None, max_length=50)
    clone_scope: str = Field(default="both", pattern=r"^(both|nginx|yml)$")

    @field_validator("code")
    @classmethod
    def _code_must_be_slug(cls, v: str | None) -> str | None:
        if v is not None and not _CODE_RE.match(v):
            raise ValueError("行业 code 仅允许字母、数字、下划线与连字符")
        return v.lower() if v is not None else v


class IndustryUpdate(BaseModel):
    """更新行业请求（字段可选）。"""

    name: str | None = Field(default=None, min_length=1, max_length=50)
    owner: str | None = Field(default=None, max_length=50)
    remark: str | None = Field(default=None, max_length=255)
    is_template: bool | None = None
    # 归属菜单：both | nginx | yml，用于在 Nginx / YML 行业管理之间迁移行业
    scope: str | None = Field(default=None, pattern=r"^(both|nginx|yml)$")

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
    scope: str
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)