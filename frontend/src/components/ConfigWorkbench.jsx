import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, message } from "antd";
import {
  getYamlConfig,
  listYamlVersions,
  rollbackYamlConfig,
  saveYamlConfig,
} from "../api/yaml";
import "../pages/nacos.css";

/**
 * Nacos 配置工作台：一个弹窗里完成「查看 / 编辑 / 版本时间线 / 版本对比」。
 *
 * 左侧版本时间线标出每版相对上一版的 +N/-M；右侧可在「编辑」与「对比」间切换，
 * 对比为并排行级 diff（基准版本可选），因此不再需要独立的「详情」「历史版本」弹窗。
 */

const splitLines = (t) => (t ?? "").split("\n");

// LCS 求最小编辑序列（仅返回 ctx/del/add，行号由调用方映射）
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "ctx", a: i, b: j });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", a: i });
      i += 1;
    } else {
      ops.push({ type: "add", b: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: "del", a: i });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: "add", b: j });
    j += 1;
  }
  return ops;
}

// 先裁掉公共前后缀，只对中间变动段做 LCS，避免整文件 O(n²)
function diffLines(aText, bText) {
  const a = splitLines(aText);
  const b = splitLines(bText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf += 1;
  }
  const mid = lcsOps(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
  const ops = [];
  for (let i = 0; i < pre; i += 1) ops.push({ type: "ctx", a: i, b: i });
  mid.forEach((op) => {
    ops.push({
      type: op.type,
      a: op.a == null ? null : op.a + pre,
      b: op.b == null ? null : op.b + pre,
    });
  });
  for (let k = 0; k < suf; k += 1) {
    ops.push({ type: "ctx", a: a.length - suf + k, b: b.length - suf + k });
  }
  return { a, b, ops };
}

// 把 ops 转成左右并排的行（连续删除与新增按序配对，视觉上更整齐）
// 同时产出按「连续变更块」分组的 hunks，供逐块 / 批量合并使用
function toRows(diff) {
  const { a, b, ops } = diff;
  const rows = [];
  const hunks = [];
  let dels = [];
  let adds = [];
  const flushHunk = () => {
    if (dels.length === 0 && adds.length === 0) return;
    const idx = hunks.length;
    hunks.push({ dels: [...dels], adds: [...adds] });
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k += 1) {
      rows.push({
        hunk: idx,
        hunkFirst: k === 0,
        left: k < dels.length
          ? { no: dels[k] + 1, text: a[dels[k]], type: "del" }
          : null,
        right: k < adds.length
          ? { no: adds[k] + 1, text: b[adds[k]], type: "add" }
          : null,
      });
    }
    dels = [];
    adds = [];
  };
  ops.forEach((op) => {
    if (op.type === "del") dels.push(op.a);
    else if (op.type === "add") adds.push(op.b);
    else {
      flushHunk();
      rows.push({
        hunk: null,
        hunkFirst: false,
        left: { no: op.a + 1, text: a[op.a], type: "ctx" },
        right: { no: op.b + 1, text: b[op.b], type: "ctx" },
      });
    }
  });
  flushHunk();
  return { rows, hunks };
}

// 行内差异：裁掉公共前后缀，只高亮真正变化的片段
function inlineDiff(aText, bText) {
  const a = aText ?? "";
  const b = bText ?? "";
  const maxPre = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < maxPre && a[pre] === b[pre]) pre += 1;
  const maxSuf = Math.min(a.length - pre, b.length - pre);
  let suf = 0;
  while (suf < maxSuf && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  return {
    pre: a.slice(0, pre),
    aMid: a.slice(pre, a.length - suf),
    aSuf: a.slice(a.length - suf),
    bMid: b.slice(pre, b.length - suf),
    bSuf: b.slice(b.length - suf),
  };
}

function countChanges(diff) {
  let added = 0;
  let removed = 0;
  diff.ops.forEach((op) => {
    if (op.type === "add") added += 1;
    if (op.type === "del") removed += 1;
  });
  return { added, removed };
}

// 构造匹配器：普通子串（可区分大小写）/ 正则
function makeMatcher(query, caseSensitive, useRegex) {
  if (!query) return { ranges: () => [], error: "" };
  if (useRegex) {
    let re;
    try {
      re = new RegExp(query, caseSensitive ? "g" : "gi");
    } catch {
      return { ranges: () => [], error: "正则表达式无效" };
    }
    return {
      error: "",
      ranges: (text) => {
        const out = [];
        re.lastIndex = 0;
        let m = re.exec(text);
        while (m) {
          if (m[0].length === 0) re.lastIndex += 1;
          else {
            out.push([m.index, m.index + m[0].length]);
            re.lastIndex = m.index + m[0].length;
          }
          m = re.exec(text);
        }
        return out;
      },
    };
  }
  return {
    error: "",
    ranges: (text) => {
      const out = [];
      const hay = caseSensitive ? text : text.toLowerCase();
      const needle = caseSensitive ? query : query.toLowerCase();
      let from = 0;
      while (from <= hay.length) {
        const idx = hay.indexOf(needle, from);
        if (idx === -1) break;
        out.push([idx, idx + needle.length]);
        from = idx + needle.length;
      }
      return out;
    },
  };
}

function Highlight({ text, ranges }) {
  if (!ranges || ranges.length === 0) return text;
  const parts = [];
  let last = 0;
  ranges.forEach(([s, e], i) => {
    if (s > last) parts.push(text.slice(last, s));
    parts.push(
      <mark key={`h${i}`} className="nc-hit">
        {text.slice(s, e)}
      </mark>
    );
    last = e;
  });
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const fmtTime = (t) => (t ? String(t).replace("T", " ").slice(0, 16) : "—");

export default function ConfigWorkbench({ row, tenant, canEdit, onClose, onSaved }) {
  const cfgId = row?.id;
  const open = !!row;

  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState("");
  const [currentVersion, setCurrentVersion] = useState(1);
  const [versions, setVersions] = useState([]);
  const [mode, setMode] = useState("edit"); // edit | diff
  const [targetVer, setTargetVer] = useState(null); // 对比右侧：版本号或 "edit"
  const [baseVer, setBaseVer] = useState(null); // 对比左侧：版本号
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  // 逐块合并选择：hunk 序号 → "base"（保持基准） | "target"（采用目标）
  const [choices, setChoices] = useState({});

  const taRef = useRef(null);
  const gutterRef = useRef(null);

  const load = useCallback(async () => {
    if (!cfgId) return;
    setLoading(true);
    try {
      const [detail, vers] = await Promise.all([
        getYamlConfig(cfgId),
        listYamlVersions(cfgId),
      ]);
      setContent(detail.data.content_text || "");
      setCurrentVersion(detail.data.version);
      setVersions(vers.data || []);
      setDirty(false);
    } catch {
      message.error("配置加载失败");
    } finally {
      setLoading(false);
    }
  }, [cfgId]);

  useEffect(() => {
    if (!open) return;
    setMode("edit");
    setTargetVer(null);
    setBaseVer(null);
    setOnlyChanges(true);
    setNote("");
    setQuery("");
    setMatchIdx(0);
    load();
  }, [open, cfgId, load]);

  // 每版相对上一版的增删行数（版本列表按倒序返回）
  const versionStats = useMemo(() => {
    const out = {};
    versions.forEach((v, i) => {
      const prev = versions[i + 1]?.content ?? "";
      const diff = diffLines(prev, v.content ?? "");
      out[v.version] = countChanges(diff);
    });
    return out;
  }, [versions]);

  const versionContent = useCallback(
    (ver) => versions.find((v) => v.version === ver)?.content ?? "",
    [versions]
  );

  const targetContent = targetVer === "edit" ? content : versionContent(targetVer);
  const baseContent = versionContent(baseVer);

  const diff = useMemo(
    () => diffLines(baseContent, targetContent),
    [baseContent, targetContent]
  );
  const view = useMemo(() => toRows(diff), [diff]);
  const rows = view.rows;
  const hunks = view.hunks;
  const stats = useMemo(() => countChanges(diff), [diff]);

  const visibleRows = useMemo(() => {
    if (!onlyChanges) return rows;
    const keep = new Set();
    rows.forEach((r, i) => {
      if (!r.left || !r.right || r.left.type === "del" || r.right.type === "add") {
        for (let k = i - 1; k <= i + 1; k += 1) keep.add(k);
      }
    });
    rows.forEach((r, i) => {
      if (r.left?.type === "del" || r.right?.type === "add") keep.add(i);
    });
    return rows.filter((_, i) => keep.has(i));
  }, [rows, onlyChanges]);

  const wholeDiffRows = useMemo(
    () => toRows(diffLines("", targetContent)).rows,
    [targetContent]
  );

  const matcher = useMemo(
    () => makeMatcher(query, caseSensitive, useRegex),
    [query, caseSensitive, useRegex]
  );

  // 编辑模式下按行统计命中并定位
  const editLines = useMemo(() => splitLines(content), [content]);
  const editMatches = useMemo(() => {
    if (!query) return [];
    const out = [];
    editLines.forEach((line, li) => {
      matcher.ranges(line).forEach(([s, e]) => out.push({ line: li, s, e, offset: 0 }));
    });
    return out;
  }, [editLines, matcher, query]);

  useEffect(() => {
    setMatchIdx(0);
  }, [query, caseSensitive, useRegex, mode, targetVer, baseVer]);

  // 切换对比基准/目标后，逐块选择重新开始
  useEffect(() => {
    setChoices({});
  }, [baseVer, targetVer]);

  const choiceOf = (idx) => choices[idx] || "target";

  const pickHunk = (idx, pick) =>
    setChoices((prev) => ({ ...prev, [idx]: pick }));

  // 按当前逐块选择生成合并结果：基准行 + 选中块的「采用目标」行
  const buildMerged = useCallback(() => {
    const a = splitLines(baseContent);
    const b = splitLines(targetContent);
    const out = [];
    let hi = -1;
    let inHunk = false;
    diff.ops.forEach((op) => {
      if (op.type === "ctx") {
        out.push(a[op.a] ?? "");
        inHunk = false;
        return;
      }
      if (!inHunk) {
        hi += 1;
        inHunk = true;
      }
      const pick = choiceOf(hi);
      if (op.type === "del" && pick === "base") out.push(a[op.a] ?? "");
      if (op.type === "add" && pick === "target") out.push(b[op.b] ?? "");
    });
    return out.join("\n");
  }, [baseContent, targetContent, diff, choices]);

  const doMergeToEditor = () => {
    if (!hunks.length) return;
    setContent(buildMerged());
    setMode("edit");
    setDirty(true);
    message.success(`已按当前选择合并 ${hunks.length} 处差异，请确认后保存`);
  };

  useEffect(() => {
    if (mode !== "edit") return;
    const m = editMatches[matchIdx];
    const ta = taRef.current;
    if (!m || !ta) return;
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 19.2;
    ta.scrollTop = Math.max(0, (m.line - 3) * lineHeight);
    const lineStart = editLines.slice(0, m.line).join("\n").length + (m.line ? 1 : 0);
    ta.focus();
    ta.setSelectionRange(lineStart + m.s, lineStart + m.e);
  }, [matchIdx, editMatches, mode, editLines]);

  const step = (delta) => {
    const total = mode === "edit" ? editMatches.length : 0;
    if (!total) return;
    setMatchIdx((i) => (i + delta + total) % total);
  };

  const openDiffFor = (ver) => {
    const idx = versions.findIndex((v) => v.version === ver);
    const prev = versions[idx + 1]?.version ?? ver;
    setBaseVer(prev);
    setTargetVer(ver);
    setMode("diff");
    setOnlyChanges(true);
  };

  const doSave = async (forceDraft = false) => {
    if (!cfgId) return;
    setBusy(true);
    try {
      const res = await saveYamlConfig(cfgId, {
        content,
        expected_version: currentVersion,
        note: note.trim() || undefined,
        force_draft: forceDraft,
      });
      message.success(`已保存，当前版本 v${res.data.version}`);
      setNote("");
      await load();
      onSaved?.();
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (err.response?.status === 422) {
        const errs = Array.isArray(detail?.errors) ? detail.errors : [];
        Modal.confirm({
          title: "配置内容语法校验未通过",
          content: (
            <div>
              <pre className="nc-err-pre">{errs.length ? errs.join("\n") : detail?.message || "语法校验未通过"}</pre>
              <p className="meta">仍要保存为草稿吗？草稿会标记为语法异常，不参与推送。</p>
            </div>
          ),
          okText: "仍保存为草稿",
          cancelText: "返回修改",
          onOk: () => doSave(true),
        });
      } else if (err.response?.status === 409) {
        message.error("配置已被他人修改，已为你刷新到最新版本");
        await load();
      } else {
        message.error(detail?.message || "保存失败");
      }
    } finally {
      setBusy(false);
    }
  };

  const doRollback = (ver) => {
    Modal.confirm({
      title: `回滚到 v${ver}？`,
      content: "回滚会以该版本原文生成一个新版本，历史记录不会被覆盖。",
      okText: "回滚",
      cancelText: "取消",
      onOk: async () => {
        setBusy(true);
        try {
          const res = await rollbackYamlConfig(cfgId, {
            version: ver,
            note: `回滚到 v${ver}`,
          });
          message.success(`已回滚，当前版本 v${res.data?.version ?? ""}`);
          await load();
          setMode("edit");
          onSaved?.();
        } catch (err) {
          message.error(err.response?.data?.detail || "回滚失败");
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const requestClose = () => {
    if (dirty && canEdit) {
      Modal.confirm({
        title: "放弃未保存的修改？",
        content: "当前编辑内容尚未保存，关闭后将丢失。",
        okText: "放弃",
        okButtonProps: { danger: true },
        cancelText: "继续编辑",
        onOk: () => onClose?.(),
      });
      return;
    }
    onClose?.();
  };

  const matchTotal = mode === "edit" ? editMatches.length : 0;

  return (
    <Modal
      open={open}
      onCancel={requestClose}
      footer={null}
      width={1180}
      centered
      destroyOnClose
      className="ncwb-modal"
      title={null}
    >
      <div className="ncwb">
        <header className="ncwb-head">
          <div className="ncwb-id">
            <span className="ncwb-dot" />
            <span className="ncwb-name mono">{row?.data_id}</span>
            <span className="ncwb-path mono">
              {tenant} / {row?.group}
            </span>
          </div>
          <div className="ncwb-head-meta">
            <span className="tag2 bare">{row?.format}</span>
            {row?.status === "invalid" && <span className="tag2 warn">语法异常</span>}
            <span className="ncwb-ver mono">当前 v{currentVersion}</span>
            <button className="ncwb-x" onClick={requestClose} title="关闭">×</button>
          </div>
        </header>

        <div className="ncwb-body">
          {/* 版本时间线 */}
          <aside className="ncwb-rail">
            <div className="ncwb-rail-head">
              <span>版本时间线</span>
              <span className="ncwb-rail-count">{versions.length}</span>
            </div>
            <div className="ncwb-rail-list">
              {loading && <p className="meta">加载中…</p>}
              {!loading && versions.length === 0 && <p className="meta">暂无版本记录</p>}
              {versions.map((v) => {
                const st = versionStats[v.version] || { added: 0, removed: 0 };
                const selected = mode === "diff" && targetVer === v.version;
                return (
                  <button
                    key={v.id}
                    className={"ncwb-node" + (selected ? " on" : "")}
                    onClick={() => openDiffFor(v.version)}
                    title="对比该版本与上一版本"
                  >
                    <span className="ncwb-node-dot" />
                    <span className="ncwb-node-top">
                      <b className="mono">v{v.version}</b>
                      {v.version === currentVersion && <span className="tag2 ok">当前</span>}
                      {(st.added > 0 || st.removed > 0) && (
                        <span className="ncwb-stat mono">
                          {st.added > 0 && <i className="add">+{st.added}</i>}
                          {st.removed > 0 && <i className="del">-{st.removed}</i>}
                        </span>
                      )}
                    </span>
                    <span className="ncwb-node-note">{v.note || "（无备注）"}</span>
                    <span className="ncwb-node-time mono">
                      {v.created_by || "-"} · {fmtTime(v.created_at)}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* 右侧：编辑 / 对比 */}
          <section className="ncwb-main">
            <div className="ncwb-toolbar">
              <div className="ncwb-seg">
                <button
                  className={mode === "edit" ? "on" : ""}
                  onClick={() => setMode("edit")}
                >
                  编辑
                </button>
                <button
                  className={mode === "diff" ? "on" : ""}
                  onClick={() => {
                    setMode("diff");
                    if (!targetVer) setTargetVer("edit");
                    if (!baseVer) setBaseVer(versions[1]?.version ?? versions[0]?.version ?? 1);
                  }}
                >
                  对比
                </button>
              </div>

              {mode === "diff" && (
                <>
                  <label className="ncwb-pick">
                    <span>基准</span>
                    <select
                      value={baseVer ?? ""}
                      onChange={(e) => setBaseVer(Number(e.target.value))}
                    >
                      {versions.map((v) => (
                        <option key={v.id} value={v.version}>v{v.version}</option>
                      ))}
                    </select>
                  </label>
                  <span className="ncwb-arrow">→</span>
                  <label className="ncwb-pick">
                    <span>目标</span>
                    <select
                      value={targetVer ?? "edit"}
                      onChange={(e) =>
                        setTargetVer(
                          e.target.value === "edit" ? "edit" : Number(e.target.value)
                        )
                      }
                    >
                      <option value="edit">编辑中内容</option>
                      {versions.map((v) => (
                        <option key={v.id} value={v.version}>v{v.version}</option>
                      ))}
                    </select>
                  </label>
                  <label className="ncwb-check">
                    <input
                      type="checkbox"
                      checked={onlyChanges}
                      onChange={(e) => setOnlyChanges(e.target.checked)}
                    />
                    只看变更
                  </label>
                  <span className="ncwb-delta mono">
                    <i className="add">+{stats.added}</i>
                    <i className="del">-{stats.removed}</i>
                  </span>
                </>
              )}


              <div className="ncwb-search">
                <input
                  className="nc-input"
                  placeholder={mode === "edit" ? "在内容中搜索（Enter 下一个）" : "在对比结果中搜索"}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      step(e.shiftKey ? -1 : 1);
                    }
                  }}
                />
                <button
                  className={"nc-btn nc-tgl" + (caseSensitive ? " on" : "")}
                  title="区分大小写"
                  onClick={() => setCaseSensitive((v) => !v)}
                >
                  Aa
                </button>
                <button
                  className={"nc-btn nc-tgl" + (useRegex ? " on" : "")}
                  title="正则表达式"
                  onClick={() => setUseRegex((v) => !v)}
                >
                  .*
                </button>
                {mode === "edit" && query && (
                  <>
                    <span className="nc-search-count">
                      {matchTotal ? `${matchIdx + 1}/${matchTotal}` : "0 处匹配"}
                    </span>
                    <button className="nc-btn" onClick={() => step(-1)} disabled={!matchTotal}>↑</button>
                    <button className="nc-btn" onClick={() => step(1)} disabled={!matchTotal}>↓</button>
                  </>
                )}
              </div>
            </div>

            {matcher.error && <p className="nc-regex-err">{matcher.error}</p>}

            {mode === "diff" && canEdit && hunks.length > 0 && (
              <div className="ncwb-mergebench">
                <span className="ncwb-merge-hint">
                  逐块选择 <b>用左侧</b> / <b>用右侧</b>，或批量处理全部{" "}
                  <b>{hunks.length}</b> 个差异块，再生成合并结果
                </span>
                <div className="ncwb-merge-ops">
                  <button
                    className="nc-btn"
                    title="所有差异块都保留基准版本内容"
                    onClick={() =>
                      setChoices(Object.fromEntries(hunks.map((_, i) => [i, "base"])))
                    }
                  >
                    全部保持基准
                  </button>
                  <button
                    className="nc-btn"
                    title="所有差异块都采用目标版本内容"
                    onClick={() =>
                      setChoices(Object.fromEntries(hunks.map((_, i) => [i, "target"])))
                    }
                  >
                    全部采用目标
                  </button>
                  <button
                    className="nc-btn nc-primary"
                    onClick={doMergeToEditor}
                    title="按当前逐块选择生成合并结果，并进入编辑确认"
                  >
                    合并 {hunks.length} 处差异
                  </button>
                </div>
              </div>
            )}

            {mode === "edit" ? (
              <div className="ncwb-editor">
                <div className="ncwb-gutter" ref={gutterRef}>
                  {editLines.map((_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </div>
                <textarea
                  ref={taRef}
                  className="ncwb-ta mono"
                  value={content}
                  spellCheck={false}
                  onChange={(e) => {
                    setContent(e.target.value);
                    setDirty(true);
                  }}
                  onScroll={(e) => {
                    if (gutterRef.current) gutterRef.current.scrollTop = e.target.scrollTop;
                  }}
                />
              </div>
            ) : (
              <div className="ncwb-diff">
                <div className="ncwb-diff-head">
                  <span className="mono">
                    基准 v{baseVer ?? "—"} · {splitLines(baseContent).length} 行
                  </span>
                  <span className="mono">
                    目标 {targetVer === "edit" ? "编辑中内容" : `v${targetVer}`} ·{" "}
                    {splitLines(targetContent).length} 行
                  </span>
                </div>
                <div className="ncwb-diff-body">
                  {visibleRows.length === 0 && (
                    <div className="nc-empty">两个版本内容一致，没有差异。</div>
                  )}
                  {visibleRows.map((r, i) => {
                    // 成对的删除/新增行做行内字符级高亮，避免整行糊成一片
                    const inline =
                      r.left?.type === "del" && r.right?.type === "add"
                        ? inlineDiff(r.left.text, r.right.text)
                        : null;
                    const pick = r.hunk == null ? null : choiceOf(r.hunk);
                    const renderText = (text, side) => {
                      if (query) {
                        return <Highlight text={text} ranges={matcher.ranges(text)} />;
                      }
                      if (!inline) return text;
                      const mid = side === "left" ? inline.aMid : inline.bMid;
                      const suf = side === "left" ? inline.aSuf : inline.bSuf;
                      return (
                        <>
                          {inline.pre}
                          <mark className="ncwb-hl">{mid}</mark>
                          {suf}
                        </>
                      );
                    };
                    return (
                    <div className="ncwb-drow" key={i}>
                      <div className={"ncwb-cell left" + (r.left ? " " + r.left.type : " empty")}>
                        {r.left && (
                          <>
                            <span className="ncwb-ln mono">{r.left.no}</span>
                            <span className="ncwb-txt mono">{renderText(r.left.text, "left")}</span>
                          </>
                        )}
                      </div>
                      <div className={"ncwb-cell right" + (r.right ? " " + r.right.type : " empty")}>
                        {r.right && (
                          <>
                            <span className="ncwb-ln mono">{r.right.no}</span>
                            <span className="ncwb-txt mono">{renderText(r.right.text, "right")}</span>
                          </>
                        )}
                        {r.hunkFirst && canEdit && (
                          <span className="ncwb-hunkact">
                            <button
                              className={"ncwb-pickbtn" + (pick === "base" ? " on" : "")}
                              onClick={() => pickHunk(r.hunk, "base")}
                              title="这一块保留基准版本内容"
                            >
                              用左侧
                            </button>
                            <button
                              className={"ncwb-pickbtn" + (pick === "target" ? " on" : "")}
                              onClick={() => pickHunk(r.hunk, "target")}
                              title="这一块采用目标版本内容"
                            >
                              用右侧
                            </button>
                          </span>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
            )}

            <footer className="ncwb-foot">
              {mode === "edit" ? (
                <>
                  <input
                    className="nc-input ncwb-note"
                    placeholder="变更说明（选填），例如：修复数据库连接超时"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  {canEdit && (
                    <button
                      className="btn primary"
                      onClick={() => doSave(false)}
                      disabled={busy || loading}
                    >
                      {busy ? "保存中…" : "保存并发布"}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="meta">
                    对比 {wholeDiffRows.length} 行 · 变更 {stats.added + stats.removed} 行
                    {hunks.length > 0 && ` · ${hunks.length} 个差异块`}
                  </span>
                  {canEdit && hunks.length > 0 && (
                    <button className="btn primary" onClick={doMergeToEditor} disabled={busy}>
                      合并到编辑区
                    </button>
                  )}
                  {canEdit && targetVer !== "edit" && (
                    <button className="btn" onClick={() => doRollback(targetVer)} disabled={busy}>
                      回滚到此版本
                    </button>
                  )}
                  <button className="btn" onClick={() => setMode("edit")}>
                    回到编辑
                  </button>
                </>
              )}
            </footer>
          </section>
        </div>
      </div>
    </Modal>
  );
}
