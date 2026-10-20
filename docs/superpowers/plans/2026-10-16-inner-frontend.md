# 内页① · Nginx 配置可视化管理系统（前端）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已验收的 `.nginx-mock/plan-c-real-conf.html`（2079 行）全量转写为 React，交付「配置文件 / 块管理 / 全局拓扑 / 业务端口 / Upstream 池 / 导出中心」六视图，替换现有 `frontend/src/pages/IndustryDetail.jsx`。

**Architecture:** 行业工作台：标题栏 + 顶部四视图菜单 + 左侧资源树 + 状态栏 + 主区三栏（配置文件主从 / 块管理 / 拓扑 / 业务端口 + 右栏 Upstream 池）。所有算法（解析 / 渲染 / 导出 / 拓扑 / 监听剥离 / upstream 判定）集中在 `frontend/src/lib/nginx-inner.js` 纯函数模块，**逐字移植** mock（移植契约见 spec §6.7）。视图组件只做 JSX 渲染与 API 编排。编辑态 = 本地树变更 → `renderPreview` 重渲染 → 逐条持久化到 config-blocks/config-options。409 版本冲突与编辑租约复用外壳②的 `api/concurrency.js`。XSS 遵守 spec §10：JSX 自动转义；任何 `dangerouslySetInnerHTML` 必须先过 `escapeHtml`（已并入 `esc`）。

**Tech Stack:** React 18 + Vite 5 + antd 5.20 + @ant-design/icons 5.4 + react-router-dom 6.26 + axios 1.7；IDE 深色主题（复用外壳② ThemeProvider 三套主题 token，见 `frontend/src/theme/`）；无前端测试框架 → 纯函数用 `node --input-type=module` 冒烟验证；UI 冒烟用 `npm run build` + 浏览器手测清单。

**前置依赖（重要）：** 后端「内页①-后端」计划须**全部完成**再启动本计划。当前后端已到 Task 5（渲染/导出已就绪）；T6（test/reload/validate 端点）、T7（拓扑）、T8（指令字典）、T9（三个列表端点改行业作用域）、T10（seed 块树演示数据）尚未落地。本计划所有端点契约均取自后端计划已设计形状，若后端存在出入以实际后端为准并同步修正本计划引用。

---

## 后端端点契约（本计划引用基准）

| 方法 | 路径 | 请求 | 响应要点 |
|---|---|---|---|
| GET | /api/nginx-configs?industry_id= | query | NginxConfig 列表（name/config_text/version/industry_id） |
| PUT | /api/nginx-configs/{id} | {config_text, base_version} | 409 `{code:"VERSION_CONFLICT",current_version}`；成功 version+1 |
| POST | /api/nginx-configs/{id}/edit-heartbeat | {holder} | 423 `{code:"LEASE_HELD",holder}` 或授权成功 |
| POST | /api/nginx-configs/{id}/edit-release | {holder} | `{message}` |
| GET | /api/nginx-configs/{id}/tree | - | `{config_id, blocks:[嵌套{id,scope,header,sort_order,children,options[{id,directive,value,row_type,is_free_text,sort_order}]}]}` |
| GET | /api/nginx-configs/{id}/render?context= | - | `{content}`（渲染文本，default 置底） |
| POST | /api/nginx-configs/{id}/export | ExportRequest | `{content}` |
| POST | /api/nginx-configs/{id}/validate | {content} | `{ok,output,error_line}` |
| POST | /api/nginx-configs/{id}/reload | - | `{ok,output}` |
| POST | /api/nginx-configs/{id}/test | - | `{results:[{host,port,ok,error?,latency_ms?}]}` |
| POST | /api/forward-ports/{forward_id}/test | - | `{ok,host?,port?,error?,latency_ms?}` |
| GET/POST | /api/config-blocks?nginx_config_id= / `{id}` CRUD | ConfigBlockCreate{nginx_config_id,parent_id?,scope,header,belongs_to_file?,sort_order?} | 块 CRUD；DELETE 级联子树 |
| GET | /api/config-blocks/{id}/children | - | 子块列表 |
| GET/POST/PUT/DELETE | /api/config-options?block_id= / `{id}` CRUD | ConfigOptionCreate{block_id,directive,value?,row_type?,is_free_text?,sort_order?} | 列表 default 恒置底 |
| PUT | /api/config-options/reorder | {block_id,ids} | `{message}` |
| GET/POST/PUT/DELETE | /api/upstreams?industry_id= / `{id}` CRUD | UpstreamCreate{industry_id,name,strategy,keepalive} | 重名 409 |
| GET/POST/PUT/DELETE | /api/upstreams/{id}/servers | UpstreamServerCreate{addr,port?,weight?,health_status?,enable?} | 节点 CRUD |
| GET | /api/upstreams/{id}/preview | - | `{content}` upstream 片段 |
| POST | /api/upstreams/{id}/validate | - | `{ok,output,error_line}` |
| GET | /api/topology?config_id= | - | `{domains:[],listeners:[{id,listen,listen_plain,server_name,location_count,proxy_targets}],upstreams:[{id,name,backends:[{addr,port,raw}]}],links:[{listen,upstream}]}` |
| GET | /api/directives | - | `[{name,description,context}]`（29 条） |
| GET | /api/domain-mappings?industry_id= | query | 域名映射列表（is_primary 等） |
| GET | /api/forward-ports?industry_id= | query | 转发规则列表（path/target/upstream_id/upstream_target/端口/公网内网/启用） |
| GET | /api/biz-ports?industry_id= | query | 业务端口列表 |
| GET | /api/industries/{id} | - | 行业信息（name/owner/is_template） |

> ExportRequest 字段：`{ssl_enabled:bool, server_name_domain:string, upstream_default_ips:string, upstream_exceptions:[{grp:string, ips:string}], context:string}`。

---

### Task 1: API 客户端扩展（补行业作用域 + 内页①端点）

**Files:**
- Modify: `frontend/src/api/nginx.js`
- Create: `frontend/src/api/nginxInner.js`

- [ ] **Step 1: 修改 `frontend/src/api/nginx.js` 三个列表方法，补行业作用域参数**

后端 T9 后 domain-mappings / forward-ports / biz-ports 列表必传 `industry_id`。把三处无参方法改为：

```js
// ---- 域名映射 ----
export function listDomainMappings(industryId) {
  return client.get("/domain-mappings", { params: { industry_id: industryId } });
}
// ---- 转发端口 ----
export function listForwardPorts(industryId) {
  return client.get("/forward-ports", { params: { industry_id: industryId } });
}
// ---- 业务端口（含公网开放开关）----
export function listBizPorts(industryId) {
  return client.get("/biz-ports", { params: { industry_id: industryId } });
}
```

其余方法（create/update/delete、`listConfigsByIndustry`）保持不变。`listNginxConfigs()` 无参调用已无使用方，可保留不删（YAGNI：不主动清理）。

- [ ] **Step 2: 新建 `frontend/src/api/nginxInner.js`（内页①全部新端点）**

```js
import client from "./client";

// ---- 配置块树 ----
export function listBlocks(nginxConfigId) {
  return client.get("/config-blocks", { params: { nginx_config_id: nginxConfigId } });
}
export function createBlock(data) {
  return client.post("/config-blocks", data);
}
export function updateBlock(id, data) {
  return client.put(`/config-blocks/${id}`, data);
}
export function deleteBlock(id) {
  return client.delete(`/config-blocks/${id}`);
}
export function blockChildren(blockId) {
  return client.get(`/config-blocks/${blockId}/children`);
}

// ---- 配置选项（KV 行）----
export function listOptions(blockId) {
  return client.get("/config-options", { params: { block_id: blockId } });
}
export function createOption(data) {
  return client.post("/config-options", data);
}
export function updateOption(id, data) {
  return client.put(`/config-options/${id}`, data);
}
export function deleteOption(id) {
  return client.delete(`/config-options/${id}`);
}
export function reorderOptions(blockId, ids) {
  return client.put("/config-options/reorder", { block_id: blockId, ids });
}

// ---- 配置树 / 渲染 / 导出 / 动作 ----
export function getConfigTree(configId) {
  return client.get(`/nginx-configs/${configId}/tree`);
}
export function renderConfig(configId, context = "conf") {
  return client.get(`/nginx-configs/${configId}/render`, { params: { context } });
}
export function exportConfig(configId, payload) {
  return client.post(`/nginx-configs/${configId}/export`, payload);
}
export function validateNginxConfig(configId, content) {
  return client.post(`/nginx-configs/${configId}/validate`, { content });
}
export function reloadNginx(configId) {
  return client.post(`/nginx-configs/${configId}/reload`);
}
export function testNginxConfig(configId) {
  return client.post(`/nginx-configs/${configId}/test`);
}
export function testForwardPort(forwardId) {
  return client.post(`/forward-ports/${forwardId}/test`);
}

// ---- Upstream 池 ----
export function listUpstreams(industryId) {
  return client.get("/upstreams", { params: { industry_id: industryId } });
}
export function createUpstream(data) {
  return client.post("/upstreams", data);
}
export function updateUpstream(id, data) {
  return client.put(`/upstreams/${id}`, data);
}
export function deleteUpstream(id) {
  return client.delete(`/upstreams/${id}`);
}
export function listUpstreamServers(upstreamId) {
  return client.get(`/upstreams/${upstreamId}/servers`);
}
export function createUpstreamServer(upstreamId, data) {
  return client.post(`/upstreams/${upstreamId}/servers`, data);
}
export function updateUpstreamServer(upstreamId, serverId, data) {
  return client.put(`/upstreams/${upstreamId}/servers/${serverId}`, data);
}
export function deleteUpstreamServer(upstreamId, serverId) {
  return client.delete(`/upstreams/${upstreamId}/servers/${serverId}`);
}
export function upstreamPreview(upstreamId) {
  return client.get(`/upstreams/${upstreamId}/preview`);
}
export function validateUpstream(upstreamId) {
  return client.post(`/upstreams/${upstreamId}/validate`);
}

// ---- 拓扑 / 指令字典 ----
export function getTopology(configId) {
  return client.get("/topology", { params: { config_id: configId } });
}
export function listDirectives() {
  return client.get("/directives");
}
```

- [ ] **Step 3: 冒烟验证**

Run: `node --input-type=module -e "import('./src/api/nginxInner.js').then(m=>{console.log(Object.keys(m).length)})"`（在 `frontend` 目录）
Expected: 输出端点方法个数（约 28）；无 import 报错。`npm run build` 通过。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/api/nginx.js frontend/src/api/nginxInner.js
git commit -m "feat(api): 内页①端点客户端 + 列表方法补行业作用域"
```

---

### Task 2: 纯函数模块 `frontend/src/lib/nginx-inner.js`（逐字移植 mock）

**Files:**
- Create: `frontend/src/lib/nginx-inner.js`
- Create: `frontend/src/lib/nginx-inner.smoke.mjs`（临时冒烟脚本，验证后删除）

**移植原则：** 以 `.nginx-mock/plan-c-real-conf.html` 为唯一算法真源。除下表「适配说明」外，函数体**逐字拷贝**，不重写逻辑、不简化。每个函数下方标注 mock 行号便于校对。mock 中的全局变量（`CTX`/`TREE`/`MIRRORS`/`UPSTREAM_SET`）在本模块内以模块级 `let` 状态 + getter/setter 暴露，组件层通过 context 同步。

- [ ] **Step 1: 写冒烟脚本（先红）**

新建 `frontend/src/lib/nginx-inner.smoke.mjs`：

```js
import {
  esc, qq, kvify, scopeOf, parse,
  hydrateOption, normalizeTree,
  isRawKV, rawText, orderedOptions, listenPlain, proxyHostOf,
  renderPreview, buildTree, rebuildSelected,
  domParse, applyDomains, upNameOf, upKeyOf, upNodePorts, upNodeParams,
  upNodeRaws, deriveUpBackends, ipsForGroup, derivedFor, exportLines,
  setCtx, getCtx, setTree, getTree, getMirrors,
} from "./nginx-inner.js";

const src = [
  "map $http_upgrade $connection_upgrade {",
  "  default upgrade;",
  "  '' close;",
  "}",
  "server {",
  "  listen 443 ssl http2;",
  "  server_name api.example.com;",
  "  location / {",
  "    proxy_pass http://backend_api;",
  "  }",
  "}",
  "upstream backend_api {",
  "  server 10.0.0.1:8080 weight=3;",
  "  keepalive 32;",
  "}",
].join("\n");

const [tree] = parse(src, "http");
if (scopeOf("location /") !== "location") throw new Error("scopeOf 失败");
const mapBlock = tree.children.find((c) => c.scope === "map");
if (!mapBlock) throw new Error("map 未解析");
const opts = orderedOptions(mapBlock.options);
if (opts[0].directive !== "''" || opts[1].directive !== "default") throw new Error("default 未置底");
const srv = tree.children.find((c) => c.scope === "server");
const lp = listenPlain(srv.options.find((o) => o.directive === "listen").value);
if (lp !== "443") throw new Error("listenPlain 失败: " + lp);
const up = tree.children.find((c) => c.scope === "upstream");
if (upNameOf(up) !== "backend_api") throw new Error("upNameOf 失败");
setCtx("conf");
const kb = buildTree(tree, null);
if (!kb || !kb.length) throw new Error("buildTree 失败");
const exp = exportLines(tree, { sslOn: false, domNew: "", defaultIps: "10.0.0.2", exceptions: [] });
if (!Array.isArray(exp) || !exp.some((e) => /10\.0\.0\.2/.test(e.text))) throw new Error("exportLines 替换失败");
console.log("SMOKE OK", exp.length, "lines");
```

- [ ] **Step 2: 运行确认失败**

Run: `node src/lib/nginx-inner.smoke.mjs`（`frontend` 目录）
Expected: FAIL —— `ERR_MODULE_NOT_FOUND`（模块未建）

- [ ] **Step 3: 逐字移植纯函数到 `frontend/src/lib/nginx-inner.js`**

模块骨架与适配点（函数体一律去 mock 行号逐字拷贝）：

```js
/* 内页① 纯函数模块 —— 逐字移植 .nginx-mock/plan-c-real-conf.html，算法真源以 mock 为准 */

// ---- 状态（对应 mock 全局）----
let CTX = "conf";            // "conf" | "stream"
let TREE = [];               // parse() 输出数组，当前活动文件树
let MIRRORS = {};            // mock L999-1034：端口对 {443:20551} 等
let UPSTREAM_SET = new Set();
let selected = null;         // buildTree 选中节点

export function setCtx(c) { CTX = c; }
export function getCtx() { return CTX; }
export function setTree(t) { TREE = t; }
export function getTree() { return TREE; }
export function getMirrors() { return MIRRORS; }
export function setSelected(n) { selected = n; }
export function getSelected() { return selected; }

// ---- 基础工具 ----
export function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }   // mock L996
export function qq(s) { return esc(s).replace(/"/g, "&quot;"); }                                                                   // mock L997

// ---- 解析 ----
export function kvify(t) { ... }    // mock L919-923 逐字
export function scopeOf(h) { ... }  // mock L925 前（scope 判定；从 mock L900-918 区段逐字）
export function parse(src, rootScope) { ... } // mock L925-955 逐字
```

**每个函数的移植对照表（顺序移植，逐个对照 mock 行号）：**

| # | 函数 | mock 行号 | 适配说明 |
|---|---|---|---|
| 1 | `esc` / `qq` | L996-997 | 原样；`esc` 兼作 XSS 消毒入口（spec §10） |
| 2 | `kvify` | L919-923 | 原样；未传 `raw` 的行由 `hydrateOption` 兜底 |
| 3 | `scopeOf` | L900-918 | 原样（server/location/map/upstream/split_clients/geo/if/limit_except/stream/events/http 判定） |
| 4 | `parse` | L925-955 | 原样；返回 `[root]` |
| 5 | `hydrateOption(o)` | 新函数（对应后端 `_option_dict`，见 nginx_render.py L245-249） | `if (o.is_free_text || o.row_type === "raw") o.raw = o.directive; else o.raw = o.directive + (o.value ? " " + o.value : "");` 返回 o。DB 树选项无 `raw`，进纯函数前必须 hydrate |
| 6 | `normalizeTree(tree)` | 新函数 | 递归：每个 block 补 `parent` 指针与 `level`；每个 option `hydrateOption`；`walk` 分配 `_id/_depth`（mock L959 逐字）；构建 `UPSTREAM_SET = nodesInCtx(["upstream"]).map(upNameOf)` |
| 7 | `isRawKV(o)` | L1089 | 原样 |
| 8 | `rawText(o)` | L1090 | 原样 |
| 9 | `orderedOptions(n)` | L1091-1097 | 原样（default 恒置底） |
| 10 | `listenPlain(b)` | L1098-1103 | 原样（剥离 ssl/http2/backlog 修饰词；unix 原样） |
| 11 | `proxyHostOf(pv)` | L1079-1088 | 原样 |
| 12 | `renderPreview(node)` | L1535-1557 | 原样（comment→`# `、if→`# 建议少用 if`、raw 去尾 `;` 再补 `;`、default 置底、缩进） |
| 13 | `buildTree(tree, sel)` | L1216-1290 | 原样（通用虚拟根使 http/stream/events 并列；返回可视树） |
| 14 | `rebuildSelected()` | L1371-1397 | 适配：签名改为 `rebuildSelected(tree, ctx)`，内部依赖的全局改为入参/模块状态 |
| 15 | `domParse(s)` | L1915 | 原样 |
| 16 | `applyDomains(raw, domNew)` | L1916-1922 | 原样；签名补 `domNew` 入参 |
| 17 | `upNameOf(n)` | L1923 | 原样 |
| 18 | `upKeyOf(n)` | L1924 | 原样（`CTX + ":" + upNameOf(n)`） |
| 19 | `upNodePorts` / `upNodeParams` / `upNodeRaws` | L1926-1928 | 原样 |
| 20 | `deriveUpBackends(g, ips)` | L1930-1939 | 原样 |
| 21 | `ipsForGroup(k)` | L1940-1943 | 适配：签名 `ipsForGroup(k, exceptions, defaultIps)` |
| 22 | `derivedFor(g, exceptions, defaultIps)` | L1944 | 适配：转发参数 |
| 23 | `exportLines(tree, cfg)` | L1989-2030 | 适配：`cfg={sslOn,domNew,defaultIps,exceptions}`；内部 `walkEx(n,d)`（L1994）原样；`SSL_DROP`（L1908 附近）原样；返回 `[{text,changed,orig}]` |

- [ ] **Step 4: 运行冒烟确认通过**

Run: `node src/lib/nginx-inner.smoke.mjs`
Expected: `SMOKE OK ... lines`

Run: `npm run build` 通过（模块可被 Vite 打包）。

- [ ] **Step 5: 删除冒烟脚本并提交**

```bash
git add frontend/src/lib/nginx-inner.js
git commit -m "feat(lib): 移植 mock 纯函数模块（解析/渲染/导出/拓扑）"
```

> 删除 `nginx-inner.smoke.mjs` 后再提交；如后续 Task 需复用冒烟可再临时创建（不进 git）。

---

### Task 3: 行业工作台外壳（替换 IndustryDetail.jsx + 四视图路由 + 资源树 + 状态栏）

**Files:**
- Rewrite: `frontend/src/pages/IndustryDetail.jsx`（整页重写为工作台外壳）
- Create: `frontend/src/pages/ops/` 下视图容器（本 Task 先建外壳与占位视图切换，视图内容由 T4-T9 填充）

- [ ] **Step 1: 工作台外壳组件**

`frontend/src/pages/IndustryDetail.jsx` 重写为「行业工作台」：

- 顶部：标题栏（36px）—— 左 `☰` + 当前上下文文件名（`FILE_NAME[CTX]`，conf→`businesscenter_nginx_CD_master.conf` / stream→`.stream`，CTX 来自 lib 状态）+ 绿色状态点；右窗口控制三圆点（纯装饰）。
- 顶部菜单（38px，4 项）：`配置文件 | 块管理 | 全局拓扑 | 业务端口`；激活项底部 2px 品牌蓝条；点击 `setView(name)` 切换（fadeIn 0.2s），同时右侧固定挂 `Upstream 池` 抽屉/右栏（T8 实现，先占位）。
- 左侧资源树（~220px）：`监听点 (N)`（server 列表，行内悬停浮层：连通性测试/启用·停用/reload）+ `共性块`（map/upstream/split_clients/geo）；底部 `.ctxseg` 分段控件 `conf | stream` 切换 `setCtx`，切换后重载树与计数。
- 状态栏（28px）：左 `main ● clean`；中错误(红)/警告(黄)计数；右 `conf/stream` 上下文 + 行/列 + `N 条域名替换 · M 组 upstream 整组替换`（导出中心联动，T9 填充）。
- 主区：按 `view` 渲染对应视图组件（`ConfigPage` / `BlockPage` / `TopologyPage` / `BizPortPage`），T4-T7 逐个填充。

**state 设计（本 Task 建立）：**

```js
const [industry] = useState(null);        // getIndustry(id)
const [configs, setConfigs] = useState([]); // listConfigsByIndustry(id)
const [configId, setConfigId] = useState(null); // 当前选中配置（ListPanel 主从联动）
const [view, setView] = useState("config"); // "config"|"block"|"topology"|"biz"
const [ctx, setCtxState] = useState("conf"); // 同步 lib setCtx
const [tree, setTreeState] = useState([]);   // 当前活动树（normalizeTree 后）
const [dirty, setDirty] = useState(false);   // 是否有未持久化改动
```

加载链：`getIndustry(id)` → `listConfigsByIndustry(id)` → 选中首个配置 → `loadTree(configId, ctx)`。`loadTree` 调 `getConfigTree(configId)`，对返回 `{blocks}` 用 `normalizeTree` 补 parent/raw/_id，`setTree(lib)`。

- [ ] **Step 2: 验证**

Run: `npm run build` 通过；`npm run dev` 后登录进入 `/ops/:industryId`，可见：标题栏/四菜单/资源树/状态栏、配置列表加载、默认进入配置文件视图（T4 前先渲染一个「配置文件视图待实现」占位）。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/pages/IndustryDetail.jsx
git commit -m "feat(ui): 行业工作台外壳（标题栏/四视图菜单/资源树/状态栏/上下文切换）"
```

---

### Task 4: 配置文件视图（主从 + 五 Tab + 统计看板 + 行级操作 + 409/租约）

**Files:**
- Create: `frontend/src/pages/ops/ConfigPage.jsx`（ListPanel + DetailPanel）
- Create: `frontend/src/pages/ops/StatBanner.jsx`
- Create: `frontend/src/pages/ops/OverviewGrid.jsx`
- Create: `frontend/src/pages/ops/BlockTree.jsx`（基础只读渲染 + KV 行编辑，T5 扩展）
- Modify: `frontend/src/pages/IndustryDetail.jsx`（view==="config" 挂载 ConfigPage）

- [ ] **Step 1: ListPanel（左 ~300px）**

```jsx
// 搜索/筛选/行选中/告警红条；onSelect(config) → 刷新右侧
// 行字段：name / version / 域名数 / 启用状态；告警行（test 失败或 validate 失败）红条
```

数据：`configs`（来自外壳）。行点击 → `setConfigId(id)` + 刷新 DetailPanel 各 Tab 数据。

- [ ] **Step 2: DetailPanel 五 Tab**

Tab 结构：`概览 / 域名映射 / 转发规则 / 业务端口 / 块树`。顶部工具栏：行级操作（`连通性测试`→testNginxConfig / `启用·停用` / `reload`→reloadNginx / `nginx -t`→validateNginxConfig(configId, renderConfig content)）、`＋ 块`（T5 addBlockModal）、`导出配置`（T9 ExportModal）、`保存`（T5 持久化）。

- **概览 Tab**：OverviewGrid（name/listen_port/is_public/status/version）+ StatBanner。
- **域名映射 Tab**：domain-mappings 列表（is_primary 主域名标记）+ 增删改（Modal 表单），`listDomainMappings(industryId)`。
- **转发规则 Tab**：forward-ports 列表（path/target（upstream 组名或 IP）/端口/公网·内网开关/启用状态）+ 行内测试（testForwardPort）/启停/编辑。
- **业务端口 Tab**：biz-ports 列表（端口经 listenPlain 展示）+ 增删改。
- **块树 Tab**：BlockTree（见下）。

- [ ] **Step 3: StatBanner + 监听点表格**

四统计卡：`server / location / upstream / if` 计数（对当前 tree 递归计数，复刻 mock `countAll` L977-988）。下挂全量监听点表格：

```jsx
// 对 tree 中 scope==="server" 的节点：
//   监听点 = listenPlain(listen 行 value)
//   主要上游 = proxy_pass 目标分类：组名命中 UPSTREAM_SET → ✓已匹配(绿tag) / 未命中 → ✗未匹配(红tag) / IP·域名直连 → 直连(橙tag)
//   proxyHostOf 复用 lib（mock L1079-1088）；matchok 语义见 spec §6.3
```

- [ ] **Step 4: KV 行编辑器（块内基础编辑，T5 完整化）**

块树 Tab 内嵌 KvListEditor：
- 每块 options 列表：`directive value` 行；`row_type==="comment"` → `# value` 灰色；`is_free_text/row_type==="raw"` → 原样 `raw` 行。
- `default` 行强制置底（绿底徽章，不可 ▲▼）；其余行行内 `▲▼` 重排（`reorderOptions(blockId, ids)`）。
- 悬停行尾 `kv-ed`（编辑弹窗：指令名 + 值，Esc 还原）与 `kv-del`（删除，二次确认后 `deleteOption`）。
- 指令名输入用 `listDirectives()` 提供 datalist 自动补全。
- 新增 `＋ KV` 按钮 → `createOption`。

- [ ] **Step 5: 409 冲突 + 编辑租约心跳**

编辑任何已持久化内容（config_text 保存、块/选项变更）前：
- `updateConfig(configId, {config_text, base_version})`；捕获 409 用 `isVersionConflict(error)` 判断 → 弹 Modal：`内容已变更（当前版本 V{n}），请加载最新并保留你的改动为对比草案，或放弃改动`；按钮 `加载最新`（刷新树丢弃本地）/ `保留草案`（把本地改动暂存 state，加载最新后并排对比）。
- 编辑会话：进入块树 Tab 时 `heartbeat(configId, holder)`（holder=用户名）；`setInterval` 每 60s 心跳（`edit-heartbeat`）；离开/切配置 `releaseConfig(configId, holder)`。收到 423 `LEASE_HELD` → Toast `该配置正被他人编辑中` + 提供 `强制接管`（重新 heartbeat）。
- holder 取 `getToken()`（`frontend/src/store/auth.js`）的前 8 位字符串（该 store 仅导出 getToken/setToken/clearToken，无用户名解析；holder 仅用于租约归属标识，token 前缀足够且不泄露）。

- [ ] **Step 6: 验证**

Run: `npm run build` 通过。手测：五个 Tab 数据加载、StatBanner 计数与 mock 一致、KV 增删改查、409 弹窗（改 base_version 模拟）、租约心跳日志（Network 面板见 edit-heartbeat 每 60s）。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/pages/ops/ frontend/src/pages/IndustryDetail.jsx
git commit -m "feat(ui): 配置文件视图（主从/五Tab/统计看板/行级操作/409冲突/租约心跳）"
```

---

### Task 5: 块管理视图（BlockTree 全功能 + addBlockModal + 镜像同步 + 持久化）

**Files:**
- Modify: `frontend/src/pages/ops/BlockTree.jsx`（只读 → 全功能编辑）
- Create: `frontend/src/pages/ops/AddBlockModal.jsx`
- Modify: `frontend/src/pages/IndustryDetail.jsx`（view==="block" 挂载块管理页；复用 BlockTree 全屏模式 + 导出入口）

- [ ] **Step 1: BlockTree 树渲染（对齐 mock buildTree L1216-1290）**

- 数据源：外壳 `tree`（normalizeTree 后）。`buildTree(tree, selected)` 返回可视树（通用虚拟根，http/stream/events 并列）。
- 树节点：`server ⊃ location ⊃ if/limit_except` 任意嵌套；map/split_clients/geo 的 `default` 恒置底徽章；正则键/引号行 `.kv-raw` 整行原样；`comment` 输出 `# 前缀`；`include` 输出 `include <path>;`；raw 照录。
- 缩进线表达 parent_id 层级；listen 行剥离 ssl/http2；proxy_pass 行尾挂 `已匹配/未匹配组/直连` mini 标签（复用 T4 逻辑）。
- 节点类型标签（scope badge）：server/location/map/upstream/if/comment/raw 各一色。

- [ ] **Step 2: 编辑能力（统一钩子）**

所有已提交变更走 `rebuildSelected()` 等价流程：**本地树变更 → setTree → renderPreview(tree) 重渲染预览（右/下方预览窗）→ 持久化**。持久化映射：

| 操作 | mock 函数 | 持久化调用 |
|---|---|---|
| ＋ 子块（location/if/limit_except，header 模板） | `addChildOfType` L1413-1420 | `createBlock({nginx_config_id,parent_id,scope,header})` |
| ＋ KV | `addKvEdit` L1421 | `createOption({block_id,directive,value,row_type:"kv"})` |
| ＋ 注释 | `addCommentEdit` L1424 | `createBlock({...,scope:"comment",header:文本})` |
| 编辑 KV | kv-ed 弹窗 | `updateOption(id,{directive,value})` |
| 删除 KV | `kv-del` | `deleteOption(id)`（二次确认） |
| 删除子块（含 location，根除外） | 块头 `×` | `deleteBlock(id)`（级联子树，二次确认） |
| KV/子块 ▲▼ 重排 | `moveOption` L1398-1412 | `reorderOptions(blockId, ids)` / 块 `sort_order` 更新 |
| 新增顶级块弹窗 | `abSetScope`/`abOK` L1442-1533 | `createBlock({...,parent_id:null})`（插到选中顶级块之后：sort_order=选中+1） |

- `＋ 子块` 展开可选：`location /`、`if ($cond) {`、`limit_except METHOD…`（header 模板）。
- 顶层整块可删（修剪整棵子树，禁残留）：根节点（http/stream/events 虚拟根）不可删。

- [ ] **Step 3: AddBlockModal（新增顶级块弹窗）**

分段选择：`server / map / split_clients / geo / upstream`（stream/events/http 仅识别不新增）。map-like 沿用 default 置底 + 正则键原样。支持「插到选中顶级块之后」。非 `window.prompt`，antd Modal + Select/Radio。

- [ ] **Step 4: server 镜像同步**

移植 mock L999-1078（`MIRRORS` 端口对 + `initMirrors` L1035 + `syncMirrors` L1052）：
- `MIRRORS = {443:20551}` 演示端口对（模块状态）。
- 编辑某 server 块内 listen/其他行时，自动把变更同步到镜像 server（保留对方自身 listen 行）。
- **声明先于调用**：`MIRRORS` 与 `syncMirrors` 在模块顶部定义后再被编辑钩子引用（var 提升陷阱，转译时注意 let/const 顺序）。

- [ ] **Step 5: 块管理页**

`view==="block"` 全屏块管理：左树（BlockTree 编辑态）+ 右预览（`renderPreview(tree)` 输出 + 行号）。顶部工具栏含 `导出配置`（T9）。保存按钮：把本地未持久化变更一次性刷出 diff 确认后逐条落库（dirty 标记来自外壳）。

- [ ] **Step 6: 验证**

手测清单：＋子块/＋KV/＋注释/删除/重排全链路；map default 置底；正则键原样；addBlockModal 各类型；镜像同步（改 443 server 的 location 看 20551 server 同步）；删除顶级块子树后侧栏/计数无残留；预览与 mock 逐行一致。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/pages/ops/ frontend/src/pages/IndustryDetail.jsx
git commit -m "feat(ui): 块管理视图（BlockTree 全功能/顶级块弹窗/镜像同步/持久化）"
```

---

### Task 6: 全局拓扑视图

**Files:**
- Create: `frontend/src/pages/ops/TopologyPage.jsx`
- Create: `frontend/src/pages/ops/GlobalChain.jsx`
- Create: `frontend/src/pages/ops/GroupDetail.jsx`
- Modify: `frontend/src/pages/IndustryDetail.jsx`（view==="topology" 挂载）

- [ ] **Step 1: 数据与聚合**

`getTopology(configId)` → `{domains, listeners, upstreams, links}`。渲染全部四个数组；拓扑不可达（404/网络错）→ 骨架屏 + `重试` 按钮（spec §7）。

- [ ] **Step 2: 四层全局链路 GlobalChain**

`业务域名 → 监听点(端口·listenPlain) → path → upstream 组 → 后端节点(addr:port · 权重)` 一条链路，节点纯 CSS/HTML 渲染（`links` 数组把 listen↔upstream 串起来；监听点的 `proxy_targets` 提供 path→组）。

- 双向可点：链路节点点击 → 跳转对应配置视图并定位（`setView("config")` + 选中对应 config / 高亮 server）；配置视图反向高亮（T4 中 server 行点击 → 切拓扑并选中同 listen 节点）。
- 简化实现：拓扑节点记录 `{listen, upstream}` 对，点击链路节点 → `setView("config")` 并 `setHighlightListen(listen)`；配置视图收到 `highlightListen` prop 时高亮该监听点行。

- [ ] **Step 3: GroupDetail**

选中 upstream 组详情：`被引用`（links 中命中该组的监听点数）+ `后端节点`（backends 表）。未引用/健康检查失败节点红角标提示（backends 无健康字段时仅展示 addr:port）。

- [ ] **Step 4: matchok 语义**

`UPSTREAM_SET`（lib 内 normalizeTree 构建）全量组名集合；proxy_pass 目标分类：组名/IP直连/域名直连；仅组名校验（命中绿✓/未命中红✗），直连橙色不警示。复刻 mock `proxyHostOf` L1079-1088 判定。

- [ ] **Step 5: 验证**

手测：拓扑四层链路渲染与 mock 一致；点击链路跳转配置视图并定位；GroupDetail 被引用计数正确。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/pages/ops/
git commit -m "feat(ui): 全局拓扑视图（四层链路/双向联动/组详情）"
```

---

### Task 7: 业务端口视图（BizPortChips + PathChain）

**Files:**
- Create: `frontend/src/pages/ops/BizPortPage.jsx`
- Create: `frontend/src/pages/ops/BizPortChips.jsx`
- Create: `frontend/src/pages/ops/PathChain.jsx`
- Modify: `frontend/src/pages/IndustryDetail.jsx`（view==="biz" 挂载）

- [ ] **Step 1: BizPortChips**

业务端口按组分组展示（数据：`listBizPorts(industryId)`）；端口用 `listenPlain` 剥离修饰词。

- [ ] **Step 2: PathChain**

每条转发规则（`listForwardPorts(industryId)`）渲染访问路径链路：`公网/内网 → 域名:端口 → /path → upstream 组或目标地址`。

- 端口剥 ssl/http2（listenPlain）。
- upstream 目标端命中/未命中分色：`forwardPort.upstream_id` 存在 → 查对应 upstream 组；`upstream_target` 直连 → 橙色。命中判定用 `UPSTREAM_SET`。
- 业务端口详情区贯穿渲染（biz-port 行下方内嵌其关联转发规则的链路）。

- [ ] **Step 3: 验证**

手测：业务端口分组展示、转发链路完整、命中/未命中分色正确。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/ops/
git commit -m "feat(ui): 业务端口视图（分组 chips + 访问路径链路）"
```

---

### Task 8: Upstream 池（右栏）+ 指令字典接入

**Files:**
- Create: `frontend/src/pages/ops/UpstreamPool.jsx`
- Modify: `frontend/src/pages/ops/BlockTree.jsx`（KV 编辑器接入 `listDirectives()` datalist，若 T4 未做则在本 Task 完成）
- Modify: `frontend/src/pages/IndustryDetail.jsx`（右栏固定挂 UpstreamPool，~360px，可折叠）

- [ ] **Step 1: 组列表 + 组详情**

- 左：upstream 组列表（`listUpstreams(industryId)`），选中联动详情。
- 右：组详情：组名 / strategy（round_robin·least_conn·ip_hash Select）/ keepalive（InputNumber）/ 节点表（addr:port · weight · 健康状态 · 启用开关），组内节点行内测试（`testForwardPort` 不适用 → 节点直连用 `/api/nginx-configs/forward-ports/{id}/test` 语义，直接对节点 addr:port 做 TCP 探测——后端未提供节点级探测端点时，本视图行内测试按钮仅对 `forward-ports` 关联测试，否则禁用并提示）。
- 节点行操作：测试（如端点存在）/ 启用·停用（enable）/ 编辑（Modal）。
- 组的 `upstream {}` 片段预览：`upstreamPreview(upstreamId)` → `{content}` 渲染（mono 字体）。

- [ ] **Step 2: nginx -t 校验**

`validateUpstream(upstreamId)` → `{ok, output, error_line}`；失败展示错误行号并禁用「应用到服务器」式操作（spec §7）。

- [ ] **Step 3: 指令字典**

`listDirectives()` 缓存到模块/context；KV 编辑器指令名输入框接 `datalist`（`<input list="directives-datalist">`），提供补全；description 悬停 tooltip。

- [ ] **Step 4: 验证**

手测：组 CRUD、节点 CRUD、预览与 mock 一致、validate 错误行号展示、KV 指令补全下拉。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/pages/ops/
git commit -m "feat(ui): Upstream 池右栏 + 指令字典补全"
```

---

### Task 9: 导出中心弹窗 + 集成收尾 + 冒烟

**Files:**
- Create: `frontend/src/pages/ops/ExportModal.jsx`
- Modify: `frontend/src/pages/ops/ConfigPage.jsx`（`导出配置` 按钮 → ExportModal）
- Modify: `frontend/src/pages/ops/BlockTree.jsx`（块管理顶部 `导出配置` → ExportModal）
- Modify: `frontend/src/pages/IndustryDetail.jsx`（状态栏计数联动）

- [ ] **Step 1: ExportModal 结构**

打开回填当前值（复用 lib 状态：`CTX`、`MIRRORS`、`UPSTREAM_SET`、当前 tree）。内容（对齐 spec §6.6 与 mock L1945-2030）：

1. **SSL 开关** `ssl_enabled`（Switch）：关 → 丢 `ssl_*` 指令行 + `listen X ssl http2;`→`listen X http2;`（`SSL_DROP` 逻辑）。
2. **域名替换** `#domNew` 单输入（Input，占位「填一个新域名，留空不替换」）：`applyDomains(raw, domNew)` 整体替换 `server_name` 值，**无需原域名**。
3. **upstream 后端整组替换**：
   - `#upDefaultIps` 默认纯 IP 文本框（TextArea，一个 IP=一个节点）。
   - `#upExceptions` 例外卡 + `＋ 添加例外`：每条例外 = `单个 upstream 组`（Input + datalist 自动补全，无全选/清空/checkbox 列表）+ `textarea.up-ip` 纯 IP；例外标签 + ✕ 删除。
4. **实时预览**：`exportLines(tree, {sslOn, domNew, defaultIps, exceptions})` 输出 `[{text,changed,orig}]`；命中行 `.subst` 高亮 + 行尾 `← 原值：<orig>`。
5. **复制 / 下载**：`navigator.clipboard.writeText(exportText)` / Blob 下载 `.conf`（文件名 = 当前 `FILE_NAME[CTX]`）。

- [ ] **Step 2: 状态栏计数**

导出预览实时回填状态栏：`N 条域名(server_name)替换 · M 组 upstream 整组替换`（M = 命中的组数，复刻 mock `exportLines` 内命中计数）。

- [ ] **Step 3: 本地算法预览 vs 后端导出**

导出弹窗的实时预览用**纯函数模块本地计算**（`exportLines`，客户端算法，与 mock 一致）；「应用导出」时调 `exportConfig(configId, payload)` 落后端，成功后展示后端返回文本（可下载）。两者应逐行一致（后端 export_lines 与前端 exportLines 同源移植）。

- [ ] **Step 4: 验证（完整冒烟清单）**

1. `npm run build` 通过。
2. 登录 → `/ops/:industryId` → 六个视图全部可达，菜单切换带淡入。
3. 配置文件页：五 Tab 数据、StatBanner 计数、监听点表格 listenPlain、KV 增删改、409 弹窗、租约心跳。
4. 块管理：＋子块/＋KV/＋注释/删除/重排/镜像同步/addBlockModal；预览与 mock 逐行一致。
5. 拓扑：四层链路、双向联动。
6. 业务端口：chips + 链路分色。
7. Upstream 池：CRUD + 预览 + validate。
8. 导出中心：SSL 关闭丢行、域名整体替换、默认+例外整组替换、`.subst` 高亮与 `← 原值`、复制/下载；后端导出与本地预览一致。
9. 安全抽查（spec §10）：KV/注释/域名含 `<script>` 时页面无注入（JSX 转义生效）；导出预览无 `dangerouslySetInnerHTML` 未消毒（如使用，先 `esc`）。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/pages/ops/ frontend/src/pages/IndustryDetail.jsx
git commit -m "feat(ui): 导出中心弹窗 + 状态栏计数 + 内页①集成收尾"
```

---

## 自审记录

**Spec 覆盖映射（spec 2026-10-08 §5-§7、§10）：**
- §5 组件拆分 → T3（外壳/路由）、T4（ConfigPage/ListPanel/DetailPanel/StatBanner/OverviewGrid/BlockTree 基础/KvListEditor/BizPortChips/PathChain 数据源）、T5（BlockTree 全功能/AddBlockModal）、T6（TopologyPage/GlobalChain/GroupDetail）、T7（BizPortPage）、T8（UpstreamPool）、T9（ExportModal）
- §6.0 全局外壳（标题栏/菜单/状态栏/资源树/ctxseg）→ T3
- §6.1 配置文件页 → T4
- §6.2 块管理 → T5
- §6.3 全局拓扑 → T6
- §6.4 业务端口 → T7
- §6.5 Upstream 池 → T8
- §6.6 导出中心 → T9
- §6.7 纯函数移植契约 → T2（移植对照表逐函数覆盖）
- §7 错误处理 → T4（409/租约）、T4/T8（validate 错误行号）、T6（骨架屏+重试）、破坏性操作二次确认（T4/T5/T8 内）
- §10 安全 → T2（`esc` 消毒）、T9（XSS 抽查）；命令注入为后端职责（T6）
- 外壳②遗留修复（nginx.js 三列表方法补 industry_id）→ T1

**占位扫描：** 无 TBD/TODO；所有新 React 组件的交互钩子均在对应 Task 给出持久化调用与 mock 行号锚点；移植函数以「mock 行号 + 适配说明」锁定真源，执行者可逐字落码。

**类型一致性：** `lib/nginx-inner.js` 导出名在 T2 定义后全计划统一引用（`renderPreview/buildTree/listenPlain/proxyHostOf/orderedOptions/exportLines/domParse/applyDomains/upNameOf/upKeyOf/deriveUpBackends/ipsForGroup/derivedFor/esc/qq/setCtx/getCtx/setTree/getTree`）；后端端点字段名（`listen_plain`/`proxy_targets`/`backends`/`upstream_exceptions[].grp`）在 T1 契约表与本计划引用保持一致；`ExportRequest` 字段名（`ssl_enabled/server_name_domain/upstream_default_ips/upstream_exceptions`）全计划一致。

**遗留提醒：**
- 后端 T6-T10 完成后才能跑通 T4/T6/T8/T9 的端点联调；若后端顺序延后，前端可先用 mock 数据占位冒烟。
- 节点级 TCP 探测端点后端未设计 → T8 行内测试按钮按「端点存在则用，否则禁用并提示」处理（YAGNI，不新增后端端点）。
