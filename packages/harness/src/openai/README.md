# OpenAI 接入

官方 Agents SDK 已由本包声明依赖，当前尚无可用 provider/session adapter。不将产品消息当作完整 RunState。

## 文本输出转换

`output.ts` 提供两个普通函数：`toMessages` 转换完整 assistant 文本，`createRunEvents` 转换 SDK 文本增量和完整消息通知。后者只观察调用方提供的运行结果，不运行模型、不拥有 native session。

- 调用方提供不取消原生执行的 iterator，例如 `stream.toStream().values({ preventCancel: true })`。
- 流结束不等于执行收尾完成；终态等待调用方的 `result`。观察失败发布不带上游诊断的 `RUN_ERROR`，原始结果 Promise 保留失败语义。
- 观察开始时即监听结果拒绝，避免慢读取或取消订阅后留下未处理的拒绝。未开始消费事件时，执行 owner 仍须独立观察自己的结果 Promise。
- 当前只转换文本，不包含工具结果、媒体输出或公开推理摘要；不据此声明 adapter 已支持这些能力。

相邻的 `output.test.ts` 使用真实 Runner 和显式 OpenAI client，本地 HTTP fixture 生成 Responses SSE；不访问模型服务、不使用云凭据。可暂停的响应体用于证明取消订阅时原生运行仍未完成。独立子进程用于验证取消订阅后的结果拒绝不会终止进程。测试不是模型质量或生产恢复验收。
