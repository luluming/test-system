import { useEffect, useState } from "react";
import { useOps } from "./OpsContext";
import * as inner from "../../api/nginxInner";

const ACT_CN = { replace: "替换", new: "新建", none: "无变化", keep: "系统保留" };
const ACT_COLOR = {
  replace: "var(--err)",
  new: "var(--ok)",
  none: "var(--text-ter)",
  keep: "var(--text-ter)",
};

function fmtTime(s) {
  if (!s) return "";
  return new Date(s).toLocaleString("zh-CN", { hour12: false });
}

function ActionTag({ action }) {
  return (
    <span style={{
      display: "inline-block", padding: "1px 8px", borderRadius: 3,
      border: `1px solid ${ACT_COLOR[action]}`,
      color: ACT_COLOR[action], background: "transparent",
      fontSize: 10, lineHeight: 1.6, whiteSpace: "nowrap",
    }}>
      {ACT_CN[action] || action}
    </span>
  );
}

function StatusTag({ status }) {
  const map = {
    pending: { c: "var(--brand)", t: "待提交" },
    applying: { c: "var(--warn)", t: "提交中" },
    success: { c: "var(--ok)", t: "已提交" },
    failed: { c: "var(--err)", t: "失败" },
  };
  const m = map[status] || { c: "var(--text-ter)", t: status };
  return (
    <span style={{ color: m.c, fontWeight: 600, whiteSpace: "nowrap" }}>{m.t}</span>
  );
}

function CopyBtn({ text, label }) {
  const ops = useOps();
  const copy = () => {
    navigator.clipboard?.writeText(text)
      .then(() => ops.toast(`${label}已复制`, "ok"))
      .catch(() => ops.toast("复制失败", "err"));
  };
  return <button className="btn mini" onClick={copy}>复制</button>;
}

export default function PushModal({ open, onClose }) {
  const ops = useOps();
  const { configId, industry, configs, ctx, toast, loadTree } = ops;
  const [tab, setTab] = useState("push");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null); // {task_id, diff, counts, message} 或 {errors}
  const [tasks, setTasks] = useState([]);
  const [detail, setDetail] = useState(null); // {id, raw_text, diff}
  const [busy, setBusy] = useState(false);
  const [pushTokens, setPushTokens] = useState(null); // {preview, apply, expires_at}
  const [taskIdInput, setTaskIdInput] = useState("");
  const [publicBase, setPublicBase] = useState(""); // 后端公网基址

  const configName = (configs || []).find((c) => c.id === configId)?.name || "";
  const industryName = industry?.name || "";

  const loadTasks = () => {
    if (!configId) return;
    inner.listPushTasks(configId).then((r) => setTasks(r.data || [])).catch(() => {});
  };
  useEffect(() => {
    if (open) {
      loadTasks();
      setTab("push");
      inner.getMetaBase()
        .then((r) => setPublicBase(r.data?.base_url || ""))
        .catch(() => setPublicBase(""));
    }
  }, [open, configId]);

  const doPreview = () => {
    if (!file) { toast("请先选择本地配置文件", "warn"); return; }
    setBusy(true);
    inner.previewPush(configId, file)
      .then((r) => {
        setBusy(false);
        setPreview(r.data);
        setDetail(null);
        setTaskIdInput(String(r.data.task_id || ""));
        loadTasks();
        toast(r.data.message || "预览完成", "ok");
      })
      .catch((e) => {
        setBusy(false);
        const d = e.response?.data?.detail;
        const errors = d && typeof d === "object" && Array.isArray(d.errors) ? d.errors : null;
        if (errors) {
          setPreview({ errors });
          toast("解析失败，文件整体拒绝", "err");
        } else {
          const msg = typeof d === "string" ? d : "未知错误";
          setPreview(null);
          toast("预览失败：" + msg + (msg.includes("token") ? "，请点击右上角重新生成后重试" : ""), "err");
        }
      });
  };

  const doApply = (taskId) => {
    if (!window.confirm("确认提交该差异到系统？提交后将自动生成版本快照，失败会整体回滚。")) return;
    setBusy(true);
    inner.applyPush(configId, taskId)
      .then((r) => {
        setBusy(false);
        setPreview(null);
        setFile(null);
        setDetail(null);
        loadTasks();
        loadTree(configId, ctx);
        toast(r.data.message || "提交成功", "ok");
      })
      .catch((e) => {
        setBusy(false);
        const d = e.response?.data?.detail;
        toast("提交失败：" + (typeof d === "string" ? d : "未知错误"), "err");
      });
  };

  const genTokens = () => {
    setBusy(true);
    Promise.all([
      inner.createPushToken(configId, "preview"),
      inner.createPushToken(configId, "apply"),
    ])
      .then(([pv, ap]) => {
        setBusy(false);
        setPushTokens({
          preview: pv.data.token,
          apply: ap.data.token,
          expires_at: pv.data.expires_at,
        });
        // 自动回填最新 pending 任务的 task_id（若存在）
        const pending = (tasks || []).find((t) => t.status === "pending");
        if (pending) setTaskIdInput(String(pending.id));
        toast("一次性 token 已生成（预览+提交各一枚，单次使用，30 分钟过期）", "ok");
      })
      .catch((e) => {
        setBusy(false);
        const d = e.response?.data?.detail;
        toast("生成 token 失败：" + (typeof d === "string" ? d : "未知错误"), "err");
      });
  };

  const openDetail = (t) => {
    if (detail && detail.id === t.id) { setDetail(null); return; }
    inner.getPushTask(configId, t.id)
      .then((r) => {
        setDetail(r.data);
      })
      .catch(() => toast("记录详情加载失败", "err"));
  };

  const originBase = `${window.location.origin}`.replace(/:\d+$/, "") || "http://localhost";
  const base = publicBase || originBase;
  const previewToken = pushTokens?.preview || "<TOKEN>";
  const applyToken = pushTokens?.apply || "<TOKEN>";
  const taskIdText = taskIdInput || "<task_id>";
  const applyCmd = preview?.apply_command || `curl -X POST "${base}/api/nginx-configs/${configId}/push/${taskIdText}/apply" \\
  -H "Authorization: Bearer ${applyToken}" \\
  -H "Content-Type: application/json" -d "{}"`;
  const curlCmd = `curl -X POST "${base}/api/nginx-configs/${configId}/push/preview" \\
  -H "Authorization: Bearer ${previewToken}" \\
  -F "file=@/path/to/local.conf"
# 确认提交（预览返回的 task_id 已填充，<APPLY_TOKEN> 替换为你的 apply token）：
${applyCmd}`;
  const cliCmd = `python tools/nginx_push.py --industry "${industryName}" --config "${configName}" --file /path/to/local.conf
# 预览无异议后确认提交（追加 --apply）：
python tools/nginx_push.py --industry "${industryName}" --config "${configName}" --file /path/to/local.conf --apply`;

  if (!open) return null;
  return (
    <div className="ops-modal-mask" onClick={onClose}>
      <div className="ops-modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>本地配置推送</h3>
        <div className="seg-row" style={{ marginBottom: 12 }}>
          <div className={`seg-i${tab === "push" ? " on" : ""}`} onClick={() => setTab("push")}>推送</div>
          <div className={`seg-i${tab === "records" ? " on" : ""}`} onClick={() => setTab("records")}>推送记录</div>
        </div>

        {tab === "push" && (
          <>
            <div className="fgroup">
              <label>本地配置文件（.conf）</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="file" accept=".conf,.txt,.text,text/plain,application/octet-stream"
                  onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); }}
                  style={{ flex: 1 }} />
                <button className="btn primary" onClick={doPreview} disabled={busy}>{busy ? "处理中…" : "预览差异"}</button>
              </div>
            </div>

            {preview && preview.errors && (
              <div style={{ marginTop: 10, border: "1px solid var(--err)", borderRadius: 6, padding: "8px 12px", fontSize: 12, color: "var(--err)", background: "var(--bg-deep2)" }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>解析失败，文件整体拒绝（不写入系统）：</div>
                {preview.errors.map((e, i) => (
                  <div key={i}>第 {e.line} 行：{e.reason}</div>
                ))}
              </div>
            )}

            {preview && preview.diff && (
              <div style={{ marginTop: 10 }}>
                <div className="modal-tip" style={{ marginBottom: 6 }}>{preview.message}</div>
                {preview.changed === false && (
                  <div style={{ marginBottom: 6, fontSize: 12, color: "var(--ok)" }}>
                    ✓ 无任何变更，无需提交；下方差异均为「无变化」。
                  </div>
                )}
                <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border-soft)", borderRadius: 6, background: "var(--bg-deep2)", padding: "6px 4px" }}>
                  {preview.diff.map((e, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 8px", fontSize: 12, fontFamily: "var(--mono)" }}>
                      <ActionTag action={e.action} />
                      <span style={{ color: "var(--text-prim)" }}>{e.display}</span>
                    </div>
                  ))}
                </div>
                <div className="modal-actions" style={{ marginTop: 10 }}>
                  <button className="btn" onClick={() => setPreview(null)}>放弃</button>
                  {preview.changed !== false && (
                    <button className="btn primary" onClick={() => doApply(preview.task_id)} disabled={busy}>确认提交</button>
                  )}
                </div>
              </div>
            )}

            <div style={{ marginTop: 14, borderTop: "1px solid var(--border-soft)", paddingTop: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "var(--text-ter)" }}>
                  生成命令（推送目标：{industryName} / {configName}，基址 {publicBase ? "公网地址" : "当前站点"}：{base}）
                </span>
                <button className="btn mini primary" onClick={genTokens} disabled={busy || !configId}>
                  {busy ? "生成中…" : (pushTokens ? "重新生成 Token" : "生成推送 Token")}
                </button>
              </div>
              {pushTokens && (
                <div style={{ fontSize: 10, color: "var(--warn)", marginBottom: 6 }}>
                  token 仅可各用一次（预览 1 枚 + 提交 1 枚），{new Date(pushTokens.expires_at).toLocaleString("zh-CN", { hour12: false })} 前有效；再次点击会作废旧 token 并重新签发。
                </div>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-sec)", whiteSpace: "nowrap" }}>task_id</span>
                <input
                  value={taskIdInput}
                  onChange={(e) => setTaskIdInput(e.target.value.trim())}
                  placeholder="预览返回的 task_id（预览后自动填充）"
                  style={{ flex: 1, height: 26, fontSize: 11, padding: "0 8px", background: "var(--bg-input)", border: "1px solid var(--border-soft)", borderRadius: 4, color: "var(--text-prim)" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-sec)", paddingTop: 2 }}>curl</span>
                <pre className="mono" style={{ flex: 1, margin: 0, padding: "6px 10px", background: "var(--bg-deep2)", border: "1px solid var(--border-soft)", borderRadius: 6, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{curlCmd}</pre>
                <CopyBtn text={curlCmd} label="curl 命令" />
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span style={{ fontSize: 11, color: "var(--text-sec)", paddingTop: 2 }}>CLI</span>
                <pre className="mono" style={{ flex: 1, margin: 0, padding: "6px 10px", background: "var(--bg-deep2)", border: "1px solid var(--border-soft)", borderRadius: 6, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{cliCmd}</pre>
                <CopyBtn text={cliCmd} label="CLI 命令" />
              </div>
            </div>
          </>
        )}

        {tab === "records" && (
          <>
            <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="modal-tip" style={{ margin: 0 }}>推送历史（原文与差异均已留档，双重保底）</span>
              <button className="btn mini" onClick={loadTasks}>刷新</button>
            </div>
            {tasks.length === 0 ? (
              <div className="empty-hint">暂无推送记录。</div>
            ) : (
              <div style={{ maxHeight: 300, overflowY: "auto", border: "1px solid var(--border-soft)", borderRadius: 6, background: "var(--bg-deep2)" }}>
                {tasks.map((t) => {
                  const counts = { replace: 0, new: 0, none: 0, keep: 0 };
                  (t.diff || []).forEach((e) => { counts[e.action] = (counts[e.action] || 0) + 1; });
                  const expanded = detail && detail.id === t.id;
                  return (
                    <div key={t.id} style={{ borderBottom: "1px solid var(--border-soft)", padding: "6px 10px" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 11, color: "var(--text-ter)" }}>#{t.id}</span>
                        <StatusTag status={t.status} />
                        <span style={{ fontSize: 11, color: "var(--text-ter)" }}>{fmtTime(t.created_at)}</span>
                        <span className="mono" style={{ fontSize: 11, color: "var(--text-ter)" }}>
                          替换{counts.replace} · 新建{counts.new} · 无变化{counts.none} · 保留{counts.keep}
                        </span>
                        {t.error_detail && (
                          <span style={{ fontSize: 11, color: "var(--err)" }}>{t.error_detail}</span>
                        )}
                        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                          <button className="btn mini" onClick={() => openDetail(t)}>{expanded ? "收起" : "详情"}</button>
                          {t.status === "pending" && (
                            <button className="btn mini primary" onClick={() => doApply(t.id)}>确认提交</button>
                          )}
                        </span>
                      </div>
                      {expanded && detail && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 11, color: "var(--text-ter)", marginBottom: 4 }}>差异清单</div>
                          <div style={{ maxHeight: 140, overflowY: "auto", border: "1px solid var(--border-soft)", borderRadius: 6, background: "var(--bg-deep)", padding: "4px" }}>
                            {(detail.diff || []).map((e, i) => (
                              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 6px", fontSize: 12, fontFamily: "var(--mono)" }}>
                                <ActionTag action={e.action} />
                                <span style={{ color: "var(--text-prim)" }}>{e.display}</span>
                              </div>
                            ))}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-ter)", margin: "6px 0 4px" }}>推送原文（{detail.raw_text?.split("\n").length || 0} 行）</div>
                          <pre className="mono" style={{ margin: 0, maxHeight: 160, overflowY: "auto", padding: "6px 10px", background: "var(--bg-deep)", border: "1px solid var(--border-soft)", borderRadius: 6, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{detail.raw_text || ""}</pre>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
