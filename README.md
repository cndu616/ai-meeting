# AI Meeting

多 Agent 会议系统：多个平等的 AI agent 围绕话题（通常是某个代码库的技术决策）
轮流讨论，用户以群聊 + 私聊双身份参与。基于 Claude Agent SDK。

## 环境要求

- Node 18+
- Claude Code CLI 已安装并可运行（SDK 依赖）
- `ANTHROPIC_API_KEY` 已配置或 claude CLI 已登录

## 启动

```bash
npm install
npm run dev
```

打开 http://localhost:3000

## 使用流程

1. 新建会议：填话题、指定工作区目录（agent 只能读写该目录）、选 2-8 个 agent、
   给每个 agent 分配会议角色（派别/立场）
2. 进入房间点「开始」：agent 按轮次依次发言，可用文件工具查证工作区代码
3. 你可以随时在聊天室发言（下一轮对所有人可见），或与单个 agent 私聊
   （仅对方可见，但会影响它的会上立场——同一上下文）
4. 暂停后可随时「继续」（召回会议），轮数用尽可追加
5. agent 的工具操作只在左侧卡片显示状态，不污染聊天室；想知道它做了什么，
   直接问它

## 内置 agent

`agents/` 目录下的 JSON 即 agent 库（启动时自动导入），可自行添加。
字段：`id`（slug）、`name`、`capability`（常规能力）、`description`、
`persona`（能力人设，进入 system prompt）、`avatar`。

## 已知限制

- 进程重启时，会议中排队的未注入私信会保留在数据库但不会被自动注入
  （重新发一次即可）
- 私聊与会议发言共用同一 agent 会话，会议进行中私信会在轮到该 agent 时
  优先处理

## 测试

```bash
npm test
```

## 项目结构

- `src/core/` 会议引擎（轮次调度、消息注入、SDK 会话封装），不依赖 Next.js
- `src/db/` Drizzle schema 与 SQLite client
- `src/app/` Next.js 页面与 API（REST + SSE）
- `src/components/room/` 会议房间 UI 组件
- `agents/` 内置 agent 配置文件
