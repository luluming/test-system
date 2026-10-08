"""日志配置模块。

使用标准库 logging；提供 redact_sensitive 对日志中的
SECRET_KEY 值、password=xxx 等敏感信息统一脱敏。
"""

import logging
import re

from app.config import settings

# 敏感参数模式：password=xxx / password: xxx / password:"xxx"
_SENSITIVE_PATTERNS = [
    re.compile(r"(password\s*[=:]\s*)[\w!@#$%^&*.-]+", re.IGNORECASE),
    re.compile(r'password[\'"]?\s*[:=]\s*[\'"][^\'"]*[\'"]', re.IGNORECASE),
]


def redact_sensitive(message: str) -> str:
    """将消息中的 SECRET_KEY 值、password 参数值替换为 ***。"""
    if settings.SECRET_KEY:
        message = message.replace(settings.SECRET_KEY, "***")
    for pattern in _SENSITIVE_PATTERNS:
        message = pattern.sub(r"\1***", message)
    return message


class RedactingFilter(logging.Filter):
    """日志过滤器：记录写出前对消息与参数统一脱敏。"""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact_sensitive(str(record.msg))
        if record.args:
            record.args = tuple(
                redact_sensitive(str(arg)) if isinstance(arg, str) else arg
                for arg in record.args
            )
        return True


def setup_logging(level: int = logging.INFO) -> None:
    """配置根日志器：控制台输出 + 敏感信息脱敏过滤。"""
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s | %(levelname)-8s | %(name)s:%(lineno)d | %(message)s"
        )
    )
    handler.addFilter(RedactingFilter())
    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(handler)


logger = logging.getLogger("app")
