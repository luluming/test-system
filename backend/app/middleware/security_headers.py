"""安全响应头中间件：为所有响应注入安全头（CSP 等）。"""
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


_DEFAULT_HEADERS = {
    # 场景：本应用渲染用户可控 nginx 配置文本 → 禁 unsafe-inline 脚本、限 frame 嵌套
    "content-security-policy": "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers.update(_DEFAULT_HEADERS)
        return response