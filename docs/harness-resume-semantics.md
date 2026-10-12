# resume 语义：产品会话入口与原生执行恢复

> 定向调研；不修改公共合同，不引入新的执行框架。结论依据官方源码、声明和文档，不是运行验收。本文补充并修正[上一轮控制核对](harness-control-review.md)：不能先把 resume 限定为执行继续，再让调用方替我们决定行业语义。

## 结论

在所核对的编码代理产品中，**会话入口的 resume 通常是重新打开或接回已有会话，恢复原生上下文，再继续使用它**。它不普遍承诺重启已停止的模型请求、工具或进程。

但 resume 不是全行业单一语义：在执行层，它也可以表示恢复尚未完成的运行。例如 OpenAI Agents 的 RunState 继续，以及新版 OpenCode 的 execution.resume。必须看恢复对象、调用入口和原生状态，不只看名字。

三个相互独立的动作是：

1. **恢复会话**：选定 native session/thread，打开它的历史、上下文和会话资源。
2. **继续执行**：使用原生 continuation，从未完成的工作继续，而不是提交新的普通 prompt。
3. **重新接入观察**：接回仍在运行的原生 thread；不是再次启动它。

## 产品语义

| 产品与入口 | resume 的实际对象与效果 | 是否仅凭这个动作重启被打断的执行 |
| --- | --- | --- |
| Pi 1.1.0：`--resume`、`/resume` | 选择已有 session，`SessionManager.open` 打开原生历史；`--continue` 选择最近会话 | 该选择路径不是低层 Agent.continue |
| Claude Code：`--resume`、`--continue` | 恢复指定或最近的 conversation；桌面恢复旧会话也属于这个用户操作 | 不由名称承诺无损执行暂停／恢复；另有受配置控制的 interrupted-turn 恢复 |
| Codex：`codex resume` | 打开旧 thread，可带新的 prompt；App Server 也能接回仍在运行的 thread | 历史恢复与新输入是不同动作；接入 live turn 不等于重启 stopped turn |
| OpenCode v1.19.0：`/resume`、`/continue` | `/sessions` 的别名，打开 Switch session；CLI 会话参数导航到旧会话 | 选择本身不调用执行继续；可显示这个 session 已有的运行活动 |

### Pi：产品 resume 与 SDK continue 不是同一件事

[固定 main.ts][pi-main] 的 `--resume` 路径选择 session 后调用 `SessionManager.open`；`--continue` 调用 `continueRecent`。[官方 SDK 示例][pi-example]也把 open/continueRecent 用作构造 session 的存储选择，并未调用模型。

注意 continueRecent 在找不到旧会话时可新建，这是产品便利行为，不能照搬为 Harness 的精确恢复保证。我们的会话身份必须显式提供，缺失历史应拒绝，不能隐式选择最近会话或静默 fresh。

### Codex：交互恢复、exec 与 SDK 包装

固定官方源码 commit `a9b0815167c27ab13719dd12d13b63e02b70d221`，不声称对应所有发行版。

- `codex resume` 选择旧 thread；可附新 prompt，不能把可选输入与恢复身份混为一体。
- `codex exec resume <id> <prompt>` 是恢复 thread 加输入执行的组合：内部先 thread/resume，再 turn/start。它不是“缺省重做未完成任务”的承诺。
- [thread/resume schema][codex-resume]明确：可以加载保存的 thread，或接回已运行的 thread；[turn/start][codex-start]另有用户输入，且可向 active turn 加输入。
- [Codex TypeScript SDK 的 resumeThread][codex-sdk]只构造带旧 ID 的 Thread handle，后续 run(input) 才执行。**这是 @openai/codex-sdk，不是本项目的 @openai/agents。**
- 上游测试区分接回 live turn 与保留历史 Interrupted 状态；daemon recovery 另有恢复分支。测试仅静态查阅，未执行，不能总结成“Codex 从不自动恢复工作”。

### OpenCode：同一个产品里也有两个层级

v1.19.0，commit `733b2c627e5aec39cb33cc22373bdce33053ef2c`：[TUI 源码][opencode-tui]中的 slashAliases 把 resume/continue 指向 session.list / Switch session；[文档][opencode-doc]也明确 List and switch between sessions。

带输入的非交互 run 可在选择会话后 prompt，这是复合命令，不是选择会话本身自动继续。

另查到 HEAD commit `773d8621d6bcd311067b225d837c917b3e83573e`，package 标记 2.0.27：

- [核心 Session.resume][opencode-execution]调用 execution.resume，这是**执行层动作**。
- [服务启动恢复][opencode-restart]会恢复未释放的 execution claim，是另一个恢复机制，不是 session picker。

因此不能把 v1 产品入口和 v2 执行实现混成一个 API，也不能说这个产品从来没有执行恢复。

## 本项目三套 SDK 的语义

| SDK／原生入口 | 恢复的是什么 | 与当前合同的对应关系 |
| --- | --- | --- |
| Pi `SessionManager.open / continueRecent`，runtime `switchSession` | 原生会话、活动分支及历史上下文 | 会话恢复；current restoreSession 的职责 |
| Pi `Agent.continue()` | 从当前原生 transcript 继续运行，有尾消息／待处理队列限制 | 执行继续，不是产品 /resume；不能绕过 AgentSession 生命周期直接映射 |
| Claude `query({prompt, options:{resume:id}})` | 指定 conversation 的历史，query 另有输入执行职责 | 恢复身份与 prompt 在原生组合入口出现；公共合同仍可分清二者 |
| Claude `options.continue` | 当前目录的最近 conversation；与 resume 互斥 | 产品级自动选择，不应变成隐式 Harness 恢复 |
| OpenAI Agents `Session` | 历史记忆层，为新的 run 提供上下文 | 会话恢复／复用；没有可直接对齐的统一 resumeSession 方法 |
| OpenAI Agents `run(agent, oldRunState, ...)` | 未完成运行的模型轮数、步骤、工具审批等原生执行状态 | 执行继续；不是重新打开 Session，更不是追加一句 Continue |

### Claude 声明依据与例外

核对本机 `@anthropic-ai/claude-agent-sdk` **0.3.295**，sdk.d.ts SHA256 `e4d91d71404ce4ffc918aa590f545c7a67df6a1dfe5de8cd28a05db0a7fe872b`。

- `Options.resume` 约 2086–2088 行：明确 Loads the conversation history from the specified session。
- `Options.continue` 约 1591–1595 行：最近 conversation，并与 resume 互斥。
- `resumeSessionAt` / `forkSession` 控制恢复到历史的哪一点以及是否分叉，不是工具程序计数器。
- `query` 约 3247 行：必须有 string 或 AsyncIterable 输入；resume 选项本身不是独立的“继续冻结运行”控制方法。
- `resume_reason` 约 3633 行明确记录 worker restart 后的自动 interrupted-turn re-run、权限回答或 in-flight tools 的继续。**这些确有原生恢复语义，但不能推广为每次 interrupt 都产生可恢复暂停点。**

Claude 产品文档做了官方域检索，但网页正文抓取被现有 SSRF/fake-IP 边界阻止，未修改安全设置；产品说明不以搜索生成摘要充当源码证明。SDK 结论以实际安装版声明为直接依据；未审计闭源 CLI。

### OpenAI：历史和运行状态明确并存

固定 **Agents JS 0.20.0**，commit `33e2741be9bb52c1d96a8b4dac0c68e46297b607`。

[Sessions 文档][openai-sessions]把 Session 定义成 persistent memory layer；它可以服务新用户输入，也可以服务 interrupted RunState 的继续。两者不是同一种状态。

[Streaming 文档][openai-streaming]明确：取消后先 await completed；若继续未完成 turn，传回 stream.state 而不是追加 fresh user message，并继续使用同一 session。

[RunState][openai-state]可由原生 toString/fromString 保存／恢复，但仍需原始 agent graph 的兼容配置与可信存储，不能从公共 messages 重建。RunState.addInput 是暂停期间的追加输入入口，不据此承诺 active steering。

## 公共合同建议：保留一个会话恢复职责

1. **把产品惯用的 resume 首先放在会话层理解。** 如果采用 `resumeSession`，它应替代当前 `restoreSession`，连同对应类型／能力命名一并保持单一事实；不增加两套同义方法。这是命名建议，本轮尚未执行。
2. `resumeSession` 只打开指定原生会话，不顺带提交新 prompt、不做 latest picker、不自动继续未完成工具。业务可在打开后调用 prompt。
3. 如果以后确实公开“继续未完成执行”，用单独且明确的执行入口，例如 continue；它与会话恢复不是别名。三套 SDK 对称的是责任，不是都要强行提供可恢复 checkpoint。
4. 同一 handle 上的 interrupt/steer、权限回答和问题回答不变成会话恢复。特别是回答回调后，Harness 内部的原生继续不再要求业务调用第二次 continue/resume。
5. 把历史会话接回和仍活动的 writer 接管分开。Codex live-thread rejoin 的产品能力不能替本项目证明跨进程 ownership 或恢复安全。

## 证据范围

检查了官方固定源码、声明、产品文档与上游测试源；没有执行 SDK、模型调用、原生 CLI 或运行恢复测试，没有读取个人凭证／配置。代码及合同未修改。

产品源码查阅由两个只读任务完成；主任务另行取得固定 Codex schemas / resumeThread 与 OpenCode TUI / v2 核心恢复源码核对关键区分。临时研究材料记录于 `/tmp/mha-resume-semantics-path.txt`。

[pi-main]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/main.ts
[pi-example]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/examples/sdk/11-sessions.ts
[codex-resume]: https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts
[codex-start]: https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts
[codex-sdk]: https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/sdk/typescript/src/codex.ts
[opencode-tui]: https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/tui/src/app.tsx
[opencode-doc]: https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/web/src/content/docs/tui.mdx
[opencode-execution]: https://github.com/anomalyco/opencode/blob/773d8621d6bcd311067b225d837c917b3e83573e/packages/core/src/session/session.ts
[opencode-restart]: https://github.com/anomalyco/opencode/blob/773d8621d6bcd311067b225d837c917b3e83573e/packages/server/src/fetch.ts
[openai-sessions]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/docs/src/content/docs/guides/sessions.mdx
[openai-streaming]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/docs/src/content/docs/guides/streaming.mdx
[openai-state]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/runState.ts
