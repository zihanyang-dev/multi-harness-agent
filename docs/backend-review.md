# 首条后端路径：完整代码审查

> 2026-10-11。范围为当前仓库代码与本轮未提交的后端实现，不把历史 live 测试当作本次运行证据。

## 结论与范围

本次从正确性和故障边界、领域归属与依赖、代码品味、进程生命周期、发布与安全检查五方面审查。Server／数据库／协议、Worker／Pi host、共享原生 adapters／Web／eval／sandbox 分别进行独立只读审查，主审查负责进程装配、配置、CI 与部署；修复后再进行有界独立复审。

发现两个 P2 故障收敛问题和两个 P3 文档／架构测试问题，均已修复。复审未发现剩余阻塞项。这是对当前实现范围的审查结论，不是“没有任何未知缺陷”或生产全量验收声明。

## 本次发现与修复

### P2：单条投递失败饿死同批其他 Turn

原 publisher 在一个批次外捕获异常；第一条 Redis／bookkeeping 错误会跳过其余已延后十秒的 reservation。持续的单条故障可能使无关 accepted Turn 一直得不到通知。

现在每条投递有实际故障边界，继续尝试同批其他投递；批次结束后仅报告 `command_publication_failed`。失败 reservation 仍可重新发现，不把已入队观察升级为持久交接。

真实 PostgreSQL／Redis 回归先把第一条 job key 改为错误 Redis 类型，观察健康 job 缺失的 RED；修复后验证两轮持续损坏都不饿死健康投递，失败项没有伪造 published 事实，去除损坏后可继续投递。

### P2：持久输入损坏无法收敛

原输入解码异常导致 claim rollback，通知失败而 Turn 仍为 accepted；publisher 可持续提升 failed job generation，制造无用失败通知，同时没有持久诊断。

现在在 claim 事务内验证持久输入。确定损坏时提交 `needs_reconciliation / invalid_input`，不插入 Attempt、不打开或调用原生会话；重投为 no-op，Thread admission 继续阻塞。协议、迁移 CHECK 与 PG18 原生 schema dump 同步更新。数据库事务失败仍返回 `claim_unknown`，不能冒充已完成隔离。

回归先观察旧代码抛出 `claim_unknown` 的 RED，再验证持久状态、诊断、重复投递、零资源分配和新 admission 的 `thread_busy`。损坏输入不能被拼造为合法 HTTP DTO：产品读取仍 fail-closed，当前需运维核对数据库事实，没有新增恢复或公开坏数据接口。

### P3：架构 guard 漏掉应用 package 私有 subpath

原 guard 仅拒绝 `@multi-harness/server`／`worker` 根 import，漏掉其 `/...` subpaths；未发现当前生产源码利用该缺口。

现在对完整 package 名和带 `/` 的私有路径一并拒绝，保留相对路径边界，不误伤名称仅有同前缀的其他包。边界谓词回归观察 private-subpath 的 RED，再验证两个应用的 root／subpath／相对跨界和合法路径。

### P3：Harness 总览与已接通范围不一致

更新 `packages/harness/README.md`：Pi text-v1 已接通认证 API、持久化、通知、Worker 与正式结果；Web 仍只有 health，OpenAI／Claude 尚未装配进产品执行路径。包级能力、已实现路径和生产验收不再混写。

## 关键审查判断

- Server 拥有产品准入、授权、查询、取消和 outbox 发布；Worker 拥有执行 claim、控制观察与结算。共享 database 没有会话业务，生产源码不跨应用 import。
- 授权先于 replay／资源读取；身份来自认证。产品写请求独立要求精确可信 Origin，不拿原生 auth 的 Origin 检查代替产品 CSRF 边界。
- 接受与 outbox 同事务；Thread 锁与 SQL partial unique index 共同约束准入，按 Thread → Turn → Attempt 锁序执行；分页比较保留 PostgreSQL timestamp 精度。
- 原生调用只发生在持久 claim 后；重投不替换既有 Attempt。固定 binding 与 exact native ID fail-closed，不找不到就 new，也不从产品消息重建原生 history。
- cancellation intent／interrupt ACK 不等于停机。invocation、控制与 dispose 都 join 后才正式结算；未知 commit／cleanup 阻塞 admission，不自动 takeover。
- BullMQ drain 同时 join 官方 close 和 owned run promise，不凭 close 单独返回认定 processor 已结束；保留真实 close-early 回归。
- 业务事务保持完整具名动作，没有新增 service／repository 转发层、执行 registry、通用状态机或第四 Agent loop。状态与生命周期保留在实际 owner 中。
- 公开结果按允许的 display facts 投影，不 spread SDK 原生响应；后台错误脱敏。默认 backend 关闭，启用凭据／profile 显式配置；重复软信号保持合作 drain。

## 本次实际验证

环境：Node 24.21.0、pnpm 12.8.1，独立 loopback PostgreSQL 18.6／Redis 8，官方 Pi faux 与隔离 SDK IO。不使用个人凭据或付费模型。

- `pnpm install --frozen-lockfile`：通过。
- `pnpm check`：Biome、全仓类型检查、159 单元测试／22 文件、全仓构建通过。
- `pnpm test:integration`：81 测试／11 文件通过，使用真实 PostgreSQL／Redis。
- `pnpm test:e2e`：1 browser smoke 通过；只验证 Web → HTTP liveness。
- dbmate：新数据库 up → down → down → up；applied 2／pending 0，PG18 client 重新生成 schema。
- Server／Worker 镜像构建通过；默认关闭的 Worker 正常退出，UID 1000、状态目录 0700；Server health 返回成功，SIGTERM exit 0。
- 对本次六个 TypeScript 改动文件的主动 LSP probe：6 confirmed clean，零 error／warning；不宣称全仓 LSP 覆盖。
- `pnpm audit --prod --audit-level high`：未发现已知漏洞，不能推导为供应链绝对安全。
- Gitleaks 8.30.1：下载校验 SHA256；当前仓库、构建输出与 11 个可达历史 commits，默认规则／redact 100，零 findings。最终 indexed tree 另做发布前检查；不含仓库外历史或个人配置。原始 patch 文本扫描报一条格式误报：diff context 的前导空格使 `.env.example` 中空的 `OPENAI_API_KEY` 跨行匹配到下一个变量名 `ANTHROPIC_API_KEY`；已检查原文与真实文件，二者值均为空，没有新增 ignore 或放宽规则。

一次中间全量集成运行发现新增 admission 断言误写为 `kind: busy`；实际合同是 `kind: conflict / reason: thread_busy`。修正断言为完整实际合同后重新运行全部检查通过，不放松生产准入。

## 未扩大为保证的边界

没有验收真实进程 crash／网络分区、生产 Redis durability、跨进程 filesystem physical fencing、OS／企业租户隔离或生产自动恢复。SQL token／Redis lock 不是物理 fencing，cwd 不是 sandbox。Web 会话、SSE、媒体、成果、E2B、完整审批与评测执行仍在后续范围。历史 OpenAI Responses compaction upstream 502 仍不由本次离线检查解决。

详见 [Thread／Turn 设计](thread-turn-design.md)、[目录结构](directory-structure.md) 与 [部署边界](../deploy/README.md)。
