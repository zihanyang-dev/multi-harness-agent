# HarnessUpdate 重审：内容、状态与原生事实

> 这是原研究轮次的记录，对[契约重审](harness-native-contract-review.md)作补充，不是运行验收。下文保留当时的候选与证据，不代表当前合同的所有命名。
>
> 后续评审明确保留 `text_delta` 和 `messages`，增加 `reasoning_delta`，不采用当时建议的 `content_delta/messages_snapshot`。同时删除 capabilities.updates，功能能力与实际观察事件不再重复声明。对应合同现已调整，当前定义见 [contract.ts](../packages/harness/src/contract.ts) 与[包说明](../packages/harness/README.md)。SDK 运行层仍未实现。
>
> 已确认需求：需要执行活动，也需要可展示的思考内容。不能删掉活动来简化类型，也不能只加一个 delta 名字便认为设计完整。

## 1. 结论

当前 `HarnessUpdate` 的责任划分基本成立：展示观察与正式结果、原生恢复、异步控制分离。但内容模型尚不完整，活动表达也不够清楚。

推荐方向：

1. 保留 `HarnessUpdate` / `onUpdate`，不为换名字建立新事件系统。
2. 回答与思考都是有序内容块。公开类别用 `text / reasoning`；reasoning 表示供应商可展示的思考文本或摘要，不保证完整隐藏推理。
3. 优先使用一个 `content_delta`，通过 messageId/contentId 追加到已有块；用消息快照纠正、撤回或替换内容。不是两个互不关联的回答/思考 transcript。
4. 正式 `PromptResult.messages` 必须使用同样的块结构，评测不订阅观察也能拿到已确认且允许公开的思考内容。
5. `process` 建议改成 `activity`，因为它表达执行活动，不是 OS 进程。增加活动关联 ID，明确区分开始、结束和仅观察到；不保证所有 SDK 提供成对区间。
6. 工具保留一种更新，计划保留完整替换。问题与权限继续走异步控制，不能混进可丢弃的观察。

这不是只改名：必须同时定义身份、快照与增量的关系，以及结果与观察的对应关系。

## 2. 来源及验证边界

| 来源 | 固定版本／依据 | 本轮核验 |
| --- | --- | --- |
| Pi | 1.1.0，`abe508e1b89912adde45528136c3221eb69acdd7` | types、provider 映射、session 恢复和活动事件源码 |
| OpenAI Agents JS | 0.20.0，`33e2741be9bb52c1d96a8b4dac0c68e46297b607` | 协议、Responses converter/model、官方 streaming 文档、compaction 源码 |
| Claude Agent SDK | 本机 0.3.295 `sdk.d.ts` | 当前安装包与先前保存声明逐字节一致；SHA256 `e4d91d71404ce4ffc918aa590f545c7a67df6a1dfe5de8cd28a05db0a7fe872b` |
| Anthropic API 类型 | 本机 SDK 0.129.0 | block index、thinking/signature 字段；不是 CLI 运行行为审计 |
| AG-UI | `2aabfc8cada0b429927e4c256c9cf990a6791e5f`，spec 1.0 | reasoning 内容与 span 分开；只作语义对照，不引入实现或闭合规则 |
| AI SDK | `ba05943b69ad070558bb5bc912da99ec66d7d263` | 原有固定快照的示例以 reasoning/text 为显示类别；不据此照搬全部事件 |

两个只读任务分别审查 Pi 与 OpenAI。OpenAI 任务遇到 sparse checkout 缺少部分离线 blobs，明确用安装版 0.20.0 distribution 补充，未声称它与 commit 一一对应。随后主任务扩展临时 sparse checkout，核对上述核心结论的固定源码。

网页搜索本轮可用，但直接获取官方页面仍被 fake-IP/SSRF 安全边界阻止，没有修改安全配置，也不把搜索生成摘要当作源码证据。旧的 harness SDK symlink 路径已不存在；Claude 使用实际 pnpm store 及一致的声明快照核验。

没有启动 SDK 会话、模型调用、业务应用或付费 provider 请求。没有新增依赖。

## 3. 原生事实：内容不是一个字符串

### Pi：内容块与终态修正

[Pi 内容和事件类型][1]分别定义 text/thinking 内容及 start/delta/end，使用 contentIndex；partial 是共享可变对象，不是每帧冻结快照。

[Responses 映射][2]把 reasoning-summary delta 映射成 thinking delta。同一个 assistant message 可以有多个 thinking/text 块。summary-part 完成时先追加分隔符，item 完成时又以正式 summary/content 替换累计字符串。

因此：

- `thinking` 不能直接解释成完整隐藏思考，它可能就是摘要。
- 单纯拼接 delta 可能与最终文本不同。
- 必须保留块边界、顺序与终态替换；不能把 SDK 的可变对象直接交给观察者。
- 签名、redacted payload、encrypted replay 数据不是可展示思考。

### Claude：一个原生 message ID 可以交付多个块

0.3.295 声明明确说明：流式响应按完成的 content block 发 assistant 消息；几个连续消息可共享 `message.id`，但每条只携带一个块，stop_reason/usage 尚未最终结算。

- `SDKAssistantMessage`：`sdk.d.ts:3609–3660`。
- `SDKPartialAssistantMessage`：`sdk.d.ts:5510–5542`，stream_event 包裹 Anthropic block 事件。
- API 类型 `BetaRawContentBlockStart/Delta/StopEvent` 使用 block index。
- `BetaThinkingBlock` 的 thinking 是文本，signature 是原生回放字段，不可作为公开内容。

所以不能收到一条 completed assistant frame 就替换同一 message ID 的全部内容，也不能将完整块再作为 delta 追加，否则前者丢块、后者重复。

声明还包含 supersedes/retracted_message_uuids，说明先前展示内容可能被撤回。安全的消息替换能力确实需要保留。

### OpenAI：思考摘要与回答是不同原生 items

[协议][3]区分 user-facing reasoning content 与 rawContent；[Responses converter][4]把 summary 转成展示内容，其余信息留在 providerData。

回答 delta 关联 message item/content_index；摘要 delta 关联 reasoning item/summary_index。不能把两者当作相同的原生 message ID。多个模型请求的局部 index 也不是 invocation 全局 ID。

[Responses model][5]还可以同时发归一化 output_text_delta 和包裹原始事件的 model 帧。若两个通道都消费同一回答 token，界面会重复文字。

公开 ID 可以由 adapter 分配，内部映射原生 response/item/block 身份；这不意味着重建历史或公开 SDK graph。OpenAI reasoning item 可以呈现为独立的 reasoning-only 输出视图，不强行和后一个回答建立原生不存在的归属关系。

## 4. 当前合同的问题

| 当前形状 | 问题 | 建议 |
| --- | --- | --- |
| text_delta + messageId | 没有思考内容；一个 ID 不区分多个内容块 | 有序内容块 + content_delta |
| AssistantMessage.content: string | 不能保留多个思考/回答块及其顺序 | 块数组，同用于快照与正式结果 |
| messages | 完整替换语义正确，但事件名没有直说 snapshot | 可改 messages_snapshot，与 delta 操作对照 |
| process + 可选 status | 内容和活动容易混淆；缺失 status 不直观；同类活动无法关联 | activity + activityId + 显式 observed/started/finished |
| 两段 type: tool | 只为 requested 禁止结果，重复整段字段 | 可合为一种 shape；行为约束由实现与运行测试保证 |
| plan | 完整列表替换，内容和进度来源清楚 | 保留，不扩展为工作流 |
| 观察独立于 prompt 结果和 controls | 正确 | 保留 |

### 候选数据形状

这是供评审的局部形状，不是本轮写入合同的代码，也不是完整输出媒体设计。

```typescript
interface AssistantContent {
  id: string;
  type: 'text' | 'reasoning';
  text: string;
}

interface AssistantMessage {
  id: string;
  content: readonly AssistantContent[];
}

type HarnessUpdate =
  | {
      type: 'content_delta';
      messageId: string;
      contentId: string;
      delta: string;
    }
  | { type: 'messages_snapshot'; messages: readonly AssistantMessage[] }
  | {
      type: 'tool';
      toolCallId: string;
      name?: string;
      phase: 'requested' | 'running' | 'finished';
      result?: ToolResult;
    }
  | { type: 'plan'; entries: readonly PlanEntry[] }
  | {
      type: 'activity';
      activityId: string;
      name: 'reasoning' | 'compaction' | 'retry';
      phase: 'observed' | 'started' | 'finished';
    };
```

`AssistantMessage` 是公开输出视图，不承诺与三套 SDK 的 message 一一对应。内容 ID 在所属消息内稳定唯一；消息与活动 ID 在 invocation 内唯一。新尝试不能复用已撤回尝试的 ID。

`content_delta` 不再重复 contentType，因为首次快照已经声明块的类别与顺序。代价是必须明确保证先建立块，再发送该块 delta；不能让调用方从未知 ID 或空白期猜测内容类别。

保留独立 text_delta/reasoning_delta 也可实现，但最终仍要解决相同的块身份、修正和撤回问题。对于同一个有序内容视图，优先一个 delta 操作更少重复；这不是原生 SDK 强制的唯一命名。

## 5. 必须伴随类型说明的行为

### 内容与快照

1. 首次出现内容块，先以快照声明其 ID、类别、已存在文本和顺序；包括没有文本的块。
2. delta 只追加到已建立的块；按观察到的原生顺序同步交付，不从增量推断正式结算。
3. 块终态权威内容、重试撤回或拒绝替换用快照纠正；快照替换整个 invocation 的公开消息视图。
4. 快照只含独立的公开 DTO；不携带 SDK 共享对象，不 deep-clone/freeze 整个 SDK graph。
5. 正式结果再次按原生确认事实构造，使用同样内容表示；不能只把 UI 的最后一份快照冒充正式结果。
6. 思考输出显式启用。开启展示与配置推理预算是不同决策；reasoning 类别支持应单独声明，不能仅因支持 content_delta 就声称模型能输出思考。
7. 签名、rawContent、加密／redacted 私有数据继续保留在原生状态内部。可展示文本可以是摘要；不要用类型或 UI 文案承诺完整隐藏思考。
8. 没有公开思考内容时保持缺失，不用 token 数、配置或等待时间生成虚假思考。

### 活动不是内容，也不是任务成功

activity 表示已观测到的原生执行活动。

- `observed`：只有事实通知，没有可靠时间区间，例如 reasoning item 被交付或重试决策已报告。
- `started/finished`：只在原生边界或可信调用观察确实提供时报告，使用同一活动 ID；无法可靠关联时退回 observed，不编造区间。
- reasoning 的边界只能按已观测的公开输出／原生活动理解，不是隐藏模型思考耗时；summary done 不证明全部推理结束。
- finished 不意味着成功；不需要为了关闭 UI 人工补齐所有跨度。
- 同类活动可能重复或并行，不能用 name 作为唯一关联键。invocation 结束可停止当前 UI 的等待显示，但不是补写未确认的原生活动成功记录。

[Pi session][6]确有 compaction/retry 事件，但部分恢复路径会只报告 end，底层请求 retry 也可能不可观察。

Claude 0.3.295 的 `SDKStatusMessage` 有 compacting/requesting/null，`SDKAPIRetryMessage` 有 attempt/delay，另有 PreCompact/PostCompact hooks；它们不是所有活动都完整配对的通用 API。

OpenAI 的 [run-item 事件][7]报告 reasoning/compaction item created，并非 start/end。[Compaction session][8]调用 responses.compact、更新原生 session，但这段工作没有对应的通用 stream span；运行方法还可能跳过压缩。若需要观测，应薄包实际原生边界，不创建新的 compaction/retry 算法。[官方 streaming 文档][9]也强调最后一个 token 之后仍要等待 completed。

## 6. 不应该因此增加的东西

- 不新增另一套 model/agent loop、通用 event registry 或 projector 框架。
- 不引入 ACP/AG-UI transport、JSON-RPC 或能力握手。
- 不为展示复用原生恢复状态；不同 SDK 的私有签名与 continuation 仍留内部。
- 不把 observer 断开、异常、未知块的展示错误升级为自动重跑 native。
- 不把问题、权限或最终结算塞进 onUpdate。
- 不为“全部功能一致”宣称全部 retry、全部 compaction、完整思考或准确思考耗时可观察。

## 7. 后续真正需要的验收

- 同一原生响应包含多个 reasoning/text 块；不同输出 items 以及并行 subagent 不碰撞 ID。
- Claude 多个同 message.id 的单块完整帧不会互相覆盖，不会与 delta 重复。
- Pi summary 分隔符及 item done 修正最终文本，不遗留旧增量。
- OpenAI 归一化回答与 provider 原始事件不重复；摘要与加密内容严格分开。
- 重试／refusal fallback 撤回旧尝试，公开最终结果不包含被撤回的助手输出；已经发生的工具动作不被当作撤回消息一起抹除。
- 未订阅 observer 仍有正式输出；显式开启/关闭思考影响公开投影，不损坏原生恢复。
- 重复／并行活动有唯一关联，不伪造未观测开始或成功结束。
- 取消、回调收尾、观察异常继续由已定义的 native ownership 合同约束。

这些是未来 SDK 实现的验收条件，本轮没有运行它们。源码和类型审查不证明完整流式实现已通过。

## 固定源码

[1]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/types.ts
[2]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/api/openai-responses-shared.ts
[3]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/types/protocol.ts
[4]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-openai/src/openaiResponsesConverter.ts
[5]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-openai/src/openaiResponsesModel.ts
[6]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts
[7]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/events.ts
[8]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-openai/src/memory/openaiResponsesCompactionSession.ts
[9]: https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/docs/src/content/docs/guides/streaming.mdx
