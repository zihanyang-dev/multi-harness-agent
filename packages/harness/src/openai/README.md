# OpenAI 原生接入

当前实现使用 `@openai/agents` 0.20.0。它是可被可信 host 调用的包级 adapter，尚未连接产品 Turn API、Web 或 Worker；不是已验收的生产 Agent 服务。

SDK 保留原生执行与资源生命周期。wrapper 不承诺接管 SDK 的全资源销毁，不修改 SDK；观察直接映射 native iterator，不另建事件队列。审查归因更正与验证范围见 [完整审查](../../../../docs/openai-review.md)。

## 唯一装配入口

从 `@multi-harness/harness` 或 `@multi-harness/harness/openai` 导入 `createOpenAIHarness`：

```ts
createOpenAIHarness({ resumable, open });
```

host 的 `open(options)` 返回 `OpenAISessionConfig`。不另设 client／model shorthand 或配置 precedence：

| 字段 | 责任 |
| --- | --- |
| `agent` | 官方根 Agent；完整保留模型、工具、MCP、handoffs、schema、guardrails 与 hooks |
| `runner` | 官方 Runner；host 显式选择 provider、tracing 与执行配置 |
| `session` | 官方历史后端；其 ID 必须非空，重开时必须保持请求的 ID |
| `context` | 可选的 SDK local context／RunContext；不能捕获全局 currentTenant／currentWorkspace |
| `runOptions` | 官方 StreamRunOptions 扣除 wrapper 拥有的字段；不镜像 SDK 参数 |
| `runState` | host 已授权、绑定版本／graph／history 的原生状态；用于创建初始 pending receipt |
| `dispose` | 仅释放显式转交给此 binding 的资源；借用 client／Runner／history 不自动关闭或清空 |

公开 runOptions 排除 `stream`、`session`、`signal`、`context`、`conversationId` 和 `previousResponseId`。实际调用总是最后提供前三项，不为它们另加重复拒绝；后三项会改变 context／history authority，仍在读取可能 lazy allocate 的 session ID 前拒绝。

factory 返回前的部分创建失败由 host 清理；返回后校验失败，wrapper 执行显式 cleanup。打开与 cleanup 同时失败时保留两个错误。disposal 幂等：等待 wrapper 的 SDK 结果，然后 await 显式 host cleanup。cleanup 自己按所拥有资源的生命周期收尾，不把 stream 完成当作任意资源已销毁的证书。

`resumable` 只声明 host 验证过 history 按 ID 重开，不是审批恢复总开关，也不代表进程／节点故障恢复。`cwd` 不自动改变 SDK 工作目录，不是 sandbox。session ID 不是授权凭据。

## 执行与原生审批

- `session.run(input)` 返回 `{ events, result, interrupt }`。输入验证同步完成后预留本地 writer，官方 Runner 自己执行 loop；不依赖事件消费者启动执行。
- `result` 成功返回 `{ status, messages, native }`；状态为 `completed`／`cancelled`／`paused`。SDK／持久化错误保留原异常并拒绝结果，不自动重试或折叠成成功暂停。
- `native` 是官方非 streaming RunResult，保留具体 context 与 output schema。getter 读取活状态；它不是 immutable snapshot。原生结果、错误与状态只应留在可信服务端。
- `pendingRun` 是当前 continuation receipt。`resume({ result, input?, updateState? })` 只接受该结果对象；旧 receipt、其他 session 的 receipt 或失败后的重用会拒绝。
- `updateState` 必须同步并返回 undefined。host 先完成授权、审批与 IO，然后在 writer gate 内调用 SDK 的 `state.approve`／`state.reject`。不建立另一套 decisions／权限引擎。
- 可追加输入，使用 SDK `RunState.addInput`；这是 staging，不保证已批准工具的副作用等待追加输入 guardrail 通过。
- updater 部分修改后抛错或返回 Promise，不能安全回滚；该 owner fail-closed。host 必须先核对历史与业务副作用，不能直接重用旧 receipt。
- handoff 与 nested agent tool 的继续执行仍使用原 root／Runner／Session 和精确 RunState，不换成 lastAgent，不从展示消息重建新 turn。
- SDK 正常识别的取消保留 continuation，可显式 resume，也可用新 turn 放弃它。受控 Model 直接抛 APIUserAbortError 的离线失败不能代替 HTTP 结论；新版网关 live 对照中原生 SDK 与 wrapper 均 cancelled，且 continuation 成功。仍不把任意异常吞成取消。

同一 wrapper 只允许一个 writer；跨 wrapper／进程互斥、授权、防重放、业务幂等、预算与受信快照存储由 host 负责。不要在 gate 外并发修改原生 RunState 或调用相同 binding 的 Runner。

RunState 与 history 不同。host 使用官方 `toString`／`fromStringWithContext` 等恢复入口重供依赖与 context，SDK 序列化可能包含 app context、approvals、usage。不要把凭据／活 client 塞进可公开快照，也不要以公开 messages／AG-UI 作为恢复 authority。

## 公共观察

wrapper 通过唯一 native iterator 直接生成公开事件，不额外 pump／enqueue。native reader 只在观察时获取，并使用 `preventCancel: true`。关闭观察者不取消执行；`interrupt` 请求取消并等待 wrapper writer 释放，不等于回滚业务效果。

投影只暴露 assistant 文本与运行事件，不默认公开工具参数、审批载荷、reasoning、provider metadata 或私有错误。原生 items 在恢复后累计，公共消息按先前 native message ID 去重。文本没有稳定 native ID 时保留在 `native`，不生成假 ID，也不使已成功的执行失败。

source EOF 不是 SDK 结果。投影等待结果后发布终态；观察失败不改变执行，私有异常只留在 result，公开事件给出脱敏错误。没有 wrapper 事件缓存或持久回放；SDK 自身 buffering 与长任务负载仍需实际验收。

## 原生文件输入

`HarnessTurnInput.content` 有序包含 text／file。文件由 host 授权准备，`source` 是 URL 或 Uint8Array，带裸 `mimeType` 和可选 `filename`。filename 原样传递，不增加 SDK schema 没有的非空规则。

- PNG、JPEG、WebP、GIF 映射为官方 input_image，其他有效 MIME 映射为 input_file。
- 非 data URL 保留引用，不添加协议白名单、不读取 file URL 或把它当上传；host 授权来源，SDK／供应商决定接受性。bytes 编码为 MIME data URL，data URL 保留已有百分号转义并转义片段分隔符。
- 在异步执行前快照 URL 与可见字节 view，不下载、转写、拆帧、上传或推断 filename／MIME。
- 原生图片内容没有 filename 字段；原生远端 file URL 没有 MIME 覆盖字段。host 保留业务元数据。
- 文件映射不是供应商接受或模型理解证明。音频／视频仍是通用文件引用，不能宣称原生 AV 理解。

工具、MCP、skills 直接由 host 使用原生 SDK 装配；不保留没有消费者的 portable 配置与假 capability map。provider 的 `resumable` 只描述实际 history 重开策略，不限制原生能力。不创建工具 registry、工具类别白名单、schema 转换框架或媒体 Workflow。

## 验证范围

相邻 `adapter.test.ts`、`session.test.ts`、`request.test.ts`、`projection.test.ts` 使用官方 ScriptedModel 与真实 Agent／Runner／MemorySession／tool，替换模型 IO，不替换 SDK loop。`adapter.test-d.ts` 由 tsc 检查具体 schema／context 与 wrapper-owned 选项。Responses wire 测试使用官方转换器及 client 的本地 HTTP 替身，明确返回 400；不伪造成功模型结果。

```sh
pnpm check
pnpm exec vitest run packages/harness/src/openai
pnpm test:e2e
```

仓库 E2E 仅检查 Web → Hono health，不调用 Agent／模型。新版生产 dist 已另用真实网关／模型完成文本、history、审批、handoff、nested agent、schema、fresh context 恢复、取消与恢复、本地 MCP、原生 tool search 和 PNG／PDF／DOCX／XLSX／CSV 验收。

临时 live 材料留在 /tmp，不加入正式目录或默认测试命令。完整矩阵为 22 passed／1 failed：包含 WAV／MP4 HTTP 400 的错误边界检查，不是 AV 理解成功；官方 Responses compaction 返回 HTTP 502，绕过 harness 直接调用官方 client 也复现。具体证据与未完成范围见完整审查。产品 Turn API、sandbox OS 隔离、生产持久化／跨进程恢复及 Pi／Claude 不据此判通过。
