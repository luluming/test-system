import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import http from "node:http";

const API_TARGET = "http://localhost:8001";

// Vite 内置 proxy 在转发后端非 2xx（如 401）响应给浏览器时存在缺陷，
// 会把后端正确的 401 转成空 text/plain 500，导致前端无法识别未授权。
// 这里改用自定义 dev-server 中间件，用 Node http 直接 pipe 到后端，
// 保证 5174/api/*（含地址栏直接访问）都正确透传后端的真实状态码与响应体。
const apiProxyPlugin = {
  name: "api-proxy",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url || !req.url.startsWith("/api")) {
        return next();
      }
      const target = new URL(API_TARGET);
      const proxyReq = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `${target.hostname}:${target.port}`,
          },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxyReq.on("error", (err) => {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`代理转发到 ${API_TARGET} 失败: ${err.message}`);
      });
      req.pipe(proxyReq);
    });
  },
};

export default defineConfig({
  plugins: [react(), apiProxyPlugin],
  server: {
    // 监听 0.0.0.0，允许局域网/远程通过本机 IP 访问；固定端口 5174
    host: true,
    port: 5174,
  },
});