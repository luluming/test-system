"""YAML 配置管理 Pydantic 模型。

沿用 schemas/nginx 的 Create/Out 三件套 + ConfigDict(from_attributes=True) 约定。
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class YamlConfigCreate(BaseModel):
    """新建 YAML 配置：归属行业 + 文件名 + 可选初始内容。

    project_id 可选：指定则挂到该项目（需该项目可编辑权限，且行业须一致）；
    不指定则落到行业默认项目（兼容旧行为）。
    """

    industry_id: int
    name: str = Field(min_length=1, max_length=100)
    group: str = Field(default="DEFAULT_GROUP", max_length=100)
    description: str | None = None
    content: str = ""
    project_id: int | None = None


class YamlConfigSave(BaseModel):
    """全文编辑保存：乐观锁（expected_version）+ 可选备注 + 语法非法时强制存草稿。"""

    content: str
    expected_version: int = Field(ge=1)
    note: str | None = None
    # 语法校验失败时是否仍以原文保存为草稿（标记为语法异常，不参与 apply）
    force_draft: bool = False


class YamlConfigOut(BaseModel):
    id: int
    industry_id: int
    name: str
    group: str = "DEFAULT_GROUP"
    description: str | None
    content_text: str
    status: str  # enabled | disabled | invalid
    version: int
    created_by: str | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class YamlConfigListItem(BaseModel):
    """列表项：不含全文（轻量），附带解析统计信息。"""

    id: int
    industry_id: int
    name: str
    group: str = "DEFAULT_GROUP"
    description: str | None
    status: str
    version: int
    updated_at: datetime
    valid: bool = False
    line_count: int = 0
    node_count: int = 0
    top_keys: list[str] = []

    model_config = ConfigDict(from_attributes=True)


class NacosViewRow(BaseModel):
    """Nacos 控制台风格配置列表行：命名空间（项目）→ group → dataId。"""

    id: int
    project_id: int
    project_name: str
    industry_id: int
    data_id: str
    group: str
    format: str  # yaml | properties | json | text
    status: str
    version: int
    updated_at: datetime
    description: str | None = None


class ImportZipResult(BaseModel):
    """Nacos ZIP 批量导入结果报告。"""

    total: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    projects_created: int = 0
    mode: str = "tenant"  # tenant：三层结构按命名空间建项目 | group：两层结构导入指定项目
    failed: list[dict] = []


class YamlConfigVersionOut(BaseModel):
    id: int
    yaml_config_id: int
    version: int
    content: str
    note: str
    created_by: str | None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class YamlRollbackRequest(BaseModel):
    """回滚到指定历史版本（生成新版本而非覆盖历史）。"""

    version: int = Field(ge=1)
    note: str | None = None


class YamlPushApplyRequest(BaseModel):
    """确认提交：可选备注（默认为空）。"""

    note: str | None = None
