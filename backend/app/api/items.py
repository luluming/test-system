"""物品 CRUD 接口（均需登录）。"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.security import get_current_user
from app.models.item import Item
from app.models.user import User
from app.schemas.item import ItemCreate, ItemOut, ItemUpdate

router = APIRouter(prefix="/api/items", tags=["物品"])


@router.get("", response_model=list[ItemOut])
def list_items(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[Item]:
    """列出当前用户拥有的全部物品。"""
    items = db.execute(
        select(Item).where(Item.owner_id == current_user.id).order_by(Item.id)
    ).scalars().all()
    return list(items)


@router.post("", response_model=ItemOut, status_code=status.HTTP_201_CREATED)
def create_item(
    payload: ItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Item:
    """创建物品（归属当前用户）。"""
    item = Item(
        title=payload.title, description=payload.description, owner_id=current_user.id
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("/{item_id}", response_model=ItemOut)
def get_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Item:
    """按 ID 查询单个物品。"""
    return _get_owned_item(db, item_id, current_user.id)


@router.put("/{item_id}", response_model=ItemOut)
def update_item(
    item_id: int,
    payload: ItemUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Item:
    """更新物品（仅更新传入字段）。"""
    item = _get_owned_item(db, item_id, current_user.id)
    if payload.title is not None:
        item.title = payload.title
    if payload.description is not None:
        item.description = payload.description
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    """删除物品。"""
    item = _get_owned_item(db, item_id, current_user.id)
    db.delete(item)
    db.commit()


def _get_owned_item(db: Session, item_id: int, owner_id: int) -> Item:
    """按 ID + 归属查询物品；不存在或不属于当前用户时返回 404。"""
    item = db.execute(
        select(Item).where(Item.id == item_id, Item.owner_id == owner_id)
    ).scalar_one_or_none()
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="物品不存在")
    return item
