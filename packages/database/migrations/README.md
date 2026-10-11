# 数据库迁移

数据库结构和迁移由共享基础设施包管理，产品和执行的业务 SQL 分别归 Server / Worker。

- `202610110001_auth.sql`：按 Better Auth 1.7.7 原生 migration compiler 生成的 PostgreSQL 结构，没有自建 session / 登录协议。
- `202610110002_conversations.sql`：Thread、不可变 Turn、Attempt、outbox，以及身份、归属、准入与正式终态约束。
- `../schema.sql`：dbmate 使用 PostgreSQL 18 `pg_dump` 生成的当前 schema；不是手工编辑的第二份迁移。文件含有效的 psql meta-command，不是仅含单条 SQL 的脚本。

```bash
pnpm db:migrate
```

此命令读取配置的 `DATABASE_URL`，不会在 Server / Worker 启动时自动执行。运行前确认目标数据库和 TLS 条件；本地无 TLS 容器 URL 需显式 `sslmode=disable`，生产不能据此关闭 TLS。

本轮在独立临时 PostgreSQL 18.6 上验证：up → rollback 会话迁移 → rollback 认证迁移 → up，最终 applied 2 / pending 0，并重新生成 schema。没有对开发者数据或生产数据库执行迁移。
