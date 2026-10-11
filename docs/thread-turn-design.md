# 首条产品执行路径：调研与决策

> 2026-10-11。先研究 PostgreSQL 18、BullMQ 6.3.12／ioredis 6.0.0、Kysely 0.29.6／pg 8.23.1 和 Pi 1.1.0 的公开语义，再实施。本文区分资料事实、首轮策略与尚未验收的保证；不是另一个 Agent loop。

## 1. 范围和 owner

首轮（历史）后端链路为：认证后的 Thread／Turn API → PostgreSQL 持久接受 → outbox → BullMQ → Worker → 现有 Pi adapter → 正式结果入库。Web、SSE、文件、业务工具、E2B、完整审批、自动 crash recovery 不在这一轮。当时 Pi 公开回答为结算完整文本，不冒充 token stream。

后续已增加 React / Tailwind 会话 UI、owner-scoped Thread 列表、Redis Streams → 授权 Server SSE → native EventSource，以及可选只读搜索策略。这些观察能力不改变以下执行权与未知阻塞规则。此前真实模型矩阵属于旧文本实现，不证明新版 SSE／搜索；独立范围和证据见 [会话 UI 与 E2E](conversation-ui.md)。

- PostgreSQL：用户归属、不可变请求、执行 claim、控制意图、正式输出与终态。
- BullMQ：引用型执行通知与领取；Redis 的 job 状态不决定产品成功。
- Pi：原生模型上下文、history、compaction、重试与 loop。
- Worker host：固定模型／权限／storage binding、唯一 invocation、明确转交的资源与收尾。
- Better Auth：认证；产品查询仍显式核对资源归属，不自建登录协议。

Server 拥有会话产品、用户授权、接受／查询／取消及命令发布；Worker 拥有 claim、原生执行、控制观察与 fenced 结算。共享 `packages/database` 只保留连接、SQL 结构和迁移，不承载业务动作。初版把两侧业务集中在 `packages/conversations` 的决定已撤销，该包与兼容路径均已删除：共同查询持久事实不等于共同拥有领域。具体目录与理由见 [目录结构](directory-structure.md)。

完整事务直接使用 SQL／Kysely，不建设通用 service / repository、状态机引擎、执行注册表或统一 SDK checkpoint。公开 HTTP 和私有执行协议使用独立 subpath exports，SDK graph 不穿过平台协议。

## 2. 官方事实

### 事务、幂等与准入

PostgreSQL 默认 Read Committed；`ON CONFLICT DO NOTHING` 的竞争行可能不在该条语句的 snapshot 中。因此不用一个 insert-or-select CTE 假定一定返回行；冲突后用下一条查询核对原请求。[1]

caller 提供请求身份，相关持久变更原子记录；相同身份但不同参数必须拒绝，不覆盖旧输入。[2] Thread 授权先于重放查询，作用域来自可信认证，不接受 body 中的 owner。

`FOR UPDATE` 锁已有行直到事务结束；锁一个空查询不会锁住未来的 admission。首轮锁已有 Thread 行，并用 partial unique index 约束 admission-blocking Turn；所有生命周期路径遵守 Thread → Turn → Attempt 的锁序，不在事务内等待模型或 Redis。[3]

### outbox 与 Redis

transactional outbox 解决数据库／消息双写缺口，但 relay 仍可能重复发布，consumer 必须幂等。[4]

BullMQ jobId 只在队列内、原 job 尚存在时去重；已完成／失败的 retained job 也会挡住同 ID 再入队，删除后去重消失。`Queue.add` 返回不等于存在可执行通知。[5]

Redis AOF `everysec` 不是零丢失保证；回复成功的入队也可能在故障中丢失。`published_at` 只能是观察／节流事实。数据库必须定期重发现已接受、尚未 claim 的 Turn，直到数据库 claim 或终态闭合交接。[6]

### 执行权与收尾

BullMQ stalled 会重投；失去 Redis lock 不会终止原 processor。数据库 claim token 能拒绝过期结果提交，不能停止 SDK 对 history／workspace／外部工具的写入。[7]

`Worker.close()` 停止领取并等待 active jobs，无内置 drain timeout；`close(true)` 不等于取消 native invocation。6.3.12 的显式 AbortSignal processor 需要三个参数；合作取消仍须实际 join。没有旧 writer 已停止的证据就不自动接管。[8]

Pi `SessionManager` 是原生持久 history 的 owner。按授权的精确 native ID 查找文件再 open；不得找不到就偷偷 new，也不从产品消息重建 context。`prompt()` 与 adapter owned join 保留原生结算；释放资源后才解除本地写入归属。[9]

## 3. 首轮产品选择

这些不是数据库或队列强制的规则：

- 一个认证用户拥有 Thread；本轮不声称已实现组织／企业租户隔离。
- 请求身份按用户作用域唯一，重放比较 Thread 与有序输入的完整意义；身份与已接受记录本轮不自动清理。
- Thread 同时只接受一个未收尾 Turn；新请求遇 busy 明确拒绝，不建立第二套 prompt backlog。
- `accepted` 可安全重复通知；已 claim 的执行不因重投、超时或队列锁丢失重启。未知结果占住 Thread admission，等待核对。
- 一个 Turn 的首轮执行只创建一个 Attempt；不为故障自动创建新 Attempt。持久输入解码确定失败时，在 claim 事务内标记 `needs_reconciliation / invalid_input`，不分配 Attempt、不打开原生会话，也不继续制造失败通知；Thread 仍阻塞。损坏的输入不会被伪造为合法公开 DTO，产品读取仍 fail-closed，运维须核对数据库事实。
- binding 固定 Pi／SDK 版本、模型、`policy` 和 storage scope，不存凭据，不 serialize native graph；不兼容 binding 不执行，进入 reconciliation。`PI_POLICY` 在 Server／Worker 默认 `text-v1`；可选 `web-search-v1` 不静默升级旧 Thread。
- 默认 `text-v1` 没有业务工具；`web-search-v1` 在 Pi native `customTools` 装配 `web_search`，实际 `tools` 与 `publicTools` 均为 `['web_search']`。Worker 私有搜索配置须与 binding 一致，否则 fail-closed；仍不开放本地 shell／filesystem tools／动态 extensions。
- 正式输出是公开 display messages，native transcript 另存；SDK 异常只作为私有诊断，公共 failure code 不含原始输入或供应商响应。
- cancellation intent 与 cancelled outcome 分开。已 claim 的 Turn 只有 owned execution 实际收尾后才能释放；completion 可以赢过取消 race。
- Better Auth 的原生 Origin 检查不代替产品 API 的 CSRF 边界。所有已认证的产品写请求必须带精确可信 Origin，缺失也拒绝；用户归属检查仍独立执行。
- 默认能力开关关闭；启用后必须有显式 profile、API key 与私有绝对状态目录。拒绝会触发 Vertex ambient ADC 的空白、placeholder 与原生 marker，不通过全局 environment 切换用户凭据。

### 临时观察不是执行权

Worker 将 schema 白名单活动写入 Redis：`MAXLEN ~ 2048`、每次写入续期 24 小时 TTL。Server 的 `GET /turns/:turnId/events` 认证并核对 owner，发送 `turn`／`activity`／`gap`，以 `Last-Event-ID` 恢复 cursor；Lua 原子读取 retention metadata 与 `XREAD COUNT 100`，识别裁剪以及新 `0-0` cursor 的已丢失历史。SQL 快照与终态仍权威，`MESSAGES_SNAPSHOT` 可撤回预览，正式结果替换临时内容。

Pi／Claude native channel 有 256 events／256 KiB 上限；同步 callback 失败隔离，不把存储 await 放进原生 callback。Worker 在 result settled 后最多给 observer 250 ms drain 窗口，Redis 命令有 1 秒上限；观察失败只留下缺口，不取消、重试或改变执行结果。iterator return／overflow 独立唤醒 observer，receipt pending 也不阻塞解除观察。

## 4. 必须验证的故障窗口

使用独立 PostgreSQL 18／Redis 和确定性输入，不能只 mock repository：

1. 同身份并发接受只产生一个 Turn／outbox；不同载荷冲突且旧输入不变。
2. 同 Thread 两个新请求竞争只能接受一个；跨用户访问返回不可见。
3. Turn／outbox 任一步失败全部 rollback；丢失接受响应后仍能幂等重放。
4. Redis add 后 bookkeeping 失败可重复发布；已发布但 Redis 丢失的未 claim Turn 能重新发现。单条投递失败不跳过同批其他投递；批次完成后只报告有界、脱敏失败。
5. retained terminal job 不把新通知永久挡住；多个 worker／stalled redelivery 不启动第二个 Pi writer。
6. claim 后、native 启动前崩溃不盲跑；native 完成但正式结果未确认时保持需要核对。
7. 正式终态已提交、BullMQ completion 未确认时，重投为无副作用 no-op。
8. cancellation／completion race、cleanup failure、worker shutdown 不错误释放 admission；确定的持久输入损坏进入阻塞核对状态，不分配资源或反复重投。
9. 原生新建／精确 ID reopen 保留 context；不存在的历史不伪造恢复。

## 5. 来源与限制

Context7 月额度耗尽；部分直接 fetch 被 fake-IP／SSRF 防护阻断，没有绕过。来源结合官方资料检索、独立静态研究和固定安装包声明／实现。第三方文档示例不是本项目运行证据。

本轮使用 Node 24.21.0、独立临时 PostgreSQL 18.6 / Redis 8 和官方 Pi faux 验证真实边界：并发身份／准入、事务 rollback、跨用户不可见、SQL cursor 精度、通知丢失与 retained terminal job、claim fence、合作取消、join 后正式提交、cleanup／未知提交阻塞、原生精确 ID 的两 Turn 跨 host 恢复。原生认证 cookies / session / revocation 和 Server 自身的 HTTP → outbox → 发布生命周期也经过真实集成检查。迁移完成 up → down → down → up 和 PG18 schema dump；没有使用个人凭据或调用付费模型。

这些检查不代表真实进程 crash、网络分区、生产 Redis durability、跨进程 filesystem fencing、OS／企业租户隔离或生产恢复已经验收。中断不能证明 native 停止；未知仍占住 admission，当前无自动 takeover。此段记录首轮验证；新版 SSE／搜索须看最新交付记录，媒体、成果、E2B 与完整审批路径仍未实现。

[1]: https://www.postgresql.org/docs/18/transaction-iso.html
[2]: https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
[3]: https://www.postgresql.org/docs/18/explicit-locking.html
[4]: https://microservices.io/patterns/data/transactional-outbox.html
[5]: https://docs.bullmq.io/guide/jobs/job-ids
[6]: https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/
[7]: https://docs.bullmq.io/guide/workers/stalled-jobs
[8]: https://docs.bullmq.io/guide/workers/graceful-shutdown
[9]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
