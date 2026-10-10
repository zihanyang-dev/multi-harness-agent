# Multi Harness Agent

多 harness 的云端通用 Agent 产品基座。直接复用 Pi、OpenAI Agents SDK、Claude Agent SDK，不自行实现 Agent loop，不预定义视频或编码创作流程。

**当前是项目骨架，不是可用 Agent 产品。**

## 已建立

- pnpm workspace、Node 24.21.0 项目运行时、TypeScript 严格检查。
- React / Vite Web 入口与真实 HTTP liveness 查询。
- Hono API 入口，`GET /healthz` 返回 `{ "status": "ok" }`，不表示数据库或队列就绪。
- Harness / Sandbox 初始契约与官方 SDK 依赖，不另建 portable Tool／MCP／Skills 契约。
- OpenAI 原生 factory adapter：有序输入、文本观察、原生审批与本地 execution ownership；尚未接入产品 API。
- Pi 原生 AgentSession binding：文本执行、原生 history／工具、完整文本观察与取消／释放；尚未接入产品 API。
- BullMQ / Redis、SQL、认证、S3、遥测的依赖归属。
- 格式、lint、类型检查、单元测试、构建、浏览器 smoke 和 CI。
- 本地 PostgreSQL / Redis Compose，Server / Worker 非 root 镜像入口。

## 未实现

Thread / 消息业务 API、迁移与 outbox、任务消费者、公开事件分发、认证接入、成果交付、Claude adapter、E2B adapter、评测数据集与评分器。

Worker 入口只说明未注册执行器并退出，**不会连接 Redis 或领取任务**。运行检查不会调用模型、创建 sandbox 或使用云端凭证。

## 开始开发

安装 pnpm 12.8.1。项目通过 `devEngines.runtime` 在需要时下载并使用 Node 24.21.0，不修改全局 Node；首次安装需要网络。

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

- Web：<http://localhost:5173>
- HTTP liveness：<http://127.0.0.1:3000/healthz>
- Web 开发代理 `/api/*` 到 API 的默认 3000 端口；调整 API 端口时同步 `apps/web/vite.config.ts`。

无需启动数据库即可查看骨架。需要本地基础设施时：

```bash
pnpm infra:up
pnpm infra:down
```

只有新增实际迁移后才运行 `pnpm db:migrate`，该命令会访问 DATABASE_URL 指向的数据库。

## 检查

```bash
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm check` 执行 lint、类型检查、单元测试与构建。共享包先构建再消费；开发入口使用 development exports，生产入口读取 dist。

E2E 使用 3000 / 5173 端口并启动独立服务，不复用正在运行的开发进程；运行前停止 `pnpm dev`。浏览器测试只检查 Web → Hono 的真实连接，不调用 Agent。

依赖 exact pin 并提交 lockfile。pnpm 限制依赖 build scripts，仅批准必要的 esbuild；新版本发布年龄例外按精确版本列出，后续更新不得自动扩大允许范围。

## 目录

```text
apps/
  web/                       # 产品 UI
  server/                    # HTTP 与产品入口
  worker/                    # 执行监督；尚未注册消费者
packages/
  harness/                   # 公共契约与 OpenAI／Pi 原生接入
  sandbox/                   # 管理权限与单环境能力分开
  protocol/                  # 跨边界 schema

evals/                       # 后续直接消费同一 adapters
  datasets/
  graders/
tests/e2e/                   # 本地浏览器 smoke
deploy/                      # 本地基础设施与应用镜像；生产部署待验证
docs/
```

代码中的注释、错误、日志、UI 文案与测试文字统一英文；说明文档中文。部署命令与限制见 [deploy/README.md](deploy/README.md)。

基础 UI 使用 Tailwind；assistant-ui 已安装但未启用 Agent runtime。shadcn/ui 是按需加入的源码组件，不提前生成未使用的组件库。

## 设计文档

- [项目目标](docs/project-goals.md)
- [架构品味](docs/architecture-taste.md)
- [代码品味](docs/code-taste.md)
- [技术选型与生产架构基线](docs/technology-stack.md)
- [OpenAI 接入与限制](packages/harness/src/openai/README.md)
- [OpenAI 代码审查与验收边界](docs/openai-review.md)
- [Pi 接入与限制](packages/harness/src/pi/README.md)
- [Pi 代码审查与验收边界](docs/pi-review.md)
