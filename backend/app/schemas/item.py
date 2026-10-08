"""物品相关 Pydantic 模型（请求/响应）。"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class ItemCreate(BaseModel):
    """创建物品请求。"""

    title: str
    description: str | None = None


class ItemUpdate(BaseModel):
    """更新物品请求（字段可选，仅更新传入项）。"""

    title: str | None = None
    description: str | None = None


class ItemOut(BaseModel):
    """物品响应。"""

    id: int
    title: str
    description: str | None
    owner_id: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
