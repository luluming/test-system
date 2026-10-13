"""行业基础信息 CRUD + 模板克隆端点（均需登录）。"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.security import get_current_user
from app.models.industry import Industry
from app.models.user import User
from app.schemas.industry import (
    CloneIndustryRequest,
    IndustryCreate,
    IndustryOut,
    IndustryUpdate,
)
from app.services.industry_clone import clone_industry

router = APIRouter(prefix="/api/industries", tags=["行业"])


def _get_industry(db: Session, industry_id: int) -> Industry:
    row = db.execute(
        select(Industry).where(Industry.id == industry_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="行业不存在")
    return row


@router.get("", response_model=list[IndustryOut])
def list_industries(
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[Industry]:
    return list(db.execute(select(Industry).order_by(Industry.id)).scalars().all())


@router.post("", response_model=IndustryOut, status_code=status.HTTP_201_CREATED)
def create_industry(
    payload: IndustryCreate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Industry:
    row = Industry(**payload.model_dump())
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="行业 code 已存在")
    db.refresh(row)
    return row


@router.get("/{industry_id}", response_model=IndustryOut)
def get_industry(
    industry_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Industry:
    return _get_industry(db, industry_id)


@router.put("/{industry_id}", response_model=IndustryOut)
def update_industry(
    industry_id: int,
    payload: IndustryUpdate,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Industry:
    row = _get_industry(db, industry_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{industry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_industry(
    industry_id: int,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    db.delete(_get_industry(db, industry_id))
    db.commit()


@router.post("/clone", response_model=IndustryOut, status_code=status.HTTP_201_CREATED)
def create_clone(
    payload: CloneIndustryRequest,
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> Industry:
    try:
        return clone_industry(db, payload=payload)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="源行业不存在")
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="该名称已存在")