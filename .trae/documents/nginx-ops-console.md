# Nginx / 端口管理控制台实现方案

## Context（背景）

现有 `test-system` 是一个前后端分离的业务系统骨架（FastAPI + React/AntD），当前仅有一个 `items` CRUD 演示功能。用户需要新增一套**运维管理控制台**，用于管理：

1. nginx 配置（增删改查）
2. 域名映射关系（域名 → 转发目标）
3. 转发端口管理
4. 业务启动端口 + **是否开放到公网**的开关

已确认的需求方向：**完整前后端持久化**（后端 ORM + REST + SQLite）、**仅配置管理界面**（不真实操作本机 nginx/防火墙）、**单页面多 Tab** 组织。

本方案完全复用项目现有模式：`items.py`（CRUD 模板）、`Dashboard.jsx`（AntD 管理页模板）、`models/__init__.py`（建表注册）、受保护路由 + JWT 认证、`client.js` axios 封装。

## 数据模型（4 张表，均全局配置、无需 owner 隔离）

统一字段约定：`created_at` 用 `DateTime, server_default=func.now()`，与 [Item](c:\Users\Administrator\Documents\trae_projects\test-system\backend\app\models\item.py#L11-L24) 一致。

| 表 | 字段 |
|----|------|
| `nginx_configs` | id, name(String 唯一名), domain(String 可空), config_text(Text), enabled(Bool 默认 True), created_at |
| `domain_mappings` | id, domain(String 唯一), forward_tos(String 如 "127.0.0.1:8001"), protocol(String http/https), description(String 备注/服务名), enabled(Bool), created_at |
| `forward_ports` | id, listen_port(Int 索引), upstream_target(String), service_name(String 可空), protocol(String tcp/http), enabled(Bool), created_at |
| `biz_ports` | id, service_name(String), port(Int 索引), protocol(String tcp/udp), **public_exposed(Bool 可空)**——是否开放公网, note(String 可空), created_at |

## 后端改动

**新增文件**
- `backend/app/models/nginx.py` —— 4 个 ORM 类（`NginxConfig`/`DomainMapping`/`ForwardPort`/`BizPort`），仿照 `models/item.py`。
- `backend/app/schemas/nginx.py` —— 每个资源一套 `XxxCreate`/`XxxUpdate`/`XxxOut`（Update 字段全部可选、Out 开启 `from_attributes=True`），仿照 `schemas/item.py`。
- `backend/app/api/nginx.py` —— 每个资源一个 `APIRouter`（prefix 分别 `/api/nginx-configs`、`/api/domain-mappings`、`/api/forward-ports`、`/api/biz-ports`，tags 中文），各实现完整 CRUD：`list/get/create/update/delete`。均依赖 `Depends(get_db)` 与 `Depends(get_current_user)` 鉴权，错误处理用 `HTTPException(404)`，与 `items.py` 完全一致。唯一差异：**不加 owner 过滤，数据为全局配置**。

**修改文件**
- `backend/app/models/__init__.py` —— 追加 import 上述 4 个模型并加入 `__all__`（这样 `seed.py` 的 `Base.metadata.create_all` 会自动建新表，SQLite 已有库只补建缺表，无需迁移工具）。
- `backend/app/main.py` —— import 并在 `include_router` 中注册 4 个 router。

## 前端改动

**新增文件**
- `frontend/src/api/nginx.js` —— 4 组 API 函数（`listXxx/createXxx/updateXxx/deleteXxx`），复用 `client`（`client.get/post/put/delete`），命名与 `api/auth.js` 一致。
- `frontend/src/pages/OpsConsole.jsx` —— 单页面多 Tab，含一个**可复用 CRUD 子组件** `ResourceTable`（参数化：资源名、列配置、表单字段配置），4 个 Tab 复用，避免重复 4 遍相同结构。Tab 结构：
  1. **nginx 配置** —— 表格列：名称/域名/是否启用(Switch)/正文预览；正文用 `Input.TextArea`（等宽字体）。
  2. **域名映射** —— 列：域名/转发目标/协议(Tag)/备注/启用。
  3. **转发端口** —— 列：监听端口/上游目标/服务名/协议/启用。
  4. **业务端口公网开关** —— 列：服务名/端口/协议/**是否开放公网（Switch + Tag 红绿）**/说明。
  交互沿用 `Dashboard.jsx`：`Table` + `Button` 新建 + `Modal`+`Form` 收集 + `Popconfirm` 删除 + `message` 反馈。**字面文案用实用型**（前端 skill 的 utility copy），如按钮直接写「新建配置」「保存」「删除」。

**修改文件**
- `frontend/src/App.jsx` —— 在受保护路由下新增 `<Route path="/ops" element={<OpsConsole />} />`，并在左侧 `Menu` `items` 加一项（图标用 `DeploymentUnitOutlined`/`GlobalOutlined`，label「运维配置」），仿照现有 `DashboardOutlined` 项。

## 验证

后端已跑在 127.0.0.1:8001、前端 5173（上个任务已启动，改动后 uvicorn `--reload` 自动重载、Vite 热更新）。

1. **后端**：用 `.env` 中 `SECRET_KEY` 走 `app.core.security` 生成一个 JWT（避免验证码阻碍登录），用该 Bearer token 对 `nginx-configs`/`domain-mappings`/`forward-ports`/`biz-ports` 四组 API 做一轮 `POST→GET→PUT→DELETE` 的 curl 冒烟验证；并确认 `/docs` 出现 4 组新端点。
2. **前端**：浏览器打开 `http://localhost:5173/ops`，若未登录会被 `ProtectedLayout` 重定向到 `/login`；用 `browser_evaluate` 向 `localStorage` 写入合法 token 后导航到 `/ops`，验证 4 个 Tab 均能加载、新建/删除可用、开关可切换。
3. **回归**：原有 `items` 与登录流程不受影响。

## 说明 / 不做的事
- 不做真实 nginx 写入与 firewall 操作（已确认仅配置界面）。
- 不加 owner 隔离（运维配置为全局）。
- 不改现有认证/登录/验证码逻辑。