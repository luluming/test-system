# Nginx 配置管理系统 · 方案 C 设计文档

> 日期：2026-10-08
> 主题：nginx-card-console
> 状态：已确认，待进入实现计划

## 1. 背景与目标

在现有 FastAPI + React（Ant Design）技术栈基础上，把「nginx 配置管理」从已实现的运维控制台升级为面向运维的**配置可视化管理系统**。核心诉求：

- 管理 nginx 配置（增删改查）
- 管理域名映射、转发端口、业务启动端口及公网/内网开关
- **整体效果预览**：从全局视角看清「域名 → 监听点 → upstream → 后端节点」的完整链路
- **upstream 组管理**：负载均衡组（多节点 + 权重 + 健康检查 + 均衡策略）

### 确定的设计选择（对用户逐条确认）

- 主落地布局：**方案 C · 列表 + 详情主从**（左列表快速导航，右详情 Tab 化编辑）
- 编辑形态：**右侧抽屉 / 详情区 Tab**承载完整表单
- 条级操作：**转发规则、upstream 节点**均支持单条测试 / 启用 / 停用 / 编辑
- 整体预览：**全局拓扑四层图**（域名 → 监听点 → upstream → 后端）
- upstream：新增独立管理，支持组内多节点、权重、健康检查、均衡策略

## 2. 整体布局（三栏 + 顶级菜单）

```
┌ 标题栏 (36px) ───────────────────────────────────────┐
├ 顶级菜单 (38px)：全局拓扑 | 配置文件 | Upstream池 | 转发规则 | 业务端口 │
├──────────┬───────────────────────────────┬──────────┤
│ 左侧资源树│ 中间：主从视图 / 全局拓扑预览  │ 右栏     │
│ 210px     自适应                        │ upstream │
│ ·监听点    · 列表列 300px               │ 池管理    │
│ ·upstream池  + 详情区 (Tab化)           │ 360px    │
├──────────┴───────────────────────────────┴──────────┤
└ 状态栏 (28px) ───────────────────────────────────────┘
```

- **顶级菜单**统领 5 个能力入口（全局拓扑 / 配置文件 / Upstream 池 / 转发规则 / 业务端口）
- **默认视图**：配置文件(列表+详情主从)；**全局拓扑**为整体预览入口

## 3. 数据模型（新增/扩展）

沿用既有 `Base(Mapped)` 风格、`created_at = server_default=func.now()`、`models/__init__.py` 统一导入 + `seed.py` 建表。

### 复用（已存在，变更最小）

| 表 | 字段要点 |
|---|---|
| `nginx_configs` | name, listen_port, config_path, is_public, status |
| `domain_mappings` | domain, is_primary, nginx_config_id |
| `forward_ports` | path, target_addr, target_port, is_public, enabled, **新增可选 upstream_id** |
| `biz_ports` | port, public_exposed |

### 新增：`upstreams`（nginx upstream 组）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int PK | |
| name | str unique | 组名，如 `api_backend` |
| strategy | str | `round_robin` / `least_conn` / `ip_hash`（默认 round_robin）|
| keepalive | int default 32 | |
| created_at | datetime | |

### 新增：`upstream_servers`（upstream 组内节点）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int PK | |
| upstream_id | FK → upstreams.id | 所属组 |
| addr | str | IP/域名 |
| port | int | |
| weight | int default 1 | |
| health_status | str | `up` / `down` / `checking` |
| enable | bool default True | |
| created_at | datetime | |

**`forward_ports` 扩展**：`target` 可从「单个地址」「或引用 upstream 组 id」二选一（`upstream_id` 可空）。

### 新增：`locations`（监听点下的 location 子实体）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int PK | |
| nginx_config_id | FK → nginx_configs.id | 所属监听点 |
| path | str | location 匹配路径，如 `/api/` |
| sort_order | int default 0 | location 顺序 |
| upstream_id | FK 可空 → upstreams.id | 可选转发目标 upstream |
| target_addr/target_port | str/int 可空 | 或单个转发地址 |
| created_at | datetime | |

### 新增：`config_options`（自由 KV 指令行）

**存储 server 级与每个 location 级的任意 nginx 指令**，承载"无法用表单建模的冷门/扩展参数"。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int PK | |
| nginx_config_id | FK → nginx_configs.id | 所属监听点（server 级指令，location_id 为空）|
| location_id | FK 可空 → locations.id | 归属的 location（location 内指令）|
| directive | str | 指令名，如 `proxy_set_header` / `add_header` |
| value | str | 指令值，如 `X-Real-IP  $remote_addr` |
| sort_order | int default 0 | 生成顺序（命令顺序即输出顺序，nginx 顺序语义重要）|
| created_at | datetime | |

> 生成配置时：`server{}` 层 = nginx_config 其下 location_id 为空的 options + 固定常用字段；`location{}` 层 = 该 location 下的 options 按 sort_order 输出。支持指令补全（内置常用指令字典：指令名 + 说明 + 所属上下文）。

## 4. 后端 API

沿用 `_make_router()` 工厂 + Pydantic v2（`Create/Update/Out`, `ConfigDict(from_attributes=True)`）、`Depends(get_db)`、`Depends(get_current_user)`、update 用 `exclude_unset=True`。

### 新增 upstream / location / KV 指令组 CRUD
- `POST/GET/PATCH/DELETE /api/upstreams`
- `POST/GET/PATCH/DELETE /api/upstreams/{id}/servers`
- `POST/GET/PATCH/DELETE /api/locations`（且 `GET /api/nginx-configs/{id}` 返回嵌套 locations）
- `POST/GET/PATCH/DELETE /api/config-options`（按 `nginx_config_id` 或 `location_id` 过滤；用 `sort_order` 批量重排）

### 新动作端点
- `GET /api/topology`：返回全局拓扑结构（域名/监听点/upstream/后端分层的聚合数据，供拓扑图渲染）
- `POST /api/forward-ports/{id}/test`：连通性探测目标（单地址或 upstream 组内节点）
- `PATCH /api/forward-ports/{id}`：切换 enabled
- `POST /api/nginx-configs/{id}/reload`：热加载并刷新 status
- `GET /api/upstreams/{id}/preview`：生成该组的 `upstream {}` 配置片段
- `POST /api/upstreams/{id}/validate`：`nginx -t` 校验预览结果
- `GET /api/nginx-configs/{id}/render`：按「固定字段 + server级 options + locations（含各自 options）」渲染整份 nginx 配置文本（供 dry-run预览）
- `GET /api/directives`：内置常用指令字典（指令名 + 说明 + 所属上下文，供补全）

## 5. 前端组件拆分

```
OpsTopologyPage        ← 全局拓扑预览（顶级菜单「全局拓扑」）
OpsUpstreamPage        ← Upstream 组管理（顶级菜单「Upstream 池」）
OpsConfigPage          ← 配置文件主从（默认页，改造既有 OpsConsole）
 ├─ ListPanel          ← 左列表：搜索/筛选/行选中/告警红条
 ├─ DetailPanel        ← 右详情：Tab 化（概览/域名映射/转发规则/业务端口）
 │   ├─ OverviewGrid   ← 概览信息网格
 │   ├─ LocationEditor ← location 列表 + 增删（每个 location：path + 其 KV 集）
 │   ├─ KvListEditor   ← 自由 KV 指令编辑器（指令补全/顺序拖拽/增删，server 级与 location 级复用）
 │   ├─ BizPortChips   ← 业务端口
 │   └─ PathChain      ← 访问路径链路（域名→端口→路径→upstream/地址→公网/内网）
 └─ TopologyView       ← 四层节点图（点击节点联动详情）
```

## 6. 错误处理与测试

- **错误处理**：连通性失败 → 节点/规则红标「失败」；`nginx -t` 校验失败 → 展示错误行号并禁止「应用到服务器」；Topology 后端不可达 → 骨架屏 + 重试；删除映射/转发/监听点/upstream 均二次确认；删除有 `upstream_id` 引用时驳回
- **测试**：后端单测覆盖 upstream/servers/locations/config-options CRUD + topology/test/reload/validate/render 端点；前端 mock 数据验证拓扑渲染、主从联动、Tab 编辑保存回填、KV 指令补全

## 7. 部署入口

- 沿用 Vite 代理 `/api → localhost:8000`，受保护路由，登录沿用 JWT + 验证码
- 迁移：SQLite 现库由 `seed.py` 自动补建两张新表，无需迁移工具

## 8. 范围外（YAGNI）

- 不做 nginx 进程实际启停（仅 Reload / 校验预览）
- 不做多服务器集群推送，单机运维控制台
- 不引入图表库，拓扑用纯 CSS/HTML 节点渲染