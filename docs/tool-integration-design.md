# 多 harness 原生接入设计

> 状态：2026-10-10 官方文档复核后的设计与实施边界。OpenAI 工作区已有原生 factory／continuation 正常路径，具体 API 见 [OpenAI 接入](../packages/harness/src/openai/README.md)。[完整审查](openai-review.md) 已更正过强的 SDK 收尾假设，并删除 wrapper 多余的主动事件队列；SDK-managed 资源与 host-owned 资源仍按各自 lifecycle 管理，不建设平台通用 finalization。Pi 已完成包级文本切片，见 [Pi 接入](../packages/harness/src/pi/README.md) 与 [Pi 审查](pi-review.md)；Claude 仍是设计。两者均不是生产恢复验收。

## 1. 重新确定边界

**共享执行与观察，原生装配与控制；一次接通完整的自然能力簇，不逐项重写 SDK。**

```text
可信 host：模型／授权／业务工具／存储／资源
                    ↓
各 SDK 的原生装配：Agent、工具、扩展、Query 配置
                    ↓
harness：执行 ownership、准入、取消／释放、公共结果投影
                    ↓
生产执行或评测
```

SDK 决定工具发现、调用、handoff、继续推理和原生状态。harness 不建设工具 registry、通用权限引擎、搜索协议、媒体 Workflow 或第四套执行循环。

“支持接入”与“服务能力验收”分别说明。host 显式提供官方工具／资源，adapter 保留它们；不能把未做付费验收当成必须在 adapter 禁掉所有相关 SDK 类型的理由，也不能把透传测试当成服务、隔离或恢复验收。

## 2. 官方文档与固定版本

本次实际读取官方正文，不以搜索生成摘要作设计证据：

- OpenAI：浏览器读取 HITL、Tools 与 API Tool Search 正文；取得官方 GitHub main `89a9ddf1e241e75f2e0ad4c15d89de9e215ebac6` 的 Agents、Running agents、Tools、MCP、HITL、Sessions、Context、Streaming、Results、Guardrails、Handoffs、Tracing、Models、Schema validation、Sandbox concepts 全文。九篇主要接入指南与 `v0.20.0` 发布 commit `33e2741be9bb52c1d96a8b4dac0c68e46297b607` 逐文件比较，内容相同。npm latest 与仓库均为 0.20.0。
- Pi：完整读取官方 README、SDK、Extensions、MCP、TUI、会话／配置／技能／安全／RPC UI 文档及相关示例；比较当前 main 与安装版。npm latest 与仓库均为 1.1.0；发布 commit `abe508e1b89912adde45528136c3221eb69acdd7`。接入相关文档无实质差异。
- Claude：读取当前官方 TypeScript、Custom tools、MCP、Permissions、Hooks、User input、Tool search、Streaming、Sessions、Session storage、Skills 等正文；浏览器再核对 Permissions。npm latest 为 0.3.296，仓库为 0.3.295；相关 Query、MCP、权限与 defer 接口已在安装版存在，不因滚动文档自动升级依赖。

Context7 配额耗尽，网页抓取受 fake-IP 检查限制；使用独立匿名浏览器与官方版本固定源码替代。研究未调用模型、真实 Claude CLI、用户凭据或业务服务。

## 3. OpenAI：一个原生会话 binding，取代不断增长的配置镜像

旧方案由 adapter 接收 client／model／instructions，再逐项补 nativeTools、MCP、guardrails、handoffs 等字段。这会逐渐复制 `Agent` 与 `Runner`，也容易引入人为功能白名单。

改为一个 **session-scoped 原生装配入口**：host 返回已装配的 SDK 对象，adapter 不再构造另一份 Agent 或 Model 配置。

```ts
// Host-owned scoped dependencies; field contracts are documented in the adapter README.
createOpenAIHarness({
  resumable: historySourceResumable,
  open: async ({ cwd, nativeSessionId }) => ({
    agent: scopedRootAgent,
    runner: configuredRunner,
    session: await openHistory(nativeSessionId),
    context: scopedContext,
    runOptions: { maxTurns: 20 },
    dispose: closeOwnedSessionResources,
  }),
});
```

这是普通的具名数据与创建能力，不是新的 runtime／manager。`open` 打开的对象从“只有历史后端”扩展为一个完整的执行 binding；不同时保留固定数组、Agent 注入和 factory 三套入口。

### 字段与 ownership

| 字段 | 使用官方类型及含义 |
| --- | --- |
| `agent` | 原生根 `Agent`；持有完整工具、MCP、handoff、schema、guardrails、hooks、模型与 instructions |
| `runner` | 官方 `Runner`；host 配置 provider、tracing、执行策略，可以在配置与并发条件允许时复用 |
| `session` | 官方 `Session`；历史来源继续与模型服务独立，不默认选择后端 |
| `context` | SDK local app context 或原生 `RunContext`；必须与 Agent／工具类型一致 |
| `runOptions` | 官方 streaming run options 扣除 wrapper 拥有的字段，不另抄几十个 SDK 参数 |
| `runState` | 可选的 host 已验证／重建的原生续执行状态，与本 binding 的 root graph 和历史身份关联 |
| `dispose` | 可选的 host 资源收尾；只释放本 binding 明确拥有的资源 |

泛型保留 context 和具体根 Agent 的类型，使 Zod／Standard Schema final output 与 `errorHandlers` 的类型不被抹成默认 text。仅在 SDK 自身要求的泛型约束处使用其宽 Agent 约束，不把实际 context、Agent 或结果强转为 unknown。

`runOptions` 有真实必要性：Runner 配置不能表达所有单次运行选项，例如 `maxTurns` 和 `errorHandlers`。一个具名类型通过单层 `Omit` 跟随官方 `StreamRunOptions`，排除 `stream`、`session`、`signal`、`context`、`conversationId`、`previousResponseId`。

- wrapper 持有 stream、history、signal 与 context ownership；JS／宽对象传入冲突字段也不能覆盖它们，不依赖 TypeScript 单独保证运行时规则。
- 本入口选择 SDK Session 作为历史 authority，因此不同时开放另一套 server-managed history 配置；不要混用两套记忆策略。
- 模型／client/provider 与 tracing 由 host 显式装配。官方 SDK 允许默认模型、默认 provider 和默认 tracing，不因为接收原生对象就声称这些默认已被关闭。示例必须显式选择 model/client/provider，并使用已授权的 tracing 设置。

### 为什么现在使用 per-session factory

租户 context、workspace 工具闭包、活 MCP client，以及只允许单个 active run 的 stateful model，都是实际作用域问题。复制工具数组或新建 Agent 不会隔离它们。

host 可以复用无会话状态且 share-safe 的 client／Runner／工具实现；对有会话状态的资源，在 `open` 中构造。不得捕获由下一个请求改写的全局 currentTenant/currentWorkspace。复用 SDK RunContext 也可能复用 approvals／usage，不仅是 app data；不能误把它当成每个新 run 都会清空的普通 context。

factory 返回前失败，由 factory 清理部分创建的资源。返回后由 wrapper 接管明确的 cleanup callback：原生 ID 校验失败时调用；dispose 在 wrapper 的 SDK 结果之后调用一次，并 await host cleanup 自身的资源收尾；SDK-owned 资源不转给 wrapper，SDK 的 stream 完成不是任意 host 资源已销毁的证书。清理失败不能静默覆盖原始打开失败，也不能偷偷关闭借用 client、MCP server、Runner 或清空历史。

## 4. 工具与相邻能力不再人为切碎

删除阶段性 `assertNativeTools` 白名单。所有原生配置直接存在于 host 提供的 Agent／Runner，不重建工具 schema、丢弃 metadata 或冻结 SDK 对象。

原生装配可保留、实施时需要验证的能力簇：

- function tools、参数／输出校验、错误／超时策略、signal、tool guardrails；
- immediate／deferred、namespace、server／client tool search；
- hosted tools、hosted MCP，以及 host 已授权装配的本地 MCP；
- agents-as-tools、handoffs、原生 hooks 与 typed final output；
- HITL、Session、原生 compaction、取消、结果和资源收尾。

这些是原生装配范围，不是“所有服务与模型已经支持”的承诺。兼容性检查、工具调度和 SDK 级约束由 SDK 执行；实际服务不支持时保留真实错误，不加伪回复或自动切换路径。

需要额外执行资源的能力仍须 host 显式装配：Computer／Shell／Editor、MCP 连接、sandbox client／session、Skills 路径、存储与凭据。删除工具白名单不等于默认开 shell、启动进程、安装 server、创建容器或授权外网。

官方 `SandboxAgent` 本身仍通过 Runner 运行；可以保留它的原生装配，但其 workspace、snapshot、权限和 lifecycle 不等于聊天 Session，不借本轮建设通用 sandbox backend。Experimental Codex／hosted multi-agent 不自动安装依赖或宣称生产支持。

Computer 的 `onSafetyCheck` 与 `needsApproval` 是不同机制：前者是 callback，缺省并不自动暂停等待人工审查；后者才是 RunState interruption 流程。Hosted shell 也不接受本地 shell 的 needsApproval／onApproval 配置。保留官方差异，不承诺一套审批参数能控制所有原生执行面。

### Tool search 的具体边界

SDK 保留 discovery ownership、runtime-loaded callbacks 与历史记录；不在 harness 实现搜索服务。默认 server search、公开内置 client paths 查询与合法 execute callback 使用 SDK 原生入口。

官方 JS Tools 指南对 custom client query 的说法与安装版运行代码有差异；Models 与 Tools／API 指南对模型门槛也不完全一致。不得依据一行指南在 wrapper 硬编码模型名或另写 Responses loop。对自定义 client query 做固定版本离线兼容验证，再注明支持范围；模型／网关接受另行授权验收。

Session history 能保留发现身份，但不能保存 JavaScript 回调。动态 callback 恢复使用 SDK 提供的显式 RunState rehydration 路径，并由 host 重供代码、权限和相同身份；不能把 history reopen 等同于动态实现恢复。

## 5. OpenAI HITL：正常暂停是正常结果

SDK 的 `completed` Promise 报告执行结果，成功可能是任务完成、取消或审批暂停；公共 status 分别表达 completed／cancelled／paused。正常 interruption 不再转换为“不支持审批”的错误。completed 的公开契约是 stream 完成，不据此扩张成任意 resource graph 的销毁证明，也不以平台自定的更强保证判断 SDK 有 bug。

```text
SDK settlement 成功且有 interruptions
→ 保留 SDK RunState／审批项
→ 返回 paused
→ host 明确批准／拒绝
→ SDK state.approve／state.reject
→ 原 root Agent + 同一 SDK Session 继续 Runner.run
```

### 续执行纪律

- 只提供 `resume({ result, input?, updateState? })` 一个 OpenAI 专用 continuation 入口；不把 RunState 塞进共享 turn。`result` 必须是当前 `pendingRun` 的原生结果对象；SDK state 会复用，不能以 state 身份接受陈旧 receipt。
- wrapper 保留当前 pending state 的 ownership；拒绝陈旧／外来／失败 continuation，审批修改与继续执行共同受 active-writer gate 保护。`updateState` 类型为 `(state) => undefined`，运行时在启动 SDK 前检查非 undefined 返回（包括 Promise）；仅可信同步修改，不承诺部分修改的 rollback。授权／IO 必须在 resume 前完成，不在 updater 内 await。
- 支持部分决定、单次／run 内 sticky 决定和拒绝 message，使用 SDK 原生 approve／reject，不强制所有请求一起批准。
- 正常新 turn 不能绕过 paused／failed continuation。`resume.input` 使用 SDK `RunState.addInput` 暂存，进入下一次 model input guardrails；不保证已批准工具副作用等待该 guardrail 通过，不把追加输入当作新的 run 重建历史。
- 嵌套 agent tool 与 handoff 内的审批仍在外层处理；恢复必须使用原始 root，不把 lastAgent 换成恢复 root。
- 普通新 turn 的起始 Agent 策略应明确；历史后端本身不保存应用的 sticky-handoff 策略，不能从公开消息推断。
- 如果 settlement 因持久化失败而拒绝，仍是失败；保留原错误与 pending ownership，不能改成成功 paused、取消或自动重试。resume 后 SDK 错误也使旧 receipt 失效，即使 interruptions 已清空；失败状态需要 host 核对再恢复。

用实际 SDK pending state 与明确的 lifecycle 表达正常暂停，取代只有 boolean 的永久封锁。异常后的不安全状态仍需局部 fail-closed，不以“原生支持恢复”为理由猜测未知副作用。

## 6. 原生结果完整，公共观察有边界

共享契约需要增加一个真实返回的 `paused` outcome，但不附跨 harness checkpoint。公开 messages／AG-UI 仍是产品投影，不成为恢复 authority。

OpenAI 专用结果保留官方 typed result view、interruptions、usage、guardrail 结果、finalOutput 与 state，供可信服务端消费。结构化 final output 或工具最终输出不能只因为没有 assistant text 就被丢失；公开文本投影与原生完整结果分别说明。

**不直接暴露原生 StreamedRunResult。** 它的 `toStream`、`toTextStream` 和 async iterator 共享同一个底层 stream，取消 reader 可以取消 SDK 执行。仅靠 Readonly 或类型断言无法隔离这种控制权。

- wrapper 保留唯一原生 stream reader；公开观察继续 preventCancel。
- `result.native` 使用官方非 streaming `RunResult`，不包含 stream reader 控制方法；其 getter 跟随活 SDK 状态，不是 immutable snapshot。不额外创造双流／tee／分发框架。
- native state、错误、tool args 和完整 result 只留可信服务端；不得直接塞进公开 custom event／浏览器 JSON。
- 当前公共投影仍以 assistant 文本为界，不宣称完整工具／审批 UI 已实现。native.newItems 在 resume 后累计，公共 messages 排除历史消息 ID，原生 items 不变。后续工具／handoff／approval 观察须按原生事实和 host 授权投影，不默认公开完整载荷；本轮不建设问卷 UI。

## 7. 原生恢复：不建设平台 checkpoint

Session history 与 RunState 分开：

- `resumable` 继续表示 host 已验证历史后端按 ID 重开；不是 HITL／进程恢复总开关。
- 长时间审批可以使用 SDK `state.toString` 与 `RunState.fromString`，快照由 host 的受信存储保存／消费；wrapper 不自动保存快照／context，SDK RunState 序列化仍包含 context、approvals 与 usage。host 在 `open` 中按授权、ID 与版本恢复对应 graph／Session，返回可选 `runState` 完成 ownership 交接；续执行入口不另外接收任意未经绑定的快照／state。
- 需要新进程 context 时，host 使用 `RunState.fromStringWithContext` 并明确 merge／replace；Runner 接收已有 RunState 时，state 中的 context 是 authority，run options 的 context 不能代替这种恢复步骤。
- 保留同版本 SDK、相容 root graph、工具代码与配置；原生 schema／ownership 校验不是快照真实性、用户授权或防重放证明。
- app context 会进入 RunState 序列化。SDK 默认省略 tracing key 不会自动擦除 app secrets／clients；host 负责可序列化数据、敏感信息与 fresh dependency 策略。
- UI 只拿经过授权的展示数据与关联标识；服务端核对身份、实际 pending 请求、授权并原子消费，不接受客户端替换工具参数、审批项或快照。
- 本 wrapper 只负责本地 writer 与 continuation；跨 wrapper／进程互斥、快照消费、未知副作用核对属于 host。

取消也不必永远销毁 SDK 状态：官方支持从 cancelled stream 的 RunState 继续未完成轮次。该路径与 approvals 共用原生 continuation：通过当前 pendingRun 继续，或显式新 turn 放弃取消 continuation；不得默认重跑未知工具副作用。

## 8. Pi／Claude 保留不同的原生形状

| Harness | 原生装配 | 人在回路的真实 lifecycle | 收尾 |
| --- | --- | --- | --- |
| Pi | `createAgentSession`、ToolDefinition、ResourceLoader、extensions、MCP／tool-search 原生扩展 | `tool_call` hook 与 ExtensionUIContext／RPC UI 通常等待一个活 callback；没有已确认的通用持久审批 continuation | abort 后使用 runtime shutdown／dispose；session.dispose 单独不保证 extension shutdown |
| Claude | `query`、Options、SDK MCP server、hooks、权限、原生 Query controls | `canUseTool` 是活等待；PreToolUse defer 是另一个可返回并按原 session 恢复的流程 | Query interrupt 与 close 分开，host 保有业务资源 |

**活等待不是已返回的 paused outcome。** Pi 或 Claude pending callback 保持执行 owner 与结果 Promise 活跃，可提供 waiting observation；不伪造一个可重启恢复的状态。

Claude defer 当前只支持单个工具调用；parallel 情况会忽略 defer 并继续权限流程，不能把所有审批等待都映射成 durable paused。恢复还要重新装配 MCP／hooks／权限和持久 transcript。

### 自然能力簇

- Pi：native tools／选择／exposure、extensions／hooks、MCP、search／codemode、skills／context loader、steer／followUp、SessionManager／runtime lifecycle 一起设计；不要重写 permission gate 或工具发现。
- Claude：SDK MCP、streaming input／output、权限／hooks／用户输入、Query controls、search hints／skills、session resume 与 close 一起设计；不围绕已移除的旧 SDKSession API 建壳。
- Pi 的 cwd 与扩展、Claude 的 MCP instance／Query 都有会话作用域；不能机械照抄一个全局 tools 数组。

权限默认不能被“便捷接入”抹掉：Claude 的 allowedTools 是预批准而非完整可见性白名单，canUseTool 也不检查所有调用；强制每次调用的检查放原生 PreToolUse／业务执行边界。显式权限模式，不默认 bypass、不自动持久化建议规则；settingSources 不是完整隔离。Pi 同样由 host 的原生 hook／UI 回调执行授权，cwd 不是 sandbox。

## 9. 公共合同与模块组织

共享执行保留 provider／session／run、有序输入、结果／观察和中断。SDK 特有装配不塞进一个 native tool 判别联合或万能 context。

没有实际消费者的 MCP-shaped HarnessTool、MCP／Skills 公共选项及 capability map 已删除，不保留只有拒绝实现的接口。provider 只公开实际 history resumable 声明；工具与相邻能力直接装配到官方对象。未来只有出现真实跨 SDK 消费者时才讨论有限共享合同，不先造转换框架。

SDK-specific 入口使用 package exports；它是标准公开路径声明，不是工具加载机制。实现直接指向有真实职责的模块，不为目录对称补 barrel、Pi／Claude 空导出或 tools.ts。

OpenAI 公开类型与 provider 入口在 `adapter.ts`；`session.ts` 以普通闭包状态拥有单 writer、SDK settlement、native continuation 与 cancel／dispose；`request.ts` 映射公共有序内容为 native run input；`projection.ts` 投影 native items／text stream 为公共 messages／AG-UI。没有 OpenAI `contract.ts` 或工具控制框架。

最终测试与源码相邻：`adapter.test.ts`、`adapter.test-d.ts`、`session.test.ts`（含原生工具与审批集成）、`request.test.ts`、`projection.test.ts`。不另设 OpenAI `tests/` 目录，不保留孤立 approvals／config／tools 测试或为此补 `tools.ts`。

## 10. 实施与验收

1. 先替换为单一原生 binding，保留已有文字／文件顺序、SDK history、writer、观察／取消回归；移除重复装配与阶段工具白名单。
2. 接通 official HITL 的成功暂停、批准、拒绝、部分决定、再次暂停、嵌套审批、追加输入、取消 continuation、并发／陈旧请求和失败收尾。
3. 验证 native tools／MCP／search／handoffs／schemas／guardrails 与资源 ownership 的自然闭环；使用真实 SDK 和离线 HTTP／transport fixture，不 mock 整个 loop。
4. 明确测试原生 snapshot round-trip 与 fresh context；host durable storage／跨进程恢复、真实 MCP、sandbox 隔离和模型服务支持分别标注，不用离线绿灯代替。
5. 更新真实 public types／导出／使用文档；完整 check、E2E、LSP 与独立 review 后再请求提交确认。

此文保留原生能力与后续实施目标，不宣称整个自然能力簇、Claude adapter 或生产全恢复已经实现；Pi 当前只验收包级文本切片。OpenAI 当前实现与最终相邻测试结构见接入文档；完整 check、E2E、类型检查与独立 review 的实际结果由实施报告记录，此处不预填测试数量或通过结论。

旧 native hosted-tool wire／client-search 离线实验不算外部服务 acceptance。用户授权后的新版 live 已验证本地真实 MCP、原生 server tool search／deferred function、HITL 与 native fresh-context 恢复等，证据见完整审查；没有 SDK 升级。WAV／MP4 通用文件被网关拒绝，原生 Responses compaction HTTP 502，未用替代框架改绿。sandbox、host durable storage 与跨进程故障恢复仍需对应服务验收。临时 live 脚本／fixture 不进入正式源码。

## 官方依据

- OpenAI：[HITL](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)、[Tools](https://openai.github.io/openai-agents-js/guides/tools/)、[Running agents](https://openai.github.io/openai-agents-js/guides/running-agents/)、[Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)、[Results](https://openai.github.io/openai-agents-js/guides/results/)、[MCP](https://openai.github.io/openai-agents-js/guides/mcp/)、[Sandbox concepts](https://openai.github.io/openai-agents-js/guides/sandbox-agents/concepts/)。主要接入证据同时固定到 [v0.20.0](https://github.com/openai/openai-agents-js/tree/33e2741be9bb52c1d96a8b4dac0c68e46297b607/docs/src/content/docs/guides)。
- Pi：[发布版 SDK](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/sdk.md)、[Extensions](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/extensions.md)、[MCP](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/mcp.md)。
- Claude：[TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)、[Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)、[Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)、[User input](https://code.claude.com/docs/en/agent-sdk/user-input)、[Tool search](https://code.claude.com/docs/en/agent-sdk/tool-search)、[Hooks defer](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)、[Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)。滚动正文与安装版类型分开核对。
