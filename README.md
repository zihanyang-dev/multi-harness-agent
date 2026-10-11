# Multi Harness Agent

多 harness 的云端通用 Agent 产品基座。直接复用 Pi、OpenAI Agents SDK、Claude Agent SDK，不自行实现 Agent loop，不预定义视频或编码创作流程。

**已有第一条受限后端执行路径；还不是完整云端 Agent 产品。**

## 已建立

- pnpm workspace、Node 24.21.0、TypeScript 严格检查、非 root Server / Worker 镜像入口。
- React / Vite Web 入口与真实 HTTP liveness 查询；Web 尚未接入会话交互。
- Better Auth 原生认证、用户归属校验、写请求 Origin 检查、Thread / Turn HTTP API。
- PostgreSQL 原子接受、不可变输入与幂等重放、事务 outbox；Server 发布 BullMQ 引用型通知。
- Worker 持久 claim → Pi 原生执行 → invocation / 控制观察 / dispose join → 正式结果与终态原子提交。
- Pi 固定文本策略、原生 history、精确 ID 恢复与完整回答观察；不冒充 token streaming。
- OpenAI / Claude 原生 adapters 与各自 history、审批、receipt、恢复语义；尚未装配到产品 HTTP 路径。
- 真实 PostgreSQL / Redis 集成测试、官方 Pi faux 新建与跨 host 恢复测试，以及格式、类型、构建、浏览器 smoke 和 CI。

未知执行仍阻塞 Thread，不自动 takeover；SQL token 和 Redis lock 都不是对原生 history / filesystem 的物理 fencing。

## 未实现

会话 Web、SSE / 公开事件分发、文件与成果交付、业务工具、E2B adapter、完整审批产品路径、自动 crash recovery，以及评测数据集与评分器。当前文本 host 不开放 shell / filesystem tools 或动态资源发现。

## 开始开发

安装 pnpm 12.8.1。项目通过 `devEngines.runtime` 在需要时使用 Node 24.21.0，不修改全局 Node；首次安装需要网络。

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

默认 `AGENT_BACKEND_ENABLED=0`：Server 只提供 liveness，Worker 不打开基础设施或原生凭据并退出。

- Web：<http://localhost:5173>
- HTTP liveness：<http://127.0.0.1:3000/healthz>，不表示数据库、队列或模型就绪。
- Web 开发代理 `/api/*` 到 API 默认 3000 端口；调整端口时同步 `apps/web/vite.config.ts`。

启用后端前，先配置 `.env.example` 所列的数据库、Redis、原生认证 secret / URL、相同 Pi profile / storage identity，以及 Worker 的显式 API key、绝对状态目录与 deadline。需要本地基础设施与迁移时：

```bash
pnpm infra:up
pnpm db:migrate
# 完成基础设施使用后；不会删除数据卷
pnpm infra:down
```

`db:migrate` 会访问 `DATABASE_URL` 指向的数据库，不在服务启动时自动运行。开发容器没有 TLS 时，连接 URL 需加 `?sslmode=disable`。确认配置后再设 `AGENT_BACKEND_ENABLED=1`。

原生公开注册默认关闭；本地测试需要时显式设 `AUTH_ALLOW_SIGN_UP=1`，不要把它当成生产账号准入。产品写 API 要求 `Origin` 等于 `BETTER_AUTH_URL` 的 origin，缺失或外来 origin 均拒绝；后续 Web 部署需使用正确的同源入口。

## HTTP 路径

- `/auth/*`：Better Auth 原生路由。
- `POST /threads`、`GET /threads/:threadId`。
- `POST /threads/:threadId/turns`、`GET /threads/:threadId/turns?after=<turnId>`。
- `GET /turns/:turnId`、`POST /turns/:turnId/cancel`。

Turn 提交包含 caller 生成的 UUID `requestId` 与有序 `input.content` 文本数组。相同身份和相同输入重放原记录；不同输入冲突。每个 Thread 同时只准入一个未收尾 Turn，不另建 prompt backlog。具体 DTO 与执行边界见 [设计说明](docs/thread-turn-design.md)。

## 检查

```bash
pnpm check
# 显式指向独立、可创建临时 schema 的 loopback PostgreSQL 和独立 Redis
TEST_DATABASE_URL='postgresql://agent:agent@127.0.0.1:5432/agent' \
TEST_REDIS_URL='redis://127.0.0.1:6379' pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm check` 执行 lint、类型检查、单元测试与构建；集成测试另行显式运行，不加载开发者 `.env`，不用个人或付费模型凭据。SDK fixture 由隔离 child launcher 执行，不直接混入普通测试进程。

E2E 使用 3000 / 5173 端口并启动独立服务，不复用开发进程；运行前停止 `pnpm dev`。它只验证 Web → Hono 的真实连接，不是会话 UI 或真实模型验收。

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
- [本轮完整代码审查与修复证据](docs/backend-review.md)
- [OpenAI 接入](packages/harness/src/openai/README.md) / [审查与限制](docs/openai-review.md)
- [Pi 接入](packages/harness/src/pi/README.md) / [审查与限制](docs/pi-review.md)
- [Claude 接入](packages/harness/src/claude/README.md) / [审查与限制](docs/claude-review.md)
