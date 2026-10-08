import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite 构建配置
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 将 /api 开头的请求代理到后端 FastAPI 服务
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
