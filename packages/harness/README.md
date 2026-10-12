# Harness 公共契约草案

本轮只设计 `contract.ts` 和外部使用方式，**没有原生 SDK 实现**。

- 唯一公共入口是 `@multi-harness/harness`，不导出 `pi/`、`claude/`、`openai/` 子路径。
- `contract.ts` 定义使用方消费的能力，也定义三个内部实现必须履行的合同。
- `CreateHarness` 目前只是函数类型。下列 `createHarness` 是未来公共函数的使用示意，不是已存在的运行能力。
- `examples/*.test-d.ts` 检查调用方式、交互与输出内容类型；它们不是可以执行的应用，也不通过 fake SDK 宣称行为通过。
- 三个实现以后使用函数与普通私有数据，不要求 class，不再让使用方提供原生 SDK 对象。原生 SDK 拥有 loop、历史、compaction、重试与 continuation；内部薄层只做配置、输入／输出映射、交互授权与生命周期适配，不建立第四套 loop。
- 统一接口不表示每个 SDK 都有同名方法或支持所有可选功能。能力不足时声明不支持并拒绝对应操作，不用补充提示词、私有 state 修改或自行重跑工具伪装支持。
- **不引入 ACP 依赖、连接、JSON-RPC 或 agent registry。** 只借鉴已有协议的数据语义，本地合同不宣称 ACP/MCP wire compatibility。

初始方案见[契约调研](../../docs/harness-contract-research.md)，收敛依据见[原生契约重审](../../docs/harness-native-contract-review.md)、[更新设计重审](../../docs/harness-update-review.md)、[恢复语义](../../docs/harness-resume-semantics.md)及[整体审查](../../docs/harness-contract-whole-review.md)、[完整重新审查](../../docs/harness-contract-renewed-review.md)。研究记录保留当时的候选；当前命名与规则以 contract.ts 和本文为准。保留 text_delta/messages，不采用 content_delta/messages_snapshot。

## 1. 评测：提交输入，等待正式结果

`apiKey`、`cwd`、`stateDirectory` 由调用方提供。示例不读取环境变量或个人凭证。

```typescript
import { createHarness } from '@multi-harness/harness';

const harness = await createHarness({
  kind: 'openai',
  model: 'gpt-5.5',
  apiKey,
});
const session = await harness.newSession({
  cwd,
  stateDirectory,
  permissions: { mode: 'allow_all' },
});

try {
  const result = await session.prompt({
    content: [{ type: 'text', text: 'Explain this project.' }],
  });
  recordEvaluation(result);
} finally {
  await session.close();
}
```

评测不必订阅增量，`result.toolResults` 仍返回已确认最终结果的 toolCallId、已知时的 name 和安全公开视图，不要求评测通过 onUpdate 建立工具名索引。**未提供 `projectToolResult` 时不公开工具负载**，已确认结果采用空安全视图，并独立保留有证据的 `isError`；上面的示例没有开启负载披露。只有 lifecycle finished、没有确认最终结果的调用不补造数组条目。`result.plan` 是最后报告的可表达计划（若有），不是对未观察状态的保证。部分工具输出不升格为最终结果；数组采用实现观察到的确认顺序，不承诺所有 SDK 都按实际完成时间排序。结束不替评测判断任务是否做对，也不把计划中的 pending 自动改成 completed。关闭失败仍需上层处理；最小示例不包含错误聚合或重试策略，生产调用方应保留执行与清理两种失败。

停止原因必须有原生确认依据，不从回答文字或未知终态猜测：

| stopReason | 含义 |
| --- | --- |
| end_turn | 原生 agent 正常结束本次执行，不是业务成功 |
| cancelled | 取消后已完成本地执行与控制收尾；也包括准入前已取消、没有启动原生工作 |
| max_tokens | 原生确认输出 token 上限终止执行，不是输入超限或任意 API 错误 |
| max_turn_requests | 原生 agent-loop 的模型轮次预算耗尽；按原生 max-turn 计数，不是业务 prompt、工具调用或 HTTP 重试次数 |
| refusal | 原生明确报告拒绝，不根据文本推断 |

不认识的原生终态不得降级为 end_turn；已知收尾的失败为 execution_failed，执行／控制收尾不明为 execution_unknown。usage 是本 invocation 的可确认模型用量总计，不是最后一条消息或累计会话计数；模型循环与已报告重试需纳入，已报告 compaction 也需纳入。输入计数包含已报告 cache 读／写且不双计，输出包含已报告 reasoning tokens。`cacheReadTokens` 与 `cacheWriteTokens` 分别表示 cache 读取和创建／写入，creation 不另设同义计数，也不再次加到 inputTokens。四个计数各自仅在本 invocation 同口径总量完整时报告：cache 计数完整不要求 inputTokens 必然存在；缺失不表示 0。无法取得完整总计时省略对应计数，不把部分样本或 SDK 默认零伪装成总量；它不是供应商账单。

`allow_all` 是宿主明确授权原生工具执行，不是默认值，也不证明 cwd 是 sandbox，不能覆盖 provider 的强制安全边界。实际有副作用的 SDK 工具必须处于宿主授权的执行边界内；服务身份、网络与 sandbox 权限仍由宿主控制。

factory、Session、prompt 分别在开始准入、第一次异步等待之前捕获本次配置数据与回调引用。捕获范围包括路径、授权策略、资源选择、schemas、MCP endpoint/headers/env、projector、prompt 展示／交互选择，不重新读取可被调用方修改的配置对象。修改原对象不会重配置已创建的 handle；变更需新一次授权装配。AbortSignal 则保留同一个活对象接收取消；输入 bytes、宿主闭包依赖、Skill 文件及远端服务不是整棵复制／冻结的 SDK graph，它们有各自明确的寿命规则。

## 2. 交互应用：观察增量，允许取消

`display` 是同步展示回调；慢的网络、存储或消息队列由应用另外处理。

```typescript
const session = await harness.newSession({
  cwd,
  stateDirectory,
  permissions: { mode: 'allow_all' },
});
const invocationId = crypto.randomUUID();
const cancellation = new AbortController();
const interrupt = () => session.interrupt(invocationId);
const steer = (nextInput) => session.steer(nextInput, { invocationId });

try {
  const completion = session.prompt(input, {
    invocationId,
    signal: cancellation.signal,
    includeReasoning: true,
    onUpdate: display,
  });
  bindControls({ interrupt, steer }); // The application observes control rejections.
  const result = await completion;
  showResult(result);
} finally {
  await session.close();
}
```

`signal` 和 interrupt 是同一 invocation 取消操作的两个入口，共用原生取消与收尾，不重复发中断。signal 便于期限或外部取消组合；interrupt 返回的 Promise 等待该执行与控制收尾，不另给一次正式结果。收尾只 join 底层原生控制 IO 和已派发回调，不 join 正在等待同一收尾的公开 interrupt/close Promise；这些 Promise 观察同一个收尾，避免等待循环。应用仍然等待 prompt，可能得到 cancelled，也可能因为完成先赢而得到 end_turn；中断 ACK 不证明已停止，取消不撤销已发生的副作用。

手动控制使用调用方提供的 invocationId：必须非空，在同一 handle 内不得复用，并且不是权限证明。它只关联这次提交，不是原生 session ID 或 checkpoint。没有 invocationId 仍可直接 await prompt 并使用 signal。interrupt 对不活动的目标无操作，绝不转向下一次执行；steer 对不活动／正在取消的目标拒绝 invalid_input。

steer 只有 capabilities.steer 支持时才可用；接收表示输入进入原生处理，不保证模型已消费／采纳，不单独返回 PromptResult。输入限制可能比普通 prompt 更窄，不支持时拒绝；不以 abort + fresh prompt 代替。同一次执行结束或取消前，必须处理或撤销尚未交付的原生补充输入，不能让它进入下一次执行；无法保证目标绑定或撤销的配置不声明支持。

本 handle 一次只准入一个 prompt，准入立即生效。先检查关闭／未知执行、并发、输入和功能支持；随后若 signal 已 aborted，返回 cancelled、空 messages/toolResults，不写历史、不启动原生工作、不触发观察或问题回调。执行中取消／关闭使待处理交互失效；失效后不再派发用户交互或应用迟到的 allow/answer，已经生效的决定不倒回。

公开 update 有六类：`text_delta`、`reasoning_delta`、`messages`、`tool`、`plan`、`activity`。

- 回答与思考都是有序内容块。`AssistantMessage.content` 是包含 `id/type/text` 的块数组，正式结果也采用同一结构。每条公开消息有 invocation 内唯一且稳定的 ID，每个块有消息内唯一且稳定的 ID；不承诺与原生 SDK message 一一对应。
- 首次快照先声明内容块与顺序；text_delta/reasoning_delta 随后通过 messageId/contentId 追加到已有且类别对应的块。messages 每次完整替换当前 invocation 的消息视图；delta 只能指向当前视图中仍存在的块。保留 ID 的块不改变类别，但可以修正文本；撤回的块或尝试不能复用身份。块终态修正或重试撤回通过替换处理，不能把完整文本再次追加，也不能把消息撤回当作已执行工具动作被撤销。
- `includeReasoning` 默认为 false；显式开启后，更新和正式结果可以包含供应商允许展示的思考文本或摘要。没有 observer 也能取得正式内容。它不是推理预算设置，不承诺完整思考或每次都有思考内容。不支持的开启请求在执行前拒绝；上述示例以配置支持该能力为前提。
- capabilities 是 factory 配置下不可变的功能能力上限，不维护观察事件清单，也不会随着打开 Session 静默改变。false 表示不支持；true 表示潜在支持，不保证任意 storage/MIME/model/tool/MCP 组合都能实现，具体配置仍需准入。reasoning 表示可以提供公开思考内容，questions/permissionRequests 表示可执行异步交互控制；它们不承诺流式时机。onUpdate 按实际观测的事实报告，不保证每一类更新都会出现；思考可以只在最终结果中提供。只要发出 delta，就必须先声明其当前内容块。关闭思考展示不删除或损坏原生恢复所需的状态。
- 工具用同一种更新表达 `requested / running / finished`，共享一个 toolCallId，不再额外发送 tool_result。requested 不携带结果；running 可以携带部分输出，finished 可以携带最终输出。这是实现与未来运行测试保证的行为约束，不再拆成两段联合类型来证明。已有输出按新快照替换，省略输出不改变旧展示，但不能把旧的部分输出确认为最终结果。
- 同一 toolCallId 的阶段不回退，已知 name 不改变，一次调用只报告一次 finished；没有观测到的阶段可以省略。finished 表示原生执行路径结束或返回，不证明所有副作用已完成，也不证明业务成功。取消时不能补造结果。
- 结果包含有序文本/文件内容、可选结构化 JSON、可选错误标记。`isError` 缺失表示未报告，不能当作 false，也不能看返回文字猜成功/失败。媒体文件用 MIME 表达，这是本地合同，不是直接导出 MCP 的 ContentBlock。
- 计划只保留 `content/status`，每次完整替换，不推断 priority。它来自原生任务事实或内部注册的 SDK 工具，不从普通回答文字猜测；harness 不执行另一套 planner。不可表达的 native 状态不映成 pending/completed、不删除个别条目伪装完整计划，而是不发布这份投影；之前的计划仅是最后报告值。只有原生明确清空才报告 []。
- activity 只报告有证据的活动，通过 activityId 关联同一次活动，同一 ID 的 name 不变、不用于下一次活动。observed 是通知，不是 started 前的状态；相同 ID 可以重复通知，但不重新打开已经结束的区间。已知 start/finish 各至多一次，finish 之后不再追加；不为遗漏的边界补假配对或推断成功。includeReasoning 只控制内容，关闭它不禁止 reasoning 活动通知。思考输出边界不能当作隐藏推理耗时，摘要结束也不证明全部推理结束。

快照和更新是独立公开 DTO，不能共享 SDK 的可变对象；观察者不能通过修改展示数据影响原生执行或正式结果。可展示的思考内容与私有回放状态分开：不公开签名、加密或 redacted 私有数据、隐藏推理、SDK graph、凭证、私有工具负载或原生 result 对象。工具输出应用大小限制后要明确报告 `truncated: true`，覆盖 content 或 structuredContent 的任何大小裁剪；缺失／false 表示未由此公共投影施加大小截断，不证明 native 上游没有裁剪。白名单安全投影与大小截断不是同一事实。助手消息／思考没有截断字段，不能静默裁剪为成功输出；无法安全完整投影时收尾并拒绝，不借用工具字段。更新是观察，不是业务结算凭证；正式结果不靠拼接 delta 得到。具体安全投影规则与大小限制仍需在工具策略设计中落实。

### 用户输入与权限决策

这两类是异步控制，和可选同步观察不同。业务选择是否展示计划/工具结果，是否启用用户输入，以及采用哪种权限策略。

```typescript
const session = await harness.newSession({
  cwd,
  stateDirectory,
  permissions: { mode: 'ask', onRequest: reviewToolInvocation },
});

try {
  const result = await session.prompt(input, {
    onUpdate: display,
    onQuestion: askQuestions,
  });
  showResult(result);
} finally {
  await session.close();
}
```

- onQuestion 是业务侧的被动回调：注册不主动提问或轮询。Agent／模型通过原生交互或内部注册的 SDK 问题工具发起请求，Harness 调用处理器；这属于向宿主推送请求，而不是 Harness 自己决定问什么。`askQuestions(request, { signal })` 接收一组非敏感问题。每个问题直接包含问题文字、选项，以及 `multiple/allowCustom` 两个选择规则；选项使用 `id/label/description`，没有 requestedSchema、oneOf、anyOf 或通用表单引擎。
- 回答为 accept（提交答案）、decline（主动不回答）或 cancel（撤回／关闭这次交互）。后两者都不提交答案、不取消 invocation；原生只有一种无答案结果时可以映到同一结果，不编造不同执行行为。未提交的问题表示跳过，accept + [] 表示明确提交全部跳过，不能替用户选择。答案中的 ID、单／多选、自由文本限制仍需运行时校验。
- 不提供 `onQuestion` 表示不启用问题交互。若原生仍请求输入，向原生调用方报告交互不可用，不编造答案或永远等待；无法安全继续时为 `interaction_required`。
- `reviewToolInvocation(request, { signal })` 为这一次确切的工具调用返回 `allow` 或 `deny`，不支持改写参数。持久审批规则由宿主策略负责。此回调收到 detached 控制 DTO，可能含敏感信息，不能转发给公开 update。实际参数／route 由实现私有保留，回调修改 DTO 不能改写执行。`toolName` 标识已绑定的 executable route，不以显示名或 MCP 前缀猜授权。
- 问题回调也接收 detached DTO；答案依据私有保留的原始 IDs／选择规则校验，不依据被修改的展示对象。控制 DTO 的隔离与公开 observer 隔离同样重要。
- ask 覆盖所选 executable tool routes，包括启用的 interaction/discovery helpers；SDK auto-grants、annotations 或之前的 native grants 不能绕过宿主。不能完整 gate 的组合在执行前拒绝。连接／spawn／来源 metadata 读取由配置输入另行预授权，不冒充一次模型工具审批；模型调用本身也不变成权限问题。
- 回调可能并发；request ID 只在当前 invocation 中匹配，不是授权证明。无答案、无效答案或异常都不能授权。权限回调失败拒绝对应动作，问题回调失败不提交答案；SDK 可以安全处理时局部拒绝并继续，不统一取消整个任务。无法安全继续时收尾后为 `interaction_failed`，收尾不明时为 `execution_unknown`。
- 原生取消和 close 会中止回调 signal；宿主必须结束自己的待处理交互。执行和关闭都等待控制收尾，迟到响应不再应用。回调不得等待同一次 prompt、interrupt 或 close 的完成，避免与等待它的收尾形成循环；未响应回调不能被冒充为已停止，也不承诺强制有界结束。
- 能力不支持时明确拒绝；注册处理器不代表某 SDK 已经能实现该能力。问题与工具拦截分别由 `capabilities.questions`、`capabilities.permissionRequests` 声明。观察回调不请求执行某项功能，也不用于能力握手。

## 3. 会话恢复、资源与错误

```typescript
const session = await harness.resumeSession({
  sessionId,
  cwd,
  stateDirectory,
  permissions: { mode: 'allow_all' },
});
```

resumeSession 替代 restoreSession，不提供别名。它只打开精确身份的原生历史，不执行新输入，不承诺继续未完成运行或接管旧 writer。配置后的 resumeSession capability 不支持时为 unsupported；历史缺失为 session_not_found，存在但无法兼容恢复为 session_incompatible，不静默新建或重写旧历史。实现检查 SDK／存储格式、原生身份与 workspace/configuration 兼容性；不能兼容的变更拒绝，不用公开消息重建。

instructions 是本 handle 的额外宿主指令，通过原生配置与其基线组合，不覆盖供应商安全边界，也不改写旧消息。新建与恢复均使用本次提供的值；省略表示不追加，不隐式继承以前的宿主配置。因此需要保持行为时调用方应重新提供同一值。permissions 也重新提供。SDK 无法安全应用或验证时拒绝，不伪装成功。

恢复也重新提供 tools/skills/MCP/projector；省略不从旧历史继承宿主绑定。资源选择变化不一律等于不兼容，但必须仍可安全回放准确的原生历史；缺失 replay-required routes、改变所需 schema／search runtime binding 时拒绝 session_incompatible。名字相同不证明兼容，不通过重新执行旧工具修补历史。暂停执行的 runtime state 与历史 reopen 仍是不同层，不因重开 handle 自动继续旧审批。

Session 装配失败时，尚未返回 handle 的资源也由该装配 attempt 清理并 join，包括部分建立的 MCP 连接。调用方不负责 close 一个从未返回的对象。清理不能确认停止时为 execution_unknown，不能包装成普通 invalid_config 就允许安全重试。宿主闭包持有的依赖不归 Session 自动关闭。

宿主负责同一原生身份／存储在所有 handle、进程之间的有效 writer 排他。session_busy 只是 handle 内保证；session ID、cwd、stateDirectory 或逻辑锁不证明授权／物理停止。

第一次 close 调用立即停止新的 prompt/steer 准入，以后为 session_closed，包括关闭失败。重复 close 共用第一次 completion，不删除历史、不重试成新的执行。当前 prompt 保持自己的真实终态。execution_unknown 后该 handle 停止执行准入，后续 prompt/steer 仍拒绝 execution_unknown；close 可做资源收尾，但不会重新开放这个 handle。宿主确认旧 writer 已停止并重新授权后，才可考虑打开原身份，不自动 retry/takeover。

| code | 触发含义 |
| --- | --- |
| invalid_config | 创建／打开的配置不合法；不是已有历史消失 |
| invalid_input | 单次输入、控制目标或调用参数不合法 |
| unsupported | 此配置不能提供所请求的功能／格式 |
| session_not_found | 指定原生历史缺失 |
| session_incompatible | 历史存在，但版本、内容或配置不能安全恢复 |
| session_busy | 此 handle 已有未收尾执行／控制 |
| session_closed | close 已开始或完成，即使 close 失败也不再准入 |
| interaction_required | 原生要求未启用的交互，无法安全局部继续，已经收尾 |
| interaction_failed | 已启用交互失效／失败，无法安全局部继续，已经收尾 |
| execution_failed | 原生执行、投影或资源操作失败，已确认本地执行／控制停止 |
| execution_unknown | 无法确认执行／控制停止，不能据此允许后续写入 |

收尾不明优先 execution_unknown，不能藏在普通失败里。公开 Error 的 message/cause/stack 也不得挂原始敏感 SDK 错误或 graph。

### 文件来源

prompt／steer 的有序 content 不为空，保留原文字而不替换为 native history；工具公开视图的 content 可以为空。准入时捕获顺序、文本、MIME、filename 与校验后的 URL 值，避免调用方修改 URL／元数据后把提交重定向到别的来源。文件 bytes 由输入调用方持有，在 prompt／steer 处理及相关执行收尾前不得修改。

Tool callback 在 Promise 返回时移交稳定结果，不得在验证／捕获期间并发修改；实现此时复制 JSON、bytes 和 URL 值再交给 SDK，而非借用 callback 的 bytes 直到 prompt 收尾。公开 output/projector/control DTO 分别 detached，包括 nested JSON、URL 对象、Uint8Array/Buffer 的实际存储，不把共享 slice 当复制。普通数据复制不允许遍历／冻结任意 SDK graph。

URL 只接受宿主授权的 HTTPS 来源，且必须由 SDK／provider 原生支持；Harness 不增加下载器，不自动读取 file/http/data/blob 或 filename 指向的本地路径。不支持的 source/MIME/限制在提交前拒绝。工具 allow_all 不授权额外抓取，来源授权仍属宿主。

返回的 URL 是宿主允许公开的外部引用，不创造资源访问授权或永久保留保证。需要可靠保存时调用方应在关闭前取得并持久化内容；URL 的外部过期／撤销由资源 owner 决定，关闭不延长它。独立 bytes 在 close 后仍可由调用方使用。

## 4. Tool／Skill／MCP 与结果披露

这些字段都是 Session 本次批准的普通声明，不是 SDK 对象、全局 registry 或产品安装管理接口。产品可在 user/workspace/Agent 层持久保存配置，打开 Session 时提供批准快照。Session 可以包含多个 prompt；选择范围不要求每次重连，也不因此增加跨 Session 连接池。

### Builtin 与宿主 callback tools

`nativeTools` 选择 implementation-native builtins，`tools` 绑定宿主 executor；两者最终都由 SDK loop 调度，不是“原生工具与第四套工具框架”的区分。省略、[]、显式列表的语义如下：

| 字段 | 省略／空列表（适用时） | 显式选择 |
| --- | --- | --- |
| nativeTools | 省略使用下面固定 Harness baseline；[] 禁用 builtins | 列表替换 baseline，不追加 ambient tools |
| tools | 不添加宿主 callback tools | 绑定给出的 schema/executor；冲突不覆盖 |
| skills | 不启用 skills，包括恢复时 | 只使用批准的预配置来源 |
| mcpServers | 不添加 servers，包括恢复时 | 只建立批准的原生连接 |
| projectToolResult | 不公开工具 payload | 显式允许经过验证的公开视图 |

第一版 builtin baseline 固定为：

| Harness / 本轮 SDK 证据版本 | 显式 builtin 名单 |
| --- | --- |
| Pi / 1.1.0 | read, bash, edit, write |
| Claude / 0.3.295 | Read, Bash, Edit, Write, Glob, Grep |
| OpenAI 普通 Agents Runner / 0.20.0 | []，没有自动 filesystem/shell/hosted tools |

这是 **Harness 明确选择的基线**，不是“完整复制 SDK/CLI 默认值”，也不是三者通用的工具名别名。SDK 升级不能静默扩大名单；已知名称在特定 native build 不可实现时拒绝 unsupported，不切到自动 grants 伪造 availability。未知名称／routing collision 是 invalid_config。上表的源码支持不等于运行验收。

资源隔离独立于 builtin selector：不加载未批准的 settings/extensions/plugins/skills/MCP。显式 deferred exposure 会启用所需原生 discovery，onQuestion 会启用所需原生 interaction；这不是偷偷增加 filesystem/shell，也不绕过 ask。Skill 需要 reader 而所选组合没有兼容 reader 时拒绝，不补 inline body。

`ToolDefinition` 使用 JSON object-root inputSchema、可选 outputSchema 和 Promise executor。实现需公布可支持 schema subset；约束要兑现或拒绝，不能静默删除字段、schema 或工具。JSON parse/provider strict sampling/native coercion 均不代替实际参数校验。授权前验证原始实际参数，并确保已批准、执行的参数与 route 一致。outputSchema 校验成功输出的 structuredContent，不校验 display text；不能直接把整个 ToolOutput 当作那个 schema 的值。

`exposure` 只表达 model-context immediate/deferred；省略使用 native policy，显式意图需兑现或拒绝。它不是 permission、模块懒加载或 first-use connection。搜索、加载与 continuation 使用原生实现，不公开 session.toolSearch，也不造通用 lazy 开关。executor 返回实际 outcome，不能把客户端 dispatch ACK 作为执行完成。

### Skill 来源

每个 `SkillSource.directory` 是绝对、预配置的单 Skill 目录，包含 SKILL.md 与资源。native discovery 产生 metadata，并按原生机制披露正文／资源；不是承诺磁盘上连正文都不读取。

装配时验证 metadata、identity 和冲突，缺失／无效为 invalid_config，无法安全使用 native loading 为 unsupported。宿主在整个 handle 寿命内保持目录、SKILL.md 和资源稳定；更新需要新的批准装配，不增加文件 watcher 或版本 registry。

选择 Skill 不加载 sibling plugin/MCP 配置，不在装配／披露中隐式执行 shell macros。技能指示模型调用已批准工具是另一件事，仍受原生工具权限约束。来源选择不是 filesystem sandbox，也不授予 shell/network 权限。

### MCP 连接与动态列表

stdio command 指向预配置 executable，不是安装包指令或 shell template；args/env 是 literal 数据。http 表示 Streamable HTTP，sse 表示 legacy SSE，不支持的 native 路径明确拒绝。URL/headers 捕获后不因调用方修改而重定向；env/header 中 `${NAME}` 或 `!command` 也不得被表达式解释执行。

stdio 只使用已批准的最小运行环境和显式 env additions，不复制完整 process.env，不向服务器默认注入模型凭据；具体平台必需项需由实现文档列出。native client 不发现个人 credentials，不自动 OAuth/refresh/browser login；SDK 不能保持 literal／隔离语义时拒绝，不另建 proxy/transport 框架。宿主仍负责子进程／远端服务的 OS、网络与凭据访问边界。

`allowedTools` 使用 server-local original **tool** names，而非 SDK mangled route 名称：

- [] 不曝光／调用 server tools，但不保证不 connect，也不等于批准或禁止所有 resources/prompts/helper actions。
- all 明确包含这个 server 未来发现的 tools，但不授予它们执行许可。
- 显式名单在初始完整原生 discovery 后缺名则装配失败；以后不扩大名单，撤回工具立即失去 eligibility。
- route/schema/local connection binding 改变使 pending approval 失效；调用前重新核验实际参数和当前绑定，丢弃旧连接的迟到回调。远端实现本身并不因此被物理冻结。
- 后续 routing collision 不覆盖已有工具，受影响路径 fail closed；不能安全继续时收尾后 execution_failed，停止不明为 execution_unknown。

连接、分页、发现和列表刷新由 SDK 负责。connections（包括 partial init）归 Session／装配 attempt 收尾，callback 闭包中的外部客户端不自动关闭。

### projectToolResult：只控制直接公开负载

此可选同步回调是本地披露策略，不是原生标准，也不执行或审批工具。输入是 detached、可表示且实际观察到的 private ToolOutput 和调用身份；返回 ToolResult 给观察／评测，undefined 仅抑制这次 payload，**不改变模型结果**。无 observer 的正式结果也走同一规则。

- 返回值先验证、再 detached 发布。`isError` 不由 projector 决定：忽略其返回的该标记，并只应用实际确认的 native classification；没有证据则省略，不能按文本猜。
- 省略 policy、返回 undefined 或后续 fail-closed 抑制时，已确认最终结果采用 `{ content: [] }` 等空安全视图，并独立保留确认的 error facts。原生 rich data 无法表示时留在 SDK 内，不能先伪造空 ToolOutput 再调用 policy。
- 仅看到 finished 或取消，没有确认最终结果，就不创造 final result 或 toolResults 条目。
- 抛错、Promise 或无效返回关闭这个 invocation **所有工具后续** payload publication，但不关闭 native execution，不把 policy failure 当 tool failure，也不恢复自动公开默认值。
- 抑制是前瞻性的，不撤销已交付的 partial。省略 update.result 保留旧 provisional view；真正确认的空 final view 可以作为替换，旧 partial 仍不进入最终结果。
- 返回的 views 只能是有依据的公开投影，不能编造 tool output facts。privacy filtering 不等于 truncated；后者只表示公共 size 截断。

policy 是 trusted、无副作用、不阻塞的函数，不 await 本 invocation 的 prompt/interrupt/close。它只过滤直接公开的工具 payload，不能保证模型不会在 assistant text 中引用已经进入模型的内容。模型输入授权仍是独立边界。

## 5. 当前声明与未实现范围

已写入合同：模型/API-key 配置、新建/恢复会话、输入、一次执行、观察、目标绑定控制、正式结果、错误与关闭；有序回答/思考块、计划、工具结果、活动、问题与权限；Session builtin/callback tools、Skill/MCP 来源、schema/exposure、cache 明细和公开披露策略。

尚未实现／验收：三套 SDK 的原生映射，supported schema subset，最小平台环境，具体大小限制，逐 SDK 停止原因、控制收尾、恢复兼容性与 callback correlation。延后：其他认证、细粒度输入能力、通用 MCP form/URL elicitation、持久交互、跨 Harness 历史迁移、Plugin/长期 Memory 和未完成执行的公开 continuation。手动控制使用指定 invocationId，不引入 SDK state 或第二套执行 handle。**类型存在不代表三套 SDK 已实现该能力。** 原生控制与 continuation 留在内部，不向调用方返回 SDK state。SDK 返回多项审批时，内部归并这批决策再由唯一 owner 继续原生 state，不能每个回调各自重启 Runner；这属于原生交互桥接，不是重新决定模型／工具步骤的 loop。

`onUpdate` 的 TypeScript `void` 返回类型本身不会阻止传入 async 函数；同步、不阻塞和异常隔离是待实现并验证的行为约定。`onQuestion` 和权限回调则明确异步，等待答案与收尾，但仍需要运行测试证明。

## 6. 验证口径

- `tsc --noEmit -p packages/harness/tsconfig.json`：检查公共类型、使用示例和负向调用。
- `tsc -p packages/harness/tsconfig.build.json`：生成 declarations 和空 JavaScript module entries，不生成 SDK 实现或 createHarness。
- `biome check packages/harness`：格式与 lint。

类型用例包含负向边界，但不能证明块声明/增量顺序、快照修正、思考开关、工具生命周期或活动关联的运行行为。不存在本轮 SDK 运行测试、模型调用、取消验证或恢复验收。旧应用已删除，遗留根测试/配置尚未迁移；不能用这个包的类型通过宣称整个仓库通过。
