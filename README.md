# test-system

前后端分离的业务系统骨架，内置安全基线（敏感配置走 `.env` 零明文、密码哈希存储、SQL 全参数化零拼接）。

## 技术栈

| 端 | 技术 |
|----|------|
| 后端 | Python 3.10+ / FastAPI / SQLAlchemy / SQLite（可迁 MySQL/PostgreSQL） |
| 前端 | React 18 / Vite / Ant Design 5 |
| 接口 | REST API（`/api/*`），JWT Bearer 鉴权 |

## 目录结构

```
test-system/
├── backend/          # 后端（FastAPI）
│   ├── app/
│   │   ├── api/      # 接口层（auth / items 路由）
│   │   ├── core/     # 安全（JWT/密码哈希/注入断言）、日志脱敏
│   │   ├── models/   # ORM 模型
│   │   ├── schemas/  # Pydantic 接口契约（DTO）
│   │   ├── config.py # .env 配置（SECRET_KEY 缺失拒绝启动）
│   │   └── database.py
│   ├── tests/        # pytest 用例
│   └── requirements.txt
└── frontend/         # 前端（React + Vite + AntD）
    └── src/
        ├── api/      # axios 封装（自动带 token，401 跳登录）
        ├── pages/    # 登录 / 注册 / 主页
        └── store/    # token 本地存储
```

## 快速启动

### 1. 后端

```bash
cd backend
pip install -r requirements.txt
# 准备环境变量（复制模板并修改 SECRET_KEY）
copy .env.example .env        # Windows
cp .env.example .env          # Linux/macOS
uvicorn app.main:app --reload --port 8001
```

- OpenAPI 文档：http://localhost:8001/docs
- 演示账号（由 seed 自动创建）：`admin / admin123`
- 运行测试：`pytest tests -q`

### 2. 前端

```bash
cd frontend
npm install
npm run dev
```

- 访问 http://localhost:5173 ，注册账号或使用演示账号登录
- `/api` 请求由 Vite 代理转发至 http://localhost:8001

## 安全规范（新增代码必须遵守）

1. **敏感配置零明文**：`SECRET_KEY` 等一律放 `.env`，`.env` 不入库；禁止在代码中硬编码密钥/密码。
2. **SQL 零拼接**：数据库访问必须走 SQLAlchemy ORM / 参数化查询，禁止 f-string 或 `+` 拼接 SQL（参考 `app/core/security.py::assert_no_sql_injection` 审计断言）。
3. **密码安全**：用户密码使用 bcrypt 哈希存储，接口响应不回传哈希/明文。
4. **日志脱敏**：日志输出前调用 `redact_sensitive()`（`app/core/logging.py`）过滤密钥与口令。
