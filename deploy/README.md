# 部署与本地基础设施

`compose.yaml` 只启动本地 PostgreSQL 18 与 Redis 8，不是生产部署。端口只绑定 localhost；示例凭证仅用于本地开发。

```bash
pnpm infra:up
pnpm db:migrate
pnpm infra:down
```

迁移访问 `DATABASE_URL`，先确认配置；无 TLS 的本地 PostgreSQL 需要 `?sslmode=disable`。`infra:down` 保留数据卷。端口改变时，同时调整 POSTGRES_PORT / REDIS_PORT 和连接 URL。

Redis 使用 AOF、everysec 与 noeviction；不提供零丢失或独立高可用保证。Server 的 outbox publisher 持续重发现 accepted / unclaimed Turn，不能把 Redis enqueue ACK 当成持久交接。PostgreSQL 18 使用新版本数据目录挂载位置。

## 应用镜像入口

从仓库根构建，pnpm deploy 打包生产依赖；Server / Worker 都非 root：

```bash
docker build -f deploy/Dockerfile --target server -t multi-harness-server:local .
docker build -f deploy/Dockerfile --target worker -t multi-harness-worker:local .
docker run --rm -p 127.0.0.1:3000:3000 multi-harness-server:local
```

默认 `AGENT_BACKEND_ENABLED=0`：Server 只提供 `/healthz`，Worker 不连接基础设施或读取原生凭据并退出。启用后端须分别注入：

- Server：数据库、Redis producer、Better Auth secret / 根 URL、同一 Pi binding；拥有 HTTP、发布任务与全部进程资源。
- Worker：数据库、Redis consumer、相同 binding、显式 Pi API key、绝对 `PI_STATE_ROOT` 与有界 deadline；拥有执行与 joined drain，不发布 outbox。
- 数据库迁移：由独立部署动作运行，不由应用隐式执行。

容器内的 `127.0.0.1` 不是宿主机或其他容器；启用模式需要实际的私有网络连接 URL，不能直接复用示例宿主机 URL。生产公开 origin 要与 `BETTER_AUTH_URL` 一致，Thread / Turn 写请求缺失或外来 Origin 会被拒绝。公开注册默认关闭；单进程内存限流也不等于多副本统一账号准入。

Worker 镜像为非 root 创建权限 0700 的 `/var/lib/multi-harness/pi`；生产应挂载持久、私有且具有明确 writer owner 的状态卷。`PI_STORAGE_ID` 必须对应真实物理存储身份；不能让不同磁盘冒用同一身份，也不能把它当成物理 fencing。当前没有自动 crash takeover。

Web 构建输出为 `apps/web/dist/`。静态托管、同源 `/api` 路由和会话 UI 尚未接入；浏览器 smoke 仅覆盖 liveness。`.dockerignore` 排除真实 `.env`、依赖和测试输出；镜像构建不注入模型或 sandbox 凭据。

Docker 只是发布载体，不是对不可信工具的隔离保证。当前 text-v1 host 不开放 shell / filesystem tools 或动态资源发现。云端 IaC、生产高可用、租户 / OS 隔离、共享状态物理 fencing、凭据代理与恢复流程尚未验收；本地集成、镜像构建或健康响应都不能代替这些保证。
