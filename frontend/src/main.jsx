import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";

// 应用入口：配置 AntD 中文语言包 + 克制风格主题（品牌色/弱边框/适中圆角） + 浏览器路由
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#3d5a75", // 品牌强调色（雾霾蓝），仅用于关键交互
          colorLink: "#3d5a75",
          borderRadius: 6, // 圆角适中
          colorBorder: "#d7dee6", // 弱化边框
          colorText: "#1e2933",
          colorTextSecondary: "#64748b",
          fontSize: 14,
        },
      }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>
);
