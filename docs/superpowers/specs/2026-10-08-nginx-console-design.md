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

### 新增：`config_blocks`（泛化块 · 自关联嵌套）

**泛化 nginx 块**。`server / location / upstream / map / geo / if / log_format / split_clients / geo / include / 注释 / raw` 统一为一种块，靠 `scope` + `parent_id` 表达类型与任意嵌套层级，替换原「只能表达三种块」的局限。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int PK | |
| nginx_config_id | FK → nginx_configs.id | 所属配置文件 |
| parent_id | FK 自关联 → config_blocks.id，可空 | 表达嵌套：`server ⊃ location ⊃ if` |
| scope | str | 块类型：`server` / `location` / `upstream` / `map` / `geo` / `if` / `log_format` / `include` / `comment` / `raw` |
| header | str | 块头部原文，如 `map $http_cookie $cookie_to_delete`、`location /api/` |
| belongs_to_file | str 可空 | 支持"一个逻辑 server 拆成多文件"的文件归属标记 |
| sort_order | int default 0 | 同级块顺序 |
| created_at | datetime | |

**嵌套即任意树**：层级完全由 `parent_id` 递归描述，`if` 可嵌在 `location` 内，`map`/`geo` 可挂在 `server` 级，无需为每类建独立表。

### 新增：`config_options`（通用 KV 行 + raw 原样行）

**承载块内所有指令/条件/映射行**，统一"键 = 值"，是块内容的最小单元，也是冷门/扩展参数的自由入口。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int PK | |
| block_id | FK → config_blocks.id | 归属的块（server/location/map/... 的任意内部行）|
| directive | str | 键：指令名 / map 条件 / geo 网段 / split 占比等 |
| value | str | 值：指令值 / map 结果 / geo 变量等 |
| row_type | str default `kv` | `kv` 常规 / `regex` 正则 / `string` 字符串 / `default` 默认值 / `raw` 原文整行 |
| is_free_text | bool default False | `raw` 模式：directive 填整行原文、value 空，照录渲染 |
| sort_order | int default 0 | 行顺序（nginx 指令顺序敏感，顺序即输出顺序）|
| created_at | datetime | |

**语义约束（用户确认保留）**
- **map default 恒置末尾**：`row_type=default` 的行在排序/渲染时强制置于该块末尾（不受 sort_order 影响），匹配 nginx `default` 语义。
- **if 弱提示**：`scope=if` 的块渲染前置 `# 建议少用 if` 注释弱提示（nginx 社区惯例），但不阻止使用。
- **raw 兜底**：完全冷门指令按"原文整行"直接内联照录渲染，保证不漏。

> 渲染：按块树深度优先 + 同级 `sort_order` 递归拼装；`map/geo/if` 输出成对应 `… { … }` 块；`comment` 输出 `# ` 前缀；`include` 输出 `include <path>;`；`raw` 行照录原文。支持指令补全（内置常用指令字典：指令名 + 说明 + 所属上下文）。

## 4. 后端 API

沿用 `_make_router()` 工厂 + Pydantic v2（`Create/Update/Out`, `ConfigDict(from_attributes=True)`）、`Depends(get_db)`、`Depends(get_current_user)`、update 用 `exclude_unset=True`。

### 新增 upstream / block / KV 指令组 CRUD
- `POST/GET/PATCH/DELETE /api/upstreams`
- `POST/GET/PATCH/DELETE /api/upstreams/{id}/servers`
- `POST/GET/PATCH/DELETE /api/config-blocks`（`parent_id` 表达嵌套；`GET /api/nginx-configs/{id}` 返回其块树；`blocks/{id}/children` 取子块）
- `POST/GET/PATCH/DELETE /api/config-options`（按 `block_id` 过滤；`sort_order` 批量重排；`row_type` 标记 regex/default/raw）

### 新动作端点
- `GET /api/topology`：返回全局拓扑结构（域名/监听点/upstream/后端分层的聚合数据，供拓扑图渲染）
- `POST /api/forward-ports/{id}/test`：连通性探测目标（单地址或 upstream 组内节点）
- `PATCH /api/forward-ports/{id}`：切换 enabled
- `POST /api/nginx-configs/{id}/reload`：热加载并刷新 status
- `GET /api/upstreams/{id}/preview`：生成该组的 `upstream {}` 配置片段
- `POST /api/upstreams/{id}/validate`：`nginx -t` 校验预览结果
- `GET /api/nginx-configs/{id}/render`：按泛化块树（深度优先 + sort_order + map default 置底）渲染整份 nginx 配置文本（供 dry-run预览）
- `GET /api/directives`：内置常用指令字典（指令名 + 说明 + 所属上下文，供补全）

## 5. 前端组件拆分

```
OpsTopologyPage        ← 全局拓扑预览（顶级菜单「全局拓扑」）
OpsUpstreamPage        ← Upstream 组管理（顶级菜单「Upstream 池」）
OpsConfigPage          ← 配置文件主从（默认页，改造既有 OpsConsole）
 ├─ ListPanel          ← 左列表：搜索/筛选/行选中/告警红条
 ├─ DetailPanel        ← 右详情：Tab 化（概览/域名映射/转发规则/业务端口/块树）
 │   ├─ OverviewGrid   ← 概览信息网格
 │   ├─ BlockTree      ← 嵌套块树（server ⊃ location/map/if...，缩进线表达 parent_id 层级，map/geo/if/log_format/include/注释/raw 均为节点，各节点可 +子块/+KV/+注释/删除）
 │   ├─ KvListEditor   ← 自由 KV 行编辑器（指令补全/顺序拖拽/row_type 标签/raw 兜底，default 行强制置底；块内复用）
 │   ├─ BizPortChips   ← 业务端口
 │   └─ PathChain      ← 访问路径链路（域名→端口→路径→upstream/地址→公网/内网）
 └─ TopologyView       ← 四层节点图（点击节点联动详情）
```

## 6. 错误处理与测试

- **错误处理**：连通性失败 → 节点/规则红标「失败」；`nginx -t` 校验失败 → 展示错误行号并禁止「应用到服务器」；Topology 后端不可达 → 骨架屏 + 重试；删除映射/转发/监听点/upstream 均二次确认；删除有 `upstream_id` 引用时驳回
- **测试**：后端单测覆盖 upstream/servers/config-blocks（含嵌套 parent_id、map default 置底渲染）/config-options CRUD + topology/test/reload/validate/render 端点；前端 mock 数据验证拓扑渲染、主从联动、Tab 编辑保存回填、KV 指令补全

## 7. 部署入口

- 沿用 Vite 代理 `/api → localhost:8000`，受保护路由，登录沿用 JWT + 验证码
- 迁移：SQLite 现库由 `seed.py` 自动补建两张新表，无需迁移工具

## 8. 范围外（YAGNI）

- 不做 nginx 进程实际启停（仅 Reload / 校验预览）
- 不做多服务器集群推送，单机运维控制台
- 不引入图表库，拓扑用纯 CSS/HTML 节点渲染