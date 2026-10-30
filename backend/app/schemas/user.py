"""用户相关 Pydantic 模型（请求/响应）。"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class UserBase(BaseModel):
    """用户公共字段。"""

    username: str
    email: str


class UserCreate(UserBase):
    """注册请求：携带明文密码（仅用于 bcrypt 哈希，不落库、不返回）。"""

    password: str


class UserLogin(BaseModel):
    """登录请求：携带验证码字段，先校验验证码再校验密码。"""

    username: str
    password: str
    captcha_id: str
    captcha_code: str


class ResetPasswordRequest(BaseModel):
    """重置密码请求（无需登录）：需要用户名、邮箱与验证码。"""

    username: str
    email: str
    captcha_id: str
    captcha_code: str
    new_password: str


class ChangePasswordRequest(BaseModel):
    """修改密码请求（需登录）：校验原密码后更新为新密码。"""

    old_password: str
    new_password: str


class UserOut(UserBase):
    """用户响应：不含 hashed_password / password，杜绝敏感字段泄漏。"""

    id: int
    role: str
    is_active: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AccountCreate(BaseModel):
    """管理员创建账号：角色固定为普通用户。"""

    username: str
    email: str
    password: str


class AccountOut(BaseModel):
    """账号管理列表项：含角色、状态与名下项目数。"""

    id: int
    username: str
    email: str
    role: str
    is_active: bool
    project_count: int = 0
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AccountStatusUpdate(BaseModel):
    """启用/停用账号。"""

    is_active: bool


class AccountPasswordReset(BaseModel):
    """管理员重置账号密码。"""

    new_password: str


class AccountSearchItem(BaseModel):
    """账号搜索（共享授权选人用）：模糊匹配用户名/邮箱。"""

    id: int
    username: str
    email: str
    is_active: bool

    model_config = ConfigDict(from_attributes=True)


class Token(BaseModel):
    """登录成功返回的 JWT 令牌。"""

    access_token: str
    token_type: str = "bearer"
