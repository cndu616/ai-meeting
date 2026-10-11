import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents / partialPrefetching 已停用：Next 16.4.0 开启 cacheComponents 时
  // next build 预渲染内置 /_global-error 页报 "useContext of null"（自定义 global-error.tsx
  // 亦无法绕过），构建无法完成。配套改动：两个 page.tsx 的 export const instant = false
  // 已移除（instant 是 cacheComponents 的伴生 segment 选项），动态渲染语义由
  // await connection() 承担。升级 Next 若修复此 bug 可恢复启用。
  // cacheComponents: true,
  // partialPrefetching: true,
  serverExternalPackages: ["better-sqlite3", "@anthropic-ai/claude-agent-sdk"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
