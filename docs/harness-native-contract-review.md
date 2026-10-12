# Harness 契约重审：从原生事实出发

> 日期：2026-10-12。状态：研究与设计建议，未定稿；本轮不修改 `packages/harness/contract.ts`，不实现三套 SDK。
>
> 边界不变：函数、普通数据、唯一公共入口；业务不导入原生 SDK；SDK 保留 loop/history/compaction；不引入 ACP 依赖或运行层。

## 1. 结论

**最自然的统一接口不是三套 SDK 接口的并集，也不是协议 schema 的缩小复刻，而是少量使用方能直接理解、原生事实能支撑的能力。**

保留已确认的计划、工具结果、用户选择、权限决策需求；缩小它们的表达方式，不缩小业务能力：

1. 保留一次 `prompt` Promise、取消 signal、可选同步观察、异步控制与关闭。
2. 工具使用一种关联清楚的更新，终态携带输出；不要同时发两个独立的完成事实。
3. 计划就是有序步骤和进度；优先不加 priority、工作流依赖或隐藏思考内容。
4. 用户交互先是问题和选项，不是通用表单生成引擎。
5. 权限是明确授权策略与独立控制入口，不混入可丢弃的展示事件。
6. 未报告的信息保持未知。不能默认错误标记为 false，不能从消息文本猜成功，不能编造全部过程的成对 start/end。

## 2. 证据和版本

| 实现 | 本轮证据 | 边界 |
| --- | --- | --- |
| Pi 1.1.0 | 官方 tag `v1.1.0`，commit `abe508e1b89912adde45528136c3221eb69acdd7`；安装包声明、运行实现；完整 SDK/extension 文档及相关交叉引用 | 定向源码核对，没有启动 Pi 会话 |
| OpenAI Agents SDK 0.20.0 | 官方 tag `v0.20.0`，commit `33e2741be9bb52c1d96a8b4dac0c68e46297b607`；安装包运行实现；官方 streaming/HITL 示例 | 两个工具调用行为做了本地无网络验证，没有执行 agent/model loop |
| Claude Agent SDK 0.3.295 | 安装包 `sdk.d.ts`、`sdk-tools.d.ts`；后者 SHA256 `749e6f013c480ef06598396334512e14c1659d897b815c057385e8dd84bf3d22` | 声明与输入/输出类型，不宣称审计闭源 CLI 的全部运行逻辑 |
| Claude ACP 适配器 0.89.1 | commit `4e1fc1e8df2b9af3b1b2d6880ba90c5862283ba8` 的 elicitation、权限与计划转换实现 | 它依赖 Claude SDK 0.3.293，与我们的版本不同；只作实现参考，没有安装运行，不引入依赖 |

Pi 旧研究快照的 SDK 文档与 session 源码已和本轮官方 checkout 逐字节比较一致。源码审查由两个只读任务分别覆盖 Pi、OpenAI；Claude 声明与适配器定向正文由主任务核对。

网页搜索本轮超时，结论使用上述固定 Git revision 和本机固定包，不以搜索摘要作权威。Context7 已知月度额度耗尽，没有用它声称完成新的文档核验。

## 3. 工具：调用、开始执行、返回、业务成功是不同事实

### Pi

原生有 `tool_execution_start/update/end`；end 同时带 result 与 `isError`。并行执行的 end 是完成顺序，写入原生 transcript 的结果是 assistant 调用顺序。嵌套执行可以有事件而没有独立 transcript 消息。

更重要的是，执行结果有 `structuredContent`，但构造 transcript 的 `ToolResultMessage` 时没有复制该字段。因此不能承诺以后仅靠原生 history 重建所有实时工具结果。

见 [Pi 事件与结果类型][1]、[Pi 结果写入实现][2]。

### OpenAI

`tool_called` 是产生调用 item，不证明开始执行。Runner/Agent 的 `agent_tool_start/end` 才是本地执行生命周期，但 start 仍可能先于输入 guardrail 的拒绝处理，不能当成副作用已经发生。

工具异常默认可被 `errorFunction` 转换成普通字符串返回。end hook 没有统一错误标记，公共生命周期也没有通用 `agent_tool_error`。`executionStatus: executed` 不能证明业务动作成功。

本地验证：实际调用 0.20.0 的公开 function-tool API，控制 execute 抛错；默认设置返回普通错误文本，关闭 fallback 后才拒绝。关闭 tracing，fetch 被禁止并计数；结果是两个断言场景通过、网络尝试 0、模型调用 0。首次脚本错用了不存在的 tracing 函数名，在执行工具之前失败；核对公开声明后改用 `setTracingDisabled`，最终验证通过。

见 [OpenAI stream items][3]、[生命周期][4]、[工具错误处理][5]、[执行实现][6]。

### Claude

公开消息区分 assistant 的 `tool_use` 与 user 消息中的 `tool_result`，还提供 `tool_progress`、`PostToolUse` 和 `PostToolUseFailure`。`tool_use_result` 是工具特有的原始输出，不能默认直接公开；它也可能是 detached 标记，不是最终完成结果。

见安装包 `sdk.d.ts:2639–2685,6182–6201,6287–6305`。

### 设计判断

推荐统一为一种工具更新：关联 ID、工具名、当前已观测阶段、可选输出。结束更新携带最终安全输出，不再单独重复“完成”通知。

阶段可区分 requested、running、finished；不要求每个 SDK 对每种工具都发齐所有阶段。finished 表示执行路径结束或返回，不表示业务成功。错误信息只有在有原生或受控工具证据时填写，缺失表示未知，而不是 false。

局部示意，不是新的完整类型定义：

```typescript
{
  type: 'tool',
  toolCallId: 'call-1',
  name: 'render',
  phase: 'finished',
  result: {
    content: [{ type: 'text', text: 'Output is available.' }],
  },
}
```

progress 输出与最终输出应明确区分，并规定快照/替换语义；取消或不可确认的失败不补造结果。公开内容继续使用安全投影，不直接暴露原生 graph、私有 details、凭证或 providerData。

## 4. 计划：任务清单，而不是调度框架

Claude 的 `TodoWriteInput` 原生条目是 content、status、activeForm，没有 priority；较新的 TaskCreate/TaskUpdate 是增量任务记录。适配器把这些记录整理为计划快照，它补出的 `priority: medium` 是转换默认值，不是模型报告的优先级。

Pi 明确没有核心 plan mode；官方 todo/plan-mode 示例是扩展。OpenAI 0.20.0 的公共 stream item 和生命周期没有语义计划事件。

见 Claude 安装包 `sdk-tools.d.ts:1089–1099,3698–3717`、[Claude 计划转换][7]；Pi 完整 README 与 todo/plan-mode 示例；OpenAI [公共事件][3]。

推荐只保留 `PlanEntry { content, status }`，每次完整替换列表。三个实现都可以支持这一公共能力：Claude 转换真实计划/任务事实，Pi/OpenAI 内部注册原生工具来报告结构化计划。工具只记录模型提出的计划，执行顺序仍由 SDK loop 决定。

支持计划不保证每次任务都会提出计划；也不能从自然语言段落默认猜出完成状态。

## 5. 用户选择：Question/Choice 更贴近实际需求

Claude 的 `AskUserQuestionInput` 已经直接描述 questions、question、header、options、label、description、multiSelect，以及用户补充答案。它不是 JSON Schema 表单。

MCP 的 `onElicitation` 是另一个面向 MCP server 请求的能力。Claude 适配器源码也明确分开这两条路径；为了走 ACP，它把 Question 转成 schema，再把回答转回 Question。我们没有 ACP 运输需求，不应为了中间协议给业务增加这一来一回。

见安装包 `sdk-tools.d.ts:1127–1150,2670–2696,3942–3971`、[Claude 交互桥接][8]。

Pi 的 select/input/confirm 是 Extension UI。交互 TUI、RPC 和 SDK 自定义 UI 的支持不同；默认 SDK 没有 UI。模型主动提问需要注册工具，官方 question 示例不能证明所有 headless 形态都支持同一富表单。OpenAI 的通用函数工具可以等待宿主答案，但没有原生 schema-form elicitation API。

**推荐核心模型使用 QuestionRequest / Question / Choice / QuestionResponse。** 单选、多选、自定义回答用显式普通数据描述；问题和选项有稳定关联。提交、明确拒绝、关闭未选择的含义保留，但取消交互与取消整个执行不能混淆。

普通消费示意：

```typescript
await session.prompt(input, {
  onUpdate: display,
  onQuestion: async (request, { signal }) => askQuestions(request, { signal }),
});
```

不是把任意 SDK UI 全部变成 Question，也不是删除 MCP form 需求。若以后真正需要通用表单或 URL elicitation，作为明确的独立能力设计，不把完整 schema 子语言塞入初版核心。

## 6. 权限：公共决策相似，内部继续方式不同

- Pi：原生 before-tool interception 可以阻止调用；拦截不覆盖任意 extension 副作用或所有直接 shell 路径。
- Claude：`canUseTool`、native PermissionResult 与 Query 控制；AskUserQuestion 也可能从这个底层入口到达，但公开问题与权限仍应分开。
- OpenAI：产生 interruptions，决策应用到原始 native item/RunState，再把同一 native state 交回 Runner。不能丢掉 state 后拿历史重跑请求。

见 [Pi before-tool contract][1]、安装包 Claude `sdk.d.ts:213–270`、[OpenAI 官方审批继续示例][9]。

保留显式的 allow-all/交互策略与一次确切调用的决策；不引入 always-allow 数据库或 SDK continuation 公共对象。allow-all 是宿主授权策略，不保证可以覆盖 provider 强制安全规则。Claude 适配器也专门警告：bypass 后仍到达的特殊请求不能再次一律放行。

handler 失败首先不得授权对应动作，但不能仅为统一接口就规定所有 SDK 一律取消整个任务。需要分别验证 native 能否返回拒绝/工具错误并继续；只有无法安全继续时才扩大失败范围。取消、旧答案、request 关联与控制收尾仍必须明确定义和验证。

## 7. 执行结果与过程通知不要硬套协议

Pi 的 prompt 原生返回 void，必须根据当前 invocation 的正式消息与 settle 事实构造结果；不能只扫描最后一段 assistant 文本。OpenAI 必须等 stream.completed，并区分 finalOutput、generated items、history 和 interruptions。Claude 必须看 result 的 subtype 和 is_error；success subtype 本身不等于成功。

所以不立即照搬 ACP 的完整 stopReason 列表，也不粗暴删除取消结果。先定义消费者需要的正常结束、取消、失败、限制和未知，再逐个核验映射。

同样，reasoning item/compaction item 被创建，不等于观测到完整的过程开始和结束。过程能力可以保留，但事件只能承诺有证据的通知，不人为补齐成对时间区间。

## 8. 对当前草案的具体取舍

| 当前内容 | 建议 |
| --- | --- |
| prompt Promise + signal + 同步 observer | 保留；控制和最终结果不依赖 observer |
| tool + tool_result 的双终态表达 | 合并为工具更新，结束更新带输出 |
| PlanEntry.priority | 删除，保留 content/status |
| requestedSchema + FormField 的核心表单子语言 | 从用户选择核心移出，改为直接 Question/Choice |
| JsonValue | 只用于真正需要 JSON 的工具数据/控制参数；不为省行改成任意 SDK unknown |
| permission 的明确策略 | 保留，原生控制和 RunState 留在内部 |
| 所有 callback 异常必取消整个任务 | 重新核验，优先局部拒绝，不统一扩大失败域 |
| toolResults 固定完成顺序、强制 isError | 缩小保证；native item 与完成顺序不同，未报告不能当 false |
| 所有 process 都有 started/finished | 不作普遍承诺，只发有证据的事件 |
| 正式结果、公开展示、native restore history | 三者仍然分开，不能互相冒充 |

不增加新的 event registry、projector framework 或交互 broker；不写另一套 planner/loop。公共合同是 native-backed 的产品能力，而不是假装三个 SDK 有完全相同的原生 API。

## 9. 后续验收，而不是本轮完成声明

- 正式工具输出无需消费 observer；工具结束与结果关联唯一，无重复执行推断。
- 默认错误 fallback、拒绝、取消、hosted/local tool、并行顺序和 partial output 各有真实样本。
- 计划来自原生任务或注册工具，不从普通文字猜测。
- 问题的单选、多选、自定义回答、拒绝、关闭、迟到答案和无 UI 都有测试。
- callback 错误、native approval continuation、取消及关闭加入行为测试；不让未知收尾释放 writer。
- 能力报告只代表配置后的真实支持，不能因为声明了接口就报告已实现。

本轮没有三套 SDK loop 互操作、真实模型、恢复或取消验收。没有修改合同、依赖、应用或已有测试；只新增这份研究说明。

## 固定来源

[1]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/agent/src/types.ts
[2]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/agent/src/agent-loop.ts
[3]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/events.ts
[4]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/lifecycle.ts
[5]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/tool.ts
[6]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/runner/toolExecution.ts
[7]: https://github.com/agentclientprotocol/claude-agent-acp/blob/4e1fc1e8df2b9af3b1b2d6880ba90c5862283ba8/src/tools.ts
[8]: https://github.com/agentclientprotocol/claude-agent-acp/blob/4e1fc1e8df2b9af3b1b2d6880ba90c5862283ba8/src/elicitation.ts
[9]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/examples/docs/human-in-the-loop/index.ts
