import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import ThemeProvider, { useTheme } from "./theme/ThemeProvider";
import "./theme/theme.css";
import "./components/appshell.css";

// 按应用主题（dark/soft/light）切换 antd 算法与 token，保持底层组件（弹窗/表单/开关/下拉）与页面一致
function ThemedAntd({ children }) {
  const { theme: appTheme } = useTheme();
  const palette = {
    dark: {
      algorithm: theme.darkAlgorithm,
      token: {
        colorPrimary: "#4a8af4", colorLink: "#6ba8fa", borderRadius: 6,
        colorBgBase: "#18181c", colorBgContainer: "#202024", colorBgElevated: "#2a2a30",
        colorBorder: "#2a2a30", colorBorderSecondary: "#222226",
        colorText: "#e8e8ea", colorTextSecondary: "#b0b0bc", colorTextTertiary: "#808090",
        fontSize: 13,
      },
    },
    soft: {
      algorithm: theme.darkAlgorithm,
      token: {
        colorPrimary: "#4a8af4", colorLink: "#8b9cf6", borderRadius: 6,
        colorBgBase: "#232338", colorBgContainer: "#2a2a42", colorBgElevated: "#35354f",
        colorBorder: "#31314a", colorBorderSecondary: "#26263a",
        colorText: "#edeef6", colorTextSecondary: "#b9bac8", colorTextTertiary: "#8e8fa1",
        fontSize: 13,
      },
    },
    light: {
      algorithm: theme.defaultAlgorithm,
      token: {
        colorPrimary: "#3b74e0", colorLink: "#3b74e0", borderRadius: 6,
        colorBgBase: "#ffffff", colorBgContainer: "#ffffff", colorBgElevated: "#f2f4f8",
        colorBorder: "#e1e6ee", colorBorderSecondary: "#e7ebf1",
        colorText: "#1a1c28", colorTextSecondary: "#464a58", colorTextTertiary: "#868b9b",
        fontSize: 13,
      },
    },
  }[appTheme] || {
    algorithm: theme.darkAlgorithm,
    token: {},
  };

  return (
    <ConfigProvider locale={zhCN} theme={palette}>
      {children}
    </ConfigProvider>
  );
}

// 应用入口：ThemeProvider 在外层提供主题上下文，ThemedAntd 据此适配 antd 暗色/亮色算法
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <ThemedAntd>
          <App />
        </ThemedAntd>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
