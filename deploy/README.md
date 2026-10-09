# 部署与本地基础设施

`compose.yaml` 只启动本地 PostgreSQL 18 与 Redis 8，不是生产部署。端口只绑定 localhost；凭证仅用于本地开发。

```bash
pnpm infra:up
pnpm infra:down
```

`infra:down` 保留数据卷，不自动删除数据库。需要修改端口时，调整根 `.env` 的 POSTGRES_PORT / REDIS_PORT 与应用连接 URL。

Redis 使用 AOF、everysec 与 noeviction；这些设置不提供零丢失或独立高可用保证。活动保留与队列容量需要另行设计。PostgreSQL 18 使用新版本数据目录挂载位置。

## 应用镜像入口

`Dockerfile` 从仓库根构建，pnpm deploy 打包生产依赖。提供非 root 的 server / worker targets：

```bash
docker build -f deploy/Dockerfile --target server -t multi-harness-server:local .
docker build -f deploy/Dockerfile --target worker -t multi-harness-worker:local .
docker run --rm -p 127.0.0.1:3000:3000 multi-harness-server:local
```

Server 当前只提供 `/healthz`；Worker 镜像仍只打印未接入提示并退出，不是长期消费进程。Web 构建输出是 `apps/web/dist/`，生产静态托管与 `/api` 同源路由在确定部署入口后配置。

`.dockerignore` 排除真实 `.env`、依赖、测试输出与本地产物；镜像不接收模型或 sandbox 凭证。Docker 是应用发布载体，不是对不可信 Agent 代码的隔离保证。

当前 API 和 Web smoke 不要求基础设施；没有迁移、队列消费者或 SDK 调用。云端 IaC、镜像 digest 准入、原生 SDK 实际运行条件、凭证代理与故障行为仍待接入验证，不能将成功构建当成生产验收。
