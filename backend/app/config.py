"""应用配置模块。

使用 pydantic-settings 从 .env 文件读取配置（含 SECRET_KEY 等敏感项）。
SECRET_KEY 缺失时不回退默认值，直接抛出 RuntimeError 拒绝启动。
"""

from pydantic import ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置类。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # JWT 安全配置（SECRET_KEY 必须由 .env 提供，无默认值）
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30

    # 数据库连接（默认使用 backend 目录下的 SQLite 文件）
    DATABASE_URL: str = "sqlite:///./test_system.db"

    # CORS：允许的前端开发服务器来源
    CORS_ORIGINS: list[str] = ["http://localhost:5173"]


def _load_settings() -> Settings:
    """加载配置；SECRET_KEY 缺失时抛出 RuntimeError 拒绝启动。"""
    try:
        return Settings()
    except ValidationError as exc:
        raise RuntimeError(
            "缺少 SECRET_KEY 配置，请检查 backend/.env 文件（禁止使用默认密钥启动）"
        ) from exc


settings = _load_settings()
