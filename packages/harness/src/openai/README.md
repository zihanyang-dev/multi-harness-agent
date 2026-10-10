# OpenAI 接入

当前提供最小文本会话 adapter，复用 OpenAI Agents SDK 0.20.0 的 Runner、Responses model 和 host 显式提供的官方 SDK `Session`。模型服务与会话后端独立装配；不自建 Agent loop，不将产品消息当作完整 RunState，也不建设通用存储框架。

## 使用

从 `@multi-harness/harness` 导入 `createOpenAIHarness`。可信 host 准备显式 OpenAI client、模型配置、原生会话装配和工作环境，不存在默认 provider、会话后端或隐式模型调用。

```ts
import { createOpenAIHarness } from '@multi-harness/harness';

const provider = createOpenAIHarness({
  client,
  model: 'gpt-4.1',
  instructions: 'Answer clearly and concisely.',
  modelSettings: { store: false },
  sessions: {
    resumable: true,
    open: openNativeSession,
  },
});
const session = await provider.openSession({ cwd: workspacePath });

try {
  const run = await session.run({
    content: [{ type: 'text', text: 'Hello.' }],
  });
  for await (const event of run.events) await publish(event);
  const result = await run.result;
  await saveResult(result);
} finally {
  await session.dispose();
}
```

示例中的 client、`openNativeSession`、工作环境、发布和保存由 host 提供。`openNativeSession` 返回官方 SDK `Session`；示例的 `resumable: true` 要求 host 已验证所选后端能够按 ID 重开历史，不是接口本身提供的持久化保证。SDK tracing 在当前装配中禁用；client 的凭据、请求超时和重试策略仍由 host 设置。

`sessions` 是必填的 OpenAI 专用装配点，原先只传 client／model 的调用需要更新；公共 `HarnessProvider`／session／turn 契约不变。`modelSettings` 直接使用官方 `ModelSettings`，固定参数交给原生 SDK，不混入 session 或 turn。`store: false` 控制模型服务的 Responses 存储，不关闭 SDK Session 历史写入，也不证明任意兼容服务支持该参数。

## 会话装配与存储归属

`OpenAISessions` 只包含 `resumable` 与 `open(nativeSessionId?)`，不重新定义官方 `Session` 的历史 CRUD，也不替业务选择文件、数据库或远端服务：

- 省略 ID 时，host 打开新原生会话；传入 ID 时，打开该后端的已授权历史。返回的 SDK `Session.getSessionId()` 必须给出非空 ID，恢复时必须与请求的 ID 完全一致。
- `resumable` 是 host 对已验证恢复能力的声明，adapter 据此报告 `capabilities.resume` 并拒绝不支持的恢复请求。内存 SDK Session 可以用于测试或明确的进程内使用，但不能因此声明持久恢复。
- host 负责租户／用户授权、原生数据保留策略、连接生命周期、存储事务及跨 wrapper／进程的写入协调。原生 ID 不是授权凭证。
- backend 保留 SDK 原生历史；公开 messages／AG-UI 活动不是恢复输入。此扩展点不提升成跨 harness 的通用 checkpoint。
- 一个 provider 的装配配置保持固定；切换 backend 后，相同 ID 不保证指向同一历史，不自动迁移。打开或读取失败原样上抛，不回退到 Conversations 或内存。

如果选用官方 Conversations 后端，可由 host 显式绑定：

```ts
import { OpenAIConversationsSession } from '@openai/agents';
import type { OpenAISessions } from '@multi-harness/harness';

const conversationsSessions: OpenAISessions = {
  resumable: true,
  open: async (nativeSessionId) =>
    new OpenAIConversationsSession({
      client: historyClient,
      ...(nativeSessionId !== undefined ? { conversationId: nativeSessionId } : {}),
    }),
};
```

将 `conversationsSessions` 传给 provider 的 `sessions`。`historyClient` 必须连接支持 Conversations API 的服务，可以与模型 client 不同；新建 ID 会请求该服务。只有 Responses 兼容能力的网关不需要同时提供 Conversations，可以接入 host 选择的其他 SDK Session 后端。当前 packages 不提供生产持久化实现，也没有默认 MemorySession。

## 输入与能力边界

- 保留有序文本 parts，不把多段文字合成一段。当前文件输入明确拒绝，不能据此宣称媒体已接入。
- `tools`、`mcpServers` 非空或传入 `skills` 时，在调用 host 会话装配前拒绝。空工具／MCP 数组表示未请求这些能力。
- `cwd` 不改变普通 SDK Agent 的进程工作目录，也不授予文件系统权限；当前没有 shell、sandbox 或 Skills 装配。
- `resume` 取决于所选会话装配的已验证能力；`steer`、`visibleReasoning`、`customTools`、`mcp`、`skills` 为 false，描述的是本 adapter 的边界，不代表官方 SDK 没有这些能力。
- 输出只含 assistant 文本，不包含工具结果、媒体输出、私有 reasoning 或公开推理摘要。

## 会话与生命周期

`openSession({ cwd, nativeSessionId })` 校验准入后调用 `sessions.open`，取得 SDK Session 和原生 ID，再装配 Runner；不由公开消息重建上下文，也不维护本地会话注册表。

- 显式空或纯空白请求 ID 在打开后端前拒绝；后端返回空 ID 或恢复时替换 ID 也明确拒绝，不静默换成新会话。
- 历史存在性与读取时机由后端决定。官方 `OpenAIConversationsSession` 对非空 ID 延迟验证，首次 `run` 加载历史时才可能失败；打开 wrapper 不等于远端恢复准入成功。
- 续轮是历史恢复，不保证恢复任意中断的执行点；没有 RunState 恢复、自动 compaction 或跨 host 故障恢复承诺。
- 同一 wrapper 的 writer 从 SDK setup 开始占用，直到原生执行和历史持久化完成；跨 wrapper／进程写同一原生 ID 的互斥由 host 负责。
- 不读取或提前关闭事件观察者不会取消原生执行。结果独立运行，失败即使无人消费也被观察；原始 `run.result` 仍拒绝，host 必须处理自己的业务失败。
- `interrupt()` 只请求中断，不证明执行或远端副作用已经停止。实际结果由 `run.result` 给出；旧 turn 的句柄不能中断后来的 turn。
- `dispose()` 不再接受新 turn，请求当前 turn 中断并等待其收尾；幂等，不清空原生历史，不关闭 host 拥有的模型 client 或存储连接。官方 Session 没有统一 close 契约，host 自行管理后端连接，不假设 wrapper dispose 会释放它。dispose 等待结束不代表该 turn 成功，执行失败仍从 `run.result` 获取。

SDK 0.20.0 对 OpenAI client 的部分 `APIUserAbortError` 包装不按 graceful cancellation 处理。adapter 只在本轮 signal 已中断、错误类型明确且 cause 是本轮 abort reason 时归为取消；SDK 交付的其他错误仍保留拒绝。OpenAI client 7.30.1 在 signal 已中断时，可能把并发的 fetch 异常改写为带同一 cause 的 abort wrapper；这时 adapter 无法重建丢失的底层失败信息，也不能承诺独立区分取消与同时发生的传输故障。

当前公开事件的 `threadId` 使用原生 session ID，`runId` 为本轮生成的标识；它们不是业务任务 ID，也不是恢复凭证。

## 文本输出转换

`output.ts` 提供 `toMessages` 与 `createRunEvents` 两个普通函数。后者只观察调用方提供的运行结果，不运行模型、不拥有 native session。

- adapter 提供不取消原生执行的 iterator：`stream.toStream().values({ preventCancel: true })`。
- 流结束不等于执行收尾完成；终态等待调用方的 `result`。观察失败发布不带上游诊断的 `RUN_ERROR`，原始结果 Promise 保留自己的语义。
- 观察开始时即监听结果拒绝，避免慢读取或取消订阅后留下未处理拒绝。未开始消费事件时，执行 owner 仍须独立观察自己的结果 Promise。

## 验证范围

相邻的 `adapter.test.ts`、`output.test.ts` 使用真实 Runner 和显式 OpenAI client，本地 HTTP fixture 模拟 Responses SSE 和显式选择的 Conversations 历史；官方 MemorySession 仅用于验证 SDK Session 注入与原生续轮，不冒充持久后端。可暂停的请求／响应体验证 setup、执行、历史写入和收尾顺序；子进程验证无人消费及取消订阅后的失败不形成未处理拒绝。

离线测试覆盖模型与历史 client 分离、无 Conversations 的原生续轮、模型参数透传、恢复准入与 ID 保留、打开失败无回退，以及原有顺序文本、无读者运行、同 wrapper 互斥、旧句柄、中断／dispose、模型／历史写入失败和未接入能力拒绝。不使用云凭据、不调用模型服务；fixture 不是远端存储服务，结果不是模型质量或生产恢复验收。

### 真实文本验收

2026-10-10（UTC），通过构建后的 `@multi-harness/harness` 公共 `createOpenAIHarness` 入口，在 `https://sub2api-rd.pexoai.cn/v1` 使用网关模型名 `gpt-6.1-sol` 完成两轮真实文本验收；不是 standalone Responses 探测。会话后端为官方 MemorySession，显式声明 `resumable: false`。SDK tracing 禁用，client 重试为 0；仅两次短文本请求，无文件、工具或 Conversations 调用。

| 检查 | 实测结果 |
| --- | --- |
| 模型请求 | 恰好两次 `POST /v1/responses`，均为 200；两次请求体均包含 `store: false`、`stream: true` |
| 原生与公开流 | 第一轮 1 个、第二轮 12 个原生文本 delta；对应公开内容事件数相同，拼接文字与最终消息一致 |
| 公开生命周期 | 两轮均只有一个 RUN_STARTED 和成功 RUN_FINISHED，无 RUN_ERROR；result 为 completed |
| 原生历史 | 第二次请求的输入角色为 user → assistant → user，包含先前用户 marker 和 assistant 历史 |
| 回忆校验 | 第二轮新问题未重复随机 marker，最终回答仍与 marker 完全一致 |
| dispose | 正常完成，SDK 内存历史保留；之后的新 turn 被拒绝，没有额外模型请求 |

该验收证明当前文本执行、输出投影及同会话原生历史路径在该网关真实可用；不证明服务持续可用、模型质量、服务器实际数据保留策略或生产持久恢复。没有按 ID 重开、跨进程／重启恢复、存储事务／幂等或跨进程 writer 协调验收，不能据此将 `resume` 改为 true。实际持久后端由 host 选择后另行验证。

凭据及原始请求头未写入脚本、日志或仓库；临时验收脚本已清理。上述是一次显式授权的付费 smoke，默认离线测试与 CI 不调用该网关。
