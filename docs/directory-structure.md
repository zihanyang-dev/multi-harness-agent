# 目录结构与归属

## 判断标准

目录表达事实和动作的 owner，不表达一套固定的 service / repository 分层模板。相同表被两个进程使用，不意味着会话业务属于共享包。原子决定也不能为了分层拆成几个可单独调用的半动作。

参考 `video-agent-example` 的领域归属，但不机械复制其 SDK 拓扑：本仓库的原生 adapters 确有产品与评测两个消费者，仍放在 `packages/harness`；产品权限、模型与 storage 的装配归具体应用。

## Server：会话产品与命令发布

```text
apps/server/src/
  main.ts                       # 配置入口、进程信号、私有诊断
  config.ts                     # 显式能力开关与部署条件
  server.ts                     # HTTP、publisher、Pool、Redis / Queue 生命周期
  app.ts                        # liveness、原生认证和领域路由装配
  identity/
    authentication.ts           # Better Auth 原生配置；借用 Pool
  conversation/
    http.ts                     # 认证、Origin、DTO、HTTP 状态映射
    submission.ts               # 捕获不可变输入、纯 replay 决策
    command-publication.ts      # outbox 到 BullMQ 的交接与重发现
  db/
    threads.ts                  # 创建与按归属读取 Thread
    submissions.ts              # 授权、锁、重放、准入、Turn / outbox 原子接受
    conversation-history.ts     # 正式公开结果与 SQL 精度 cursor
    cancellations.ts            # 未 claim 的原子取消，或运行中的控制意图
    command-publication.ts      # due reservation、发布观察、generation fence
```

HTTP 可直接调用完整具名事务操作，不添加 service 转发层或 repository 接口。纯规则只有确实不依赖 IO、又能独立说明业务意义时才抽出。接受路径中授权、Thread mutex、幂等比较、准入与 outbox 是一个事务。

Server 只发布 `{turnId}` 通知，不装配 SDK、不执行模型。发布成功不是完成，更不是释放 Thread 的权限。

## Worker：执行与收尾

```text
apps/worker/src/
  main.ts                       # 显式原生凭据、进程资源和信号
  config.ts                     # 固定 binding、storage 与 deadline 条件
  contract.ts                   # Worker 消费的 PiTurnHost 最小合同
  worker.ts                     # BullMQ intake、合作取消、joined drain
  execution/
    execute-turn.ts             # claim → open → invoke → join → 正式结算
    db/turns.ts                 # claim、native allocation、控制读取、fenced finish
  harness/pi/
    host.ts                     # 产品文本策略与授权的精确 native history 装配
```

执行侧 SQL 使用可信 notification 查找 Thread，再按 Thread → Turn → Attempt 的锁序完成整体动作；不调用 Server 的用户授权函数，也不导入 Server 的产品代码。Worker 不扫描产品 outbox、不拥有 producer Queue。

SDK 仍拥有 loop、Session、history、compaction 与重试。Worker 只拥有 invocation 和控制观察的生命周期及正式结果，不能把 interrupt ACK、deadline 或 Redis lock 丢失写成已停止事实。

## 共享包：真正跨边界的基础设施与原生接入

- `packages/database`：连接、Pool 关闭、SQL 结构、迁移与生成的 `schema.sql`。JSON 列只声明数据库结构，由 owner 解码；不依赖产品 protocol。
- `packages/protocol/http`：公开 Thread / Turn、输入与结果 DTO。
- `packages/protocol/execution`：私有 Pi binding、队列名与引用型通知；根 export 只公开 HTTP 合同。
- `packages/harness`：Pi / OpenAI / Claude 原生 adapters，生产和 `evals` 直接消费；不建立第四执行框架。
- `packages/sandbox`：后续隔离合同；当前产品路径没有 E2B 实现。

不存在 `packages/conversations` 兼容包或旧路径转发 barrel。正常动作优先放在可直接阅读的 ES module，不为目录对称性生成 micro-helper、manager、registry 或状态机引擎。

## 测试

纯规则、HTTP 与执行测试靠近 owner。`tests/integration` 保留横跨 Server / Worker 事实交接的真实 PostgreSQL 测试与独立基础设施 helper；测试可以显式组合两个 owner，生产不可以跨应用 import。官方 SDK fixture 由 child launcher 隔离，普通 Vitest 不直接发现它们。

集成测试文件串行执行：Better Auth 的原生 Kysely introspection 会扫描 pg_catalog，另一个文件同时 DROP 临时 schema 会使 `has_schema_privilege` 的名字解析失败；不是产品 schema 不匹配。保留原生 schema 检查，不为测试关闭生产校验。套件内部显式的并发接受、claim、reservation 和取消竞争仍真实并发。
