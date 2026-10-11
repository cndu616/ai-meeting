// src/app/global-error.tsx —— 全局错误边界（Next 文件约定）。
// 必须自带 <html>/<body>（激活时替换根布局）；'use client' 必须（错误边界是客户端组件）。
// 背景：缺此文件时 next build 预渲染内置 /_global-error 页在 cacheComponents 配置下报
// "useContext of null"（dispatcher 为空），自定义文件让预渲染走本组件，构建恢复绿。
'use client';

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body className="flex h-screen flex-col items-center justify-center gap-4">
        <h2 className="text-lg font-bold">页面发生严重错误</h2>
        <p className="text-sm text-gray-500">{error.digest ? `错误标识：${error.digest}` : '请稍后重试'}</p>
        <button
          onClick={() => retry()}
          className="rounded bg-gray-800 px-4 py-1.5 text-sm text-white hover:bg-gray-700"
        >
          重试
        </button>
      </body>
    </html>
  );
}
