# AI Meeting

多 Agent 会议系统：多个平等的 AI agent 围绕话题（通常是某个代码库的技术决策）
自由讨论，用户以群聊 + 私聊双身份参与。基于 Claude Agent SDK。

## 环境要求

- Node 20+
- Claude Code CLI 已安装并可运行（SDK 依赖）
- `ANTHROPIC_API_KEY` 已配置或 claude CLI 已登录
- Windows 无 Visual Studio 的机器：`npm install` 须加 `--ignore-scripts`
  （npm 会为含 binding.gyp 的 better-sqlite3 隐式触发 node-gyp 编译，
  找不到 VS 即整体失败；其预编译二进制随包自带，跳过脚本不影响使用）

## 启动

```bash
npm install              # Windows 加 --ignore-scripts
npm install --ignore-scripts
npm run dev
```

打开 http://localhost:3000

## 停止

- 前台运行：在终端按 `Ctrl+C`
- 后台运行或终端已关闭：按端口找进程结束

```bash
# Linux / macOS
lsof -ti:3000 | xargs kill

# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess }

# Windows (Git Bash)
netstat -ano | grep ":3000 .*LISTENING" | awk '{print $5}' | sort -u |
  xargs -r -n1 taskkill //F //PID
```

会议数据持久化在 SQLite，停止/重启不丢失；进行中的会议重启后需「继续」召回。

## 使用流程

1. 新建会议：填话题、指定工作区目录（agent 只能读写该目录）、选 2-8 个 agent、
   给每个 agent 分配会议角色（派别/立场）
2. 进入房间点「开始」：消息实时推送给所有 agent，各自自主决定发言或沉默，
   可用文件工具查证工作区代码
3. 你可以随时在聊天室发言（实时推送对所有人可见），或与单个 agent 私聊
   （仅对方可见，但会影响它的会上立场——同一上下文）
4. 暂停后可随时「继续」（召回会议，上下文与讨论增量完整恢复）
5. agent 的工具操作只在左侧卡片显示状态，不污染聊天室；想知道它做了什么，
   直接问它

## 内置 agent

`agents/` 目录下的 JSON 即 agent 库（启动时自动导入），可自行添加。
字段：`id`（slug）、`capability`（常规能力）、`description`、
`persona`（能力人设，进入 system prompt）、`avatar`。

## 已知限制

- 进程重启后，成员最后一条无回应的私信会在会议「继续」时自动补推；
  更早的连续多条未回应私信目前只补最后一条（其余重新发一次即可）
- 私聊与会议发言共用同一 agent 上下文：会议进行中私信即时推送，
  暂停期间走一次性会话处理

## 测试

```bash
npm test
```

## 项目结构

- `src/core/` 会议引擎（消息分发、增量注入、SDK 会话封装），不依赖 Next.js
- `src/db/` Drizzle schema 与 SQLite client
- `src/app/` Next.js 页面与 API（REST + SSE）
- `src/components/room/` 会议房间 UI 组件
- `agents/` 内置 agent 配置文件

## 卸载

无全局依赖、不写系统配置，删除项目目录即完成卸载。先停止 dev server
（运行中的进程会锁定 `.next` 导致删除失败），再分步清理：

```bash
rm -rf node_modules   # 依赖
rm -rf .next          # 构建产物
rm -rf data           # SQLite 数据（全部会议记录，删前确认）
```

外部依赖（Claude Code CLI、`ANTHROPIC_API_KEY`）为自行安装，按需另行处理。
