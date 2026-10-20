# 方案 C+ 增强实现计划（全局链路 / 统计看板 / 路径链路）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有方案 C（列表+详情主从）基础上做三处「数据展示增强」——全局拓扑四层链路（GlobalChain）、配置文件顶部统计看板（StatBanner）、业务端口路径链路（PathChain），全部作为可独立构建的 React 组件，复用 pure-CSS 节点渲染（不引图表库）。

**Architecture:** 三个展示组件均为**纯展示型（presentational）**组件：输入结构化数据（DTO），输出 JSX。拓扑链路/路径链路的节点渲染与跨节点跳转逻辑抽成**纯函数 transform**（`buildChain()` / `toPathChain()`），便于单测。组件不直接调接口，由父页面注入数据 + 回调（`onNavigate`）。后端复用既有 `/api/topology`，本计划不改后端（拓扑四层数据结构已在 base 计划 §5 定义）。

**Tech Stack:** React 18 + Vite + Ant Design 5（仅用 Layout/Space/Tag/Tooltip 等基础件）；无前端测试框架，用 `npm run build`（esbuild 未导入/语法门禁）+ 浏览器冒烟验证。数据转换纯函数用 Node 内建 `node --test` 冒烟（若可用）或 build 门禁。

**Design spec (authoritative):** `docs/superpowers/specs/2026-10-08-nginx-console-design.md` §2.1 + §5（GlobalChain / StatBanner / PathChain）。
**Mockup 验收基准：** `.nginx-mock/plan-c-real-conf.html`（真实配置 22 server / 105 location / 31 upstream / 3 if；C+ 数据形态已人工验收 0 JS 错误）。

**组件规划：** C+ 三组件目前**尚未创建**（plan-c-real-conf.html 是静态 mock，非 React）。本计划落地为 React 组件，并规划在 base 计划的 `OpsTopologyPage` / `OpsConfigPage` / 业务端口详情区挂载。无后端改动。

---

## 文件结构（先锁定分解）

- Create `frontend/src/pages/ops/topologyTransform.js` — **纯函数**：`buildChain()`（组/链路 → 四层节点 DTO）+ `toPathChain()`（domain/listen/path/target → 链路段）+ `faultNodes()`（健康检查标记）。无 React 依赖，可 Node 直测。
- Create `frontend/src/pages/ops/GlobalChain.jsx` — 全局链路条：一屏完整「业务域名→监听点(端口)→path→upstream 组→后端节点」，节点可点击，故障/未引用红角标。
- Create `frontend/src/pages/ops/StatBanner.jsx` — 四卡统计看板（server / location / upstream / if counts + 可选告警计数）。
- Create `frontend/src/pages/ops/PathChain.jsx` — 每条转发规则的访问路径链路（公网/内网→域名:端口→/path→target）。
- Create `frontend/src/pages/ops/chain.css` — 三个组件共用的 CSS（仅用 design-token 变量，不引组件库样式）。
- Modify 视最终挂载：base 计划的 `OpsTopologyPage.jsx` / `OpsConfigPage.jsx` / 业务端口详情区（本计划预留 props 接口，实际挂载在 base 计划执行时）。

---

## Task 1：纯函数 transform 层（`topologyTransform.js`）

**Files:**
- Create: `frontend/src/pages/ops/topologyTransform.js`
- Test: 脚本化冒烟 `frontend/transform-smoke.mjs`（Node 直测，不依赖 React）——或 `node --test frontend/transform.test.mjs`

- [ ] **Step 1：写失败测试（Node 冒烟）**

Create `frontend/transform.test.mjs`（用 Node 内置 test runner）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildChain, toPathChain, faultNodes } from "./src/pages/ops/topologyTransform.js";

test("buildChain 返回四层节点 DTO", () => {
  const chain = buildChain({
    groupName: "api_backend",
    refs: [{ domain: "api.example.com", listen: "443 ssl http2", path: "/api/" }],
    backends: [
      { addr: "10.0.0.97", port: 20500, weight: 5, hash: false },
    ],
  });
  assert.equal(chain.length, 5, "应为 5 层：域名→监听点→path→组→后端");
  assert.equal(chain[0].kind, "domain");
  assert.equal(chain[3].kind, "upstream");
  assert.equal(chain[4].label, "10.0.0.97:20500 · w5");
});

test("toPathChain 组成为公网/内网→域名:端口→/path→目标", () => {
  const segs = toPathChain({
    isPublic: true, domain: "api.example.com", listen: "443",
    path: "/api/", target: "upstream:api_backend",
  });
  assert.equal(segs.length, 5);
  assert.equal(segs[0].label, "公网");
  assert.equal(segs[3].label, "api_backend");
});

test("faultNodes 标记失控/未引用后端", () => {
  const marked = faultNodes([
    { addr: "1.1.1.1", port: 1, up: true, referenced: false },
    { addr: "2.2.2.2", port: 2, up: false, referenced: true },
  ]);
  assert.equal(marked[0].fault, "unreferenced");
  assert.equal(marked[1].fault, "down");
});
```

- [ ] **Step 2：运行确认失败**

Run: `node --test frontend/transform.test.mjs`（在 `frontend/` 下）
Expected: FAIL —— 模块 `topologyTransform.js` 不存在（Cannot find module）。

- [ ] **Step 3：实现纯函数**

Create `frontend/src/pages/ops/topologyTransform.js`：

```js
// 方案 C+ 数据变换纯函数 —— 无 React 依赖，Node 可直测。
// 设计文档 §2.1 增强1/2 的数据形态。

// 四层链路节点类型
const KINDS = ["domain", "listen", "path", "upstream", "backend"];

// domain→listen→path→upstream→backend 五层节点 DTO（前四层由 refs 派生）
export function buildChain({ groupName, refs = [], backends = [] }) {
  const nodes = [];
  // 用一个 ref 推导主链路（多 ref 时取第一条，其余并入 domain 的备用列表）
  const primary = refs[0] || { domain: "-", listen: "-", path: "/" };
  nodes.push({ id: "domain-0", kind: "domain", label: primary.domain, raw: primary.domain });
  nodes.push({ id: "listen-0", kind: "listen", label: primary.listen, raw: primary.listen });
  nodes.push({ id: "path-0", kind: "path", label: primary.path, raw: primary.path, alt: refs.slice(1).map((r) => r.path) });
  nodes.push({ id: "upstream-0", kind: "upstream", label: groupName, raw: groupName });
  // 后端节点：每个 addr:port 一层
  backends.forEach((b, i) => {
    nodes.push({
      id: "backend-" + i,
      kind: "backend",
      label: b.addr + ":" + b.port + (b.weight ? " · w" + b.weight : ""),
      raw: b.addr + ":" + b.port,
    });
  });
  return nodes;
}

// 路径链路：公网/内网→域名:端口→/path→目标（upstream 组或地址）
export function toPathChain({ isPublic, domain, listen, path, target }) {
  const upstreamTargeting = String(target || "").startsWith("upstream:");
  const targetLabel = upstreamTargeting ? String(target).replace("upstream:", "") : target;
  return [
    { kind: "scope", label: isPublic ? "公网" : "内网" },
    { kind: "domain", label: domain },
    { kind: "port", label: listen },
    { kind: "path", label: path },
    { kind: "target", label: targetLabel, upstream: upstreamTargeting },
  ];
}

// 故障/未引用标记
export function faultNodes(backends = []) {
  return backends.map((b) => {
    if (!b.referenced) return Object.assign({}, b, { fault: "unreferenced" });
    if (b.up === false) return Object.assign({}, b, { fault: "down" });
    return Object.assign({}, b, { fault: null });
  });
}
```

- [ ] **Step 4：运行确认通过**

Run: `node --test frontend/transform.test.mjs`
Expected: PASS（3 tests）。

- [ ] **Step 5：构建门禁**

Run: `cd frontend && npm run build`
Expected: build 通过，无未导入报错。

- [ ] **Step 6：Commit**

```bash
git add frontend/src/pages/ops/topologyTransform.js frontend/transform.test.mjs frontend/package.json
git commit -m "feat(ops): 方案C+ 拓扑/路径链路数据变换纯函数 + 冒烟测试"
```

---

## Task 2：GlobalChain 全局链路条组件

**Files:**
- Create: `frontend/src/pages/ops/GlobalChain.jsx`
- Create: `frontend/src/pages/ops/chain.css`

- [ ] **Step 1：先建 CSS（design-token 变量，无组件库样式）**

Create `frontend/src/pages/ops/chain.css`：

```css
/* 方案C+ 链路组件共享样式——仅用设计令牌，不引组件库 */
.oc-chain { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 10px 14px; background: var(--bg-surface-2); border: 1px solid var(--border-primary); border-radius: var(--radius-md); }
.oc-node { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); background: var(--bg-surface-3); border: 1px solid var(--border-primary); border-radius: var(--radius-sm); padding: 4px 9px; white-space: nowrap; cursor: pointer; transition: all .15s var(--ease); }
.oc-node:hover { color: var(--text-primary); border-color: var(--brand-border); }
.oc-node.is-domain { color: var(--info); }
.oc-node.is-upstream { color: var(--warning); }
.oc-node.is-backend { color: var(--success); }
.oc-node.is-fault { color: var(--error); border-color: var(--error-border); }
.oc-node.is-fault::after { content: "●"; margin-left: 4px; color: var(--error); font-size: 8px; }
.oc-arrow { color: var(--text-tertiary); font-family: var(--font-mono); font-size: 11px; }
.oc-pill { font-size: 10px; padding: 1px 6px; border-radius: var(--radius-xs); font-weight: 600; }
.oc-pill.pub { background: var(--success-bg); border: 1px solid var(--success-border); color: var(--success); }
.oc-pill.priv { background: var(--bg-surface-3); border: 1px solid var(--border-primary); color: var(--text-tertiary); }
```

- [ ] **Step 2：实现组件**

Create `frontend/src/pages/ops/GlobalChain.jsx`：

```jsx
import { toPathChain, faultNodes } from "./topologyTransform";
import "./chain.css";

// 全局链路条：一屏完整「业务域名→监听点→path→upstream 组→后端节点」
// props:
//   link   { domain, listen, path, group, backends:[{addr,port,weight,up,referenced}] }
//   onJump (nodeKind, payload) => void    —— 点击节点跳转到对应配置视图
export default function GlobalChain({ link, onJump }) {
  const kinds = ["domain", "listen", "path", "upstream", "backend"];
  const backends = faultNodes(link?.backends || []);
  const chain = toPathChainLabels(link, backends);
  return (
    <div className="oc-chain">
      {chain.map((n, i) => {
        const fault = n.fault;
        const cls = [
          "oc-node",
          "is-" + n.kind,
          fault ? "is-fault" : "",
        ].filter(Boolean).join(" ");
        return (
          <span key={i} style={{ display: "contents" }}>
            {i > 0 && <span className="oc-arrow">→</span>}
            <span
              className={cls}
              title={n.raw}
              onClick={() => onJump && onJump(n.kind, n.payload || n.raw)}
            >
              {n.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

// 决定链路节点标签与故障标记（复用 toPathChain + faultNodes 的数据形态）
function toPathChainLabels(link, backends) {
  if (!link) return [];
  const chain = toPathChain({
    isPublic: link.isPublic,
    domain: link.domain,
    listen: link.listen,
    path: link.path,
    target: link.upstream ? "upstream:" + link.group : link.target,
  });
  // 覆盖：把 target 段替换为 upstream + backend 段
  const out = chain.slice(0, 4);
  out.push({ kind: "upstream", label: link.group, raw: link.group, payload: link.group });
  // 后端段：健康状态直接以故障标记体现
  const backNodes = backends.map((b) => ({
    kind: "backend",
    label: b.addr + ":" + b.port + (b.weight ? " · w" + b.weight : ""),
    raw: b.addr + ":" + b.port,
    fault: b.fault,
    payload: b.addr + ":" + b.port,
  }));
  // 若有过多的后端，折叠为「+N」
  const MAX = 4;
  const tail = backNodes.length > MAX ? backNodes.slice(0, MAX) : backNodes;
  if (backNodes.length > MAX) {
    tail.push({ kind: "backend", label: "+" + (backNodes.length - MAX), raw: "", fault: null });
  }
  return out.concat(tail);
}
```

- [ ] **Step 3：构建门禁**

Run: `cd frontend && npm run build`
Expected: build 通过。

- [ ] **Step 4：Commit**

```bash
git add frontend/src/pages/ops/GlobalChain.jsx frontend/src/pages/ops/chain.css
git commit -m "feat(ops): 方案C+ GlobalChain 全局链路条组件"
```

---

## Task 3：StatBanner 统计看板 + PathChain 路径链路组件

**Files:**
- Create: `frontend/src/pages/ops/StatBanner.jsx`
- Create: `frontend/src/pages/ops/PathChain.jsx`

- [ ] **Step 1：实现 StatBanner（四卡统计）**

Create `frontend/src/pages/ops/StatBanner.jsx`：

```jsx
import "./chain.css";

// 顶部统计看板：server / location / upstream / if 四卡 + 可选告警计数
// design 文档 §2.1 增强2；配色沿用 mockup 四卡语义（blue/green/yellow/red）
const CARDS = [
  { key: "server", label: "server 监听块", color: "#4a8af4" },
  { key: "location", label: "location 转发", color: "#22c55e" },
  { key: "upstream", label: "upstream 组", color: "#f59e0b" },
  { key: "if", label: "if 弱提示", color: "#ef4444" },
];

export default function StatBanner({ counts, alerts }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
      {CARDS.map((c) => {
        const v = counts ? counts[c.key] : 0;
        const warn = alerts && alerts[c.key];
        return (
          <div
            key={c.key}
            style={{
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-md)",
              padding: "12px 14px",
            }}
          >
            <b style={{ fontSize: 19, display: "block", fontWeight: 600, color: c.color }}>
              {v}
            </b>
            <small style={{ color: "var(--text-tertiary)", fontSize: 11 }}>
              {c.label}
              {warn ? <span style={{ color: "var(--error)", marginLeft: 4 }}>ⓘ {warn}</span> : null}
            </small>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2：实现 PathChain（每个转发规则的访问路径链路）**

Create `frontend/src/pages/ops/PathChain.jsx`：

```jsx
import { toPathChain } from "./topologyTransform";
import "./chain.css";

// 一条转发规则的访问路径链路：公网/内网→域名:端口→/path→upstream 组或地址
// design 文档 §2.1 增强2
export default function PathChain({ rule, compact }) {
  const segs = toPathChain({
    isPublic: rule?.isPublic,
    domain: rule?.domain,
    listen: rule?.listen,
    path: rule?.path,
    target: rule?.target,
  });
  return (
    <div className="oc-chain" style={compact ? { padding: "6px 10px" } : undefined}>
      {segs.map((s, i) => (
        <span key={i} style={{ display: "contents" }}>
          {i > 0 && <span className="oc-arrow">→</span>}
          {s.kind === "scope" ? (
            <span className={"oc-pill " + (s.label === "公网" ? "pub" : "priv")}>{s.label}</span>
          ) : (
            <span className={"oc-node is-" + s.kind} title={s.label}>{s.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 3：构建门禁**

Run: `cd frontend && npm run build`
Expected: build 通过。

- [ ] **Step 4：Commit**

```bash
git add frontend/src/pages/ops/StatBanner.jsx frontend/src/pages/ops/PathChain.jsx
git commit -m "feat(ops): 方案C+ StatBanner 看板 + PathChain 路径链路组件"
```

---

## Task 4：挂载到父页面（三处）

> C+ 三组件是**纯展示组件**，父页面（`OpsTopologyPage` / `OpsConfigPage` / 业务端口详情区）属 base 计划。本任务假设 base 计划已建好这些父页面并预留插槽；若尚未建，**不阻塞本计划**——先提供挂载代码片段，等 base 落地后粘贴。

**Files:**
- Modify: `frontend/src/pages/ops/OpsTopologyPage.jsx`（如已存在；否则提供片段挂到待创建文件）
- Modify: `frontend/src/pages/ops/OpsConfigPage.jsx`（同）
- 业务端口详情区：base 的 `BizPortChips`/转发规则表格行内

- [ ] **Step 1：拓扑页顶部插 GlobalChain**

在 `OpsTopologyPage` 右侧详情顶部、选中组/链路数据就绪处渲染：

```jsx
import GlobalChain from "./GlobalChain";
// 选中链路 link = { domain, listen, path, group, isPublic, upstream, backends:[...] }
<GlobalChain
  link={selectedLink}
  onJump={(kind, payload) => {
    // kind==="domain" 跳配置文件(域名定位)；"upstream" 跳 Upstream 池定位该组；"backend" toast + 行内连通测试
    navigateToConfiguredView(kind, payload);
  }}
/>
```

- [ ] **Step 2：配置文件页顶部插 StatBanner**

在 `OpsConfigPage` 的 `DetailPanel`（或 OverviewGrid 上方）顶部：

```jsx
import StatBanner from "./StatBanner";
<StatBanner counts={{ server: 22, location: 105, upstream: 31, if: 3 }} alerts={{ if: "建议收敛" }} />
```

- [ ] **Step 3：业务端口详情区行内插 PathChain**

在 `DetailPanel` 的「业务端口」Tab 的每条转发规则行内：

```jsx
import PathChain from "./PathChain";
<PathChain rule={{ isPublic: r.is_public, domain: r.domain, listen: r.listen_port,
  path: r.path || "/", target: r.upstream_target }} compact />
```

- [ ] **Step 4：构建门禁 + 浏览器冒烟**

Run: `cd frontend && npm run build` → 通过。
随后 `npm run dev`，浏览器打开对应视图，确认：
- 拓扑页详情顶部出现一条完整四层链路，节点可点、故障节点红角标；
- 配置文件页顶部四卡统计显示正确数字；
- 业务端口规则行内显示「公网→域名:443→/path→upstream组」链路。

- [ ] **Step 5：Commit**

```bash
git add frontend/src/pages/ops/
git commit -m "feat(ops): 方案C+ 三组件挂载到拓扑/配置/业务端口视图"
```

---

## Task 5：清理冒烟测试产物（可选）

**Files:**
- Delete: `frontend/transform.test.mjs`（若不需要保留测试）

- [ ] **Step 1：确认测试是否保留**

若团队希望保留前端数据变换单测，留 `transform.test.mjs` 与 `package.json` 的 `test` 脚本；否则删除并移除 package.json 中对应脚本。

- [ ] **Step 2：Commit**

```bash
git add frontend/ frontend/package.json
git commit -m "chore(ops): 整理方案C+ transform 测试产物"
```

---

## Task 6：监听展示剥离 / upstream 关联可视化 / IP 清单补全（增强 3/4/5）

> spec §2.1「C+ 增强 III」。落地于 `.nginx-mock/plan-c-real-conf.html`（静态 mock，参照实现），本任务把同一语义落进 React transform 层与组件。不改后端。

**Files:**
- Modify: `frontend/src/pages/ops/topologyTransform.js`（新增 `stripListen()` / `proxyHost()` / `buildUpstreamSet()`）
- Modify: `frontend/src/pages/ops/chain.css`（`.oc-node.unmatched` / `.oc-node.matchok` / `.tag.ok` / `.tag.none`）
- Modify: `frontend/src/pages/ops/GlobalChain.jsx` / `PathChain.jsx` / `StatBanner.jsx`（消费新 DTO）
- Modify: 导出中心（base 的 OpsConfigPage 导出弹窗）增「后端 IP 清单」补全逻辑（`applyIpList` 参照 mock）

- [ ] **Step 1：transform 层新增纯函数（含失败测试）**

在 `frontend/src/pages/ops/topologyTransform.js` 追加并导出：

```js
// R1: 展示层剥离 listen 修饰词（ssl/http2/backlog=…）。unix socket 原样。
export function stripListen(listen) {
  const t = String(listen == null ? "" : listen).trim();
  if (/^unix:/i.test(t)) return t;
  return /\s/.test(t) ? t.split(/\s+/)[0] : t;
}
// R2: 解析 proxy_pass 目标主机，区分 upstream组名(name) / IP直连(ip) / 域名直连(domain)
export function proxyHost(pv) {
  const m = String(pv || "").match(/\/\/([^\/:$]+)/);
  if (!m) return null;
  const h = m[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return { host: h, kind: "ip" };
  if (/[./]/.test(h)) return { host: h, kind: "domain" };
  return { host: h, kind: "name" };
}
// R2: 由 upstream 组数组构建 组名→true 集合
export function buildUpstreamSet(groups = []) {
  return groups.reduce((s, g) => ((s[g] = true), s), {});
}
// R2: 仅对组名引用标注是否命中；IP/域名直连返回 matched=null（不警示）
export function upstreamMatch(upstreamSet, proxyPass) {
  const h = proxyHost(proxyPass);
  if (!h || h.kind !== "name") return { host: h && h.host, matched: null };
  return { host: h.host, matched: !!upstreamSet[h.host] };
}
```

在 `frontend/transform.test.mjs` 追加用例：

```js
test("stripListen 剥离 ssl/http2，unix 原样", () => {
  assert.equal(stripListen("443 ssl http2"), "443");
  assert.equal(stripListen("0.0.0.0:443 http2"), "0.0.0.0:443");
  assert.equal(stripListen("unix:/var/run/a.sock"), "unix:/var/run/a.sock");
});
test("proxyHost 区分 name/ip/domain", () => {
  assert.equal(proxyHost("http://saas_web").kind, "name");
  assert.equal(proxyHost("http://10.0.0.97:20500").kind, "ip");
  assert.equal(proxyHost("http://api.example.com").kind, "domain");
});
test("upstreamMatch 命中/未命中/直连", () => {
  const s = buildUpstreamSet(["saas_web", "api_backend"]);
  assert.equal(upstreamMatch(s, "http://saas_web").matched, true);
  assert.equal(upstreamMatch(s, "http://missing").matched, false);
  assert.equal(upstreamMatch(s, "http://10.0.0.97:1").matched, null);
});
```

Run: `node --test frontend/transform.test.mjs` → 通过（4 组用例）。

- [ ] **Step 2：chain.css 追加关联样式**

在 `frontend/src/pages/ops/chain.css` 追加（design-token，无全局污染）：

```css
.oc-node.matchok{color:var(--success);}
.oc-node.unmatched{color:var(--error);border-color:var(--error-border);background:var(--error-bg);}
.oc-node.unmatched::after{content:"✗ 未匹配";color:var(--error);font-size:9px;font-weight:600;margin-left:2px;}
.tag.ok{background:var(--success-bg);border:1px solid var(--success-border);color:var(--success);}
.tag.none{background:var(--error-bg);border:1px solid var(--error-border);color:var(--error);}
```

- [ ] **Step 3：GlobalChain / PathChain 消费关联 DTO**

- GlobalChain：`chainForServer` 等价处，upstream 节点按 `upstreamMatch(UPSTREAM_SET, proxyPass)`：
  - `matched===true` → 类 `matchok`（绿）
  - `matched===false` → 类 `unmatched`（红 + ✗未匹配角标）
  - `matched===null`（IP/域名直连或空）→ 普通 `is-upstream`（橙，不警示）。
- PathChain：路径末段目标节点同规则；监听点段用 `stripListen(rule.listen)` 渲染。
- StatBanner 监听点表格：端口列 `stripListen`；末列渲染 `tag.ok`(✓) / `tag.none`(✗未匹配) / 直连 `—`。
- 入口处用 `buildUpstreamSet(groups)` 建一次 `UPSTREAM_SET`，供渲染期只读查询。

- [ ] **Step 4：导出中心「后端 IP 清单」补全（applyIpList）**

导出弹窗（base 的 OpsConfigPage 导出中心）在 upstream 可编辑表下方插入：组下拉（全部组 + 各 upstream 组，id `ipGroupSel`）+ 多行文本框（id `ipList`）+ 按钮（id `ipApply`）。实现 `applyIpList`（参照 mock 的「端口保持补全 + upOverride 持久化」）：

```js
function applyIpList() {
  const sel = document.getElementById("ipGroupSel");
  const gsel = sel ? sel.value : "";
  const nodes = document.getElementById("ipList").value
    .split(/[;\n]/).map((s) => s.replace(/;\s*$/,"").trim()).filter(Boolean);
  if (!nodes.length) { toast("后端 IP 清单为空", "warn"); return; }
  const targets = gsel ? [gsel] : Object.keys(upstreamEdit);
  let applied = 0;
  targets.forEach((g) => {
    if (g in upstreamEdit) { upOverride[g] = nodes.slice(); applied++; }
  });
  if (!applied) { toast("未匹配任何 upstream 组", "warn"); return; }
  initUpstreamEdit(); sel.value = gsel; renderExportPreview();
  toast("已用 " + nodes.length + " 个后端节点补全 " + (gsel ? gsel : applied + " 个组"), "ok");
}
```

端口保持补全的持久化（mock 已落地，React 侧同构）：`applyIpList` 与手填编辑均写入持久 `upOverride` map；`initUpstreamEdit()` 每次从配置树重建 `upstreamEdit` 后重新套用 `upOverride`，否则重建表会重置补全结果。端口沿用各组原配置（IP 清单只取 IP，`weight=` 保留）。与手填编辑表共用 `upstreamEdit`，互不冲突；本次导出生效、不落库。绑定 `#ipApply` click。

- [ ] **Step 5：构建门禁**

Run: `cd frontend && npm run build` → 通过。

- [ ] **Step 6：Commit**

```bash
git add frontend/src/pages/ops/ frontend/transform.test.mjs
git commit -m "feat(ops): 方案C+ 监听展示剥离/upstream关联/IP清单补全"
```

---

## 自检清单（对照 spec）

- **§2.1 增强1（全局四层链路）** → Task1 buildChain/GlobalChain + Task4-1 挂载；双向点击通过 `onJump` 回调实现。✅
- **§2.1 增强2（StatBanner 四卡 + PathChain）** → Task3 + Task4-2/4-3。✅
- **故障/未引用红角标** → Task1 `faultNodes` + Task2 `.is-fault`。✅
- **不引图表库 / 纯 CSS** → 全部用 `chain.css` design-token。✅
- **主从联动保持** → 组件均为纯展示，父页面注数据+回调，不改列表主从逻辑。✅
- **向后兼容** → 三组件可选插入，不破坏既有四视图。✅
- **§2.1 增强3（监听展示剥离 ssl/http2）** → `stripListen` / `listenPlain` 应用于监听点列表/表格/链路/PathChain/块树 listen 行；ssl 由导出开关决定。✅
- **§2.1 增强4（proxy_pass↔upstream 关联）** → `proxyHost`/`upstreamMatch`/`buildUpstreamSet`；GlobalChain/PathChain 目标端着色，监听点表格 ✓/✗ tag，块树 proxy_pass 行 mini 标签。✅
- **§2.1 增强5（IP 清单自动补全 upstream）** → 导出弹窗 `ipGroupSel`/`ipList`/`ipApply` + `applyIpList`，与手填共用 `upstreamEdit`。✅