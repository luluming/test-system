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

### 已确认子功能（mockup 验收通过，须落实代码）

> 依据 `plan-c-real-conf.html`（浏览器验收 0 JS 错误）确认的范围，全部纳入本实现。

1. **全局拓扑视图**：按 `upstream 组 → 被引用(server·location) → 后端节点` 渲染纯 CSS/HTML 节点链路（见 §5 TopologyView）。
2. **块管理导出中心**：DetailPanel 顶部新增「导出配置」入口，弹窗含 **SSL 开关** + **域名替换/upstream 后端整组替换** + **实时预览** + **复制/下载**。
3. **监听点 / 业务端口视图**：配置文件概览 + 业务端口按组分组展示（见 §5 OverviewGrid / BizPortChips / PathChain）。
4. **行级操作**：监听点 / location 行内提供「连通性测试 / 启用·停用 / reload」操作，结果以 toast 反馈（对应 §4 forward-test / reload 端点）。
5. **SSL 导出开关语义**：关闭 SSL 导出时——
   - 丢弃 `ssl_*` 指令行（`ssl_protocols|ssl_certificate|ssl_certificate_key|ssl_session_cache|ssl_session_timeout|ssl_ciphers|ssl_prefer_server_ciphers`）；
   - `listen X ssl http2;` → 改写为 `listen X http2;`（去除 `ssl` 标记并折叠空白）。
6. **导出自动替换**（增强 V）：① 填一个**全局新域名** → 导出时所有 `server_name` 的值整体替换为它（无需填原域名）；② **upstream 后端整组替换（默认 + 例外）**：填默认纯 IP 应用到未例外交代的组，例外卡「每条例外=选单个 upstream 组（datalist 自动补全）+纯 IP」，未单独配置的组一律走默认；只替换 IP，端口与端口后参数沿原。

## 2. 整体布局（三栏 + 顶级菜单）

```
┌ 标题栏 (36px) ───────────────────────────────────────┐
├ 顶级菜单 (38px)：配置文件 | 块管理 | 全局拓扑 | 业务端口 │
├──────────┬───────────────────────────────┬──────────┤
│ 左侧资源树│ 中间：主从视图 / 全局拓扑预览  │ 右栏     │
│ 210px     自适应                        │ upstream │
│ ·监听点    · 列表列 300px               │ 池管理    │
│ ·共性块    + 详情区 (Tab化)             │ 360px    │
├──────────┴───────────────────────────────┴──────────┤
└ 状态栏 (28px) ───────────────────────────────────────┘
```

- **顶级菜单实际 4 项**（以 mock 为准）：`配置文件`（默认视图，主从） / `块管理`（同配置文件的块树编辑能力独立入口） / `全局拓扑`（整体链路预览） / `业务端口`。早期设计的「Upstream 池 / 转发规则」入口已折并入配置文件详情（监听点表格/块树）与业务端口页，不再单列菜单。
- **默认视图**：配置文件(列表+详情主从)；**全局拓扑**为整体预览入口

### 2.1 方案 C+ 增强决策（2026-10-09 确认）

> 评估结论：方案 C（列表+详情主从）骨架是最贴合运维场景的主框架，保留不变。为回到设计文档 §1 核心诉求（整体效果预览 + 链路可读），在 C 基础上做**两处增强**，不推翻已有结构，不改动现有四视图主从一致性。此增强记录为「方案 C+」。

**增强 1：全局拓扑 —— 从「逐组 upstream」升级为「四层全局链路」**
- 保留主从导航（左=upstream 组列表，右=选中组详情），但在**右侧详情区顶部**增设一条**全局链条**：`业务域名 → 监听点(端口) → path → upstream 组 → 后端节点(addr:port · 权重)`
- 双向可点：从链路任意节点点击可跳到对应配置视图并定位；从配置视图也可反向跳到拓扑高亮该链路
- 复用现有 pure-CSS/HTML 节点渲染（不引入图表库，坚守 §8 约束）
- 未被引用/健康检查失败的后端节点以红角标提示

**增强 2：配置文件 / 业务端口 —— 恢复数据密度，PathChain 贯穿**
- 配置文件视图：**顶部统计看板回归**（server/location/upstream/if 四卡 + 全量监听点表格），不做成"仅选中才见短表"
- 业务端口详情区：每条转发规则渲染为 **PathChain（访问路径链路）**：`公网/内网 → 域名:端口 → /path → upstream 组或目标地址`
- 主从联动保持不变（点选列表行刷新右侧详情）

**保留不变**：三栏结构、左侧全球共用资源树、方案 C 的块树嵌套语义（map default 置底 / if 弱提示 / raw 兜底）、Tab 化详情区、导出中心、行级操作（连通性·启停·reload）。

### 2.1 C+ 增强 III（2026-10-09 · 监听展示 / upstream 关联 / IP 清单补全）

> 在方案 C+ 之上追加的三处数据语义修正，落地于 `plan-c-real-conf.html` 并同步本计划。

**增强 3：监听端口展示剥离 ssl/http2 修饰词（listenPlain）**
- 监听端口在**展示层**只显示纯「地址:端口」（如 `443`、`0.0.0.0:443`），不再显示 `ssl`/`http2`/`backlog=` 等修饰词。
- **ssl 与否由「导出」时决定**（导出弹窗的「启用 SSL 导出」开关），监听点自身不再宣称协议。
- 实现：`listenPlain(b)` 取 `listen` 首段（unix socket 原样保留）；应用于监听点侧栏/列表、配置文件监听点表格、全局链路、PathChain、块树 listen 行、业务端口视图。左侧/中间列表内部仍以 `listenOf` 作联动 key（数据层不变，仅展示替换）。

**增强 4：proxy_pass ↔ upstream 关联可视化（关联性可读）**
- 建立全量 `upstream` 组名集合 `UPSTREAM_SET`；解析 `proxy_pass` 目标主机，区分 **upstream 组名引用 / IP 直连 / 域名直连**。
- 仅对「组名引用」校验：命中组 → 绿色「✓ 已匹配」；无对应组 → 红色「✗ 未匹配」警示；IP/域名直连 → 橙色（不打未匹配标）。
- 落点：配置文件监听点表格「主要上游（proxy_pass 关联）」列（✓/✗ tag）、全局链路 upstream 节点（matchok/unmatched）、PathChain 目标端、块管理 location 的 proxy_pass 行（已匹配/未匹配组/直连 mini 标签）。

**增强 5（已废弃）· 导出按后端 IP 清单自动补全 upstream**
- **（2026-10-12 移除）**：本项「按组独立填节点」（`upstreamEdit/upOverride` + 后端 IP 清单补全）被用户判定为不需要，已从实现与设计中移除；导出替换能力统一收敛到 **增强 V 的全局「IP/域名替换（按指令）」映射表**。upstream 组的各 IP 不同，通过增强 V 的 `server`（upstream节点）指令类型多条规则实现。

### 2.1 C+ 增强 IV（2026-10-10 · 块管理编辑能力落地）

> 承接方案 C 的块树语义（§3 config_blocks / config_options），把 mock 中已落地的「块管理编辑能力」全部并入，作为 BlockTree 的标准交互。统一钩子：**所有已提交的块树变更都汇经 `rebuildSelected()`（同步 / 镜像 / 刷新）**；新增块、edit 提交、删除均先经它再刷新侧栏与计数。

- **双文件树 + stream 上下文（.stream 独立文件）**：`CONF_TREE=parse(src,"http")` / `STREAM_TREE=parse(srcStream,"stream")`，根为通用虚拟根使 http/stream/events 并列（杜绝 stream 误挂 http 下）；左下 `.ctxseg` 切换 conf/stream；`countAll()` 只统计当前活动树；块管理/新增弹窗/导出均按当前上下文生效；`upKey(g)=CTX+":"+g` 命名空间隔离 http/stream 同名 upstream 组。
- **server 镜像同步（持久保持一致）**：`MIRRORS={"443":"20551"}` 端口对；`initMirrors()` 首载深克隆生成镜像 server，`syncMirrors(edited)` 沿 parent 上溯顶级 server（仅 conf、无 `_new` 待编辑）后经 MIRRORS 定位对方并 `applyMirror`（保留对方自身 listen）；声明须在调用前（`var` 提升陷阱）。挂载于 `rebuildSelected()` 首行，天然覆盖 KV 编辑/新增/删除、子块增删、header 提交、位置重排的镜像同步。
- **新增顶级块弹窗（替代 window.prompt）**：`#addBlockModal` 分段选 server / map / split_clients / geo / upstream / stream / events；map-like（map/split_clients/geo）沿用 default 置底 + 正则键原样渲染；stream/events/http 仅识别不新增；`topToInsertAfter()` 支持「插到选中顶级块之后」。
- **已有 KV 可编辑 + 子块类型可选**：普通指令行悬停浮现 `kv-ed` 编辑（指令名/值回填，Esc 还原）；`+ 子块` 展开可选 location / if / limit_except，`_new` 按 scope 拼 header（location `/`、`if (条件) {`、`limit_except METHOD…`）；`+ KV` 新增。
- **删除能力（补删）**：KV 行悬停 `kv-del`；子块（含 location）header `×`；**顶层整块可删（`parentNode=TREE[0]` 也渲染 ▲▼/×）**，删除后 `pruneAllNodes(node)` 从 allNodes 剪除整棵子树（否则侧栏/计数残留），并 `refreshPane()+refreshCounts()`。
- **块树排序 + 插入位置**：左侧 server（`#sideListen`）/ map·upstream（`#sideCommon`）拖拽排序，`flushListOrder` 按该类在 TREE[0].children 的既有槽位重排；块内 KV 行 ▲▼ 重排；map default 恒置底。
- **块树层次感 + 渲染稳健化 R3**：`.brow` 平铺容器用 `margin-left` 递进缩进（0/14/32/50px），层级线随深度着色加粗；`isRawKV(o)` 稳健分类（default / 引号含 `"` / 首字符 `~`/`*` 整行原样），`default` 置底带绿底徽章无箭头，正则键/引号行 `.kv-raw` 原样可重排可删，普通指令 `directive = value`。

### 2.1 C+ 增强 V（2026-10-12 · 导出替换收敛为 server_name 域名 + upstream 后端整组替换）

> 目标：导出时基于用户提供的域名 / 后端 IP，**自动替换**配置文件内容。用户明确仅两种替换：① **server_name 域名**（旧→新规则）；② **upstream 后端**（指定部分上游组、填一个或多个 IP，**整组替换**原后端节点）。原「全局按指令类型映射表」（`listen/proxy_pass/all` 等指令类型）已按用户确认移除。落地于 `plan-c-real-conf.html` 导出中心。

**替换模型 = 两类正交的自动替换（无泛化指令类型）**
- **① 域名替换（server_name → 全局新域名）**：单一输入 `domNew`；导出时把所有 `server_name` 指令的值**整体替换**为新域名（`applyDomains` 用 `^server_name\s+(.+)$` 捕获原值整体替换，返回 `{raw,changed,orig}`），**无需填原域名**；留空则不替换。
- **② upstream 后端整组替换（默认 + 例外覆盖，纯 IP，每条例外只针对单个组）**：用户只填**纯 IP** 清单（每行/逗号分隔，一个 IP = 一个节点），**端口与端口后参数（weight 等）一律自动沿用该组原节点对应位置设置**，无需手写。模型：`upDefaultIps`（默认 IP 清单，应用到未被任何例外覆盖的全部组）+ `upExceptions=[{grp:"<CTX>:<组名>", ips:"纯IP…"}]`（**每条例外只针对一个 upstream 组**，未单独配置的组一律走默认；`grp` 为单字符串 key=上下文 `<CTX>:<组名>` 隔离 http/stream 同名组，替换了 v4 的 `sel` 多选集合）。`ipsForGroup(k)` 先查例外（`e.grp===k` 首个命中）否则回退默认；`derivedFor(g)` 用该组 IP 清单产新后端行，清单为空则该组不替换（返回 null）。例：**C 组 1 个 IP、其它组 3 个 IP** —— 默认填 3 个 IP、例外把 C 单独改为 1 个，无需理解优先级/排序。
- **导出替换时机**：`exportLines` 逐行：`server_name` 行走 `applyDomains`；`scope=upstream` 且 `derivedFor` 命中则跳过原 `server` 节点行、在块内统一输出新后端行；其余行不动。
- **预览逐条可控**：命中行（`changed && orig`）以 `.subst` 高亮、行尾标注 `← 原值：<原文>`；状态栏显示「N 条域名(server_name)替换 · M 组 upstream 整组替换」（M 按命中的组数计，非全组总数）；复制 / 下载输出替换后文本。
- **落点**：导出弹窗「域名替换（server_name → 新域名）」`#domNew` 单输入框（`＋ 添加规则 #domAdd` 及原域名/新域名表格 `#domRows` 已移除）；「upstream 后端整组替换（默认 + 例外覆盖）」`#upDefaultIps` 文本框 + `#upExceptions` 例外卡（`renderUpExceptions()`：例外标签 + ✕ 删除 + **单组选择器 `input.search up-search` + `datalist` 自动补全（选一个 upstream 组，仅该组用本 IP；v5 起以自动补全输入框取代 v4 的 `#up-search` 搜索框 + checkbox 多选折叠列表 + 全选/清空）** + `textarea.up-ip` 纯 IP；`＋ 添加例外 #upAddEx`/`addUpEx()`）；`btnExport/btnOvExport` 打开时 `initExprOpen()`。
- **验证**：浏览器（cache-busted 全新 URL）① 域名：填一个 `#domNew` → 所有 server_name 变为新域名、状态栏「1 条域名(server_name)替换」，清空恢复且无计数；② 例外=单组：`＋ 添加例外` → 例外卡仅含单个 datalist 自动补全输入框（无全选/清空、无 checkbox 长列表），选 `sub_backstage_web` 填 `10.8.8.8` → 状态栏「**1 组** upstream 整组替换」（非 31 组），预览恰 1 行 `server 10.8.8.8:20690 weight=5 max_fails=2 fail_timeout=30s;`（端口/参数沿原、无双分号），未加例外的组走默认。

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
- `POST /api/nginx-configs/{id}/export`：**导出中心**。请求体 `{ "ssl_enabled": bool, "server_name_domain": "new.example.com"|null, "upstream_default_ips": ["ip", ...], "upstream_exceptions": [{"grp": "<CTX>:<组名>", "ips": ["ip", ...]}, ...] }`。返回 `{ "content" }`：
  - `ssl_enabled=false` → 在 render 结果上丢弃 `ssl_*` 指令行 + 改写 `listen X ssl http2;` → `listen X http2;`
  - `server_name_domain`（增强 V ①）→ 非空时把所有 `server_name` 指令的值**整体替换**为该域名（无需原域名）；null 则不动。
  - `upstream_default_ips` + `upstream_exceptions`（增强 V ②，默认+例外覆盖）→ 组名匹配**先走例外（`grp` 精确匹配，首个命中）、否则默认**；**每条例外只针对单个组**；命中组**整组替换其原 `server` 节点行，只替换 IP，端口与端口后参数（weight 等）沿原对应位置原设置**。支持「不同组配不同 IP 数量」。组级覆盖表、`domain_replacements`/`upstream_rules` 的优先级语义、例外多选 checkbox（`groups` 数组）与 `upstream_servers` 均已废弃，不再有。
- `GET /api/directives`：内置常用指令字典（指令名 + 说明 + 所属上下文，供补全）

## 5. 前端组件拆分

```
OpsTopologyPage        ← 全局拓扑预览（顶级菜单「全局拓扑」）
 └─ TopologyView        ← 四层节点图（业务域名→监听点→path→upstream→后端；点击节点联动详情）
     ├─ GlobalChain     ← [C+] 全局链路条：选中组/链路的一屏完整链路，节点可点击跳转对应配置视图
     └─ GroupDetail     ← upstream 组详情（被引用·后端节点），保持主从
OpsUpstreamPage        ← Upstream 组管理（顶级菜单「Upstream 池」）
OpsConfigPage          ← 配置文件主从（默认页，改造既有 OpsConsole）
 ├─ ListPanel          ← 左列表：搜索/筛选/行选中/告警红条
 ├─ DetailPanel        ← 右详情：Tab 化（概览/域名映射/转发规则/业务端口/块树）
 │   ├─ StatBanner     ← [C+] 顶部统计看板（server/location/upstream/if 四卡）；监听点表格端口经 listenPlain 剥离 ssl/http2，末列「主要上游」渲染 ✓/✗ 关联tag（增强3/4）
 │   ├─ OverviewGrid   ← 概览信息网格
 │   ├─ BlockTree      ← 嵌套块树（server ⊃ location/map/if...，缩进线表达 parent_id 层级，map/geo/if/log_format/include/注释/raw 均为节点，各节点可 +子块/+KV/+注释/删除）；listen 行展示剥离 ssl/http2；proxy_pass 行尾挂「已匹配/未匹配组/直连」mini 标签（增强3/4）；**KV 行可逐条删除（kv-del）、子块（含 location）可删除（blk-del，根节点除外）**，删除后实时重渲染块树与预览
 │   ├─ KvListEditor   ← 自由 KV 行编辑器（指令补全/顺序拖拽/row_type 标签/raw 兜底，default 行强制置底；块内复用）
 │   ├─ BizPortChips   ← 业务端口（监听点展示剥离 ssl/http2）
 │   └─ PathChain      ← [C+] 访问路径链路（公网/内网→域名:端口→/path→upstream 组或目标地址；业务端口详情区贯穿渲染）；端口用 listenPlain，upstream 目标端命中/未命中分色（增强3/4）
 │ └─ (导出中心)      ← 导出弹窗含「域名替换（server_name → 新域名）」单输入 `#domNew`（填一个新域名，导出时所有 server_name 的值整体替换为它，**无需填原域名**，留空则不替换）与「upstream 后端整组替换（默认 + 例外覆盖）」#upDefaultIps 文本框（默认纯 IP，一个 IP=一个节点）+ #upExceptions 例外卡（#upAddEx 添加：每条=**单个 upstream 组**（`datalist` 自动补全单组选择器）+目标纯 IP，替代旧多选 checkbox 列表）；例外卡 `renderUpExceptions()` 内无「全选/清空」/长 checkbox 列表，仅一个自动补全输入框 + `textarea.up-ip`。`exportLines()` 逐行标注 `{text,changed,orig}`，预览命中行 `.subst` 高亮并标注原值；状态栏「N 组 upstream 整组替换」按命中的组数计（增强V）。「IP/域名替换按指令」泛化指令类型、旧的「upstream 后端节点可编辑表 / 后端 IP 清单补全」组级覆盖、域名「原域名→新域名」规则表 #domRows/#domAdd、以及例外多选 checkbox 折叠列表均已移除。
```

## 6. 页面级功能与交互清单（v5 全量固化，直接可开发）

> 依据 `plan-c-real-conf.html`（浏览器验收通过）逐项固化。各渲染一律遵循 IDE 深色主题 tokens（6 层背景、品牌蓝 `#4a8af4`、`ease-standard` 缓动、hover 推入 / 点击 scale(0.97) 微反馈、8px 网格），不引图表库/图标库。

### 6.0 全局外壳
- **标题栏（36px）**：左=菜单图标 ☰ + 项目名（语义：当前上下文文件，如 `businesscenter_nginx_CD_master.conf`）+ 绿色状态点；右=窗口控制（关闭/最小化/最大）。
- **顶部菜单（38px，4 项）**：`配置文件 | 块管理 | 全局拓扑 | 业务端口`；点击切换视图（带淡入），当前项品牌色激活条。
- **状态栏（28px）**：左=分支名 + 状态（`main ● clean`）；中=错误(红)/警告(黄)计数；右=上下文指示（conf/stream）+ 行/列 + 语言 + 出口计数（如「N 条域名(server_name)替换 · M 组 upstream 整组替换」）。
- **左侧资源树**：`监听点 (N)` server 列表 + `共性块`（map/upstream/split_clients/geo）；左下 `.ctxseg` conf/stream 上下文切换（影响整树/计数/块管理/导出）；server 项悬停浮现行级操作（连通性测试/启用·停用/reload），map·upstream 项可拖拽排序。告警行红条提示。
- **统一反馈**：删除/破坏性操作弹二次确认；操作成功/失败走右下角 toast（4px 语义色条，3s 自动消失）；`nginx -t` 失败展示错误行号并禁用「应用到服务器」。

### 6.1 配置文件页（默认，主从）
- **ListPanel（左，~300px）**：搜索/筛选/行选中/告警红条；点击行刷新右侧详情（主从联动）。
- **DetailPanel（右，Tab 化）**：`概览 / 域名映射 / 转发规则 / 业务端口 / 块树` 五个 Tab；顶部工具栏含**行级操作**（连通性测试/启用·停用/reload）、`＋ 块`（新增顶级块弹窗）、`导出配置`、`同步`（已弃用旧刷新按钮则为镜像同步）、`保存`按钮。
- **StatBanner**：server/location/upstream/if 四统计卡；下挂**全量监听点表格**：端口经 `listenPlain` 剥离 ssl/http2，末列「主要上游（proxy_pass 关联）」渲染 ✓已匹配/✗未匹配/直连 tag。
- **OverviewGrid**：概览信息网格（name/listen_port/is_public/status 等）。
- **域名映射 Tab**：域名列表 + 主域名标记（is_primary），增删改。
- **转发规则 Tab**：path / target（单地址或 upstream 组）/ 端口 / 公网·内网开关 / 启用状态，行内测试·启停·编辑。

### 6.2 块管理（BlockTree，配置文件的块树编辑能力）
- **数据源**：`CONF_TREE=parse(src,"http")` / `STREAM_TREE=parse(srcStream,"stream")`，通用虚拟根使 http/stream/events 并列；当前活动树决定整树/计数/弹窗/导出。
- **树语义**：server⊃location⊃if/limit_except 任意嵌套；map/split_clients/geo 的 `default` 恒置底（绿底徽章、无 ▲▼）；正则键/引号行 `.kv-raw` 整行原样、可 ▲▼ 可删；普通指令 `directive = value`；`comment` 输出 `# 前缀`；`include` 输出 `include <path>;`；raw 照录。listen 行剥离 ssl/http2；proxy_pass 行尾挂「已匹配/未匹配组/直连」mini 标签（增强 4）。
- **编辑能力**（统一钩子：所有已提交变更经 `rebuildSelected()` → 同步/镜像/刷新侧栏与计数）：
  - `＋ 子块` 展开可选 `location / if / limit_except`，header 模板对应生成（location `/`、`if ($cond) {`、`limit_except METHOD…`）。
  - `＋ KV` 新增指令行；普通指令悬停浮现 `kv-ed` 编辑（指令名/值回填，Esc 还原）；KV 悬停 `kv-del` 删除。
  - 子块 header `×` 删除（含 location，根节点除外）；**顶层整块可删**（修剪整棵子树，禁侧栏/计数残留）。
  - KV/子块行内 ▲▼ 重排；左侧 server 与 map·upstream 拖拽排序（`flushListOrder` 按既有槽位重排）；map default 恒置底。
  - **新增顶级块弹窗 `#addBlockModal`**（非 window.prompt）：分段选 `server / map / split_clients / geo / upstream / stream / events`（stream/events/http 仅识别不新增）；map-like 沿用 default 置底 + 正则键原样；支持「插到选中顶级块之后」。
  - **server 镜像同步**：`MIRRORS={443:20551}` 端口对；编辑某 server 时自动同步到镜像 server（保留对方自身 listen）；声明须先于调用（var 提升陷阱）。
  - **上下文感知**：`upKeyOf(g)=CTX+":"+g` 隔离 http/stream 同名 upstream 组；计数/弹窗/导出均按当前上下文。

### 6.3 全局拓扑（四层全局链路）
- **GlobalChain**：`业务域名 → 监听点(端口) → path → upstream 组 → 后端节点(addr:port · 权重)` 一条链路，节点 pure-CSS/HTML 渲染；**双向可点**（链路→对应配置视图并定位，配置视图→反向高亮）。
- **GroupDetail**：选中 upstream 组详情（被引用 · 后端节点），保持主从；未引用/健康检查失败节点红角标提示。
- **matchok 语义**：`UPSTREAM_SET` 建全量组名集合；proxy_pass 目标区分 组名/IP直连/域名直连；仅组名校验（命中绿✓ / 未命中红✗），直连橙色不警示。

### 6.4 业务端口
- **BizPortChips**：业务端口按组分组展示，端口用 `listenPlain`。
- **PathChain**：每条转发规则渲染访问路径链路 `公网/内网 → 域名:端口 → /path → upstream 组或目标地址`；端口剥 ssl/http2，upstream 目标端命中/未命中分色（增强 3/4）；业务端口详情区贯穿渲染。

### 6.5 Upstream 池（右栏 ~360px）
- 组列表 + 组详情：组名 / strategy（round_robin·least_conn·ip_hash）/ keepalive / 节点表（addr:port · weight · 健康状态 · 启用），组内节点行内测试/启停/编辑；组的 `upstream {}` 片段预览 + `nginx -t` 校验。

### 6.6 导出中心（导出弹窗）
- 打开：配置文件 / 块管理详情顶部 `导出配置`（或全局拓扑处 `btnOvExport`）；`initExprOpen()` 回填当前值与例外卡。
- **SSL 开关**：关 → 丢 `ssl_*` 指令行 + `listen X ssl http2;`→`listen X http2;`（§1 子功能 5）。
- **域名替换**：`#domNew` 单输入（填一个新域名，导出时所有 `server_name` **整体替换**为它，**无需填原域名**，留空不替换）。
- **upstream 后端整组替换（默认 + 例外，纯 IP）**：
  - `#upDefaultIps` 文本框：默认纯 IP（应用到未被例外交代的全部组；留空则这些组不替换）。
  - `#upExceptions` 例外卡（`＋ 添加例外 #upAddEx`）：**每条例外 = 单个 upstream 组（`input`+`datalist` 自动补全选择，无全选/清空、无 checkbox 长列表）+ `textarea.up-ip` 纯 IP**；例外标签 + ✕ 删除。
  - 语义：一个 IP=一个节点；**只替换 IP，端口与端口后参数（weight 等）一律沿用该组原节点对应位置**；`grp` key=`<CTX>:<组名>` 隔离同名组；`ipsForGroup(k)` 先查例外（`e.grp===k` 首个命中）否则默认；清单为空则该组不替换。
- **实时预览**：`exportLines()`/`walkEx()` 逐行进结构输出 `{text,changed,orig}`；命中行 `.subst` 高亮 + 行尾标注 `← 原值：<原文>`；状态栏「N 条域名(server_name)替换 · M 组 upstream 整组替换」（M 按命中的组数计）。
- **复制 / 下载**：输出替换后文本（`.conf`）。

### 6.7 前端纯函数移植契约（导出/拓扑/块树，React 侧须逐字复刻）
| 函数 | 输入 → 输出 | 语义要点 |
|---|---|---|
| `stripListen` / `listenPlain(b)` | 监听行 → 纯「地址:端口」 | 取 listen 首段，unix socket 原样；剥离 `ssl/http2/backlog=` 等展示修饰词；数据层联动 key 仍为 listenOf |
| `buildUpstreamSet` / `upKeyOf(n)` / `upNameOf(n)` | 配置树 → 组名集合 / 组 key / 组名 | `UPSTREAM_SET` 全量组名；`upKeyOf=CTX+":"+upNameOf`；upNameOf 去 header 前导 `upstream ` 并 trim |
| `proxyHost` / `upstreamMatch` | proxy_pass 目标 → 组名/IP/域名 三分类 + 命中判定 | 仅组名引用校验（✓匹配/✗未匹配），IP/域名直连橙色不警示 |
| `isRawKV(o)`    | 行对象 → 是否整行原样 | default / 值含 `"` / directive 首字符 `~`/`*` → raw；`rawText(o)` 回显原文 |
| `orderedOptions` | 块内 KV 排序 | 仅 default 强制置底，其余按书写/重排；正则键/引号行原样可拖可删 |
| `domParse(s)`   | 文本 → IP 数组 | 逗号/换行拆分、trim、去空 |
| `applyDomains(raw)` | 单行 → `{raw,changed,orig}` | `^server_name\s+(.+)$` 捕获原值整体替换为 `domNew`；留空→changed:false |
| `deriveUpBackends(g,ips)` | (组, 纯IP[]) → 后端行数组 | `server {ip}{补端口}{ 参数};`；补端口仅当无端口且非 unix；参数沿原位置（去尾 `;` 防双分号） |
| `ipsForGroup(k)` | 组 key → IP 文本 | 遍历例外 `e.grp===k` 首个命中且非空，否则默认 |
| `derivedFor(g)` / `exportLines`/`walkEx` | 组 → 替换后行 or null；树 → 全文行 | 命中组跳过原 server 节点行、块内统一 emit 新行；其余行不动 |

## 7. 错误处理与测试

- **错误处理**：连通性失败 → 节点/规则红标「失败」；`nginx -t` 校验失败 → 展示错误行号并禁止「应用到服务器」；Topology 后端不可达 → 骨架屏 + 重试；删除映射/转发/监听点/upstream 均二次确认；删除有 `upstream_id` 引用时驳回
- **测试**：后端单测覆盖 upstream/servers/config-blocks（含嵌套 parent_id、map default 置底渲染）/config-options CRUD + topology/test/reload/validate/render 端点；前端 mock 数据验证拓扑渲染、主从联动、Tab 编辑保存回填、KV 指令补全

## 8. 部署入口

- 沿用 Vite 代理 `/api → localhost:8001`，受保护路由，登录沿用 JWT + 验证码
- 迁移：SQLite 现库由 `seed.py` 自动补建两张新表，无需迁移工具

## 9. 范围外（YAGNI）

- 不做 nginx 进程实际启停（仅 Reload / 校验预览）
- 不做多服务器集群推送，单机运维控制台
- 不引入图表库，拓扑用纯 CSS/HTML 节点渲染

## 10. 安全（2026-10-13 补充 · 内页细项；通用基线见 `2026-10-13-multi-industry-template-design.md` §10）

- **XSS（内页重点）**：块树/预览/拓扑渲染大量配置文本（KV 指令值、raw/正则键、location 路径、proxy_pass、server_name、upstream IP）。React 用 JSX 自动转义；任何 `dangerouslySetInnerHTML` 仅在**先 `escapeHtml` 消毒**后使用；纯函数迁移（§6.7）输出不得以未转义方式写回 DOM。关注**存储型 XSS**：落库的配置/注释再次渲染时必须同样转义。
- **命令注入**：`nginx -t`、reload、连通性测试统一 `subprocess.run([…], shell=False)`，配置写临时文件后以路径作参数，绝不把配置内容拼进 shell 字符串；`config_path`/`.stream`/导出文件名白名单正则（字母数字 `-_./`）防路径遍历。
- **其它**：拓扑连通性测试目标加 IP 白名单防 SSRF；导出/下载 `Content-Disposition` 安全文件名防头注入；行业越权见外壳 §10③。