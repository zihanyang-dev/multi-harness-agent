# Multi Harness Agent

多 harness 的云端通用 Agent 产品基座。直接复用 Pi、OpenAI Agents SDK、Claude Agent SDK，不自行实现 Agent loop，不预定义视频或编码创作流程。

**已有真实认证、文本会话 UI 与第一条 Pi 执行路径；还不是完整云端 Agent 产品。**

## 已建立

- pnpm workspace、Node 24.21.0、TypeScript 严格检查、非 root Server / Worker 镜像入口。
- React / Tailwind CSS / Vite 会话 UI：原生登录、持久侧栏、Thread URL、完整回答、取消、复制与手机布局；`/status` 保留 liveness 查询。
- Better Auth 原生认证、用户归属校验、写请求 Origin 检查、Thread / Turn HTTP API。
- PostgreSQL 原子接受、不可变输入与幂等重放、事务 outbox；Server 发布 BullMQ 引用型通知。
- Worker 持久 claim → Pi 原生执行 → invocation / 控制观察 / dispose join → 正式结果与终态原子提交。
- Pi 不可变 `text-v1`（默认）／`web-search-v1` 策略、原生 history、精确 ID 恢复与真实增量文本／工具活动。
- OpenAI / Claude 原生 adapters 与各自 history、审批、receipt、恢复语义；尚未装配到产品 HTTP 路径。
- 真实 PostgreSQL / Redis、官方 Pi loop / native tool 的集成与 13 项浏览器回归；新版真实 `gpt-5.5` 验证含 5 次调用 / 7 个场景组（无 live Tavily）。范围与限制见[会话验证](docs/conversation-ui.md)和[实时报告](docs/evidence/conversation-streaming-live.json)。

未知执行仍阻塞 Thread，不自动 takeover；SQL token 和 Redis lock 都不是对原生 history / filesystem 的物理 fencing。

## 未实现

文件与成果交付、搜索以外的业务工具、E2B adapter、完整审批产品路径、自动 crash recovery，以及评测数据集与评分器。当前 host 不开放 shell / filesystem tools 或动态资源发现。

## 开始开发

安装 pnpm 12.8.1。项目通过 `devEngines.runtime` 在需要时使用 Node 24.21.0，不修改全局 Node；首次安装需要网络。

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

默认 `AGENT_BACKEND_ENABLED=0`：Server 只提供 liveness，Worker 不打开基础设施或原生凭据并退出。

- Web：<http://127.0.0.1:5173>；默认后端关闭时可查看布局，登录与会话 API 尚不可用。
- HTTP liveness：<http://127.0.0.1:3000/healthz>，不表示数据库、队列或模型就绪。
- Web 开发代理 `/api/*` 到 API 默认 3000 端口；可在启动 Web 时设置 `WEB_API_PROXY_TARGET` 调整目标。

启用后端前，先配置 `.env.example` 所列的数据库、Redis、原生认证 secret / URL、相同 Pi profile / storage identity，以及 Worker 的显式 API key、绝对状态目录与 deadline。需要本地基础设施与迁移时：

```bash
pnpm infra:up
pnpm db:migrate
# 完成基础设施使用后；不会删除数据卷
pnpm infra:down
```

`db:migrate` 会访问 `DATABASE_URL` 指向的数据库，不在服务启动时自动运行。开发容器没有 TLS 时，连接 URL 需加 `?sslmode=disable`。确认配置后再设 `AGENT_BACKEND_ENABLED=1`。

原生公开注册默认关闭；本地测试需要时显式设 `AUTH_ALLOW_SIGN_UP=1`，不要把它当成生产账号准入。产品写 API 要求 `Origin` 等于 `BETTER_AUTH_URL` 的 origin，缺失或外来 origin 均拒绝。该配置应为浏览器访问的根 origin（本地默认 `http://127.0.0.1:5173`），不是私有 API 端口；不要混用 `localhost` 与 `127.0.0.1`。Web 部署需使用正确的同源入口。

## HTTP 路径

- `/auth/*`：Better Auth 原生路由。
- `POST /threads`、`GET /threads?after=<threadId>`、`GET /threads/:threadId`。
- `POST /threads/:threadId/turns`、`GET /threads/:threadId/turns?after=<turnId>`。
- `GET /turns/:turnId`、`POST /turns/:turnId/cancel`。
- `GET /turns/:turnId/events`：认证并核对 owner 的 SSE，具名事件 `turn`（SQL 快照）、`activity`（白名单临时活动）、`gap`（观察缺口）；native EventSource 通过 `Last-Event-ID` 恢复 Redis cursor。断线不取消执行，正式结果替换预览；5 秒查询仅作 SSE 不可用／对账的备援，不以 1.5 秒轮询为主通道。

Turn 提交包含 caller 生成的 UUID `requestId` 与有序 `input.content` 文本数组。相同身份和相同输入重放原记录；不同输入冲突。每个 Thread 同时只准入一个未收尾 Turn，不另建 prompt backlog。Thread create/get/list 返回 `tools: ['web_search'] | []`；wire 字段可选只为兼容旧客户端，缺失不用于猜测策略。具体 DTO 与执行边界见 [设计说明](docs/thread-turn-design.md)。

## 检查

```bash
pnpm check
# 显式指向独立、可创建临时 schema 的 loopback PostgreSQL 和独立 Redis
TEST_DATABASE_URL='postgresql://agent:agent@127.0.0.1:5432/agent' \
TEST_REDIS_URL='redis://127.0.0.1:6379' pnpm test:integration
pnpm exec playwright install chromium
# 同样显式提供 TEST_DATABASE_URL / TEST_REDIS_URL 时运行完整会话浏览器回归
TEST_DATABASE_URL='postgresql://agent:agent@127.0.0.1:5432/agent' \
TEST_REDIS_URL='redis://127.0.0.1:6379' pnpm test:e2e
```

`pnpm check` 执行 lint、类型检查、单元测试与构建；集成测试另行显式运行，不加载开发者 `.env`，不用个人或付费模型凭据。SDK fixture 由隔离 child launcher 执行，不直接混入普通测试进程。

E2E 使用独立的 3001 / 5174 端口，不复用开发进程。有测试 URL 时，隔离 schema / queue / HOME，运行真实认证、SQL、队列与 Pi native loop，仅用官方 faux 替换外部模型 IO；无两个 URL 时会话用例跳过，仅验 `/status` liveness。真实模型验证不在普通 CI 中运行，范围与 sanitized reports 见 [会话 UI 与 E2E](docs/conversation-ui.md)。

共享包先构建再消费；开发入口使用 development exports，生产读取 dist。依赖 exact pin、lockfile 与受限 build scripts，不自动扩大版本年龄例外。

## 目录与 owner

```text
apps/server/src/
  identity/                  # 原生认证装配
  conversation/              # 产品规则、HTTP、命令发布
  db/                        # 产品完整 SQL 操作
  server.ts                  # HTTP / publisher / Pool / Redis 生命周期
apps/worker/src/
  execution/                 # 执行监督与执行侧 SQL
  harness/pi/                # 产品 Pi host 装配
  worker.ts                  # BullMQ 消费与 joined drain
packages/
  database/                  # 连接、结构、SQL 迁移；不拥有会话业务
  protocol/                  # 公开 HTTP 与私有执行协议分开
  harness/                   # 生产与评测共享的原生 adapters
  sandbox/                   # 后续 sandbox 合同
```

业务不是因为两进程都查数据库就归入共享包。目录理由见 [目录结构](docs/directory-structure.md)，部署边界见 [deploy/README.md](deploy/README.md)。代码、注释、错误、日志、UI 与测试文字统一英文；说明文档中文。

## 设计文档

- [项目目标](docs/project-goals.md)
- [架构品味](docs/architecture-taste.md) / [代码品味](docs/code-taste.md)
- [技术选型与生产架构基线](docs/technology-stack.md)
- [Thread / Turn 设计与证据边界](docs/thread-turn-design.md)
- [后端完整代码审查与修复证据](docs/backend-review.md)
- [会话 UI、工作流与真实 E2E](docs/conversation-ui.md)
- [Agent 产品源码研究与能力边界](docs/agent-product-research.md)
- [OpenAI 接入](packages/harness/src/openai/README.md) / [审查与限制](docs/openai-review.md)
- [Pi 接入](packages/harness/src/pi/README.md) / [审查与限制](docs/pi-review.md)
- [Claude 接入](packages/harness/src/claude/README.md) / [审查与限制](docs/claude-review.md)
