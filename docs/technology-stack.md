# 技术选型与生产架构基线

> 决策日期：2026-10-09。本文确定建设基线，不表示组件已经集成、性能已经实测或故障保证已经验收。服务于[项目目标](project-goals.md)，遵循[架构品味](architecture-taste.md)与[代码品味](code-taste.md)。

## 1. 选型准则与已确认负载

已确认：复用 Pi、OpenAI Agents SDK、Claude Agent SDK；多 harness；实时对话、流式输出和可见活动；图片、视频、PDF 等成果；写代码与生成视频等长任务；用户中断；后续直接接入评测运行器；提前建立 harness 与 sandbox 契约。

**Agent 自己决定任务计划、工具顺序和创作过程。平台负责持久接受、运行条件、观察、控制和安全恢复，不预写视频或编码业务流程。** 这是本次修订的关键澄清，撤回将长任务直接推导为默认 Temporal 编排的选型。

具体功能范围、配额、留存、SLO、企业身份要求仍需讨论。产品研究中的项目、定时任务、浏览器接管和协作能力不是自动批准的首版需求。

**不以组件最少为目标，以自有持久机制最少、责任清楚、失败可解释为目标。**

- 成熟组件能替掉持久调度、定时等待、恢复或安全基础设施，就值得引入。
- 不因“最新”选择预发布的核心能力，不因“轻量”把关键机制留给自己实现。
- 不许诺组件消除所有业务状态、副作用不确定性或原生 SDK 恢复责任。
- 技术栈确定后，以版本兼容、负载测试和故障演练验收，而不是持续围绕偏好换库。

## 2. 产品体验给出的依据

只研究公开产品和帮助文档，不推断这些公司的私有技术栈，也不把文档能力当成本项目实测。

| 官方产品体验 | 对我们架构的启示 |
| --- | --- |
| Manus Cloud Browser 可观看操作、遇登录或验证码可接管 | 文本、行动与人工控制是不同通道和语义；工具活动不是完整内部推理 |
| Manus Projects 持久保存指令与知识，任务访问有独立范围 | Thread、上下文配置和任务权限应有清楚归属；不共享一袋可变全局上下文 |
| Claude Cowork 公开描述云端继续工作、跨设备查看和重定向 | 执行不绑定网页连接；断线不等于取消 |
| Claude Artifacts 支持独立查看、编辑和导出不同类型成果 | 成果是有身份、类型与权限的实体，不只是聊天中的 URL |
| ChatGPT Agent 支持中断、确认与浏览器接管；Deep Research 展示进度、来源并导出报告 | 执行控制、等待输入、历史观察与成果交付分别建模 |

视频能力不偷换：Manus 多媒体文档明确描述短视频与动画；Claude Motion 当时为受方案与权限限制的 beta；不能拿独立 Sora 产品证明 ChatGPT Agent 的能力。本项目的视频生成通过明确接入的业务工具实现，不绑定某个产品演示。

资料为动态官方页面；本轮未登录这些产品做交互或跨设备测试。来源见文末。

## 3. 确定的技术栈

| 领域 | 基线 | 选择理由 |
| --- | --- | --- |
| 语言与运行时 | TypeScript 严格模式；Node.js 24 LTS | SDK 与基础设施兼容面广，避免让生产依赖特殊运行时行为 |
| 仓库与包管理 | pnpm workspace | 应用与可复用包直接组织；不先建设额外构建平台 |
| Web | React + Vite + TanStack Router / Query | 独立后端的交互应用，无已确认 SSR 需求；路由与服务器状态不用自己重写 |
| UI | React + Tailwind CSS；原生 dialog / inert、react-markdown / GFM | 首版忠实实现原型与真实文本任务；基础组件按实际需要复用，不先加入额外 Thread runtime |
| HTTP 服务 | Hono + @hono/node-server | 以 Web 标准表达产品路由和中间件；当前没有必须采用 Fastify 封装体系的需求 |
| 公共 schema | Zod + @hono/zod-validator | 维护一份边界定义，连接运行时校验与 TypeScript；不复制 SDK 内部类型 |
| 实时传输 | HTTP 命令 + SSE；使用 Hono streamSSE | 文本和活动以服务端推送为主；复用 SSE 编码，连接清理不取消后台任务 |
| 公开活动 | AG-UI 已发布稳定事件 + 少量具名产品扩展 | 不重新发明文本和工具事件；成果、搜索来源、技能活动按实际需求扩展 |
| 任务调度 | BullMQ | Redis 上的成熟队列负责领取、并发、锁续期与重投；不定义 Agent 的业务计划 |
| 实时活动运输 | 托管 Redis / Redis-compatible，使用 Streams | 增量日志、短期回放与分发从业务数据库分离；按选定服务验证命令与持久性 |
| 产品数据 | PostgreSQL 18；生产托管、开启高可用与备份 | 事务、约束、查询与可恢复产品事实 |
| SQL 与迁移 | Kysely + pg；dbmate 管理 SQL 迁移 | 查询与事务可见，避免重复 ORM 层和 repository 转发；迁移可审阅 |
| 身份认证 | Better Auth + PostgreSQL | 不自己实现会话、登录和凭证基础设施；资源授权仍属于产品 |
| 成果存储 | S3；官方 AWS SDK 与签名访问 | 大文件、独立持久化、生命周期与授权下载；不让 API 搬运所有文件字节 |
| 执行环境 | 托管 E2B；packages/sandbox 保持供应商无关契约 | 复用隔离执行、命令、文件和环境生命周期，不自研 sandbox 平台 |
| 原生执行 | 官方 Pi / OpenAI Agents SDK / Claude Agent SDK | 原生 loop、session 与 compaction 保留；packages/harness 接入 |
| 可观测性 | OpenTelemetry + Pino；托管 Grafana Cloud | 标准化 trace、指标和结构化日志；不自研追踪存储与控制台 |
| 测试与评测 | Vitest、Playwright、真实基础设施集成测试 | 契约、交互、重复投递与故障行为分别验证；评测复用实际 adapters |
| 初始生产部署 | Docker；AWS ECS Fargate、RDS、S3、托管 Redis；E2B 独立托管 | 不先自建 Kubernetes、数据库、工作流服务或虚拟机平台 |

2026-10-11 首版已实现 React / Tailwind 文本会话、原生认证与持久侧栏，现已通过 Worker → Redis Streams → owner-scoped Server SSE → native EventSource 观察增量；5 秒 HTTP 查询只作 SSE 不可用／对账备援。Pi 可选 web-search-v1 已装配受限只读搜索，其他业务工具仍属后续基线。未引入 shadcn/ui 或 assistant-ui，也不伪造其 runtime 已接入。实现与真实模型证据见 [会话 UI 与 E2E](conversation-ui.md)。

HTTP adapter、UI adapter 和协议版本需纳入依赖验收；“官方”与“有版本号”不代替兼容测试。锁定具体版本和镜像 digest，及时接收安全修复。Node 24 当时为 LTS；不为使用最新版改用尚处 Current 的 Node 26。

托管服务按相近区域部署并验证延迟、服务限额、数据驻留、出口成本与可用性。若当前团队已有生产云平台，映射托管服务而不改变上述责任边界；不能因为参考项目使用某个云就继承它的运维假设。

## 4. 调度任务，不预编排创作

**长任务不等于预定义业务 Workflow。** Agent 可以搜索、编码、生成素材、检查结果、修改计划；这些决定由原生 harness 和模型作出，不被平台节点图限制。

BullMQ 负责把已接受的执行请求交给 worker，管理并发、领取锁和故障重投。worker 启动原生 runtime，观察并保存结果。平台只有必要的执行生命周期，不把每个创作步骤变成持久调度阶段。

Redis 已承担活动运输，因此选择其成熟队列库 BullMQ，不再追加 pg-boss。pg-boss 的事务入队优势仍成立，它不是因质量问题被排除；当前选择以共享基础设施和明确职责为依据。

Temporal 不等于 LangGraph，也不必限制 Agent 自由：可以只包运行外壳。但它会引入工作流 history、确定性约束、独立服务和兼容发布机制；只包装一个黑盒原生 run，并不能自动恢复其内部工具步骤。现有证据不足以证明这部分成本值得作为默认基线，故本次移除。

将来若出现有明确业务语义的独立长流程，再对该范围评估持久工作流引擎。不依据“任务持续很久”或“Agent 有多个步骤”自动采用，也不宣称某类框架已经过时。

**队列不是原生恢复引擎。** 重投触发执行核对，不代表从头重跑。SDK 恢复能力、副作用查询和旧 writer 收尾仍需实现；不能用换队列掩盖这些责任。

## 5. 调度与观察是两条路径

```text
Web
 ├── HTTP：提交与控制 ── Server ── PostgreSQL
 └── SSE：观察活动   ── Server ── Redis Streams

持久接受 ── 可靠入队 ── BullMQ ── Worker
                                  └── 原生 Harness Runtime
                                        ├── 隔离执行环境
                                        └── 业务工具
                                              │
                                              ├── 增量活动 ── Redis Streams
                                              └── 正式结果 ── PostgreSQL / S3
```

普通对话和长任务采用同一持久接受入口，任务复杂度由 Agent 在执行中决定，不先猜测它是“聊天”还是“固定长流程”。

按块发送实时活动，不把 token 或 stdout 变成队列 job。用常驻 worker、相近区域和受控并发降低调度开销，以真实 TTFT 和工具延迟验收。

BullMQ 与活动 Streams 可以使用同一托管 Redis，但保留、内存与写入压力要主动管理；活动积压不能耗尽队列容量。队列要求的持久化、复制和 noeviction 策略按生产配置验收。

Redis Streams 不决定执行状态：它保存有界实时回放，不成为任务终态、审批或恢复的权威。多个独立读者广播与同组消费者分摊不同，当前 SSE 每连接以非阻塞 Lua 原子读取 metadata 与 `XREAD COUNT 100`，不占独立 Redis 阻塞连接，也未建立本地 fan-out 层。

正式消息有 PostgreSQL 持久查询路径；关键行动事实长期留存与独立成果交付仍是建设目标。Stream 使用 `MAXLEN ~ 2048` 与滑动 24 小时 TTL；已裁剪（含新 0 cursor）或故障时，客户端恢复 SQL 快照并标明实时缺口，不拼造丢失的 delta。需要长期保留的轨迹进入受授权存储，不无限占用 Redis。

初始不将 WebSocket 用作所有事件的通用底座。若确认实时终端、双向音频或浏览器接管需求，再采用相应双向协议，不能把它们塞进 SSE。

## 6. 创作由 Agent 决定，工具提供可信能力

平台交给 Agent 用户输入、权限、工具、Skills 与工作环境，不预定义“写脚本、生成分镜、渲染、交付”的顺序。任务内是否搜索、编码、生成视频、检查或返工，由 Agent 决定；平台边界只限制授权、预算和安全。

工具内部可以有明确协议。例如外部视频服务需要提交、查询、取消和读取成果。这是一个工具的操作生命周期，不是平台规定整个视频创作流程。

工具契约说明返回的是已完成结果还是异步操作身份。是否等待、查询、并行处理其他工作或重新生成，交给 Agent 和原生 harness 的实际能力。后台 job 与任务有关联，不能因为原生 turn 结束或模型说“已完成”，就把仍在运行的外部 job 判为成功。

供应商已有回调、查询与任务机制优先使用，不再为每种工具建设通用 Workflow。提交后失联、取消后晚到结果等按工具业务协议核对；任何队列都不保证外部收费或副作用 exactly-once。

原生 SDK 的暂停与恢复分别验收。只有进程内等待能力时，要诚实说明重建限制；SDK、sandbox 或工具结果未知时，不以强行重跑制造成功。

## 7. 事实归属与交接

| 事实 | 权威／恢复依据 |
| --- | --- |
| 用户输入、执行记录、控制意图与正式输出 | PostgreSQL；执行层核对并推进运行事实 |
| 任务是否已排队／领取 | BullMQ；不直接代替产品执行状态 |
| 成果内容与访问元数据 | S3 / PostgreSQL |
| 原生模型上下文与 SDK 状态 | 对应 harness 的原生持久机制 |
| 工作文件与执行进程 | 对应环境及独立备份／归档策略 |
| 实时观察增量 | Redis Streams；按配置保留，不作为永久恢复证书 |

产品接受与 Redis 入队不是跨系统事务。以稳定任务身份、一条受限的 outbox 入队路径和核对闭合交接；不直接“写数据库然后 enqueue”后假装不可能丢任务。验证 BullMQ jobId 的去重、清理和重投语义，队列丢失时能从持久事实重新发现未完成请求。

outbox 只负责交接，不承载逐 token 消息，也不演变成创作流程引擎。只维护用户可解释的执行状态，不另建一套每个工具步骤的通用状态机。

控制输入绑定用户、具体任务／动作、参数与稳定身份。取消是持久意图与实际收尾两个事实，不因请求被接受就立即宣称旧 writer 已停止。

正常失败重试与 stalled 重投都可能再次调用 handler；不能只设置 attempts 就认为不会重执行。handler 先核对执行身份、取消和终态。旧 runtime 仍活着时，不能让新旧 attempt 同时修改同一原生状态；未知结果先核对，不从头盲跑。

## 8. 运行信任边界

可信 harness、会话管理和凭证权威，与不可信 shell／生成代码分离。harness 不必物理上远离工作环境，可以使用已支持的执行后端或隔离的邻近运行方式。

目标确定，三个 SDK 的具体部署拓扑不能只凭文章确定：逐一验证公开扩展点、文件路径、Skills、输入文件、原生状态和取消保真。若某组合不能满足安全边界，就不通过生产能力准入；不靠私有补丁或抹平原生工具达成表面对称。

E2B 提供隔离基础设施，但默认网络、凭证传递、API 能力和数据保留需要主动配置。环境暂停不是独立备份；不依赖 beta pause/sidecar/快照行为作为唯一持久性保证。

平台管理凭证不进入任意 shell。业务工具按资源授权，以稳定操作身份执行；模型不能赋予权限。登录与认证用成熟组件，任务、环境和成果访问仍由平台授权。

## 9. 仓库形状

```text
apps/
  web/
  server/
  worker/
    src/
      execution/
      runner/
packages/
  harness/
    src/
      contract.ts
      pi/
      openai/
      claude/
  sandbox/
    src/
      contract.ts
      e2b/
  protocol/
evals/
deploy/
docs/
```

execution 承接领取后的运行监督，不规定 Agent 的任务步骤；不创建 workflows/、activities/ 或自研图引擎。Runner 是执行入口，不自动成为另一个后台服务。

Harness 和 Sandbox 提前设计公共契约。管理环境的能力与当前环境的执行／文件能力分开；厂商对象不泄漏给产品。两包由 worker 和评测装配，不创建双向依赖。

数据库、成果存储、技能与工具先有准确的 owner；当真实代码被多个入口消费时，再提取具体包。提前抽象关键替换点，不等于预建一圈 provider 与 manager。

UI 的 runtime 仅指前端状态适配，不是 Agent harness。assistant-ui 不持有产品任务权威；不采用实验性 thread-list 机制作为默认历史管理。切换 thread、关闭页面和组件卸载只解除观察，不能自动取消后台任务；显式用户控制才发送停止命令。

AG-UI 的事件不等于让浏览器提交的 messages 数组成为权威历史。Server 根据可信身份和持久记录决定输入，当前公开推理只呈现过程状态，禁止 raw thought、工具参数、private graph 与 signatures；安全快照支持撤回临时回答。

## 10. 哪些机制交给成熟组件，哪些仍然自己负责

| 交给组件 | 平台保留 |
| --- | --- |
| BullMQ：任务领取、并发、锁续期与重投机制 | 接受与入队交接、执行核对、原生 SDK 恢复与副作用规则；不接管 Agent 计划 |
| Redis Streams：增量追加、短期回放与分发基础 | 授权、活动含义、去重、缺口提示与长期事实 |
| Hono：路由、中间件、校验接入与流编码 | 产品权限、公共输出白名单、结构化日志、连接与进程收尾 |
| Better Auth：登录与会话机制 | 资源授权、执行授权与租户边界 |
| E2B：隔离基础设施与环境操作 | 能力准入、凭证边界、预算、恢复与销毁策略 |
| UI 库：基础组件与对话交互 | 任务与成果模型、产品导航和控制语义 |

不引入第二套任务队列、全局 EventBus 框架、通用 session 转换器、DI 容器或插件平台。也不自研任务队列、Redis、身份认证或 sandbox 的替代品。

## 11. 上线前验收：没有“选中组件即生产级”

- 核对 SDK / Node / BullMQ / HTTP adapter / UI adapter / 协议版本；锁依赖与镜像。
- 在代表性负载下测持久接受、TTFT、增量延迟、工具往返、并发、流量、费用与数据库影响，再确定 SLO。
- 演练 API 接受后崩溃、重复入队、stalled 重投、Worker 失联、Redis 重启、浏览器重连、晚到回调与取消竞态。
- 验证同一 session/workspace 只有有效 writer，旧执行无法收尾时隔离影响范围，不默认全 worker 停止。
- 对危险调用审计默认重试；外部生成、发布和付费操作验证幂等／查询限制。队列锁续期不当作 SDK checkpoint。
- Worker 有界 drain、兼容发布，核对旧 runtime 的实际停止，不将未收尾任务直接重跑。
- 数据库迁移采用 expand/contract；实际还原 PostgreSQL、成果、原生状态与相关工作文件，不只验证备份存在。
- 日志、tracing、队列 payload 和原生 transcript 有权限、脱敏、保留与删除策略；任务载荷优先引用，不复制大型文件和凭证。
- 生产评测记录模型、harness、工具、权限与环境版本；效果评测和 API 端到端可靠性评测分开。

具体合规、留存、区域恢复与配额目标待共同确定，不将检查清单冒充全部需求已冻结。

## 12. 研究来源与限制

调研结合官方产品资料、框架文档、发布记录及版本化文档。部分直接抓取因网络限制失败，部分由只读研究独立读取正文，部分通过官方索引与 Context7 核对。未运行登录产品、SDK 集成、托管基础设施、故障注入或负载测试。

### 产品体验

- [Manus Cloud Browser](https://manus.im/docs/features/cloud-browser)、[Projects](https://manus.im/docs/features/projects)、[Multi-modal](https://manus.im/docs/features/multi-modal)。动态文档，没有可靠整页发布日期。
- [Claude Cowork](https://claude.com/product/cowork)、[Artifacts 帮助](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)。滚动开放与 beta 需分开；不计入帮助页中的 2026-10-15 未来默认安排。
- [ChatGPT Agent](https://help.openai.com/en/articles/11752874-chatgpt-agent)、[Deep Research](https://help.openai.com/en/articles/10500283-deep-research)。动态帮助页；不据此推测内部基础设施。

### 工程选择

- [BullMQ stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs)、[cancellation](https://docs.bullmq.io/guide/workers/cancelling-jobs)、[connections](https://docs.bullmq.io/guide/connections)。核对重投、合作取消和 Redis 配置。
- 比较时参考 [pg-boss 12.37.1 API](https://github.com/timgit/pg-boss/tree/12.37.1/docs/api)与 [Temporal message passing](https://docs.temporal.io/develop/typescript/message-passing)、[safe deployments](https://docs.temporal.io/develop/safe-deployments)。不把队列能力不足或工作流限制夸大为绝对结论；当前不选 Temporal。
- [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)。广播与组内分摊、裁剪和持久性分别核对。
- [Hono Node 接入](https://hono.dev/docs/getting-started/nodejs)、[streaming](https://hono.dev/docs/helpers/streaming)、[validation](https://hono.dev/docs/guides/validation)。SSE 不替应用保存历史，Node 进程由 host 管理关闭。
- [Better Auth Hono 接入](https://www.better-auth.com/docs/integrations/hono)、[PostgreSQL 接入](https://www.better-auth.com/docs/adapters/postgresql)。实际实现还需核对所锁定版本、代理、cookie、多值响应头与 origin。
- [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)、[AG-UI runtime options](https://www.assistant-ui.com/docs/runtimes/ag-ui/runtime-options)。不采用会将 thread 切换等同后台取消的默认行为。
- [Anthropic Managed Agents 架构](https://www.anthropic.com/engineering/managed-agents)、[跨产品隔离](https://www.anthropic.com/engineering/how-we-contain-claude)。其架构不构成所有公开 SDK 都支持透明远端原生工具的证明。
- [E2B 文档](https://docs.e2b.dev/)、[Node 发布信息](https://nodejs.org/en/blog/release)、[PostgreSQL 支持政策](https://www.postgresql.org/support/versioning/)。部署范围与版本限额在实施前核对。
