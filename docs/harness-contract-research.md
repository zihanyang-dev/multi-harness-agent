# Harness 契约调研与设计讨论

> 调研日期：2026-10-12。状态：讨论稿，不是已实现或已定稿的运行合同。
>
> 后续第一版类型草案见 [`packages/harness/src/contract.ts`](../packages/harness/src/contract.ts)，调用示例见 [Harness README](../packages/harness/README.md)。它选择下文候选 B 供评审；尚无 SDK 实现，也不表示本研究中的能力已验证。
>
> 本轮在 `refactor/harness-contract-first` 分支删除旧 `packages/harness/`、`apps/worker/`、`apps/web/`、`apps/server/`，不以旧调用方作为新接口的兼容约束。数据库、协议、评测、测试和部署配置暂时保留，因此仓库目前不是可构建的完整产品。

## 1. 要解决的问题

我们需要一个同时服务生产执行和评测的本地包：

- 使用方只导入 `@multi-harness/harness`，不导入 Pi、Claude 或 OpenAI 的原生 SDK。
- 配置选择实现；SDK 的创建、运行、原生历史、事件消费与收尾留在包内部。
- 三个实现对称地履行同一合同，但不强迫内部拓扑或算法相同。
- 默认采用函数、普通数据和模块；不建立类体系、registry、通用执行器或第四个 agent loop。
- 凭证、工作环境和业务授权由使用方提供；包不自行读取平台数据库或偷偷发现个人配置。

**契约不仅是函数签名：它还规定事实含义、调用顺序、并发、资源所有权和失败后果。**

这里的 ACP 指 **Agent Client Protocol**，不是同名的 Agent Communication Protocol。

## 2. 调研依据与版本边界

官方文档网页直接抓取受本机 TUN/fake-IP 的 SSRF 检查阻挡。默认搜索超时后，使用 OpenAI 搜索定位资料，再通过正常 Git HTTPS 获取官方仓库，固定下列 revision 阅读。未修改网络安全配置。

| 资料 | 固定 revision | 阅读重点 |
| --- | --- | --- |
| ACP 协议 | `b0b0be076fb89b41cb05d9ec9a7875ee1a98d654` | README；v1 初始化、会话设置、prompt、取消、工具、内容；v2 生命周期的定向比较 |
| ACP TypeScript SDK | `afa002b0a08a961db39b0d739cfe280779e1e328` | 1.8.0 manifest；`acp.ts` 的连接合同与 `Agent` / `Client` 接口段落 |
| MCP | `1f520964b295d58494d944f2aea8a5ab51c79f77` | README；2026-07-28 规范入口、架构、取消；工具规范的定向段落 |
| AG-UI | `2aabfc8cada0b429927e4c256c9cf990a6791e5f` | 1.0 规范入口、run input、processing、lifecycle、tool calls；interrupt 概念文档的定向段落 |
| A2A | `12e9d2fbb9badfe98f8ab4f660697870eeb1940b` | task 生命周期、streaming/async、与 MCP 的分工；服务 protobuf 的前 100 行 |
| Vercel AI SDK | `ba05943b69ad070558bb5bc912da99ec66d7d263` | 7.0.137；完整 `agent.ts` 与 `create-agent-ui-stream.ts` |

不是六仓全文审计，也没有安装、运行这些项目或执行互操作测试。

额外定向读取本机固定发布包声明：Pi 1.1.0 的 `subscribe`、`prompt`、`abort`、`dispose`；OpenAI Agents 0.20.0 的 Session 与 RunConfig 段落；Claude Agent SDK 0.3.295 的 Query 控制段落。声明可以证明签名及其文档约定，不能替代实现和运行验证。Context7 查询因月度额度耗尽未取得结果。

特别注意：

- ACP 官方 README 明确当前稳定 wire protocol 是 **1**；v2 虽然已有文档路径和生成 schema，TypeScript SDK 仍通过 `./experimental/v2` 导出。不能把 v2 当作当前稳定承诺。参见 [1]、[2]。
- 协议版本、SDK 包版本和 schema 工件版本不是同一件事。
- MCP 此 revision 的规范入口指向 **2026-07-28**，已采用自包含请求与每请求能力声明；不能混用旧版 `initialize` 生命周期，也不能推断三个现有 SDK 已支持此版 MCP。[3]
- AG-UI 的规范/schema 是权威来源，概念页是辅助说明；例如 lifecycle 规范已包括 cancelled outcome，interrupt 概念页的局部联合示例不能作为完整终态枚举。[4]

## 3. 这些协议分别解决什么

| 方案 | 实际边界 | 可以借鉴 | 不宜直接搬进本地合同 |
| --- | --- | --- | --- |
| ACP | 客户端 ↔ agent | 会话、prompt、能力、反向权限请求、明确停止原因 | JSON-RPC envelope、初始化握手、IDE 文件/终端全套 RPC |
| MCP | agent/host ↔ 工具与资源 | 工具描述与执行分离、schema、最小授权、工具错误 | 把一次工具请求当成完整 agent session |
| AG-UI | agent ↔ 用户交互应用 | 消息/工具身份、增量与替换、展示生命周期 | 全量 UI transcript 作为原生恢复证书、所有事件默认公开 |
| A2A | 独立 agent 服务 ↔ 调用方/另一 agent | 上下文与工作单元分离、终态不可重启、观察与任务管理分开 | 持久 Task 服务、agent card、webhook、远程调度放入本地 SDK 包 |
| AI SDK Agent | 库内消费方 ↔ 可替换 agent | 以消费者动作定义 interface、UI 转换另设边界 | 接管三套 SDK 的工具循环、照搬复杂泛型或自建通用 ModelMessage 历史 |

我们首先在设计**进程内库的能力合同**，不是另外发明一个网络协议。未来可以在包外做 ACP、AG-UI 或 A2A binding。

## 4. ACP 最值得借鉴的内容

### 4.1 小的控制面，明确的反向能力

ACP v1 的基本使用顺序是：初始化 → 创建/打开会话 → prompt → updates → prompt response。

它不要求客户端创建 agent 的内部模型对象。客户端提供工作环境和交互能力，agent 内部负责执行。SDK 的 `Agent` 与 `Client` 两个接口进一步展示了这个方向：

- 使用方调用会话与执行动作。
- agent 向使用方请求权限，或发送更新。
- 权限请求有响应；更新是通知。二者不是同一种 callback。[5]

对应我们的设计：**公开观察 callback 失败不能决定执行结果；权限决策 callback 失败则不能被当成批准。**

不需要为借鉴这个分工而把完整 ACP Client、连接对象和 RPC router 塞进 `contract.ts`。

### 4.2 Session、一次 prompt、展示消息不是同一个东西

ACP session 持有上下文；一次 prompt 可以经过多个模型调用与工具调用。message ID 标识展示消息，并不等于 session ID。

我们的业务 Thread、一次执行、原生历史身份同样不应混成一个 `id`，但也不必把平台的 Thread/Turn/Attempt 数据模型全部带入 harness。公开的 session ID 应是不透明身份，不能被当作授权。

### 4.3 恢复执行与回放展示历史分开

ACP v1：

- `session/load`：恢复上下文，回放展示历史，回放完成后返回。
- `session/resume`：恢复上下文，不回放展示历史。
- `session/close`：取消当前工作并释放活动资源，不等于删除持久历史。[6]

因此，不建议一个含糊的 `resume()` 同时表示打开原生历史、读历史、审批继续和故障恢复。

我们可以用更适合本地库的名字，例如 `restoreSession` 与单独的历史读取能力。是否需要回放，应由真实消费者决定，不先创造万能 checkpoint。

### 4.4 终止原因比一个 success boolean 更准确

ACP v1 `stopReason` 包括 `end_turn`、`max_tokens`、`max_turn_requests`、`refusal`、`cancelled`。[7]

这些结果不能全部写成“完成了用户任务”。一个 agent 正常停止、不再调用工具，不代表业务目标成功。我们的结果应该说出执行事实，不替评测或产品判断业务成功。

### 4.5 取消意图与结束证据分开

ACP `session/cancel` 是通知；确认来自原 prompt 的结束响应。取消后仍可有最后的更新，并且待处理权限请求也需要结束。[7]

可借鉴：

- 请求停止不等于已经停止。
- 确认完成前不能释放本次执行的所有权。
- 正常完成与取消可能竞争；晚到的取消不能改写既成结果。
- 关闭要明确等待哪些执行与控制动作。

ACP 建议客户端提前把未完成工具标为 cancelled，这是展示策略，不是物理工具已经停止的证据。我们不能用它释放 writer。

### 4.6 v1 与 v2 展示了两种不同的完成模型

稳定 v1：`prompt` response 表示本轮停止。

实验 v2：`prompt` response 表示用户消息已插入会话；后续 foreground work 由 `state_update` 表示，idle/stopReason 另行报告。v2 明确接受不保证持久化或模型已经消费，响应丢失后的重试可能产生重复输入。[8]

这说明 `Promise` 返回的含义必须先确定：是“收到”“接受”“开始”还是“停止”？不能靠同一个方法名隐藏改变。

我们当前偏向本地合同的一次执行 Promise 表示执行结束，而不是照搬 v2 的接受通知模型。将来的业务持久接受应由包外控制面负责。

## 5. 其他设计对我们的约束

### 5.1 MCP：工具接口不是 agent 接口

MCP 明确区分 host、client、server；host 负责授权，server 暴露专注的工具与资源。[3]

借鉴：

- 原生 SDK 工具、自定义工具、MCP 接入配置要区分，不默认替换成同一套平台工具。
- 通用工具注册使用普通 schema 和输入/输出，不要求调用方使用 SDK tool builder。
- 工具描述、readonly 等 annotation 不是授权。
- 工具执行失败可以作为工具结果反馈给模型；协议/配置错误与 agent 执行失败另行分类。

同时不能机械借用取消语义：此版 MCP Streamable HTTP 将关闭请求 SSE 视为该**工具请求**的取消信号。[9] 我们的 agent 公开观察流断开不能据此取消整个执行。不同边界可以采用不同规则。

### 5.2 AG-UI：借展示语义，不把展示协议当执行内核

AG-UI `TOOL_CALL_END` 表示参数生成结束，不表示工具执行成功；结果另由 `TOOL_CALL_RESULT` 表示。[10]

它也明确区分 producer 报告 cancelled 与 consumer 放弃读取造成的 truncated stream。[11]

适合借鉴的内容：

- 以明确 ID 关联消息、工具和子活动。
- append 与 replacement 含义不同，重试后的半段文字不能永久拼接成正式结果。
- 未收到结束证据时，观察方不能补造成功或取消。
- 原生 tool proposal、执行开始、执行结果有不同含义。

不直接采用整份 `RunAgentInput`：它要求完整展示 history，并规定不支持的内容 part 可以被丢弃后继续。[12] 对我们的 execution admission，这可能改变用户请求；建议不支持的输入在执行前明确拒绝，而不是静默删掉。

公开活动的安全边界也应是我们的明确白名单，不默认暴露协议允许的 raw、thinking、完整 arguments 或任意 metadata。

### 5.3 A2A：上下文可以延续，终态工作不能原地复活

A2A 的 context 可以关联多个 task；task 到达终态后，后续修订创建新 task，不重启原 task。独立状态查询、取消、订阅是不同服务动作。参见 [13]、[14]。

借鉴身份与终态原则即可。不因此在 harness 包里加入数据库、持久任务管理、SSE 服务或 webhook。远程协作协议也不等于原生跨 SDK checkpoint 格式。

### 5.4 AI SDK：小的能力接口与展示转换可以分开

AI SDK 的 Agent interface 用 `generate` / `stream` 描述消费动作，允许不同实现履行接口；UI stream helper 在另一边界做输入校验与转换。参见 [15]、[16]。

它并不证明我们也该有 generate/stream 两个独立执行入口。对持有原生会话的三套 SDK，一个执行入口加可选观察可能更简单。可以学习“消费者合同与实现分离”，不采用它的 ToolLoopAgent 去替换原生 loop。

## 6. 本地合同的两个候选

### 候选 A：返回 Run 能力对象

```text
session.run(input) → { result, events, cancel }
```

优点：结果和异步事件流独立，适合由调用方分别监督。

代价：需要规定事件流何时开始、是否必须消费、消费者退出、背压、缓冲溢出、Run 生命周期。旧实现已经在这里累积了不少机制，不能仅换名字保留下来。

这是有效设计，但不能因为旧接口如此就当成默认答案。

### 候选 B：一次执行 Promise + 可选观察

```text
session.prompt(input, { signal, onUpdate }) → Promise<PromptResult>
```

优点：一次执行只有一个完成出口；评测可以不订阅更新；取消通过原生可接受的控制意图接入；包不用对外拥有另一条通用活动队列。

代价：必须明确观察 callback 的时序、错误隔离与背压规则。不能接受一个永远等待的 observer Promise，也不能因少写队列而阻塞原生 reader。

**目前倾向候选 B，但不在研究阶段定稿。** 如果真实消费者必须从包获取可背压的 Stream，而不是自行运输观察事实，候选 A 会更合适。两者都要维持结果不依赖展示成功、原生 reader 有明确 owner。

这里的 `signal` 只表示取消请求；Promise 的实际结果仍决定是否真的取消。Session 的完整资源释放仍由 `close` 确认。

## 7. 第一份 contract 应围绕哪些概念

讨论形状，不是可编译实现；下面尚未展开的类型需要下一轮逐项设计。

```typescript
export interface Harness {
  readonly capabilities: HarnessCapabilities;
  newSession: (options: SessionOptions) => Promise<HarnessSession>;
  restoreSession: (options: RestoreSessionOptions) => Promise<HarnessSession>;
}

export interface HarnessSession {
  readonly id: string;
  prompt: (input: PromptInput, options?: PromptOptions) => Promise<PromptResult>;
  close: () => Promise<void>;
}
```

公共入口另提供 `createHarness(config)`。这是调用方式，不要求实现使用 class。

建议的阅读顺序：少量身份与配置 → Harness/Session 动作 → Input/Result → 必要的 Update/Permission 数据。

### 准入原则

1. 每个字段/方法有具体消费者，不复制所有 SDK 配置。
2. 配置为明确分支，不构造几十个 optional 字段的万能袋子；分支可以知道选择了哪个 harness，但不能携带 SDK 对象。
3. 使用方提供凭证与授权环境，harness 内部完成原生装配；没有 `openNative`、原生 `Agent`、`Query`、`RunState` 逃生口。
4. 内容保留顺序与 exact text；不能用 MIME 名或模型名假定所有能力。
5. 能力声明反映当前配置、模型与存储条件，不只反映包名；未知不等于支持。
6. `restoreSession` 不存在时明确拒绝，不能创建空历史作为成功；关闭不删除历史。
7. 同一可写 session 的并发拒绝或排队必须明确。初版倾向明确拒绝，steer/并行分支以后独立准入。
8. 结果来自原生正式事实，不通过观察 delta 猜测终态。只报告有证据的停止原因、用量和输出。
9. 观察与控制分开。公开 update 可丢/可失败的范围、权限请求失败的后果分别定义。
10. 资源所有者与收尾顺序必须写进 JSDoc；关闭是幂等还是重入、失败后还能否使用需要测试。
11. 保留 SDK loop/history/compaction；相同接口不意味着相同实现。OpenAI 的 Session 是历史存储接口，而 Claude Query 是非序列化的 reader/control 对象，不能把同名概念当成同一对象。
12. 不把框架内部 optional 字段、raw graph、供应商错误正文和 personal config discovery 暴露为默认公共 API。

### 暂不塞进核心接口

Thread/Turn/Attempt、队列、数据库、Redis/SSE、产品 artifact 存储、HTTP auth、租户授权查询、万能 checkpoint、跨 harness history import、agent registry、通用 projector/writer framework。

原生审批后继续与打开持久历史必须区别设计。不能为对称声明一个 universal `paused` 状态后，让使用方拿 SDK state 自己恢复。是否采用 host 权限 callback、是否需要有界 continuation 能力，下一轮必须对三套固定 SDK 分别核验。

## 8. 写 contract 前需要对齐的三个决定

1. **调用方式：**默认一次 Promise + 可选观察，还是显式 Run/Stream 对象？
2. **初版能力：**新会话、同 harness 原生历史恢复、执行、取消、关闭为核心；工具、权限与多模态逐项确定保证，不为接口整齐全部禁用。
3. **输出边界：**harness 提供安全的中立活动，未来再映射到 ACP/AG-UI；还是直接承诺某一协议的严格子集？前者更少 UI 耦合，但自定义格式的每个语义必须证明有实际必要，不能又造一套大事件体系。

这三个决定应先在真实外部使用示例里评审，再落实 `contract.ts` 和公共契约测试。

## 9. 后续契约测试应证明什么

- 外部只导入公共入口，创建、运行、恢复、关闭均无原生 SDK 类型。
- 评测不消费观察，也能等待正确结果。
- 取消与完成竞争不会改写已结束结果，早取消不漏到下一次执行。
- observer 抛错/退出不取消或重试 native；权限处理失败不被当作批准。
- 同 session 不能出现意外双 writer；原生历史缺失不能静默新建。
- 关闭等待活动执行和控制收尾；收尾失败不得宣称安全停止。
- 不支持的内容/能力在副作用前拒绝，输入顺序和空白保持。
- 输出不包含 raw thinking、完整私有 SDK graph 或凭证；正式输出不由拼接 delta 得出。

以上是验收计划，尚未执行，也不是三套 SDK 已可互换的证明。

## 参考

以下均为本次实际读取的固定 revision；部分大型源码/规范只读上文声明的段落。

[1]: https://github.com/agentclientprotocol/agent-client-protocol/blob/b0b0be076fb89b41cb05d9ec9a7875ee1a98d654/README.md
[2]: https://github.com/agentclientprotocol/typescript-sdk/blob/afa002b0a08a961db39b0d739cfe280779e1e328/package.json
[3]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/1f520964b295d58494d944f2aea8a5ab51c79f77/docs/specification/2026-07-28/architecture/index.mdx
[4]: https://github.com/ag-ui-protocol/ag-ui/blob/2aabfc8cada0b429927e4c256c9cf990a6791e5f/docs/spec/1.0/index.mdx
[5]: https://github.com/agentclientprotocol/typescript-sdk/blob/afa002b0a08a961db39b0d739cfe280779e1e328/src/acp.ts#L3745-L4184
[6]: https://github.com/agentclientprotocol/agent-client-protocol/blob/b0b0be076fb89b41cb05d9ec9a7875ee1a98d654/docs/protocol/v1/session-setup.mdx
[7]: https://github.com/agentclientprotocol/agent-client-protocol/blob/b0b0be076fb89b41cb05d9ec9a7875ee1a98d654/docs/protocol/v1/prompt-turn.mdx#L451-L587
[8]: https://github.com/agentclientprotocol/agent-client-protocol/blob/b0b0be076fb89b41cb05d9ec9a7875ee1a98d654/docs/protocol/v2/prompt-lifecycle.mdx#L153-L201
[9]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/1f520964b295d58494d944f2aea8a5ab51c79f77/docs/specification/2026-07-28/basic/patterns/cancellation.mdx
[10]: https://github.com/ag-ui-protocol/ag-ui/blob/2aabfc8cada0b429927e4c256c9cf990a6791e5f/docs/spec/1.0/events/tool-calls.mdx
[11]: https://github.com/ag-ui-protocol/ag-ui/blob/2aabfc8cada0b429927e4c256c9cf990a6791e5f/docs/spec/1.0/events/lifecycle.mdx
[12]: https://github.com/ag-ui-protocol/ag-ui/blob/2aabfc8cada0b429927e4c256c9cf990a6791e5f/docs/spec/1.0/basic/run-input.mdx
[13]: https://github.com/a2aproject/A2A/blob/12e9d2fbb9badfe98f8ab4f660697870eeb1940b/docs/topics/life-of-a-task.md
[14]: https://github.com/a2aproject/A2A/blob/12e9d2fbb9badfe98f8ab4f660697870eeb1940b/specification/a2a.proto#L19-L82
[15]: https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/ai/src/agent/agent.ts
[16]: https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/ai/src/agent/create-agent-ui-stream.ts
