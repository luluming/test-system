"""本地 nginx 配置推送 CLI（两阶段：预览 → 确认提交）。

用法示例：
    python tools/nginx_push.py --industry "业务中心" --config "businesscenter_nginx_CD_master.conf" --file ./master.conf
    # 预览差异无误后追加 --apply 正式提交：
    python tools/nginx_push.py --industry "业务中心" --config "businesscenter_nginx_CD_master.conf" --file ./master.conf --apply

依赖：Python 3 标准库（urllib），无需第三方库。
认证：--token 参数或环境变量 NGINX_PUSH_TOKEN（Bearer JWT）。
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:8001/api"

_ACTION_CN = {"replace": "替换", "new": "新建", "none": "无变化", "keep": "系统保留"}


def _call(base: str, token: str, method: str, path: str, data=None, headers=None, timeout: int = 30):
    url = base.rstrip("/") + path
    h = {"Authorization": f"Bearer {token}"} if token else {}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"detail": raw}
        return exc.code, parsed


def _multipart(field: str, filename: str, content: bytes, boundary: str) -> bytes:
    parts = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode(),
        b"Content-Type: text/plain\r\n\r\n",
        content,
        b"\r\n",
    ]
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts)


def _find_industry(base, token, name):
    code, data = _call(base, token, "GET", "/industries")
    if code != 200 or not isinstance(data, list):
        sys.exit(f"[错误] 获取行业列表失败（HTTP {code}）：{data}")
    for row in data:
        if row.get("name") == name:
            return row["id"]
    sys.exit(f"[错误] 未找到行业「{name}」，可用行业：{', '.join(str(r.get('name')) for r in data)}")


def _find_config(base, token, industry_id, name):
    code, data = _call(base, token, "GET", f"/nginx-configs?industry_id={industry_id}")
    if code != 200 or not isinstance(data, list):
        sys.exit(f"[错误] 获取配置文件列表失败（HTTP {code}）：{data}")
    for row in data:
        if row.get("name") == name:
            return row["id"]
    sys.exit(f"[错误] 该行业下未找到配置文件「{name}」，可用：{', '.join(str(r.get('name')) for r in data)}")


def _print_diff(diff, counts):
    rows = sorted(diff, key=lambda e: {"replace": 0, "new": 1, "none": 2, "keep": 3}[e["action"]])
    print("\n差异清单：")
    if not rows:
        print("  （空）")
    for e in rows:
        act = _ACTION_CN.get(e["action"], e["action"])
        print(f"  [{act:<4}] {e['display']}")
    print(
        f"\n汇总：替换 {counts.get('replace', 0)} 个 / 新建 {counts.get('new', 0)} 个 / "
        f"无变化 {counts.get('none', 0)} 个 / 系统保留 {counts.get('keep', 0)} 个"
    )


def main():
    parser = argparse.ArgumentParser(description="本地 nginx 配置推送（预览/提交到系统）")
    parser.add_argument("--industry", required=True, help="行业名称（按名称解析行业）")
    parser.add_argument("--config", required=True, help="系统内的配置文件名称（如 businesscenter_nginx_CD_master.conf）")
    parser.add_argument("--file", required=True, help="本地 nginx 配置文件路径")
    parser.add_argument("--apply", action="store_true", help="预览后直接确认提交（默认仅预览）")
    parser.add_argument("--base-url", default=os.environ.get("NGINX_PUSH_BASE", DEFAULT_BASE), help=f"API 基础地址（默认 {DEFAULT_BASE}）")
    parser.add_argument("--token", default=os.environ.get("NGINX_PUSH_TOKEN", ""), help="JWT（默认取环境变量 NGINX_PUSH_TOKEN）")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP 超时秒数")
    args = parser.parse_args()

    if not args.token:
        sys.exit("[错误] 缺少 --token 或环境变量 NGINX_PUSH_TOKEN")

    with open(args.file, "rb") as fh:
        content = fh.read()

    industry_id = _find_industry(args.base_url, args.token, args.industry)
    config_id = _find_config(args.base_url, args.token, industry_id, args.config)
    print(f"目标：行业「{args.industry}」(id={industry_id}) → 配置「{args.config}」(id={config_id})")

    boundary = f"----nginxpush{os.urandom(8).hex()}"
    body = _multipart("file", os.path.basename(args.file), content, boundary)
    code, resp = _call(
        args.base_url, args.token, "POST",
        f"/nginx-configs/{config_id}/push/preview",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=args.timeout,
    )
    if code != 200:
        errors = resp.get("detail", {}).get("errors") if isinstance(resp.get("detail"), dict) else None
        if errors:
            print("[解析失败] 文件无法结构化入库，全部拒绝：")
            for e in errors:
                print(f"  第 {e.get('line')} 行：{e.get('reason')}")
        else:
            print(f"[错误] 预览失败（HTTP {code}）：{resp}")
        sys.exit(1)

    task_id = resp.get("task_id")
    _print_diff(resp.get("diff", []), resp.get("counts", {}))
    print(f"\n预览任务已创建：task_id={task_id}（状态 pending，原文已留档）")

    if not args.apply:
        print("如确认无误，请追加 --apply 执行提交。")
        return

    code, resp = _call(
        args.base_url, args.token, "POST",
        f"/nginx-configs/{config_id}/push/{task_id}/apply",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        timeout=args.timeout,
    )
    if code != 200:
        detail = resp.get("detail") if isinstance(resp.get("detail"), str) else resp
        print(f"[错误] 提交失败（HTTP {code}）：{detail}")
        sys.exit(1)
    print(f"\n提交成功：{resp.get('message', '')}")
    for item in resp.get("applied", []):
        print(f"  ✔ {item['display']}")
    for m in resp.get("mirrored", []):
        print(f"  ↺ 镜像同步：{m['dst']} ← {m['src']}")


if __name__ == "__main__":
    main()
