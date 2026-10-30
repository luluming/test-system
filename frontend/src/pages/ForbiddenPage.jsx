import { useNavigate } from "react-router-dom";

// 403 无权限页：IDE 风格，复用主题变量
export default function ForbiddenPage() {
  const navigate = useNavigate();
  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        color: "var(--text-sec)",
      }}
    >
      <div
        style={{
          fontSize: 64,
          fontWeight: 700,
          letterSpacing: 4,
          color: "var(--text-ter)",
          fontFamily: "var(--mono, monospace)",
        }}
      >
        403
      </div>
      <div style={{ fontSize: 15, color: "var(--text-pri)" }}>你没有该项目的访问权限</div>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-ter)" }}>
        如需访问，请联系项目负责人或系统管理员开通权限
      </p>
      <button className="btn primary" style={{ marginTop: 10 }} onClick={() => navigate("/")}>
        返回首页
      </button>
    </div>
  );
}
