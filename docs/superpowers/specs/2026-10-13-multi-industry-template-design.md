# 多行业层 + 登录 + 模板克隆 · 设计文档（方案C 外壳扩展）

> 日期：2026-10-13
> 主题：nginx-card-console（外层外壳）
> 状态：已确认，待进入实现计划
> 依赖：`docs/superpowers/specs/2026-10-08-nginx-console-design.md`（方案C 内页设计，本文档是其**上一级外壳**扩展，不推翻其内部结构与导出规约）
> 静态效果参照：`.nginx-mock/login.html`、`.nginx-mock/dashboard.html`、`.nginx-mock/industry-switcher-sketch.html`、`.nginx-mock/plan-c-real-conf.html?industry=<id>`（内页 mock）

## 1. 背景与目标

在方案C（单行业「海外货运」配置管理控制台）之上，把系统升级为「**登录 + 多行业层 + 模板克隆 + 并发保护**」的运维控制台外壳：

- **统一登录页**：登录后管理行业基础信息。
- **多行业层**：每个行业（海外货运 / 国内 / 出租 / 公交…）能独立管理自己的 nginx 与 stream 配置文件，行业间数据相互隔离。
- **进入即控制台**：进入某行业即复用方案C 全部能力（块管理 / 全局拓扑 / 业务端口 / Upstream 池 / 导出替换），作用于该行业的配置，可按行业需求修改与导出。
- **模板克隆**：把任意行业配置做成模板，供其它行业「从模板克隆」初始化，克隆后**完全独立**，按行业需要进一步修改（已确认：克隆后独立 + 初次从模板初始化）。
- **并发规避**：多人对同一份配置修改不互相覆盖（乐观版本校验 + 编辑会话租约，2026-10-13 确认）。

明确交互链：`登录页 → 行业管理落地页 → 点行业「进入」→ 行业配置控制台（nginx + stream 双上下文）→ 修改 + 导出`。

## 2. 页面流程

```
login.html ──登录──▶ dashboard.html（行业管理）──进入──▶ plan-c-real-conf.html?industry=<id>
                      ▲                                    │
                      └──── 新建行业（模板克隆）────────────┘
```

mock 已可点击冒烟（python -m http.server 8765 于 `.nginx-mock`）。

### 2.1 登录页（`.nginx-mock/login.html`）

- 左品牌区：产品名「Nginx 配置管理系统」+ 三卖点（多行业层管理 / 模板派生 / 可视化配置）；右表单：账号 / 密码 / 记住我 / 忘记密码 / 登录按钮。
- 认证沿用方案C §8：JWT + 验证码；登录成功跳行业管理落地页。
- 视觉：深色基调 + 品牌蓝，顶栏/内页主题 token 一致。

### 2.2 行业管理落地页（`.nginx-mock/dashboard.html`，已定稿）

采用 Linear 式克制风格（frontend-skill 约束），**行列表**而非卡片堆叠，工具化文案，克制动效（逐行入场 / 行悬停左缘品牌渐亮 + 右侧“→”滑入 / 按钮按压缩放）。

结构自上而下：
- **顶栏**（吸顶毛玻璃）：Logo + 品牌名 + 面包屑（登录 › 行业管理）+ **主题切换器**（纯黑 / 软深 / 浅色 三个圆点，仅切 CSS 变量）+ 用户。
- **页头**：标题「行业管理」+ 一行作用域说明 + 右侧「☰ 视图 ▾」与主按钮「＋ 新建行业（模板克隆）」。
- **KPI 丝带**（一行分隔的四项）：行业总数 / nginx 配置 / stream 配置 / 全网监听点（等宽数字 + 分隔线，悬浮底部渐亮）。
- **行业列表**（列头 + 行）：列 = 行业 / 归属·更新 / nginx server / upstream / stream / 操作；行业行含：图标 + 名称 + 标签（`模板源`/`克隆自 · 海外货运`）+ 负责人/更新时间；行尾操作「基础信息」「进入」；**整行可点进入**。
- 底部：克隆流程说明 note。

**主题系统**（与方案C 内页共用同一套 token）：三套 CSS 变量集——纯黑（`--bg-deep:#0a0a0c`）、软深（`--bg-deep:#16162a`，推荐默认，由 `#1e1e2e/#262635` 演进、带紫蓝深夜氛围）、浅色（`--bg-deep:#f4f6f9`，白底 + 单一品牌蓝强调，白天偏好）。切换仅改 `:root`，不动结构。

## 3. 行业层数据模型

### 新增 `industries`

| id | int PK |
|---|---|
| code | str unique（如 `overseas_freight` / `domestic` / `taxi` / `bus`）|
| name | str（海外货运 / 国内 / 出租 / 公交）|
| owner | str 可空（负责人）|
| remark | str 可空 |
| is_template | bool default False（是否为模板源）|
| cloned_from_id | FK → industries.id 可空（记录「克隆自」溯源）|
| created_at / updated_at | datetime |

### 扩展 `nginx_configs`

- 新增 `industry_id` FK → `industries.id`；唯一约束 `(industry_id, name)`。
- 每个行业独立一套：`config_blocks` / `config_options` / `upstreams` / `upstream_servers` / `domain_mappings` / `forward_ports`（全部经 `nginx_configs` 关联，天然带行业维度）。
- **stream 独立性**：每行业保留自己的 `.stream` 独立上下文（沿用方案C 双文件树 + `ctxseg` conf/stream 切换）。

### 作用域语义（进入行业后）

- 控制台所有能力（配置文件 / 块管理 / 拓扑 / 业务端口 / Upstream 池 / 导出）**仅作用当前行业**。
- 路由带行业：`/ops/:industryId/{config|topology|ports|pool}`；切换行业 → 重载该行业数据；跨行业互不污染。

## 4. 模板 -> 克隆

- **模板源**：任一行业可标记 `is_template=true`（如「海外货运」），作为其它行业克隆基准；可多模板并存。
- **动作「＋ 新建行业（模板克隆）」**：选模板源行业 + 新行业名（+ 负责人）→ 后端**事务内深拷贝**：`config_blocks`（整棵 `parent_id` 嵌套树）+ `config_options` + `upstreams` + `upstream_servers` + `domain_mappings` + `forward_ports` + 该行业 `.stream` 源 → 生成新 `nginx_configs` 及全量关联 → 新行业标 `cloned_from_id=源行业`。
- **克隆后完全独立（已确认）**：此后新行业编辑 / 导出不影响模板源；无模板版本推送 / 联动。
- **初次进入无配置行业**（已确认）：默认引导「从模板克隆初始化」，先克隆再编辑。
- 复用方案C 的块管理编辑 / 导出替换能力，按行业需求进一步修改。

## 5. 多方并发修改规避（2026-10-13 确认）

**主机制 = 乐观版本冲突检测**，辅以**编辑会话租约**防残留：

- **版本冲突检测（乐观锁）**：每份 `nginx_configs` 增加 `version(int)` + `updated_at`。前端进入编辑态时记录基线 `version`；提交/写回携带基线版本；后端比对当前 `version`，不一致 → `409` + 「内容已变更，请刷新对比后再提交」。不直接覆盖。
  - 冲突处理：前端引导→提供「加载最新并保留我的改动为对比草案」/「丢弃我的改动」二选一。
- **编辑会话租约（防残留锁）**：编辑会话带 heartbeat lease；**超时（默认 10 分钟无操作）自动失效**；他人可**强制接管**。避免某个编辑窗口长期占住或掉线残留把配置锁死。
- **粒度**：一份配置（`nginx_configs` / 块树）一个版本；跨行业天然隔离（不同 industry 互不影响）。
- **导出为只读**：导出/预览写库不落库，不参与冲突。

## 6. 后端 API 扩展（叠加于方案C §4）

| 端点 | 说明 |
|---|---|
| `GET /api/industries` / `POST` / `PUT /{id}` / `DELETE /{id}` | 行业基础信息 CRUD |
| `POST /api/industries/clone` | 体 `{source_industry_id, name, owner?}` → 事务深拷贝生成新行业 + 整套配置 |
| 各资源列表/写入带 `industry_id` 过滤 | 行业维度作用域（配置/映射/转发/upstream/block） |
| `nginx_configs` 详情/列表返回 `version` | 供前端基线比对 |
| 写接口携带 `base_version` | 不一致返回 409 |
| `POST /api/configs/{id}/edit-heartbeat` / `release` | 编辑会话租约续期 / 释放 |
| 接管 | 明确传 `force=true` 的写或解锁操作 |

## 7. 前端组件（叠加于方案C §5）

- `LoginPage`：登录表单 + 验证码。
- `IndustryDashboard`：行业管理落地页（顶栏 + KPI 丝带 + 行业行列表 + 主题切换）。
- `IndustryCloneModal`：新建行业 / 从模板克隆（选模板源 + 命名）。
- 顶层受保护布局外层套「行业作用域」；方案C 内页按 `:industryId` 读取；进入行业内沿用方案C 内部结构（主从 + BlockTree + 拓扑 + 业务端口 + 导出中心）。
- `ThemeProvider`：暴露 纯黑/软深/浅色 三套 CSS 变量集（与 `dashboard.html` 一致），默认软深。
- 并发：编辑态记录 `base_version`；提交 409 时引导对比/保留草稿。

## 8. 错误处理与测试

- 克隆失败整体回滚（事务）；作业务内一致性（嵌套 parent_id 完整性）。
- 冲突 409 → 前端引导对比/保留草稿；租约超时 → 提示可能被他人接管。
- 测试：
  - 后端：`industries` CRUD；克隆深拷贝（整棵块树 + 全关联 + 计数一致）；版本冲突 409；租约过期/接管。
  - 前端：登录 → 行业列表 → 进入行业 → 内页按行业读取；主题切换三套变量生效；冲突弹窗引导。

## 9. 范围外（YAGNI）

- 不做细粒度行级锁 / 多人实时协作合并。
- 不做模板版本管理与推送到已派生行业（克隆后即独立）。
- 不改动方案C 内页结构与导出规约；仅加行业作用域与并发两层。

## 10. 安全（2026-10-13 补充，全应用内外两层通用）

本系统**渲染并回写用户可控的 nginx 配置文本**，属对安全要求较高的运维面。以下为外壳层与内页共同遵守的最低安全基线（内页 XSS/命令注入细项见 `2026-10-08-…-nginx-console-design.md` §10）：

**① XSS（首要）**
- 一切来自数据库/配置的用户可控文本（server_name、upstream IP、KV 指令值、raw/正则键、头部、路径、行业名/备注等）渲染时**必须转义**：React 用 JSX 自动转义，严禁把未经转义的配置文本拼进 `innerHTML`；纯 JS/任何 `dangerouslySetInnerHTML` 前必须 `escapeHtml` 白名单消毒。
- 存储型 XSS：持久化的配置内容若在块树/预览/拓扑不安全渲染即形成存储型 XSS，须在**渲染点**统一走转义函数（内页 pure function 迁移时尤其注意）。
- 全局 `Content-Security-Policy`：禁用 `unsafe-inline` 脚本，限制 `frame-ancestors` 等；用户内容区不执行内联事件脚本。

**② 命令注入**
- 后端执行 `nginx -t` / `reload` / 连通性测试时：一律**子进程 + 参数数组**（`subprocess.run([…], shell=False)`），配置内容/文件名**绝不**拼进 shell 字符串；配置先写入临时文件、以文件路径作为参数传入，运行后删除。
- 校验文件路径：`config_path` / `.stream` 名称/导出文件名做白名单正则（仅字母数字 `-_./`），阻止路径遍历与写越界目录。

**③ 越权 / 行业隔离**
- 全部读取/写入按 `industry_id` 做租户级鉴权：用户仅能访问被授权的行业及其配置；任意鉴权中间件对 `industry_id` 做归属校验，防 IDOR/跨行业访问。
- 登录沿用 JWT + 验证码；登录接口限流（防爆破）；`DELETE /api/industries/:id` 仅管理员等可执行。

**④ 其他基线**
- SQL 注入：统一 ORM 参数化（FastAPI + SQLAlchemy），无字符串拼接。
- CSRF：JWT 放 `Authorization` 头（非 Cookie 会话）；若未来用 Cookie 会话须加 `SameSite` + CSRF token。
- 越权不可达服务：拓扑「连通性测试」限制目标为受控内网/IP 白名单，防 SSRF。
- 安全响应头：`X-Content-Type-Options`、`CSP`、`Referrer-Policy`；生产强制 HTTPS。
- 导出/下载：文件名做编码与头注入防护（`Content-Disposition` 用安全文件名，防 CRLF 注入）。
- 输入校验（前端 + 后端双重）：行业名、owner、组名、IP、域名、新指令值均按各自白名单/格式校验后落库。