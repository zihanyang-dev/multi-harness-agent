# 数据库迁移

后续使用 dbmate 管理可审阅的 SQL 迁移。当前未创建 Thread、Turn、outbox 或认证表；领域合同确定后再增加迁移。

`pnpm db:migrate` 会访问 DATABASE_URL 指向的数据库，只有配置正确且已有待执行迁移时使用。
