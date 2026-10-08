"""验证码模块：生成 SVG 验证码并进行校验。

验证码为 4 个随机字符（去除易混淆的 0/O/1/l/I），以内存字典存储并携带
过期时间戳，有效期 300 秒。图片使用 SVG 字符串绘制（不依赖 Pillow），
包含随机旋转/偏移的字符、干扰线与噪点，base64 编码后作为 data URI 返回。
"""

import base64
import random
import string
import time

# 去除易混淆字符（0/O/1/l/I）后的候选字符集
_CAPTCHA_CHARS = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ"
_CAPTCHA_LENGTH = 4
_CAPTCHA_TTL_SECONDS = 300  # 验证码有效期：300 秒
_IMAGE_WIDTH = 120
_IMAGE_HEIGHT = 40

# 内存存储：captcha_id -> (验证码明文, 过期时间戳)
_captcha_store: dict[str, tuple[str, float]] = {}


def _generate_id() -> str:
    """生成随机 captcha_id（32 位字母数字）。"""
    return "".join(random.choices(string.ascii_letters + string.digits, k=32))


def _build_svg(code: str) -> str:
    """绘制验证码 SVG：随机旋转/偏移的字符 + 干扰线 + 噪点。"""
    stroke_colors = ["#9db2c7", "#d1d5db", "#6b7280", "#4f6f8f"]
    text_colors = ["#1e1e1e", "#3d5a75", "#4f6f8f", "#6b7280"]
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_IMAGE_WIDTH}" '
        f'height="{_IMAGE_HEIGHT}" viewBox="0 0 {_IMAGE_WIDTH} {_IMAGE_HEIGHT}">',
        f'<rect width="{_IMAGE_WIDTH}" height="{_IMAGE_HEIGHT}" rx="6" fill="#f1f3f5"/>',
    ]
    # 干扰线：2~3 条随机斜线
    for _ in range(random.randint(2, 3)):
        parts.append(
            f'<line x1="{random.randint(0, _IMAGE_WIDTH // 2)}" '
            f'y1="{random.randint(0, _IMAGE_HEIGHT)}" '
            f'x2="{random.randint(_IMAGE_WIDTH // 2, _IMAGE_WIDTH)}" '
            f'y2="{random.randint(0, _IMAGE_HEIGHT)}" '
            f'stroke="{random.choice(stroke_colors)}" stroke-width="1"/>'
        )
    # 噪点：15 个随机小圆点
    for _ in range(15):
        parts.append(
            f'<circle cx="{random.randint(0, _IMAGE_WIDTH)}" '
            f'cy="{random.randint(0, _IMAGE_HEIGHT)}" '
            f'r="{random.choice([1, 1.5])}" fill="{random.choice(stroke_colors)}" '
            f'opacity="0.5"/>'
        )
    # 字符：随机旋转与水平偏移
    slot = _IMAGE_WIDTH / (_CAPTCHA_LENGTH + 1)
    for i, ch in enumerate(code):
        x = round(slot * (i + 1) + random.uniform(-3, 3), 1)
        y = random.randint(25, 32)
        angle = random.randint(-25, 25)
        parts.append(
            f'<text x="{x}" y="{y}" font-family="monospace" font-size="22" '
            f'font-weight="bold" fill="{random.choice(text_colors)}" '
            f'transform="rotate({angle} {x} {y})">{ch}</text>'
        )
    parts.append("</svg>")
    return "".join(parts)


def _cleanup_expired() -> None:
    """清理已过期的验证码条目，避免内存无限增长。"""
    now = time.time()
    expired = [
        captcha_id
        for captcha_id, (_, expires_at) in _captcha_store.items()
        if expires_at <= now
    ]
    for captcha_id in expired:
        _captcha_store.pop(captcha_id, None)


def generate_captcha() -> dict:
    """生成一个验证码。

    Returns:
        字典，键为 captcha_id（校验用唯一标识）、captcha_image（SVG data URI）、
        code（验证码明文，仅供内部与测试使用，严禁通过 HTTP 接口对外暴露）。
    """
    _cleanup_expired()
    code = "".join(random.choices(_CAPTCHA_CHARS, k=_CAPTCHA_LENGTH))
    captcha_id = _generate_id()
    svg_b64 = base64.b64encode(_build_svg(code).encode("utf-8")).decode("utf-8")
    _captcha_store[captcha_id] = (code, time.time() + _CAPTCHA_TTL_SECONDS)
    return {
        "captcha_id": captcha_id,
        "captcha_image": f"data:image/svg+xml;base64,{svg_b64}",
        "code": code,
    }


def verify_captcha(captcha_id: str, code: str) -> bool:
    """校验验证码：大小写不敏感，校验后立即删除（一次性使用）。

    Args:
        captcha_id: 生成验证码时返回的标识。
        code: 用户输入的验证码。

    Returns:
        验证码存在、未过期且内容匹配返回 True；过期/不存在/错误返回 False。
    """
    item = _captcha_store.pop(captcha_id, None)
    if item is None:
        return False
    stored_code, expires_at = item
    if time.time() > expires_at:
        return False
    return stored_code.lower() == code.strip().lower()
