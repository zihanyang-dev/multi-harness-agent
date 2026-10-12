# Harness 控制职责：interrupt、steer 与 resume

> 本轮是补充核对，不修改公共合同。`strre` 暂按 `steer` 理解。后续[产品与 SDK 的 resume 语义调研](harness-resume-semantics.md)已补充：产品会话入口通常表示会话恢复，执行层另有 continuation 语义。具体 API 尚未修改，不能为了补三个名字建立另一套 loop。

## 职责先分清

| 动作 | 单一职责 | 不承担的职责 |
| --- | --- | --- |
| prompt | 在已打开会话中提交新的执行输入 | 不自动继续旧的私有执行状态 |
| interrupt | 请求打断指定执行，并由原生收尾判断实际结果 | 不是 dispose，不保证暂停点，不代表立即停止副作用 |
| steer | 执行中补充方向，由原生 SDK 在支持的交付点消费 | 不是回答问题、不是权限决定，也不是 abort 后重新 prompt |
| restoreSession | 打开兼容的原生历史与存储 | 不默认保证恢复未完成执行 |
| resume（执行含义） | 使用保留的原生 continuation 继续尚未完成的工作 | 不是 prompt("Continue")，不是将 UI transcript 重放到模型 |
| close | 收尾活动工作并释放 handle 资源 | 不删除历史，也不保留仍活动的 writer |

`signal` 已承担当前 invocation 的取消意图。如果增加 interrupt 方法，二者必须汇入同一个取消/收尾路径，不能成为两套控制状态或重复发原生中断。不能把 interrupt 定义成所有 SDK 都支持的无损暂停。

如果 resume 指“重新打开历史会话”，现有 restoreSession 已承担，应选一个名称，而不是增加别名。如果指“继续被打断的执行”，它必须是独立能力，并明确要求实际可用的原生 continuation。

## 核对到的原生差异

### Pi 1.1.0

固定 commit `abe508e1b89912adde45528136c3221eb69acdd7`。

- [AgentSession][1] 的 steer 排入原生输入队列，在当前 assistant 轮的工具调用处理后、下一次模型调用前交付。返回 queued/handled 不证明模型已消费。
- abort 会取消 run/retry/compaction 等工作并等待 idle，不是建立一个通用可恢复暂停点。
- [Agent][2] 的 continue 从原生 transcript 继续，但要求尾消息为 user/tool-result；尾部 assistant 只有待处理队列时才可继续，否则拒绝。
- AgentSession 自己拥有 post-run、compaction/retry、before-settle 生命周期。不能为了增加 resume 绕过 session，仅调用低层 continue 就宣称完整会话恢复成立。
- `/resume` 与 runtime switchSession 是会话历史加载，不是上述运行 continuation 的普遍保证。

### Claude Agent SDK 0.3.295

依据当前安装版及逐字节一致的 `sdk.d.ts` 快照，不声称审计闭源 CLI。

- Query.interrupt 在 streaming input/output 下可用；新版 receipt 可报告 still_queued。中断当前 turn 不意味着所有已排队输入消失，也不能以 receipt 代替执行/控制收尾。
- Query.streamInput 接受原生输入流，SDKUserMessage 有 priority 字段；这些声明不足以证明任意输入都能在当前执行内部按 Pi 的 steering 点消费。
- options.resume 的声明明确是加载指定 session 的历史，属于 restoreSession。
- SDK 声明中的 interrupted-turn 自动恢复机制不能直接当成通用公开 resume 方法，更不能据此自动重试副作用。

声明定位：Query.interrupt 约 `sdk.d.ts:2846–2861`，streamInput 约 `3210–3215`，Options.resume 约 `2086–2088`，SDKUserMessage 约 `6285–6300`。

### OpenAI Agents SDK 0.20.0

[固定版本 streaming 文档][3]明确区分：

- AbortSignal／stream reader cancellation 只是停止意图，仍须等待 completed。
- 继续未完成 turn 应传回原来的 stream.state，而不是追加一个新的用户消息；原生 RunState 留在内部。
- approval interruptions 的继续也使用原生 state，已由权限桥接内部处理，不应要求业务再调用一次公共 resume。问题工具等待自己的回调答案，不把它伪装成原生 approval interruption。
- [RunState.addInput][4] 和[官方说明][5]允许在暂停期间加入输入，在下一次 resumed model call 前由 SDK 接纳；它会拒绝终态、没有剩余模型轮次等不安全状态。
- 没有找到已承诺 active Runner steering 的公开入口。addInput 的源码检查按 state step，不代表任意 active 调用绝对不可能，但文档只承诺 paused/resumed admission。不能将这一点、私有 state 修改、context hook 或 abort + 新 prompt 冒充已验证的 active steering。
- 如果产品接受 interrupt → settle → addInput → 原生 resume，这是原生 continuation 路径，但应明确命名与交付语义，不静默包装成同一种 active steer。

这些是定向源码/声明依据，不是恢复或取消运行验收。

## 增加接口前需要确定的边界

1. interrupt/signal 都必须作用于确切的执行，不能让迟到控制误伤下一个 prompt。裸 session 当前指针不足以表达外部旧请求的目标。
2. 正常完成可以赢过打断；receipt、ACK 与取消 intent 都不改写已确认结局。
3. steer 是接收/入队，不是模型采纳。必须规定取消或完成竞态下未交付输入的归属，不让它静默落到下一次执行。
4. resume 的可用性取决于保存了什么原生状态，不能只看 stopReason: cancelled。跨进程是否支持又是独立证据问题。
5. 正式结果与展示作用域要明确：继续是否报告本次继续段的结果，不能偷偷改写前一次已经结算的结果。
6. 问题答案、权限允许/拒绝已经沿各自回调进入原生继续路径，不再提供第二个 answer/resume 控制入口。
7. unsupported 是真实能力边界；不能为了接口对称写一条万能“继续”提示词或第四套执行驱动。

## 固定来源

[1]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts
[2]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/agent/src/agent.ts
[3]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/docs/src/content/docs/guides/streaming.mdx
[4]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/runState.ts
[5]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/docs/src/content/docs/guides/human-in-the-loop.mdx
