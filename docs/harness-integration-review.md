# Harness 原生接入重新审查

本轮重新读取官方文档、精读六个业内实际接入方案，并逐函数审查整个 `packages/harness`，不沿用上一轮“已审查所以没有问题”的判断。

结论：**已实现的 Pi／OpenAI 保持小型一致外部合同，内部沿用各自官方执行与状态 authority；本轮修复三处 OpenAI authority capture 缺陷。没有理由引入第四执行框架、portable 工具层或统一 checkpoint。** 这不是“三个 SDK 已全部完成”或“代码已经绝对完美”的证明：Claude 未实现，产品、隔离与恢复边界也未全量验收。

## 1. 官方资料与版本基准

仓库依赖仍固定 Pi **1.1.0**、OpenAI Agents JS **0.20.0**，没有因调研升级版本。

| 官方来源 | 固定基准 | 本轮 fresh main | 阅读与比较 |
| --- | --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi/tree/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent) | `abe508e1b89912adde45528136c3221eb69acdd7` | `4ac0bd8c7b96d72cb6a73226edc7c9ecaae1d14e` | 完整 README、SDK、sessions、compaction、extensions、models、configuration、security；相关 linked docs、14 个 SDK examples、6 个引用 extension examples；installed implementation 的生命周期路径 |
| [OpenAI Agents JS](https://github.com/openai/openai-agents-js/tree/33e2741be9bb52c1d96a8b4dac0c68e46297b607) | `33e2741be9bb52c1d96a8b4dac0c68e46297b607` | `89a9ddf1e241e75f2e0ad4c15d89de9e215ebac6` | 完整 agents、context、sessions、streaming、running-agents、HITL、tools、MCP，以及 results、guardrails、handoffs、models；guide 引用 examples 与 installed result／run／context implementation |

OpenAI `v0.20.0` 的 `2916ca9c…` 是 annotated tag object，真正 commit 是上表的 `33e2741…`。不能将 tag object 当作源码 commit 的比较结果。

fresh main 比较中，上述八个 Pi 文档和 OpenAI guide pages 没有变化；Pi 其他变更包括 cursor／theme 文档，OpenAI 有 dependency／release／example 变更。这**不等于整个 SDK 与 main 相同**，运行语义仍以固定版本及本仓测试为准。

### 重新确认的官方边界

- Pi：`prompt()` fulfilled 可以是 handled／无模型调用、error、aborted 或 deferred。`agent_end`、`agent_settled`、owned prompt Promise 不是同一个身份或完成边界。
- Pi：public `message_end` subscriber 在 native history append 前收到通知；展示 branch 在 owned prompt join 后读取。model context 仍由 SessionManager 的 compaction／context edits projection 决定。
- Pi：preflight 没有端到端 prompt AbortSignal。取消自动 compaction 后，外层 prompt 仍可能继续启动 agent，所以早期取消需在原生 operation start 补发。
- Pi：`bindExtensions()` 实际执行 startup 与资源发现；`AgentSession.dispose()` 同步且不等于 awaited extension shutdown。host 要通过原生 lifecycle 显式收尾。
- OpenAI：native `toStream()` 返回 Web ReadableStream；默认 reader cancellation 会取消执行。`values({ preventCancel: true })` 是保留原生执行的公开 stream API，不是另造 loop。
- OpenAI：await `completed` 后才分类成功／取消／审批；EOF、最后一条文本或停止 reader 都不能代替它。此处仍不扩大成任意 host／detached resource graph 的完成保证。
- OpenAI：RunResult 是原 RunState 的 live view；原生 continuation 用原 root、Runner、Session 和同一 state，不从公开 transcript 或 `lastAgent` 重建。
- OpenAI：审批、guardrails、工具可见性与 RunState schema 校验不是业务授权；serialized state 只来自可信存储，跨进程原子消费与副作用对账归 host。

## 2. 六个业内实现：实际调用链，不以名气替代证据

以下均重新解析 source pin、版本与实际函数。第三方源码仅静态阅读，**未安装、执行测试或调用模型**。阅读范围是接入的装配 → submit → history／events → cancel／cleanup，不声称读完每个项目全仓。

| 方案／固定源码 | 真实形态与版本 | 实际精读路径 |
| --- | --- | --- |
| [OpenHands](https://github.com/OpenHands/OpenHands/tree/e0a26af82f0b2016423c0d53cc9ae32a357cef2d) + [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk/tree/c4b93299cf2b31c8b5d0b2c5a89965ccc5ff24f9) | MIT；Canvas 1.26.0／SDK 1.54.0；ACP subprocess client，不是 OpenAI Agents SDK | Canvas launcher → conversation service → EventService.run → LocalConversation._arun → ACPAgent init／prompt／cancel／shutdown |
| [svkozak/pi-acp](https://github.com/svkozak/pi-acp/tree/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905) | MIT；0.0.34／ACP JS ^0.26.0；ACP → Pi CLI RPC，不是 SDK embedding | src/index → PiAcpAgent → SessionManager／PiAcpSession → PiRpcProcess → native prompt／settled／abort |
| [Hankweave](https://github.com/SouthBridgeAI/hankweave-runtime/tree/9ea76bbb826becb6ab148bec9dd3aeb00b410c61) | Apache-2.0；0.12.0；external Pi SDK 0.85.1 | CodonRunner.createProcessManager → PiSdkManager.spawn → ModelRuntime／SessionManager／createAgentSession → subscribe／prompt → stop reason → cleanup |
| [OpenClaw current](https://github.com/openclaw/openclaw/tree/2e4ab55c12d5c4212fef6d17a268f7f400c7cb05) 与 [external-SDK predecessor](https://github.com/openclaw/openclaw/tree/99b27cde64d6616a9e41f52f4a699577cf60f1d6) | MIT；current 2026.9.9 已 internalized；predecessor 2026.5.27 使用 external Pi 0.75.5 | current attempt preparation／local SDK／prompt submit／subscription／cleanup；historical runEmbeddedAttempt 全生命周期及 private coupling |
| [Temporal TypeScript](https://github.com/temporalio/sdk-typescript/tree/c42ad422e91174967984c6793b4b0b72502872c7/contrib/openai-agents) | MIT；integration 1.24.0／OpenAI native SDK 0.14.3；durable workflow 特定接入 | worker plugin／activities → convertAgent → ActivityBackedModel → native Runner.run → workflow session／stateful MCP cleanup |
| [Paperclip](https://github.com/paperclipai/paperclip/tree/0e37a385e678d1a568f483c31ae1c19024d2df98/packages/adapters/pi-local) | MIT；pi-local 0.3.1；`pi --mode json -p --session`，不是 RPC／SDK；sandbox installer pin Pi 0.74.0，本地实际 CLI 版本未知 | execute 全函数 → runtime-config／JSONL parser → execution-target process seam；native session header scope、fresh fallback、finally cleanup |

OpenHands pin 使用 **pi-acp 0.0.33 + Pi 0.83.0**，不能把 adapter HEAD 0.0.34 行为直接当作其已部署行为。`zed-industries/pi-acp` 不存在，实际项目为 `svkozak/pi-acp`，不是 Zed／Pi 官方 adapter。Paperclip default branch 是 `master`，本轮未将不存在的 `main` 当作成功证据。

### 2.1 OpenHands：借鉴取消与拥有者，不照搬产品调度

[ACPAgent](https://github.com/OpenHands/software-agent-sdk/blob/c4b93299cf2b31c8b5d0b2c5a89965ccc5ff24f9/openhands-sdk/openhands/sdk/agent/acp_agent.py#L3044-L3269) 启动 stdio client、initialize、按 native identity load/new session，再通过 conn.prompt 委托外部 loop。[_astep cancellation](https://github.com/OpenHands/software-agent-sdk/blob/c4b93299cf2b31c8b5d0b2c5a89965ccc5ff24f9/openhands-sdk/openhands/sdk/agent/acp_agent.py#L4280-L4354) 区分 cancel、bounded drain 和必要的 restart；[shutdown](https://github.com/OpenHands/software-agent-sdk/blob/c4b93299cf2b31c8b5d0b2c5a89965ccc5ff24f9/openhands-sdk/openhands/sdk/agent/acp_agent.py#L4551-L4633) 有 terminate／wait／kill。

补读 [EventService.run](https://github.com/OpenHands/software-agent-sdk/blob/c4b93299cf2b31c8b5d0b2c5a89965ccc5ff24f9/openhands-agent-server/openhands/agent_server/event_service.py#L1422-L1644) 和 [LocalConversation._arun](https://github.com/OpenHands/software-agent-sdk/blob/c4b93299cf2b31c8b5d0b2c5a89965ccc5ff24f9/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L2114-L2615)，确认中间确实调用 conversation native async path，再调用 ACPAgent.astep；不是仅从 README 猜链路。该产品自身还有容量 permit、queued input、restart 与事件发布 tail，不移植成我们的通用 session engine。

HOME relocation 是 config／lock scope，不是 OS sandbox；ACP permission bridge 的自动选择不能当作业务审批策略。外部 loop 原生拥有工具／compaction，值得保留。

### 2.2 pi-acp：传输 acknowledgment 不等于完成

[PiAcpSession.startTurn](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/src/acp/session.ts#L595-L635) 只从 RPC prompt 得到受理，实际 [settlement](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/src/acp/session.ts#L949-L974) 等 agent_settled。这是 RPC transport 的完成面，不要求我们的 SDK adapter 放弃 owned prompt join。

借鉴 native history、cancel 与 active turn 分离；不借鉴全局 session-map、未转发 MCP、没有完整 wait/escalation 的 SIGTERM dispose，以及 SDK-internal `.agent` cleanup。history replay 是 UI projection，不是原始事件或可迁移 checkpoint。

### 2.3 Hankweave：最接近我们的 Pi embedding，但不等于无条件标杆

[assembly](https://github.com/SouthBridgeAI/hankweave-runtime/blob/9ea76bbb826becb6ab148bec9dd3aeb00b410c61/server/pi-sdk-manager.ts#L403-L506) 使用 native factory／tool allowlist／in-memory settings；[prompt](https://github.com/SouthBridgeAI/hankweave-runtime/blob/9ea76bbb826becb6ab148bec9dd3aeb00b410c61/server/pi-sdk-manager.ts#L594-L739) 订阅后提交，并检查 fulfilled prompt 的 in-band stop reason；[resume](https://github.com/SouthBridgeAI/hankweave-runtime/blob/9ea76bbb826becb6ab148bec9dd3aeb00b410c61/server/pi-sdk-manager.ts#L781-L861) 找不到原 ID 时明确失败。

借鉴独立 env overlay、不 mutate process.env、native ownership 和严格 resume。不要照搬 Claude-schema JSONL 归一、synthetic PID、in-process “forceKill” 或 timeout race 后即认为已停止。ModelRuntime default discovery 与未禁用 context files 也不能称 hermetic。

### 2.4 OpenClaw：必须区分 current internalized 与 historical external

[internalization commit](https://github.com/openclaw/openclaw/commit/bb46b79d3c1479f194a90afcf3dd69a1858a7898) 的 sole parent 为上述 external predecessor。current 使用自己的 local SDK／runtime，不是当前 external Pi coding-agent embedding；pi-tui 依赖不能证明仍采用官方 loop。

借鉴 current 的 [owner publication](https://github.com/openclaw/openclaw/blob/2e4ab55c12d5c4212fef6d17a268f7f400c7cb05/src/agents/embedded-agent-runner/run/attempt-session-prepare.ts#L91-L275)、fact 与 delivery 分离、[explicit MCP/LSP cleanup](https://github.com/openclaw/openclaw/blob/2e4ab55c12d5c4212fef6d17a268f7f400c7cb05/src/agents/embedded-agent-runner/run/attempt-subscription-cleanup.ts#L36-L105)。不能把 local receipts、cohort、symbol hooks 当作 upstream 公共能力。

historical 真实调用 external createAgentSession，但同时修改 [_baseSystemPrompt](https://github.com/openclaw/openclaw/blob/99b27cde64d6616a9e41f52f4a699577cf60f1d6/src/agents/pi-embedded-runner/system-prompt.ts#L147-L161)、[session-manager internals](https://github.com/openclaw/openclaw/blob/99b27cde64d6616a9e41f52f4a699577cf60f1d6/src/agents/pi-embedded-runner/session-manager-init.ts#L24-L68) 与 steering queue。我们的薄 binding 不应复制这些 private graph patch。

### 2.5 Temporal：native loop 不变，但 graph conversion 有特定成本

[convertAgent](https://github.com/temporalio/sdk-typescript/blob/c42ad422e91174967984c6793b4b0b72502872c7/contrib/openai-agents/src/workflow/convert-agent.ts#L7-L71) clone graph、替换 ActivityBackedModel；[runner](https://github.com/temporalio/sdk-typescript/blob/c42ad422e91174967984c6793b4b0b72502872c7/contrib/openai-agents/src/workflow/runner.ts#L242-L318) 最后仍调用 native Runner。model Activity 同时发布 live events 和返回可 replay 的 recorded events，两者不是一条透明 token stream。

借鉴 explicit model side-effect boundary、原生执行、cleanup 的 primary error 保留；不引入 graph conversion、workflow polyfills／replay 或 WorkflowSafeMemorySession。该实现不传普通 SDK signal，不能据此承诺 HTTP 即时取消；它的 nested agent-tool approval 限制也不是我们的 0.20.0 限制。

### 2.6 Paperclip：native CLI 可用，host policy 不应伪装成 SDK 原则

[execute](https://github.com/paperclipai/paperclip/blob/0e37a385e678d1a568f483c31ae1c19024d2df98/packages/adapters/pi-local/src/server/execute.ts#L235-L905) 核对 execution target、session params 与 native header cwd，再调用 JSON print CLI。借鉴 [process seam](https://github.com/paperclipai/paperclip/blob/0e37a385e678d1a568f483c31ae1c19024d2df98/packages/adapter-utils/src/execution-target.ts#L855-L935) 对 SSH disconnect／timeout 不作已停止证明，以及 finally 恢复／cleanup。

不借鉴 shared HOME skills 写入、缺失 history 后 fresh fallback 与 raw error accumulation 的最终结果策略。其 runtime-config 会 materialize provider secrets，是它自己的部署选择，不进入本包。我们的 requested ID mismatch 明确失败，成功 native retry 只公开成功文本，而不是将旧失败永远混进当前结算。

### 2.7 核验了一个“看似应该存在”的接入

[官方 AG-UI HEAD](https://github.com/ag-ui-protocol/ag-ui/blob/2aabfc8cada0b429927e4c256c9cf990a6791e5f/README.md#L119-L125) 仍将 OpenAI Agent SDK 标为 In Progress；实际 TS HttpAgent 仅是 fetch/SSE client。client abort 不证明服务端 Runner 已取消。

另读 `daniprol/ag-ui-openai@59bd982…` 的 Python native Runner wrapper，但其 licensing、cancel、HITL resume 有未闭合处，不当作官方／优秀标杆凑数，也不把 Python API 当成 TypeScript API。六个主案例已经满足阅读范围。

## 3. 外部一致，内部不伪造对称

共同入口只统一 **open／run／events／result／interrupt／dispose** 与 ordered text/file input。结果的 completed／cancelled／paused 是可消费的公共分类，不是 portable state machine。

| 问题 | Pi | OpenAI | 审查选择 |
| --- | --- | --- | --- |
| 执行 | AgentSession.prompt | Runner.run(stream:true) | 使用官方 loop，无第四 loop |
| 会话 authority | SessionManager branch/context projection | native Session + RunState | public messages 不作 checkpoint |
| 结果 | prompt void + native terminal facts | native RunResult live state | 不给 Pi 造 RunResult 替身 |
| 观察 | native facts + settled full-text events | lazy non-cancelling native reader | 都不由 reader 驱动执行；时效不假装相同 |
| 取消 | native session abort，preflight 补发 | owned AbortSignal | 不为形式一致复制 SDK 内部协议 |
| paused | deferred handle；live hooks 仍 await | native approvals／cancel continuation | 特有控制面留在 native／typed adapter API |
| 失败后再提交 | Pi 普通 provider error 可新 turn | failed owner 需 host reconcile | 不机械复制 failed gate |
| cleanup | 显式 callback，owned prompt/abort join | 显式 callback，owned outcome join | 借用原生资源不隐式销毁 |

没有 portable Tool／MCP／Skills facade、capability registry、统一 Runtime graph、输入下载器或假媒体兼容层。OpenAI `<C,A>` 真实保留 app context／具体 Agent schema，Pi AgentSession 无会话级泛型，不人为对齐。

这些公共合同只承诺当前切片。Pi 文件明确拒绝，OpenAI 映射成功不等于 provider 接受；approval UI、实时活动、native control、产品 Worker/API 和 Claude 不由表格自动变成已实现功能。

## 4. 逐函数代码品味审查

全部 production TS、相邻 tests/type tests、READMEs、package exports 与 build/test 配置已读。下面按真实动作列出判断，不只看折叠签名。

| 文件 | 已审查函数 | 决定 |
| --- | --- | --- |
| contract/index/package | 公共数据形状、exports、type chain、build exclusion | 保留小合同与显式 subpaths；不添虚构能力 |
| OpenAI adapter | createOpenAIHarness、openSession、assertSessionRequest、validateSessionConfig、closeFailedOpening | 修复跨 await authority capture；保留准入／校验／清理的完整阶段 |
| OpenAI session | createOpenAISession、runSession、resumeSession、reserveExecution、startExecution | 保留 native graph、writer reservation；resume 捕获一份 receipt，不反复读 mutable options |
| OpenAI session | readNativeEvents、settleRun、runStatus、disposeSession、releaseSession、assertAvailable | lazy reader 与 done latch 有真实语义；completed 再分类；failed gate／reentrant closing 各有 owner |
| OpenAI request | toNativeInput、toNativeContent、escapeDataUrl | 保留同步 byte/URL snapshot、native MIME mapping；不引入媒体 IO |
| OpenAI projection | createRunEvents、toMessages、toEvents、toModelEvents、toItemEvents、toFinalMessageEvents、toTextMessage、toRunOutcome | 平坦 family dispatch；每个 converter 完整转移自己的观察状态；不变成大 factory |
| Pi adapter | createPiHarness、openSession、assertSessionRequest、validateSessionConfig、closeFailedOpening | opening 主线直接；补 request snapshot ownership 注释，不造 generic opener |
| Pi session | createPiSession、runSession、settleRun、requestInterruption、interruptExecution、disposeSession、releaseSession、assertAvailable | previousEntryIds 明确 ID 种类；补 native append／preflight／cleanup 的不可见时序 |
| Pi request | toNativeInput | 小函数完整；注释明确 command/template 是 native prompt 的行为，不逐行解释拼接 |
| Pi projection | subscribeRun、observeEvent、toRunStatus、createRunEvents、toMessages、toTextMessage、toFinalMessageEvents、toRunOutcome | raw facts 不放进 session；补 in-band outcome／display-context 区分；不给每次赋值单建 helper |

没有为减少行数合并 lifecycle 与投影；没有为增加注释给简单 guard／converter逐行翻译；没有将本地状态藏进大 factory、types 墙、manager 或通用执行器。微小重复的 outcome 映射也不值得另建 shared projection 框架。

### 正式 Pi 测试的命名与作用

原 `native.test.ts` 是离线隔离 launcher，不是真实模型 E2E 残留。但名字过宽、默认排除相邻 session suite 的导航也不直观，本轮改成：

- `pi/session.test.ts`：正常 Vitest 入口，负责 clean child process。
- `pi/session.sdk.test.ts`：真实 SDK／faux model IO 的 17 个行为测试；root config 不直接加载它。

临时 child config 只选择后者，不 import root config，避免递归。白名单 env、temporary HOME／agentDir 和 PI_OFFLINE 保留；不是加一个新测试框架。直接运行 session.test.ts 可得到正确隔离。build 的 `**/*.test.ts` 排除两份文件，正式 dist 不带测试。

## 5. 本轮发现的三个实质问题与修复

1. **opening request alias**：原 OpenAI 将 caller request 直接交 host，并在 await 后读取修改后的 ID。两条回归分别证明 caller mutation 导致合法 opening 被拒，以及 host mutation 让错误 history 被接受。立即 snapshot，并向 host 传独立副本。
2. **returned binding drift**：getSessionId() 可以异步创建 history；原先验证 config 后才捕获 execution binding。两条回归分别证明 Agent／history／cleanup 切换及 context option 越过 guard。现在在 try 内先 shallow capture config/runOptions，再 await validation；原生对象／mutable context 原样引用，snapshot throw 仍进入明确 cleanup。
3. **receipt drift inside updater**：原先校验 options.result 后仍反复读取。真实 native approval 回归中 updater 替换为另一个 paused receipt，原代码返回另一份 pause。现在一次捕获 result/input/updater，所有 native mutation 与 execution 使用同一已校验 receipt。

五条回归均先观察到对应真实 RED，再小改 GREEN；没有用 fake Runner／fake loop 覆盖问题。原有 handoff、nested tool、partial approval、failed updater、writer reentry、disposal reentry 与 persistence-before-cleanup 测试保留。最终独立只读复核未发现这些修复的 implementation blocker。

## 6. 验证与未验收范围

本轮 fresh local checks：frozen install；`pnpm check` 的 formatter/lint、全仓 typecheck、**10 files／64 outer tests** 和 build；12 个 touched TS 路径 LSP **0 diagnostics**。其中 1 个 outer launcher 再执行 17 个 Pi SDK cases，不将 64 + 17 冒充互不重叠的总数。

root／Pi／OpenAI built exports smoke 和 Web health Playwright 1 项通过；发布时跟踪 exact commit 的 GitHub CI。本轮调研和回归不访问用户模型配置、模型凭据或 history，不运行付费模型矩阵；上一阶段真实模型结果单独保留在 Pi／OpenAI review，不能当成本轮重新跑过。

仍未验收生产 tenant isolation、cross-process writer、crash recovery、完整 native UI/control、所有 media/MCP/provider、Claude、产品 Thread/Turn/API/Worker。源码中的 host authority 边界不是这些能力的实现。所谓“教科书级”应体现可解释的顺序、owner 和失败后果，不能成为绝对正确或生产认证的宣言。
