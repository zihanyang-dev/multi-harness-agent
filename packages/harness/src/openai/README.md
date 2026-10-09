# OpenAI 接入

当前提供最小文本会话 adapter，复用 OpenAI Agents SDK 0.20.0 的 Runner、Responses model 和 Conversations session。它不自建 Agent loop，不将产品消息当作完整 RunState。

## 使用

从 `@multi-harness/harness` 导入 `createOpenAIHarness`。可信 host 准备显式 OpenAI client、模型配置和工作环境，不存在默认 provider 或隐式模型调用。

```ts
const provider = createOpenAIHarness({
  client,
  model: 'gpt-4.1',
  instructions: 'Answer clearly and concisely.',
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

示例中的 client、工作环境、发布和保存由 host 提供。SDK tracing 在当前装配中禁用；client 的凭据、请求超时和重试策略仍由 host 设置。调用 `openSession` 创建新会话时会请求远端 Conversations API，不是纯本地操作。

## 输入与能力边界

- 保留有序文本 parts，不把多段文字合成一段。当前文件输入明确拒绝，不能据此宣称媒体已接入。
- `tools`、`mcpServers` 非空或传入 `skills` 时，在访问远端历史前拒绝。空工具／MCP 数组表示未请求这些能力。
- `cwd` 不改变普通 SDK Agent 的进程工作目录，也不授予文件系统权限；当前没有 shell、sandbox 或 Skills 装配。
- 当前能力只有原生历史续轮 `resume`；`steer`、`visibleReasoning`、`customTools`、`mcp`、`skills` 为 false，描述的是本 adapter 的边界，不代表官方 SDK 没有这些能力。
- 输出只含 assistant 文本，不包含工具结果、媒体输出、私有 reasoning 或公开推理摘要。

## 会话与生命周期

`openSession({ cwd, nativeSessionId })` 使用官方 `OpenAIConversationsSession` 按原生 ID 打开历史；不由公开消息重建上下文，也不维护本地会话注册表。

- 不传 ID 时创建新远端历史；显式空或纯空白 ID 拒绝，不静默换成新会话。
- 非空 ID 遵循 SDK 的延迟验证：`openSession` 不检查远端是否存在，首次 `run` 加载历史时才可能失败。打开 wrapper 不等于远端恢复准入成功。
- 续轮是历史恢复，不保证恢复任意中断的执行点；没有 RunState 恢复、自动 compaction 或跨 host 故障恢复承诺。
- 同一 wrapper 的 writer 从 SDK setup 开始占用，直到原生执行和历史持久化完成；跨 wrapper／进程写同一原生 ID 的互斥由 host 负责。
- 不读取或提前关闭事件观察者不会取消原生执行。结果独立运行，失败即使无人消费也被观察；原始 `run.result` 仍拒绝，host 必须处理自己的业务失败。
- `interrupt()` 只请求中断，不证明执行或远端副作用已经停止。实际结果由 `run.result` 给出；旧 turn 的句柄不能中断后来的 turn。
- `dispose()` 不再接受新 turn，请求当前 turn 中断并等待其收尾；幂等，不删除远端 conversation，不关闭借用的 client。dispose 等待结束不代表该 turn 成功，执行失败仍从 `run.result` 获取。

SDK 0.20.0 对 OpenAI client 的部分 `APIUserAbortError` 包装不按 graceful cancellation 处理。adapter 只在本轮 signal 已中断、错误类型明确且 cause 是本轮 abort reason 时归为取消；SDK 交付的其他错误仍保留拒绝。OpenAI client 7.30.1 在 signal 已中断时，可能把并发的 fetch 异常改写为带同一 cause 的 abort wrapper；这时 adapter 无法重建丢失的底层失败信息，也不能承诺独立区分取消与同时发生的传输故障。

当前公开事件的 `threadId` 使用原生 session ID，`runId` 为本轮生成的标识；它们不是业务任务 ID，也不是恢复凭证。

## 文本输出转换

`output.ts` 提供 `toMessages` 与 `createRunEvents` 两个普通函数。后者只观察调用方提供的运行结果，不运行模型、不拥有 native session。

- adapter 提供不取消原生执行的 iterator：`stream.toStream().values({ preventCancel: true })`。
- 流结束不等于执行收尾完成；终态等待调用方的 `result`。观察失败发布不带上游诊断的 `RUN_ERROR`，原始结果 Promise 保留自己的语义。
- 观察开始时即监听结果拒绝，避免慢读取或取消订阅后留下未处理拒绝。未开始消费事件时，执行 owner 仍须独立观察自己的结果 Promise。

## 验证范围

相邻的 `adapter.test.ts`、`output.test.ts` 使用真实 Runner 和显式 OpenAI client，本地 HTTP fixture 模拟 Responses SSE 和 Conversations 历史。可暂停的请求／响应体验证 setup、执行、持久化和收尾顺序；子进程验证无人消费及取消订阅后的失败不形成未处理拒绝。

离线测试覆盖历史按 ID 续轮、顺序文本、无读者运行、同 wrapper 互斥、旧句柄、中断与 dispose、模型／持久化失败和明确拒绝未接入能力。不使用云凭据、不调用模型服务；fixture 不是远端存储服务，结果不是模型质量或生产恢复验收。
