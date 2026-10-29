import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Modal, Input } from "antd";
import { getIndustry } from "../../api/industry";
import * as yamlApi from "../../api/yaml";
import "./yaml.css";

/* ============================================================
 * YAML 配置工作台 —— IDE 级编码工坊
 * 布局：左文件列表 / 中央高亮编辑器（行号·当前行·缩进辅助）/ 右侧结构·版本面板
 * 定位：结构树点击跳行 · 语法错误点击跳行 · 行号/键路径直达 · Ctrl+F 全文搜索
 * 推送：顶栏「接收推送」抽屉（拖拽上传 → 分色 diff → apply），命令行方式折叠收纳
 * ============================================================ */

const LINE_H = 19.8;   // 12px × 1.65，必须与 CSS 完全一致
const CHAR_W = 7.2;    // 等宽字符近似宽度，仅用于横向滚动估算

const TOKEN_CLS = {
  comment: "tk-com", key: "tk-key", str: "tk-str", num: "tk-num",
  bool: "tk-bool", list: "tk-list", punc: "tk-punc", plain: "tk-plain",
};

function splitLine(line) {
  const out = [];
  let i = 0;
  const push = (cls, text) => { if (text) out.push({ cls, text }); };

  const mInd = /^([ \t]+)/.exec(line);
  if (mInd) { push("plain", mInd[1]); i = mInd[1].length; }

  if (line[i] === "#") { push("comment", line.slice(i)); return out; }

  const mList = /^(-(\s+)?)/.exec(line.slice(i));
  if (mList) { push("list", mList[1]); i += mList[1].length; }

  const rest = line.slice(i);
  let colon = -1; let inStr = null;
  for (let k = 0; k < rest.length; k++) {
    const ch = rest[k];
    if (inStr) { if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; continue; }
    if (ch === ":") { colon = k; break; }
  }
  if (colon === -1) { push("plain", rest); return out; }
  push("key", rest.slice(0, colon).replace(/[ \t]+$/, ""));
  push("punc", ":");
  const val = rest.slice(colon + 1);
  const mv = /^\s+/.exec(val);
  if (mv) push("plain", mv[0]);
  const vrest = val.slice(mv ? mv[0].length : 0);
  if (vrest === "") return out;

  let commentAt = -1; let q = null;
  for (let k = 0; k < vrest.length; k++) {
    const ch = vrest[k];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === "#") { commentAt = k; break; }
  }
  const vpart = commentAt === -1 ? vrest : vrest.slice(0, commentAt);
  if (vpart.trim() === "") { if (commentAt > -1) push("comment", vrest); return out; }

  const vs = vpart.trim();
  const qm = /^(["'])(.*)\1$/.exec(vs);
  if (qm) { push("str", vpart.replace(/^\s*|\s*$/g, "")); push("plain", commentAt > -1 ? vrest.slice(vpart.length) : ""); }
  else if (/^-?\d+(\.\d+)?$/.test(vs)) push("num", vpart);
  else if (["true", "false", "null", "yes", "no", "on", "off"].includes(vs)) push("bool", vpart);
  else push("plain", vpart);
  if (commentAt > -1) push("comment", vrest.slice(vpart.length));
  return out;
}

/** 高亮层中的一行：只输出 token，不加 pre（避免与 textarea 行高不一致） */
function HighlightLine({ text, query, base = 0, cur = -1 }) {
  const toks = splitLine(text);
  let idx = base - 1;
  const renderText = (t) => {
    if (!query) return t;
    const q = query.toLowerCase();
    const low = t.toLowerCase();
    const parts = [];
    let i = 0, j = low.indexOf(q);
    while (j !== -1) {
      if (j > i) parts.push(t.slice(i, j));
      idx++;
      parts.push(
        <span key={"h" + idx} className={"hit" + (idx === cur ? " cur" : "")}>
          {t.slice(j, j + query.length)}
        </span>
      );
      i = j + query.length;
      j = low.indexOf(q, i);
    }
    if (i < t.length) parts.push(t.slice(i));
    return parts;
  };
  return (
    <span className="yh-code">
      {toks.map((t, i) => <span key={i} className={TOKEN_CLS[t.cls]}>{renderText(t.text)}</span>)}
    </span>
  );
}

/** 扫描全文，建立「键路径 → 行号」索引，供结构树/键路径定位使用 */
function buildLineIndex(text) {
  const map = new Map();
  const stack = [];
  text.split("\n").forEach((ln, i) => {
    const m = /^(\s*)(?:-\s+)?([^\s#][^:]*?)\s*:\s*(.*)$/.exec(ln);
    if (!m) return;
    const indent = m[1].length;
    const key = m[2].trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].path : "";
    const path = parent ? `${parent}.${key}` : key;
    stack.push({ indent, path, key });
    if (!map.has(path)) map.set(path, i + 1);
  });
  return map;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TYPE_CN = { list: "列表", map: "映射", scalar: "标量" };
const ACT_CN = { replace: "修改", new: "新增", delete: "删除", keep: "无变化" };
const ACT_COLOR = { replace: "var(--warning)", new: "var(--success)", delete: "var(--error)", keep: "var(--text-ter)" };

function TreeNode({ n, depth, defaultOpen, onLocate }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const hasKids = !!(n.children && n.children.length);
  const badge = n.count != null ? ` ${n.count}` : "";
  // 映射节点直接展示其 name 子项，形如 `= my-cluster`，便于识别列表中的每一项
  const named = n.type === "map"
    ? (n.children || []).find((c) => c.key === "name" && c.value != null)
    : null;
  const val = named
    ? ` = ${named.value}`
    : n.value != null ? ` = ${n.value}` : "";
  return (
    <div className="ytree-node" style={{ paddingLeft: depth * 13 }}>
      {/* 行与子节点分离渲染：子行不是可点击行的后代，点击子行不会冒泡到父节点 */}
      <div className="ytree-row" onClick={() => onLocate?.(n)}>
        <span
          className="tw"
          onClick={(e) => { e.stopPropagation(); if (hasKids) setOpen(!open); }}
          style={{ cursor: hasKids ? "pointer" : "default" }}
        >
          {hasKids ? (open ? "▾" : "▸") : "·"}
        </span>
        <span
          className="tk-key"
          title={`${n.path}${n.line ? ` · 第 ${n.line} 行` : ""} · 点击定位`}
        >{n.key}</span>
        <span className="cnt" title={named ? `${n.path} · name = ${named.value}` : n.path}>
          [{TYPE_CN[n.type]}]{badge}{val}
        </span>
      </div>
      {open && hasKids && n.children.map((c, i) => (
        <TreeNode key={i} n={c} depth={depth + 1} onLocate={onLocate} />
      ))}
    </div>
  );
}

function fmtTime(s) {
  if (!s) return "";
  return new Date(s).toLocaleString("zh-CN", { hour12: false });
}
function fmtDate(s) {
  if (!s) return "";
  return String(s).split("T")[0];
}

export default function YamlConfigPage() {
  const { industryId } = useParams();
  const navigate = useNavigate();

  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [fileFilter, setFileFilter] = useState("");
  const [activeId, setActiveId] = useState(null);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState("structure");
  const [tree, setTree] = useState([]);
  const [treeInfo, setTreeInfo] = useState({ valid: true, errors: [] });
  const [versions, setVersions] = useState([]);
  const [toast, setToast] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [industry, setIndustry] = useState(null);
  const [verModal, setVerModal] = useState(null);

  // 推送
  const [openPush, setOpenPush] = useState(false);
  const [pushTokens, setPushTokens] = useState(null);
  const [pushFile, setPushFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [publicBase, setPublicBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [diffFilter, setDiffFilter] = useState("all");
  // 提交按钮两步确认（避免在抽屉上再叠一层 Modal）
  const [armApply, setArmApply] = useState(false);
  const [busyTag, setBusyTag] = useState(""); // preview | apply | token，用于各自按钮的进行中文案

  // 编辑器定位状态
  const [curLine, setCurLine] = useState(1);
  const [flashLine, setFlashLine] = useState(0);
  const [goInput, setGoInput] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [search, setSearch] = useState("");
  const [cur, setCur] = useState(0);

  const taRef = useRef(null);
  const hlRef = useRef(null);
  const searchInputRef = useRef(null);
  const toastTimer = useRef(null);
  const flashTimer = useRef(null);

  const notify = useCallback((msg, type = "ok") => {
    setToast({ msg, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const fullText = editing ? draft : content;
  const lines = useMemo(() => fullText.split("\n"), [fullText]);
  const lineIdx = useMemo(() => buildLineIndex(fullText), [fullText]);
  const dirty = editing && draft !== content;

  // ---------- 数据加载 ----------
  const loadFiles = useCallback(() => {
    if (!industryId) return;
    setFilesLoading(true);
    yamlApi.listYamlConfigs(industryId)
      .then((r) => {
        const list = r.data || [];
        setFiles(list);
        setActiveId((prev) => (list.some((f) => f.id === prev) ? prev : list[0]?.id || null));
      })
      .catch(() => notify("加载 YAML 文件列表失败", "err"))
      .finally(() => setFilesLoading(false));
  }, [industryId, notify]);

  const loadActive = useCallback(() => {
    if (!activeId) return;
    yamlApi.getYamlConfig(activeId)
      .then((r) => setContent(r.data.content_text || ""))
      .catch(() => notify("加载文件内容失败", "err"));
    yamlApi.getYamlTree(activeId)
      .then((r) => { setTree(r.data.tree || []); setTreeInfo({ valid: r.data.valid, errors: r.data.errors || [] }); })
      .catch(() => { setTree([]); setTreeInfo({ valid: false, errors: [{ line: 0, reason: "结构加载失败" }] }); });
    yamlApi.listYamlVersions(activeId)
      .then((r) => setVersions(r.data || []))
      .catch(() => setVersions([]));
  }, [activeId, notify]);

  useEffect(() => {
    getIndustry(industryId).then((res) => setIndustry(res.data)).catch(() => setIndustry(null));
    loadFiles();
  }, [industryId, loadFiles]);

  useEffect(() => {
    setEditing(false);
    setDraft("");
    setPreview(null);
    setPushFile(null);
    setShowSearch(false);
    setSearch("");
    setCur(0);
    setCurLine(1);
    setGoInput("");
    loadActive();
  }, [activeId, loadActive]);

  useEffect(() => {
    yamlApi.getMetaBase()
      .then((r) => setPublicBase(r.data?.base_url || ""))
      .catch(() => setPublicBase(""));
  }, []);

  useEffect(() => () => {
    clearTimeout(toastTimer.current);
    clearTimeout(flashTimer.current);
  }, []);

  // 抽屉打开时 Esc 关闭；任何状态变化都复位"二次确认"
  useEffect(() => {
    if (!openPush) { setArmApply(false); return; }
    const h = (e) => { if (e.key === "Escape") setOpenPush(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [openPush]);

  useEffect(() => { setArmApply(false); }, [preview, pushFile]);

  // ---------- 滚动同步（textarea 驱动高亮层） ----------
  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    const hl = hlRef.current;
    if (!ta || !hl) return;
    hl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  }, []);

  // 内容切换（换文件 / 进入或退出编辑）后 textarea 滚动会被重置，高亮层不会自动跟随，这里强制对齐一次
  useEffect(() => {
    requestAnimationFrame(syncScroll);
  }, [fullText, editing, syncScroll]);

  // ---------- 定位 ----------
  const jumpToLine = useCallback((n) => {
    const ta = taRef.current;
    if (!ta || !lines.length) return;
    const line = Math.min(Math.max(1, Number(n) || 1), lines.length);
    // 目标行定位到编辑区上方约 1/5 处，保证整块内容落在可视区内；同时复位横向滚动，避免内容偏到屏幕外
    const place = () => {
      const top = 10 + (line - 1) * LINE_H - ta.clientHeight * 0.2;
      ta.scrollTop = Math.max(0, top);
      ta.scrollLeft = 0;
      syncScroll();
    };
    place();
    // 内容/布局刚变化（切换文件、编辑草稿）时滚动高度可能尚未稳定，下一帧再校正一次
    requestAnimationFrame(place);
    setCurLine(line);
    setFlashLine(line);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashLine(0), 2000);
  }, [lines.length, syncScroll]);

  const scrollToOffset = useCallback((pos) => {
    const ta = taRef.current;
    if (!ta) return;
    const before = fullText.slice(0, pos);
    const line = before.split("\n").length;
    const col = pos - before.lastIndexOf("\n") - 1;
    ta.scrollTop = Math.max(0, (line - 1) * LINE_H - ta.clientHeight / 2);
    const visW = Math.max(200, ta.clientWidth - 68);
    ta.scrollLeft = Math.max(0, col * CHAR_W - visW / 2);
    syncScroll();
    setCurLine(line);
  }, [fullText, syncScroll]);

  /** 结构树节点 → 精确行号：优先用后端节点自带的 line，缺失才按键路径/键名兜底 */
  const locateNode = useCallback((node) => {
    if (node?.line) { jumpToLine(node.line); return; }
    const byPath = lineIdx.get(node?.path);
    if (byPath) { jumpToLine(byPath); return; }
    if (node?.key) {
      const re = new RegExp(`^(\\s*)(?:-\\s+)?${escapeRe(node.key)}\\s*:`);
      const idx = lines.findIndex((l) => re.test(l));
      if (idx >= 0) { jumpToLine(idx + 1); return; }
    }
    notify("未能在原文中定位该节点", "warn");
  }, [lineIdx, lines, jumpToLine, notify]);

  /** 定位输入框：行号 / 键路径 / 任意内容（命中后进入搜索态，可 Enter 循环） */
  const handleGo = () => {
    const v = goInput.trim();
    if (!v) return;
    if (/^\d+$/.test(v)) { jumpToLine(Number(v)); return; }
    const hit = lineIdx.get(v) || lineIdx.get(v.replace(/\[\d+\]/g, ""));
    if (hit) { jumpToLine(hit); return; }
    const last = v.split(".").pop().replace(/\[\d+\]/g, "");
    const re = new RegExp(`^(\\s*)(?:-\\s+)?${escapeRe(last)}\\s*:`);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx >= 0) { jumpToLine(idx + 1); return; }
    // 既非行号也非键路径：按内容全文查找，并打开搜索栏让命中高亮可循环
    const pos = fullText.toLowerCase().indexOf(v.toLowerCase());
    if (pos === -1) { notify(`原文中未找到「${v}」`, "warn"); return; }
    setShowSearch(true);
    setSearch(v);
    setCur(0);
    scrollToOffset(pos);
  };

  // ---------- 搜索 ----------
  const matches = useMemo(() => {
    if (!search) return [];
    const out = [];
    const q = search.toLowerCase();
    const t = fullText.toLowerCase();
    let i = t.indexOf(q);
    while (i !== -1) { out.push(i); i = t.indexOf(q, i + q.length); }
    return out;
  }, [fullText, search]);

  useEffect(() => {
    setCur((c) => (matches.length === 0 ? 0 : Math.min(c, matches.length - 1)));
  }, [matches.length]);

  const stepMatch = useCallback((dir) => {
    setCur((c) => (matches.length ? (c + dir + matches.length) % matches.length : 0));
  }, [matches.length]);

  useEffect(() => {
    if (!search || matches.length === 0) return;
    scrollToOffset(matches[Math.min(cur, matches.length - 1)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, search]);

  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus();
  }, [showSearch]);

  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowSearch(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (editing && dirty) handleSave();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const closeSearch = useCallback(() => { setShowSearch(false); setSearch(""); setCur(0); }, []);

  // 每行的搜索命中起始序号，用于判定"当前命中"
  const hitBases = useMemo(() => {
    const arr = [];
    let base = 0;
    const q = search.toLowerCase();
    for (const ln of lines) {
      arr.push(base);
      if (!q) continue;
      const low = ln.toLowerCase();
      let j = low.indexOf(q);
      while (j !== -1) { base++; j = low.indexOf(q, j + q.length); }
    }
    return arr;
  }, [lines, search]);

  // ---------- 编辑 ----------
  const startEdit = () => {
    setDraft(content);
    setEditing(true);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const cancelEdit = () => {
    if (!dirty) { setEditing(false); return; }
    Modal.confirm({
      title: "放弃未保存的修改？",
      content: "当前修改尚未保存，放弃后无法恢复。",
      okText: "放弃修改",
      okType: "danger",
      cancelText: "继续编辑",
      onOk: () => { setEditing(false); setDraft(""); },
    });
  };

  const handleSave = () => {
    if (!active) return;
    if (draft.trim() === "") { notify("内容为空，未保存", "err"); return; }
    yamlApi.saveYamlConfig(active.id, { content: draft, expected_version: active.version, note: "全文编辑保存" })
      .then((r) => { setEditing(false); notify(`已保存并生成新版本快照 v${r.data.version}`, "ok"); refreshAll(); })
      .catch((e) => {
        const d = e.response?.data?.detail;
        if (e.response?.status === 409) {
          notify(typeof d === "string" ? d : "内容已被他人修改，请刷新后重试", "err");
          refreshAll();
        } else if (e.response?.status === 422 && d && Array.isArray(d.errors)) {
          const er = d.errors[0];
          Modal.confirm({
            title: `语法校验未通过（第 ${er.line} 行）`,
            content: (
              <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                <div style={{ color: "var(--error)", fontFamily: "var(--mono)", marginBottom: 8 }}>{er.reason}</div>
                可以放弃本次修改，或仍以原文保存为草稿（标记为语法异常，不参与推送 apply）。
              </div>
            ),
            okText: "仍保存为草稿",
            okType: "danger",
            cancelText: "放弃保存",
            onOk: () => yamlApi.saveYamlConfig(active.id, { content: draft, expected_version: active.version, force_draft: true, note: "保存为草稿（语法异常）" })
              .then((r) => { setEditing(false); notify(`已按草稿保存，生成 v${r.data.version}`, "ok"); refreshAll(); })
              .catch((e2) => notify("保存失败：" + (typeof e2.response?.data?.detail === "string" ? e2.response.data.detail : "未知错误"), "err")),
          });
        } else {
          notify("保存失败：" + (typeof d === "string" ? d : "未知错误"), "err");
        }
      });
  };

  // Tab / Shift+Tab 缩进（支持多行选区）
  const handleKeyDown = (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const ta = taRef.current;
    if (!ta || ta.readOnly) return;
    const s = ta.selectionStart;
    const en = ta.selectionEnd;
    const val = draft;
    const lineStart = val.lastIndexOf("\n", s - 1) + 1;
    const nl = val.indexOf("\n", en);
    const lineEnd = nl === -1 ? val.length : nl;

    if (s === en) {
      if (!e.shiftKey) {
        const next = val.slice(0, s) + "  " + val.slice(en);
        setDraft(next);
        requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2));
      } else {
        const pre = val.slice(lineStart, s);
        const blanks = (pre.match(/ +$/) || [""])[0].length;
        if (!blanks) return;
        const cut = Math.min(2, blanks);
        const next = val.slice(0, s - cut) + val.slice(s);
        setDraft(next);
        requestAnimationFrame(() => ta.setSelectionRange(s - cut, s - cut));
      }
      return;
    }
    const block = val.slice(lineStart, lineEnd).split("\n");
    const changed = e.shiftKey
      ? block.map((l) => l.replace(/^ {1,2}/, ""))
      : block.map((l) => "  " + l);
    const nb = changed.join("\n");
    const next = val.slice(0, lineStart) + nb + val.slice(lineEnd);
    setDraft(next);
    requestAnimationFrame(() => ta.setSelectionRange(lineStart, lineStart + nb.length));
  };

  const onSelectionChange = () => {
    const ta = taRef.current;
    if (!ta) return;
    const line = fullText.slice(0, ta.selectionStart).split("\n").length;
    setCurLine(line);
  };

  const active = files.find((f) => f.id === activeId) || null;
  const refreshAll = () => { loadFiles(); loadActive(); };
  const lineCount = lines.length;

  const statusLabel = !active ? "" : active.status === "invalid" ? "语法异常" : "语法合法";
  const statusCls = !active ? "" : active.status === "invalid" ? "err" : "ok";

  const switchFile = (id) => {
    if (id === activeId) return;
    const go = () => { setActiveId(id); setEditing(false); };
    if (dirty) {
      Modal.confirm({
        title: "有未保存的修改",
        content: "切换文件将丢弃当前修改，确定继续吗？",
        okText: "放弃修改并切换",
        okType: "danger",
        cancelText: "留在当前文件",
        onOk: go,
      });
    } else go();
  };

  const handleExport = () => {
    navigator.clipboard?.writeText(content)
      .then(() => notify("原文已复制到剪贴板"))
      .catch(() => notify("复制失败，请手动复制", "err"));
  };

  const handleCreate = () => {
    const nm = newName.trim();
    if (!nm || (!nm.endsWith(".yml") && !nm.endsWith(".yaml"))) { notify("文件名需以 .yml / .yaml 结尾", "err"); return; }
    yamlApi.createYamlConfig({ industry_id: Number(industryId), name: nm, content: `# ${nm} 新建占位\nhosts: []\n` })
      .then((r) => {
        setShowNew(false); setNewName("");
        loadFiles();
        setActiveId(r.data.id);
        notify(`已创建 ${nm}`);
      })
      .catch((e) => {
        const d = e.response?.data?.detail;
        if (e.response?.status === 409) { notify(d || "该行业下已存在同名文件", "err"); return; }
        notify("创建失败：" + (typeof d === "string" ? d : "未知错误"), "err");
      });
  };

  const handleDelete = (f) => {
    Modal.confirm({
      title: `删除「${f.name}」`,
      content: "删除后该文件的内容、版本快照与推送记录将一并移除，且不可恢复。确定删除吗？",
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: () => yamlApi.deleteYamlConfig(f.id)
        .then(() => { notify(`已删除 ${f.name}`); loadFiles(); })
        .catch((e) => notify("删除失败：" + (typeof e.response?.data?.detail === "string" ? e.response.data.detail : "未知错误"), "err")),
    });
  };

  // ---------- 推送 ----------
  const pickFile = (f) => {
    setPushFile(f || null);
    setPreview(null);
    setDiffFilter("all");
  };

  const doPreview = () => {
    if (!pushFile || !active) { notify("请先选择本地 YAML 文件", "warn"); return; }
    setBusy(true);
    setBusyTag("preview");
    yamlApi.previewPush(active.id, pushFile)
      .then((r) => { setBusy(false); setBusyTag(""); setPreview(r.data); notify(r.data.message || "预检完成", "ok"); })
      .catch((e) => {
        setBusy(false);
        setBusyTag("");
        const d = e.response?.data?.detail;
        if (d && typeof d === "object" && Array.isArray(d.errors)) {
          setPreview({ errors: d.errors, message: d.message || "YAML 语法校验未通过，文件整体拒绝" });
        } else {
          setPreview(null);
          notify("预检失败：" + (typeof d === "string" ? d : "未知错误"), "err");
        }
      });
  };

  const doApply = (taskId) => {
    setBusy(true);
    setBusyTag("apply");
    yamlApi.applyPush(active.id, taskId)
      .then((r) => {
        setBusy(false);
        setBusyTag("");
        pickFile(null);
        notify(r.data.message || "提交成功", "ok");
        refreshAll();
      })
      .catch((e) => {
        setBusy(false);
        setBusyTag("");
        notify("提交失败：" + (typeof e.response?.data?.detail === "string" ? e.response.data.detail : "未知错误"), "err");
      });
  };

  /** 提交按钮：第一次点击进入"待确认"，4 秒内再点一次才真正提交 */
  const onApplyClick = () => {
    if (!preview?.task_id) return;
    if (!armApply) { setArmApply(true); return; }
    setArmApply(false);
    doApply(preview.task_id);
  };

  useEffect(() => {
    if (!armApply) return;
    const t = setTimeout(() => setArmApply(false), 4000);
    return () => clearTimeout(t);
  }, [armApply]);

  const genTokens = () => {
    if (!active) return;
    setBusy(true);
    setBusyTag("token");
    Promise.all([
      yamlApi.createYamlPushToken(active.id, "preview"),
      yamlApi.createYamlPushToken(active.id, "apply"),
    ])
      .then(([pv, ap]) => {
        setBusy(false);
        setBusyTag("");
        setPushTokens({ preview: pv.data.token, apply: ap.data.token, expires_at: pv.data.expires_at });
        notify("一次性 Token 已生成（各 1 枚，30 分钟过期）", "ok");
      })
      .catch(() => { setBusy(false); setBusyTag(""); notify("生成 Token 失败", "err"); });
  };

  const doRollback = () => {
    if (!verModal || !active) return;
    Modal.confirm({
      title: "确认回滚",
      content: `将以 v${verModal.version} 的原文生成一次新保存（不覆盖历史版本，保留完整审计轨迹）。`,
      okText: "回滚",
      okType: "danger",
      cancelText: "取消",
      onOk: () => yamlApi.rollbackYamlConfig(active.id, { version: verModal.version, note: `回滚至 v${verModal.version}` })
        .then((r) => { setVerModal(null); notify(`已回滚，生成 v${r.data.version}`, "ok"); refreshAll(); })
        .catch((e) => notify("回滚失败：" + (typeof e.response?.data?.detail === "string" ? e.response.data.detail : "未知错误"), "err")),
    });
  };

  // ---------- 渲染 ----------
  if (filesLoading) {
    return (
      <div className="yaml-root">
        <div className="yaml-toolbar">
          <span className="yt-brand"><span className="y-dot" />YAML 配置工作台<small>加载中…</small></span>
        </div>
        <div className="empty-hint" style={{ padding: 40 }}>正在加载该行业的 YAML 文件…</div>
      </div>
    );
  }
  if (!active) {
    return (
      <div className="yaml-root">
        <div className="yaml-toolbar">
          <span className="yt-back" onClick={() => navigate("/")}>← 行业管理</span>
          <span className="yt-brand"><span className="y-dot" />YAML 配置工作台</span>
        </div>
        <div className="empty-hint" style={{ padding: 60, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📄</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            {files.length === 0 ? "该行业暂无 YAML 配置文件" : "未选中任何文件"}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-sec)", marginBottom: 20 }}>
            {files.length === 0
              ? "新建一个 .yml / .yaml 文件，开始编辑与版本管理。"
              : "请从左侧列表选择一个文件，或新建一个。"}
          </div>
          <button className="yt-btn primary" onClick={() => setShowNew(true)}>＋ 新建 YAML 配置</button>
        </div>
      </div>
    );
  }

  const base = publicBase || "http://localhost:8001";
  const taskIdText = preview?.task_id ?? "<task_id>";
  const previewCmd = `curl -X POST "${base}/api/yaml-configs/${active.id}/push/preview" \\
  -H "Authorization: Bearer ${pushTokens?.preview || "<PREVIEW_TOKEN>"}" \\
  -F "file=@./${active.name}"`;
  const applyCmd = `curl -X POST "${base}/api/yaml-configs/${active.id}/push/${taskIdText}/apply" \\
  -H "Authorization: Bearer ${pushTokens?.apply || "<APPLY_TOKEN>"}" \\
  -H "Content-Type: application/json" -d "{}"`;
  const copyCmd = (cmd, label) => {
    navigator.clipboard?.writeText(cmd)
      .then(() => notify(`${label} 命令已复制`))
      .catch(() => notify("复制失败", "err"));
  };

  const visibleFiles = fileFilter.trim()
    ? files.filter((f) => f.name.toLowerCase().includes(fileFilter.trim().toLowerCase()))
    : files;

  const diffItems = (preview?.diff || []).filter((d) => d.action !== "keep");
  const diffCount = diffItems.reduce((acc, d) => {
    acc[d.action] = (acc[d.action] || 0) + 1;
    return acc;
  }, {});
  const shownDiff = diffFilter === "all" ? diffItems : diffItems.filter((d) => d.action === diffFilter);

  // 底部常驻操作栏的状态与可用性
  const canApply = !!preview?.task_id && preview.changed !== false && !preview?.errors && !busy;
  const footHint = !pushFile
    ? "第 1 步：选择要推送的 YAML 文件"
    : preview?.errors
      ? "预检未通过，请修正文件后重试"
      : preview?.diff
        ? (preview.changed === false
          ? "内容与当前版本一致，无需提交"
          : `${diffItems.length} 处变更，确认后提交入库`)
        : "第 2 步：点击「预检差异」查看变更";

  return (
    <div className="yaml-root">
      {/* ===== 顶栏 ===== */}
      <div className="yaml-toolbar">
        <span className="yt-back" onClick={() => navigate("/")}>← 行业管理</span>
        <span className="yt-sep" />
        <span className="yt-brand">
          <span className="y-dot" />
          {industry ? industry.name : `industry #${industryId}`}
          <small>{active.name}</small>
        </span>
        <span className="yt-sp" />
        <div className="yt-btns">
          <button className={`yt-btn ghost${showSearch ? " on" : ""}`} onClick={() => setShowSearch((v) => !v)} title="全文搜索（Ctrl/⌘ + F）">
            搜索<kbd>⌘F</kbd>
          </button>
          <button className="yt-btn ghost" onClick={() => setShowNew(true)}>新建</button>
          <button className="yt-btn ghost" onClick={handleExport}>导出</button>
          <button className={`yt-btn push${preview ? " live" : ""}`} onClick={() => setOpenPush(true)}>
            接收推送{preview ? <i className="pdot" /> : null}
          </button>
          <span className="yt-sep" />
          {editing ? (
            <>
              <button className="yt-btn" onClick={cancelEdit}>取消</button>
              <button className="yt-btn primary" onClick={handleSave} disabled={!dirty} title="Ctrl/⌘ + S">
                {dirty ? "保存 ●" : "保存"}
              </button>
            </>
          ) : (
            <button className="yt-btn primary" onClick={startEdit}>编辑</button>
          )}
        </div>
      </div>

      {/* ===== 主体 ===== */}
      <div className="yaml-body">
        {/* 左：文件列表 */}
        <div className="ylist">
          <div className="ylist-head">
            YAML 文件 <span className="n">{files.length}</span>
          </div>
          {files.length > 6 && (
            <div className="ylist-filter">
              <input value={fileFilter} onChange={(e) => setFileFilter(e.target.value)} placeholder="筛选文件名…" spellCheck={false} />
            </div>
          )}
          <div className="ylist-scroll">
            {visibleFiles.map((f) => (
              <div
                key={f.id}
                className={`yfile${f.id === activeId ? " on" : ""}`}
                onClick={() => switchFile(f.id)}
                title={`${f.name} · v${f.version}`}
              >
                <div className="f1">
                  <span className={`ystat ${f.status === "invalid" ? "err" : "ok"}`} />
                  <span className="yname">{f.name}</span>
                  {f.id === activeId && dirty && <span className="ydirty" title="有未保存的修改" />}
                </div>
                <div className="f2">
                  <span className="ver">v{f.version}</span>
                  <span>{f.line_count} 行 · {f.node_count} 节点</span>
                </div>
                <button className="yfile-del" title="删除文件" onClick={(e) => { e.stopPropagation(); handleDelete(f); }}>✕</button>
              </div>
            ))}
            {visibleFiles.length === 0 && <div className="empty-hint">没有匹配的文件</div>}
          </div>
        </div>

        {/* 中：高亮编辑器 */}
        <div className={`yedit${editing ? " is-editing" : ""}`}>
          <div className="yedit-head">
            <span className="fname"><b>{active.name}</b></span>
            <span className="fmeta">{fmtDate(active.updated_at)} · {lineCount} 行 · {active.node_count} 节点</span>
            <span className="sp" />
            <input
              className="ygo"
              value={goInput}
              onChange={(e) => setGoInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { handleGo(); e.preventDefault(); } if (e.key === "Escape") setGoInput(""); }}
              placeholder="定位：行号 / 键路径 / 内容"
              spellCheck={false}
              title="输入行号（如 128）、键路径（如 hosts[0].ip）或任意内容，回车跳转；内容命中后可用 Enter 继续下一个"
            />
            <span className={`yedt-tag ${statusCls}`}>{statusLabel}</span>
          </div>

          {showSearch && (
            <div className="ysrch">
              <input
                ref={searchInputRef}
                value={search}
                placeholder="搜索内容（Enter 下一个 / Shift+Enter 上一个 / Esc 关闭）"
                onChange={(e) => { setSearch(e.target.value); setCur(0); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
                  if (e.key === "Escape") closeSearch();
                }}
                spellCheck={false}
              />
              <span className="cnt">{search ? (matches.length ? `${cur + 1}/${matches.length}` : "无结果") : ""}</span>
              <button className="sbtn" title="上一个（Shift+Enter）" onClick={() => stepMatch(-1)} disabled={!matches.length}>↑</button>
              <button className="sbtn" title="下一个（Enter）" onClick={() => stepMatch(1)} disabled={!matches.length}>↓</button>
              <button className="sbtn" title="关闭（Esc）" onClick={closeSearch}>✕</button>
            </div>
          )}

          <div className="yedit-body">
            <div className="yh-layer" aria-hidden="true">
              <div className="yh-inner" ref={hlRef}>
                {lines.map((ln, i) => (
                  <div
                    key={i}
                    className={`yh-line${i + 1 === curLine ? " on" : ""}${i + 1 === flashLine ? " flash" : ""}`}
                  >
                    <span className="yh-gutter">{i + 1}</span>
                    <HighlightLine text={ln} query={search} base={hitBases[i] || 0} cur={cur} />
                  </div>
                ))}
              </div>
            </div>
            <textarea
              ref={taRef}
              className="yh-input"
              value={fullText}
              readOnly={!editing}
              wrap="off"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onScroll={syncScroll}
              onKeyDown={handleKeyDown}
              onSelect={onSelectionChange}
              onClick={onSelectionChange}
              onKeyUp={onSelectionChange}
            />
          </div>
        </div>

        {/* 右：结构 / 版本 */}
        <div className="ypanel">
          <div className="yp-tabs">
            <div className={`yp-tab${tab === "structure" ? " on" : ""}`} onClick={() => setTab("structure")}>
              结构{tree.length ? <em>{tree.length}</em> : null}
            </div>
            <div className={`yp-tab${tab === "versions" ? " on" : ""}`} onClick={() => setTab("versions")}>
              版本{versions.length ? <em>{versions.length}</em> : null}
            </div>
          </div>
          <div className="yp-body">
            {tab === "structure" && (
              <>
                <p className="ytree-desc">点击键名可跳转到原文对应行</p>
                {!treeInfo.valid && treeInfo.errors.length > 0 && (
                  <div className="yp-err">
                    <b>语法异常，仅保留原文（无法结构化）</b>
                    {treeInfo.errors.map((e, i) => (
                      <button key={i} className="err-line" onClick={() => jumpToLine(e.line)} title="点击定位到该行">
                        第 {e.line} 行 · {e.reason}
                      </button>
                    ))}
                  </div>
                )}
                {tree.length === 0 ? (
                  <div className="empty-hint">暂无结构化节点</div>
                ) : (
                  tree.map((n, i) => <TreeNode key={i} n={n} depth={0} defaultOpen onLocate={locateNode} />)
                )}
              </>
            )}

            {tab === "versions" && (
              <>
                <p className="ytree-desc">点击查看全文，可回滚生成新版本（保留审计轨迹）</p>
                {versions.length === 0 && <div className="empty-hint">暂无版本快照</div>}
                {versions.map((v) => (
                  <div key={v.version} className={`ver-row${v.version === active.version ? " current" : ""}`} onClick={() => setVerModal(v)}>
                    <span className="v-badge">v{v.version}</span>
                    <span className="v-note">{v.note || "快照"}</span>
                    <span className="v-meta">{fmtTime(v.created_at)}<br />{v.created_by || "—"}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ===== 状态条 ===== */}
      <div className="yaml-status">
        <span className={statusCls}>● {statusLabel}</span>
        <span>行 {lineCount} · 节点 {active.node_count}</span>
        {dirty && <span className="warn">● 未保存</span>}
        <span className="right">
          <span>Ln {curLine}, Col 1</span>
          <span>UTF-8</span>
          <span>YAML</span>
          <span>{editing ? "编辑中" : "只读"}</span>
        </span>
      </div>

      {/* ===== 接收推送抽屉 ===== */}
      {openPush && (
        <>
          <div className="ypush-mask" onClick={() => setOpenPush(false)} />
          <aside className="ypush">
            <div className="ypush-head">
              <span className="ttl">接收推送</span>
              <span className="sub">{active.name}</span>
              <button className="ypush-x" onClick={() => setOpenPush(false)} title="关闭（Esc）">✕</button>
            </div>
            <div className="ypush-body">
              <label
                className={`ypush-drop${dragOver ? " over" : ""}${pushFile ? " has" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
              >
                <input type="file" hidden accept=".yml,.yaml,.txt" onChange={(e) => pickFile(e.target.files?.[0])} />
                {pushFile ? (
                  <>
                    <b>{pushFile.name}</b>
                    <span>{(pushFile.size / 1024).toFixed(1)} KB · 点击重新选择</span>
                  </>
                ) : (
                  <>
                    <b>拖拽 YAML 文件到这里</b>
                    <span>或点击选择本地文件（.yml / .yaml）</span>
                  </>
                )}
                {pushFile && (
                  <button
                    className="drop-clear"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); pickFile(null); }}
                    title="移除已选文件"
                  >移除</button>
                )}
              </label>

              <div className="ypush-steps">
                <span className={`step${pushFile ? " done" : " on"}`}>1 选择文件</span>
                <span className="ln" />
                <span className={`step${preview ? " done" : pushFile ? " on" : ""}`}>2 预检差异</span>
                <span className="ln" />
                <span className={`step${canApply ? " on" : preview?.changed === false ? " done" : ""}`}>3 确认提交</span>
              </div>

              {preview && preview.errors && (
                <div className="yp-err" style={{ marginTop: 10 }}>
                  <b>{preview.message || "YAML 语法校验未通过，文件整体拒绝"}</b>
                  {preview.errors.map((e, i) => <div key={i} className="err-line">第 {e.line} 行 · {e.reason}</div>)}
                </div>
              )}

              {preview && preview.diff && (
                <div className="ydiff">
                  <div className="ydiff-sum">
                    <span className="ok-n">{diffCount.new || 0} 新增</span>
                    <span className="warn-n">{diffCount.replace || 0} 修改</span>
                    <span className="err-n">{diffCount.delete || 0} 删除</span>
                  </div>
                  <div className="ydiff-chips">
                    {[
                      ["all", `全部 ${diffItems.length}`],
                      ["new", "新增"], ["replace", "修改"], ["delete", "删除"],
                    ].map(([k, label]) => (
                      <button key={k} className={`ychip${diffFilter === k ? " on" : ""}`} onClick={() => setDiffFilter(k)}>{label}</button>
                    ))}
                  </div>
                  <div className="ydiff-list">
                    {shownDiff.length === 0 && <div className="empty-hint">{diffItems.length ? "该分类无差异" : "内容无变化"}</div>}
                    {shownDiff.map((d, i) => (
                      <div key={i} className="ydiff-row" title={d.path}>
                        <span className="act" style={{ color: ACT_COLOR[d.action] }}>{ACT_CN[d.action]}</span>
                        <span className="path">{d.path}</span>
                      </div>
                    ))}
                  </div>
                  {preview.changed === false && (
                    <div className="empty-hint" style={{ padding: "6px 0" }}>内容与当前版本一致，无需提交</div>
                  )}
                </div>
              )}

              <div className="ypush-cmd">
                <button className="ypush-cmd-t" onClick={() => setCmdOpen((v) => !v)}>
                  命令行方式（CI / 脚本推送）{cmdOpen ? "▾" : "▸"}
                </button>
                {cmdOpen && (
                  <>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
                      <button className="yt-btn ghost" onClick={genTokens} disabled={busy}>
                        {pushTokens ? "重新生成 Token" : "生成推送 Token"}
                      </button>
                      {pushTokens && <span className="tok-tip">各 1 枚单次使用 · {fmtTime(pushTokens.expires_at)} 前有效</span>}
                    </div>
                    {pushTokens && (
                      <div className="tok-box">
                        <div><span>preview</span>{pushTokens.preview}</div>
                        <div><span>apply</span>{pushTokens.apply}</div>
                      </div>
                    )}
                    <div className="cmd-card">
                      <div className="c-head"><span className="st">preview</span>预检差异 · 返回 task_id
                        <span className="copy" onClick={() => copyCmd(previewCmd, "preview")}>复制</span></div>
                      <pre>{previewCmd}</pre>
                    </div>
                    <div className="cmd-card">
                      <div className="c-head"><span className="st">apply</span>确认提交 · 需一次性 Token
                        <span className="copy" onClick={() => copyCmd(applyCmd, "apply")}>复制</span></div>
                      <pre>{applyCmd}</pre>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* 常驻操作栏：按钮始终可见，不随内容滚动，不可用时置灰并说明原因 */}
            <div className="ypush-foot">
              <span className="ypush-hint">{footHint}</span>
              <div className="ypush-actions">
                <button className="yt-btn" onClick={() => setOpenPush(false)} disabled={busy}>关闭</button>
                <button className="yt-btn" onClick={doPreview} disabled={busy || !pushFile} title={pushFile ? "对比本地文件与当前版本" : "请先选择文件"}>
                  {busyTag === "preview" ? "预检中…" : "预检差异"}
                </button>
                <button
                  className={`yt-btn ${armApply ? "danger" : "primary"}`}
                  onClick={onApplyClick}
                  disabled={!canApply}
                  title={canApply ? "提交后自动生成版本快照，失败整体回滚" : footHint}
                >
                  {busyTag === "apply" ? "提交中…" : armApply ? "再次点击确认提交" : "确认提交"}
                </button>
              </div>
            </div>
          </aside>
        </>
      )}

      {/* 新建弹窗 */}
      <Modal
        title="新建 YAML 配置"
        open={showNew}
        onCancel={() => setShowNew(false)}
        onOk={handleCreate}
        okText="创建"
        cancelText="取消"
      >
        <p style={{ fontSize: 12.5, color: "var(--text-sec)", marginBottom: 8 }}>文件名（以 .yml / .yaml 结尾），归属当前行业。</p>
        <Input
          placeholder="deploy_config.yml"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={handleCreate}
          autoFocus
        />
      </Modal>

      {/* 版本查看 / 回滚 */}
      <Modal
        title={verModal ? `v${verModal.version} · ${verModal.note || "快照"} · ${fmtTime(verModal.created_at)}${verModal.created_by ? ` · ${verModal.created_by}` : ""}` : ""}
        open={!!verModal}
        onCancel={() => setVerModal(null)}
        width={760}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="yt-btn" onClick={() => setVerModal(null)}>关闭</button>
            {verModal && verModal.version !== active.version && (
              <button className="yt-btn primary" onClick={doRollback}>回滚到此版本</button>
            )}
          </div>
        }
      >
        <pre className="mono" style={{ maxHeight: 440, overflowY: "auto", margin: 0, padding: "10px 12px", background: "var(--bg-deep2)", border: "1px solid var(--border-soft)", borderRadius: 6, fontSize: 11.5, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {verModal ? verModal.content : ""}
        </pre>
      </Modal>

      {toast && <div className={`yt-toast${toast.type === "err" ? " err" : ""}${toast.type === "warn" ? " warn" : ""}`}>{toast.msg}</div>}
    </div>
  );
}
