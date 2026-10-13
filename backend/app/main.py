"""FastAPI 应用入口：创建实例、配置 CORS、注册路由与生命周期。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.items import router as items_router
from app.api.industries import router as industries_router
from app.api.nginx import (
    biz_router,
    forward_router,
    mapping_router,
    nginx_router,
)
from app.config import settings
from app.core.logging import setup_logging
from app.seed import init_db


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """应用生命周期钩子：启动时初始化日志、数据库与演示数据。"""
    setup_logging()
    init_db()
    yield


app = FastAPI(
    title="Test System API",
    description="FastAPI 演示后端：认证（JWT）+ 物品 CRUD",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS：仅允许前端开发服务器访问，并支持携带凭证（Authorization 头等）
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册业务路由
app.include_router(auth_router)
app.include_router(items_router)
app.include_router(industries_router)
app.include_router(nginx_router)
app.include_router(mapping_router)
app.include_router(forward_router)
app.include_router(biz_router)
