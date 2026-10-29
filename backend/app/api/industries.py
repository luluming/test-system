"""行业基础信息 CRUD + 模板克隆端点（均需登录）。"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.core.security import get_current_user
from app.models.industry import Industry
from app.models.nginx import (
    BizPort,
    ConfigBlock,
    ConfigOption,
    DomainMapping,
    ForwardPort,
    NginxConfig,
    NginxConfigVersion,
    NginxMirrorPair,
    NginxPushTask,
    NginxPushToken,
    Upstream,
    UpstreamServer,
)
from app.models.user import User
from app.models.yaml import (
    YamlConfig,
    YamlConfigVersion,
    YamlPushTask,
    YamlPushToken,
)
from app.schemas.industry import (
    CloneIndustryRequest,
    IndustryCreate,
    IndustryOut,
    IndustryUpdate,
)
from app.services.industry_clone import clone_industry

logger = logging.getLogger("industries")

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
    scope_filter: str | None = Query(None, pattern=r"^(both|nginx|yml)$"),
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[Industry]:
    stmt = select(Industry)
    if scope_filter == "nginx":
        stmt = stmt.where(Industry.scope.in_(["both", "nginx"]))
    elif scope_filter == "yml":
        stmt = stmt.where(Industry.scope.in_(["both", "yml"]))
    stmt = stmt.order_by(Industry.id)
    return list(db.execute(stmt).scalars().all())


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


def _delete_nginx_data(db: Session, industry_id: int) -> None:
    """删除行业下全部 Nginx 族数据（配置块树 + 版本/推送/镜像对 + Upstream + 映射/端口）。

    所有 SQL 以 db.execute(Table.__table__.delete().where(...)) 执行（SA 2.0 风格）。
    """
    nginx_cfg_ids = select(NginxConfig.id).where(NginxConfig.industry_id == industry_id)
    block_ids = select(ConfigBlock.id).where(ConfigBlock.nginx_config_id.in_(nginx_cfg_ids))
    upstream_ids = select(Upstream.id).where(Upstream.industry_id == industry_id)

    def _del(table, where):
        db.execute(table.__table__.delete().where(where))

    # 最深子表（依赖 nginx_config_id / block_id）
    _del(ConfigOption, ConfigOption.block_id.in_(block_ids))
    _del(ConfigBlock, ConfigBlock.nginx_config_id.in_(nginx_cfg_ids))
    for model in (NginxConfigVersion, NginxPushTask, NginxPushToken, NginxMirrorPair):
        _del(model, getattr(model, "nginx_config_id").in_(nginx_cfg_ids))

    # Upstream 链（ForwardPort 同时依赖 upstream_id 与 industry_id，须先删）
    _del(UpstreamServer, UpstreamServer.upstream_id.in_(upstream_ids))
    _del(ForwardPort, ForwardPort.industry_id == industry_id)
    _del(Upstream, Upstream.industry_id == industry_id)

    # 直接依赖 industry_id 的
    _del(DomainMapping, DomainMapping.industry_id == industry_id)
    _del(BizPort, BizPort.industry_id == industry_id)
    _del(NginxConfig, NginxConfig.industry_id == industry_id)
    db.flush()


def _delete_yaml_data(db: Session, industry_id: int) -> None:
    """删除行业下全部 YAML 族数据（推送令牌 → 推送任务 → 版本快照 → 配置本体）。"""
    yaml_cfg_ids = select(YamlConfig.id).where(YamlConfig.industry_id == industry_id)

    def _del(table, where):
        db.execute(table.__table__.delete().where(where))

    for model in (YamlPushToken, YamlPushTask, YamlConfigVersion):
        _del(model, getattr(model, "yaml_config_id").in_(yaml_cfg_ids))
    _del(YamlConfig, YamlConfig.industry_id == industry_id)
    db.flush()


def _delete_industry_row(db: Session, row: Industry) -> None:
    """彻底删除行业记录：先断开克隆溯源引用，避免 self-FK 约束报错。"""
    db.execute(
        update(Industry)
        .where(Industry.cloned_from_id == row.id)
        .values(cloned_from_id=None)
    )
    db.delete(row)
    db.commit()


@router.delete("/{industry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_industry(
    industry_id: int,
    delete_scope: str = Query(
        ...,
        pattern=r"^(nginx|yml)$",
        description="nginx/yml：只删当前菜单所属模块的数据，绝不跨模块删除",
    ),
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> None:
    """删除行业在单个模块下的数据（模板行业一律禁止）。

    两个菜单完全独立：本接口只处理 ``delete_scope`` 指定的模块，另一模块的
    数据与列表绝不会被影响。

    - nginx：只清 Nginx 族；行业若同时归属 YML 则保留并收敛为 scope=yml，否则整条删除
    - yml：只清 YAML 族；行业若同时归属 Nginx 则保留并收敛为 scope=nginx，否则整条删除
    """
    row = _get_industry(db, industry_id)
    if row.is_template:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="这是模板源行业，禁止删除。如需移除模板属性请先编辑该行业",
        )

    if delete_scope == "nginx":
        _delete_nginx_data(db, industry_id)
        kept_scope = "yml"
    else:
        _delete_yaml_data(db, industry_id)
        kept_scope = "nginx"

    if row.scope in ("both", kept_scope):
        # 行业仍归属另一侧菜单 → 保留行业记录，归属收敛为单一模块
        row.scope = kept_scope
        db.commit()
        logger.info(
            "已清空行业 %s 的 %s 数据，行业保留并归入 %s 菜单",
            industry_id, delete_scope, kept_scope,
        )
        return

    # 行业只属于当前模块 → 数据删完后行业本身也无意义，整条移除
    _delete_industry_row(db, row)
    logger.info("已删除行业 id=%s name=%s（仅归属 %s，无其它模块数据）",
                industry_id, row.name, delete_scope)


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