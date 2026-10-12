# 架构品味

> 版本：0.4 · 工程基线草案 · 调研截止：2026-10-12\
> 服务于[项目目标](project-goals.md)，落实到[代码品味](code-taste.md)。本文给出原则与偏离条件；当前组件选择见[技术选型与生产架构基线](technology-stack.md)，不据此承诺尚未验证的会话互操作。

## 1. 我们怎样定义好架构

**好架构让一次用户请求的身份、执行权、数据和失败后果可以被清楚解释，并让下一次变化只触及必要的边界。**

品味不是服务数量、图是否对称、模式名称或用了多少最新框架。它体现在：

- 正常路径直接，异常路径诚实。
- 模块内部承接足够复杂度，对外提供少而完整的能力。
- 事实有权威归属，资源有 owner，副作用有执行边界。
- 默认失败范围小，必要时才升级为系统故障。
- 新能力不要求调用方理解原生 SDK 的全部内部结构。
- 删除一个过时能力是有限工作，不需要拆掉整个平台。

我们偏好简单，但不把“代码更少”置于隔离、持久性和正确性之上。也不把保守性等同于所有异常都停止整个服务。

## 2. 默认拓扑：控制面简单，执行面隔离

```text
产品入口 / API
      │
控制面：身份、Thread / Turn、授权、审批、执行归属
      │
持久任务调度与执行监督
      │
受控的 Attempt / Native Runtime
      ├── Pi
      ├── OpenAI Agents SDK
      └── Claude Agent SDK
      │
工作环境 / 受控业务工具 / 成果存储
```

这是责任图，不是微服务图。

控制面默认从边界清楚的模块化应用起步。执行进程、容器或 sandbox 是否独立，依据安全、物理 writer、故障隔离和资源需要决定。模块化单体不意味着让任意代码与控制面共用信任域。

新增部署边界必须解决已观察到的问题：独立安全边界、扩展、发布、团队归属或故障域。不能只为“将来会大”支付分布式通信、交接和排障成本。控制面单体与执行隔离可以同时成立。[^1]

## 3. 原生 harness 是模块，不是待重写的实现细节

### 默认

直接使用官方公开 API，保留各 harness 的 loop、原生 session、compaction 和特有能力。adapter 只承接平台实际需要的生命周期、策略入口和结果观察。

Agent 自己决定任务计划、工具顺序和创作步骤。平台管理执行条件，不预定义视频或编码 Workflow；工具内部的提交／查询协议与整个任务的自主计划是不同层。

可以统一任务提交、执行观察、授权、成果和错误分类；不能假装分支、steer、审批恢复、取消和 checkpoint 的语义一致。

支持某项能力，必须写清楚支持条件。例如“恢复”至少区分后续会话继续、审批后继续、进程中断后的继续和换 host 后的继续。能力准入先于分配昂贵资源。

### 不做

- 不在平台内再写一层决定工具顺序、压缩历史、规划子任务的通用 loop。
- 不复制整份供应商 SDK 接口，只抽象当前真实消费的能力。
- 不通过 SDK 内部对象补丁、伪造协议帧或拼接未完成 delta 获得“成功”。
- 不为接口整齐而删掉所有 harness 的原生工具，统一成最低公共能力。

adapter 可以采用不同执行拓扑：进程内接入并调用远端能力，或在隔离环境内运行原生工具。差异由 adapter 和运行部署承担，不泄漏到产品业务。

一个 adapter 变得很复杂时，先问是否承诺了不存在的统一语义，而不是先拆出更多 factory。[^2][^3][^4]

## 4. 公共契约小，原生状态原样保留

平台保存用户请求、授权、执行身份、成果及必要业务事实。harness 保存其原生上下文和运行状态。两者用途不同，不由一份“万能历史”同时承载。

- 用户可见消息用于展示和业务交互，不是原生恢复证书。
- 原生状态可供兼容 harness 恢复，但不直接成为公共 DTO。
- UI 事件可以由执行事实投影，不应反过来成为执行调度依据。
- 副本、缓存、索引与审计记录可以存在，但必须说明权威、构建方式、延迟、保留与损坏处理。
- 不建立多个都能独立决定任务终态的 owner。

不采用自定义 `HandoffContext` 或通用业务摘要协议。跨 harness 会话互操作仍是验证项：优先官方历史接口、已有标准和经过审计的转换器，不先创造公共 transcript 再补大量兼容 metadata。

ACP 主要统一客户端与 agent 的控制；其 session load/resume 不构成任意跨 harness 状态导入。AG-UI 的消息与事件可以表达产品交互，但也不是所有 SDK 的 native checkpoint。MCP 解决工具接入，不决定业务幂等或租户授权。标准只在它真实解决的边界采用，不叠加成协议套娃。[^5][^6]

**引入新公共格式的门槛：**已有方案的具体不足、需要保真的语义、版本演进、测试样本和维护 owner 均明确；实验失败应当缩小承诺，而不是不断补造内部字段。

## 5. Turn 持久，Attempt 可替换，Binding 不可偷偷改变

接受用户请求与开始执行是两个步骤。一个 turn 可以因为故障或迁移产生多个 attempt，但不会因为换执行实例而变成用户的新请求。

每个 attempt 明确绑定 harness、版本、模型与工具配置、权限来源、原生 session 及工作环境。影响恢复的配置通过版本／不可变引用定位；不把凭证直接固化进历史快照。

默认配置变化只影响新 attempt。已开始的 attempt 不在每轮模型调用时读取新的“全局默认 harness”。原生 session 兼容期与退役计划明确，旧版本不无限保留。

对同一个可写 native session／workspace，默认只有一个有效 writer。不同 turn 的串行或并行由明确策略决定；需要并行时使用独立分支／环境与成果提交规则，不能默认多写者互不影响。

恢复优先同 harness；跨 harness 替换不作为任意错误的默认处理。模型故障、harness 故障、工具故障、状态损坏分别分类。

## 6. 持久接受与可靠投递不能偷换

默认让持久任务事实能被重新发现，通知只加速发现，不决定任务是否存在。

当前产品已明确同时需要实时活动与自主长任务，技术基线采用 BullMQ 领取执行请求、Redis Streams 运输实时活动，两者使用 Redis 的不同能力；产品与执行事实在数据库／对象存储中。三条路径各有一个理由：BullMQ 加速分派可重发现的 Turn；Streams 承接有界观察与回放；PostgreSQL 决定接受、执行归属与正式终态。队列 ACK、活动结束或页面断线均不能释放 Thread。长任务不自动推导为持久 Workflow，Agent 自主计划仍由原生 harness 负责。选择依据、交接和验收条件见[技术选型](technology-stack.md)。

引入队列／Streams／outbox 时，明确下面四件事：

1. 发送方何时判为已发送。
2. 接收方何时持久接受。
3. 重复投递如何核对相同身份与载荷。
4. 队列丢失已确认消息后，如何根据持久事实重新发现或对账。

`XADD`／send 成功不等于接收方已持久接受。只扫描“未发布”记录，而没有接收确认或重新发现路径，会留下交接缺口。outbox 不是端到端 exactly-once 的证书。

原子接受事务保持短且完整。默认不在数据库锁内等待模型、sandbox 或外部网络；若确有需要，说明有界等待、锁范围、故障处理及为何不用独立 claim 协议。

## 7. 逻辑租约不等于物理 owner

数据库 owner／执行代次用于拒绝过期提交。它不自动停止旧进程、撤销文件系统写入或取消远端付费任务。

共享可写环境接管前，必须满足以下之一：

- 确认旧 writer 已停止并完成必要收尾。
- 存储／执行端能够拒绝旧代次操作。
- 使用隔离写环境，由有效 owner 发布成果；外部业务仍另行处理幂等。

“租约过期”“发出 abort”“关闭连接”“TTL 到期”分别提供不同证据，不能互相替代。无法确认时，暂停受影响资源的自动接管并核对，不盲目抢占。

也不把整个 native state 根目录的全进程独占锁作为默认可扩展方案。隔离范围应对齐受影响的 session、workspace 或可管理分片；存储协调方式必须与实际文件系统保证相符。[^7]

## 8. 故障域尽量小，停止要有理由

| 情况 | 默认范围 |
| --- | --- |
| 用户输入非法、业务拒绝、能力不支持 | 当前请求 |
| 模型暂时不可用、单个工具故障 | 当前 attempt，并按策略处理 |
| 一个 native writer 无法收尾 | 对应 runtime／session／分片 |
| 单个消息无法解析 | 持久记录并隔离该交接项，告警，不伪造接受 |
| 共享存储完整性、可信身份或进程级不变量失效 | 扩大范围，必要时 fail-stop |

隔离不等于丢弃。确定性坏消息保留原身份、原因和受控恢复路径；未知结果不能通过 ACK／删除来“修复”。自动恢复反复遇到同一永久错误时必须收敛，不形成重启循环。

fail-stop 可以是正确策略，但必须说明为什么无法安全局部隔离。整个 worker 的错误处理不应成为所有会话共享的万能停止开关。

## 9. 副作用安全属于业务，调用纪律属于平台

业务服务定义同一支付／渲染／发布操作的语义。平台提供稳定操作身份、授权、调用关联、预算和待核对状态，不自己实现所有业务的去重。

- 操作身份不等于 attempt ID；同一业务动作恢复后仍使用原身份。
- 业务幂等需要处理同键不同参数和有效期限，不能仅记录“这个 ID 见过”。
- 工具结果未知时先查询或核对；不由模型文本判定是否成功。
- 取消停止新增受控调用，但对已发出动作按业务协议查询、取消或补偿。
- sandbox 的文件结果与外部业务副作用分开处理。

供应商不支持幂等或可靠查询时，应暴露工具恢复限制，不在本地加一张去重表后宣称外部 exactly-once。[^8]

## 10. 重试、恢复和预算有一个清楚的负责人

一次网络操作的 SDK、HTTP 层和平台不能独立叠加重试。接入时检查默认重试、自动 compaction、后台 writer 和恢复行为；定义主要重试 owner、可重试错误、截止时间、退避抖动及尝试预算。

单次请求重试与整次 attempt 恢复可以分层，但必须共享可解释的预算与副作用规则。权限拒绝、参数错误、状态损坏和取消不进入普通瞬时故障重试。

预算至少覆盖时限、模型调用／可得的用量、工具与执行资源。恢复不重置逻辑 turn 的预算；未知付费请求不凭空退款。低层设置使用原剩余期限，不在每层新开一个完整 timeout。[^9]

## 11. 安全边界独立于模型与 prompt

- 从可信身份确定租户，按资源归属授权；模型只能提出动作，不能授予权限。
- 执行环境限制宿主访问、出站网络、资源和可见凭证，强度由威胁模型决定。
- 控制面凭证与业务工具凭证最小化分配，不向任意 shell 暴露通用管理凭证。
- 动态工具发现不等于动态授权；已有描述与旧审批不自动授权新调用。
- 审批绑定实际参数与目标，在执行边界重新核对。
- prompt injection 是实际输入风险；“reference only”标签不是隔离机制。
- 日志、native transcript、备份、缓存和成果均考虑租户归属、保留、删除及访问控制。

不把每个任务一台 VM 定为唯一答案，也不把容器存在当作安全验收。隔离和凭证策略需要实际验证。[^10]

## 12. 发布、观察和恢复属于正常设计

### 发布

采用有界 drain：停止领取 → 完成或到达恢复边界 → 收尾或隔离旧 writer → 必要时新 attempt 接续。审批等待、超长任务和外部 job 有各自处理策略，不靠等待所有 Promise 永远解决。

数据库、公共协议及原生持久状态的变更采用兼容发布：扩展 → 迁移 → 验证 → 收缩。不可逆数据删除必须单独标记；回滚代码不等于恢复数据。[^11][^12]

### 观察

执行事件带上 thread、turn、attempt 和有序身份；这些是关联信息，不强制全部作为高基数指标标签。断线回放有明确游标，终态可通过持久快照核对，不能依赖一次 SSE 正常结束。

临时输出属于 attempt，正式结果属于 turn。恢复时不把两个 attempt 的半段文字直接拼成一个“原生回答”。事件层不自行补造 SDK 最终结果。订阅退出只停止观察；SDK result、观察收尾与正式结算分别等待，不能把 observer return 当 native cancel。回放裁剪、身份变化或缺口退回可信快照，不能以最大游标静默跨洞。

公开投影使用白名单：思考内容默认关闭，显式开启时只展示供应商允许公开的文本或摘要；不公开隐藏推理、签名、加密或 redacted 回放状态。活动通知与内容开关分开，不把输出边界当作隐藏推理区间。工具结果默认通用安全提示，只有 host 明确审阅的结果可展示。供应商支持摘要配置不代表自定义 gateway 的载荷自动安全。审批 continuation、hooks 和原生 checkpoint 保留 provider owner，不用一个公共 paused 布尔伪装三种 SDK 的恢复能力。

默认遥测记录状态、耗时、错误类别、预算和恢复事实。原始 prompt、工具载荷和文件内容不默认复制到外部 tracing；供应商 SDK 的默认遥测配置也要审查。[^13]

### 恢复

分别定义进程、节点、存储和区域故障。native session 持久化不等于 workspace 备份，filesystem pause 不等于独立副本。备份验收包括实际还原任务、原生状态、成果和业务操作关联，不能只检查备份文件存在。

可靠性以用户结果、明确故障范围和演练证据表达，不以组件名称表达。

## 13. 默认不引入的复杂度，以及何时可以引入

| 候选 | 默认 | 引入条件 |
| --- | --- | --- |
| 微服务 | 不预拆业务服务 | 有稳定独立部署、扩展、团队或隔离边界 |
| 持久工作流引擎 | 不自研，当前不引入 | 独立的业务协调范围证明收益时再评估；不因任务长而预编排 Agent 创作步骤 |
| 实时活动运输 | 当前基线选择 Redis Streams | 承接增量分发与有界回放；交接与缺口恢复闭合，不作为任务权威 |
| 通用插件注册框架 | 显式组装有限 adapters | 扩展者、动态发现和隔离需求已真实出现 |
| 通用会话转换层 | 先验证已有方案 | 保真需求与官方接口不足明确，维护范围可控 |
| 自动模型／harness 路由 | 先固定可解释策略 | 稳定评测和生产数据证明收益 |

拒绝的是无证据的复杂度，不是成熟基础设施。避免为了“不依赖框架”最终自己写出更差的队列、工作流引擎或凭证系统。

## 14. 架构评审问题

一项设计至少能回答：

1. 为哪个已确认目标服务？最简单可行方案是什么？
2. 哪些事实由谁拥有，哪些只是投影？
3. 正常调用经过多少边界，是否存在纯转发层？
4. 新增哪个状态／资源 owner，何时转移或释放？
5. 网络／进程失败后，哪些结果确定，哪些未知？
6. 旧执行仍活着时，新执行如何避免共同写入？
7. 会影响当前 turn、一个分片，还是所有租户？为什么？
8. 如何发布、恢复、退役与验证？
9. 采用的标准到底解决了哪一层？版本和支持是否真实？
10. 能否删除这项能力，而不改变无关业务？

重要、不可逆或跨信任边界的决定留下简短决策记录：问题、备选、选择、代价、证据和重新评估条件。普通实现细节无需审批文件。

## 15. 研究依据与证据口径

2026 年五个社区项目的固定 revision、完整／选段源码范围、产品浏览器证据和官方 SDK 重读结论见[Agent 产品源码研究](agent-product-research.md)。采用薄投影、快照对账、邻近特性组织；不复制平台规模、operation 树或第四执行 loop。该研究不构成生产性能或故障恢复验收。

以下资料支持原则，不共同构成一套已验证的产品架构。长期工程原则与 2026 年 Agent 资料结合使用，不以发布日期新旧排序品味。动态官方文档、预览能力和第三方转换器不得未经精确版本验证进入生产承诺。调研使用本机 SDK 文档／源码、官方文档查询和第一手工程资料；部分网页直接抓取受网络限制，动态页面未全部核验历史快照。尚未执行 SDK 互操作、故障注入或负载测试。

[^1]: [Martin Fowler：Monolith First](https://martinfowler.com/bliki/MonolithFirst.html)。经验性默认，不是要求执行面共享信任域。
[^2]: [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)及[CLI Integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md)。本机 1.1.0 文档已读取；SDK/RPC 选择依据实际进程边界。
[^3]: [OpenAI Agents SDK：Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)及[Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)。Session 与 RunState 的职责不同。
[^4]: [Claude Agent SDK：Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)及[Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)。原生 resume 不自动构成外部历史导入。
[^5]: [ACP Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)及[Session Resume RFD](https://agentclientprotocol.com/rfds/session-resume)。按所接入的协议版本和能力检查，不用草案推断实际 adapter 支持。
[^6]: [AG-UI Run Input](https://docs.ag-ui.com/spec/1.0/basic/run-input)。公共交互输入与原生执行状态不同。
[^7]: [AWS Builders’ Library：Leader election in distributed systems](https://aws.amazon.com/builders-library/leader-election-in-distributed-systems/)。逻辑领导权与实际执行间存在失效窗口。
[^8]: [AWS Builders’ Library：Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)。
[^9]: [AWS Builders’ Library：Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)。
[^10]: [AWS SaaS Lens：Tenant isolation](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/tenant-isolation.html)。隔离策略随业务、部署与合规要求变化。
[^11]: [Temporal：Worker shutdown](https://docs.temporal.io/encyclopedia/workers/worker-shutdown)。借鉴有界收尾原则，不据此要求采用 Temporal。
[^12]: [Martin Fowler：Parallel Change](https://martinfowler.com/bliki/ParallelChange.html)。
[^13]: [OpenTelemetry：Handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/)及[OpenAI Agents SDK：Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)。
