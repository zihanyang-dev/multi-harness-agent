# Harness 公共合同整体审查

> 本文记录调整前 `packages/harness/contract.ts` 的 28 个公共声明、README、三个类型用例及控制调研的审查。后续合同已按批准方向收敛，当前入口和规则以 [Harness README](../packages/harness/README.md) 与 contract.ts 为准；本文中的旧名称、行号及缺口是审查时快照，不代表仍未调整。没有 SDK 运行实现，因此条款调整仍不是行为验收。

## 结论与命名

当前合同的主要责任分层是成立的，但还不能称为“每个状态都无歧义”。更重要的问题是准入、取消、失效和未知执行的后果没有完全闭合，而不是类型数量或名字不够统一。

- **现在没有 restore/resume 重复接口**：实际只有 restoreSession；resumeSession 仍是研究建议。
- 若采用产品惯用术语，建议把 restoreSession / RestoreSessionOptions / capabilities.restoreSession 一并替换成 resumeSession / ResumeSessionOptions / capabilities.resumeSession，**不保留别名**。这是命名收敛，不是增加第二种恢复能力，也不是必须修复的行为缺陷。
- 会话恢复只打开指定兼容的原生会话；不同时 prompt，不静默选最近会话，不自动接管 writer。
- 真正的执行 continuation 与会话恢复不同。不能因 stopReason 为 cancelled 就宣称可以 continue，也不把问题／权限回答变成业务第二次调用的 resume。
- interrupt 与 signal 若都公开，只能是同一个 invocation 取消操作的触发入口，不各建一套取消状态或重复发原生控制。close 是资源终结，不是另一种日常取消。
- steer 是 active invocation 的补充输入，不是普通 prompt 的并发排队或 abort + fresh prompt。支持条件与交付竞态必须依据原生实现，不能只补名字。

## 优先收敛的具体缺口

### 高：未知执行之后，handle 能不能再使用没有定义

位置：`contract.ts:49–65, 99–100, 291–302`。

现有规则只禁止并发 prompt，却没有规定 execution_unknown 后的 handle 状态。Promise 拒绝不证明 writer 已停止；同一个 handle 之后再次 prompt 可能与未知工作冲突。

**建议**：execution_unknown 后停止该 handle 的执行准入，不能因拒绝、逻辑锁或换 handle 自动重试。后续收尾可继续尝试确认资源停止，但当前 handle 不自行恢复可执行状态。何时能重新打开原生身份由停止证据及宿主 ownership 决定，不把它伪装成普通可重试错误。无需公开另一份 session 状态字段。

### 高：close 开始时的准入边界缺失

位置：`contract.ts:54–65, 298`。

定义了重复 close 共享 completion，但没有规定 close 刚开始、执行中、失败后的 prompt 行为。

**建议**：第一次 close 调用立即停止新执行准入；之后均为 session_closed，包括 close 失败时。正在执行的 prompt 独立返回其真实结果；close 不改写它。close 失败仍不证明原生 writer 停止。

### 高：新增控制必须解决目标绑定与失效，不能裸指向“当前任务”

位置：现有 `contract.ts:49–65, 77–105, 262–276`；控制研究 `docs/harness-control-review.md`。

signal 已绑定某次 prompt；尚不存在 interrupt/steer 公共方法。若直接增加 session.interrupt()，旧请求迟到可能取消下一次 prompt。steer 也需要明确绑定哪次执行、接收是否仅表示入队、未交付输入能否残留到下一次执行。

**建议**：在定签名之前明确 invocation 目标绑定。轻量执行句柄或显式身份都是可能形状，但不能为此制造第四套 Run/registry/loop。保留一个原生执行 owner。对已失效目标的控制不能影响后续执行。

同时补充当前回调规则：

- 已中止的 prompt signal 能否准入、是否写入历史，以及返回 cancelled 还是拒绝，必须选定明确行为；当前未定义。
- 取消／关闭使关联控制失效；失效后的 late allow/answer 必须收尾但不能再应用，不能授权新增动作。
- 这不撤销之前已生效的决定或已发生的副作用；正常完成仍可赢过取消。
- callback 不得等待同一 invocation 的 prompt 或 close completion，否则 close 等 callback、callback 等 close 会形成收尾循环。
- 不承诺不合作的宿主回调也能有界结束。

### 中：恢复参数与兼容失败含义不完整

位置：`contract.ts:17–18, 35–45, 291–302`。

permissions 明确在恢复时重新提供；instructions 却没有定义是系统指令、补充指令还是替换原生默认，也没有定义恢复时省略／修改它的效果。cwd、model、baseUrl 等哪些变化允许继续旧历史也未明确。

**建议**：先定义 instructions 的作用与恢复规则，并给恢复兼容性和错误码写短表。缺失历史与存在但不兼容不能含糊互换。可由各实现做兼容检查，但不能让 native fallback 静默新建、换会话或破坏旧上下文。

writer 排他责任也应明确覆盖同进程的多个 handle，而不仅 cross-process。当前 session_busy 只保证 this handle；不是整个原生身份的全局锁。

### 中：正式工具结果不完全自足

位置：`contract.ts:113–119, 169–180`。

tool 名字只出现在可选 update 中。无 observer 的评测拿到 toolResults 的 ID 和输出，却没有正式结果字段指出是哪一种工具。AssistantMessage 也不包含工具调用记录；ID 不能被当成可解析的工具名称。

**建议**：在最终工具记录中保留有原生依据的可选工具名，而不是强迫使用方维护 onUpdate 索引。事件与正式结果携带同一事实是合理投影，不是两个 owner；未知名称仍不编造。无需因此增加完整 tool-call transcript。

### 中：停止原因与 usage 的单位尚未定稿

位置：`contract.ts:110–123, 144–147`；README 已明确承认停止原因映射未定稿。

- end_turn 必须有原生确认依据；陌生、无法分类的原生终态不能默认归到它。
- max_turn_requests 的 request 计数单位未定义，不能混用模型轮次、工具次数和业务 prompt 次数。
- usage 未定义是最后一次请求还是 invocation 总量，也未明确循环、重试、compaction、思考与 cache 类别如何计入。

**建议**：先给现有五个 stopReason 和错误码定义互斥边界，不增加“看起来正常结束”的兜底。定义本 invocation 的计数口径；不能得到符合口径的总量时不伪造总量。保留缺失不是零。是否支持部分已报告计数需要明确，而不是假定它是完整计费数。

### 中：文件来源的权限、所有权和生命周期缺失

位置：`contract.ts:68–75, 203–205`。

URL / Uint8Array 的形状很简洁，但没有说 URL 是谁取、支持什么 scheme、是否允许 local file、输入 bytes 可否在运行中修改，以及输出 URL 在 prompt/close 后是否仍可用。

**建议**：定义资源访问和借用／复制边界、支持的 source、输出生命周期。allow_all 仅是工具授权，不能变成 harness 任意拉取 URL 的授权。不必因此造新的 Asset registry 或输入／输出两套相同媒体 schema。

### 中／低：观察阶段与可选值还有几处缺口

位置：`contract.ts:166–210, 222–259`。

- activity 的 observed 是缺乏可靠区间的事实通知，不是“尚未 started”的执行状态；要定义同一 ID 的 name 不变、重复通知和终结后的身份规则，不补假 start/finish。
- tool 的 requested/running/finished 是观测阶段，可跳过；保留一次 finish、不补结果。还应明确不回退阶段，以及已知 name 的身份一致性。finished 未附 result 时，旧 partial 仍不能被确认为 final。
- plan 的三种状态只接受有依据且可表达的事实。遇到 blocked/failed/unknown 不能擅自映成 pending/completed；需定义不能表达时的保守报告规则，并与 [] 清空区分。
- truncated 的 false 与缺失、覆盖 content 还是整个投影未定义。已知截断必须报告 true；隐私省略不应未经说明冒充大小截断。
- decline 应表达主动不答，cancel 表达撤回／关闭这次交互；都不取消 invocation。原生只有一种无答案结果时允许收敛为同一 native 结果，但不宣称存在不同执行行为。
- accept + [] 是否表示全部跳过要明确；现有 subset 规则未禁止这种形状。不要同时把它当成拒绝、默认作答和无效输入。
- PermissionRequest.id 缺少与 QuestionRequest.id 一样的 invocation 唯一性说明；它标识一次决策请求，toolCallId 标识工具调用，不能假定二者总是一一对应或删除其中一个。

## 全部 28 个声明覆盖

“保留”表示没有发现必须重做的职责／形状，不表示未来实现或每个输入值已经验证。

| 声明 | 职责／状态审查结论 |
| --- | --- |
| HarnessKind | 保留有限三个实现；不改成动态 registry |
| CreateHarness | 保留显式配置装配；固定 Harness 与会话资源 owner 分清，不能隐式发现凭证 |
| HarnessConfig | 保留 provider/model/凭证的显式输入；三段 shape 不因相似而强拆公共基类 |
| Harness | new 与恢复分清；若改 resumeSession 则替换，不增加同义方法 |
| HarnessCapabilities | 保留五个功能能力；不是事件清单；reasoning 可提供与 includeReasoning 请求提供不是重复 |
| SessionOptions | 必填授权保留；instructions 语义需补足，cwd 不等于 sandbox |
| RestoreSessionOptions | 真实扩展为原生身份；兼容范围和错误定义需补足 |
| HarnessSession | prompt 与 close 责任成立；未知执行、关闭准入、控制目标绑定需收敛 |
| PromptInput | 有序输入保留；不接收替代原生历史，空输入和资源所有权需要准入规则 |
| InputPart | text/file 共享形状保留；URL/bytes 权限与生命周期需说明 |
| PromptOptions | 取消意图、展示选择、观察、交互不同职责；pre-abort/late response/reentrancy 需说明 |
| PromptResult | 一份正式结果保留；native-confirmed 不等于业务成功，tool 名称与用量口径有缺口 |
| AssistantMessage | 多条、有序公共消息保留；最终结果与临时视图不是 checkpoint |
| AssistantContent | text/reasoning 块、稳定 ID 保留；公开边界、大小与省略仍需落实 |
| TokenUsage | 两个可选计数保留；统计范围与类别不明，不补零 |
| HarnessUpdate | 六类观察保留；不用第三套泛化事件协议或 capabilities.updates |
| PlanEntry | 三状态及全量替换保留；不补业务失败状态，需处理不支持的 native 状态 |
| ToolResult | 部分／最终由承载位置区分；isError 缺失不等于成功，截断与文件边界需说明 |
| JsonValue | 公共结构化数据保留；运行边界校验有限数字、无环 JSON 等，类型不能单独证明 |
| QuestionRequest | 内容交互而非授权；请求 ID 与非空有效请求的规则需运行校验 |
| Question | options/multiple/allowCustom 表示直接选择规则；不是通用 schema，引导文字与 ID 需校验 |
| Choice | 标识、标签、可选说明职责独立；不靠 label 匹配答案 |
| QuestionAnswer | 选择 ID 与允许的 custom/note 不重复；单多选及非空提交规则保留 |
| QuestionResponse | accept/decline/cancel 保留；空 accept 和两类无答案意图需明说 |
| PermissionPolicy | allow_all 与 ask 保留；没有隐式授权，取消后不应用迟到决定 |
| PermissionRequest | 决策请求 ID、工具 ID、实际参数各有职责；不要向观察路径公开参数 |
| PermissionResponse | allow/deny 保留；只用于这次请求，不持久继承或改写参数 |
| HarnessError | 10 个 code 保留为候选；每个 code 触发和恢复后果要定义，message/cause/stack 不挂原始敏感错误 |

## 哪些重复不应该删除

- messages update 与 result.messages：前者是可丢弃临时视图，后者是正式输出，一份权威事实的两种交付时机。
- plan update 与 result.plan、tool update 与 result.toolResults：同理，不要求评测消费增量。
- text_delta/reasoning_delta 与块 type：追加事件定位并验证已有块，不能据此改回 content_delta。
- reasoning capability 与 includeReasoning：可提供与请求提供是不同问题；不重复承诺实时事件。
- tool phase、ToolResult.isError、PromptResult.stopReason：分别是工具观测阶段、工具错误报告和 agent 执行结局，不能机械合并成 success。
- QuestionResponse.cancel、signal、close：分别关闭内容交互、请求取消执行、终结资源，不能合并。

## 文档一致性

root README 仍描述被删除的三应用及旧 adapters 已存在；当前 packages/harness/README 的“尚无 SDK 实现”符合文件现状，不能反过来删去这个真实限制。旧验收要保持历史口径。

`docs/architecture-taste.md` 的“当前推理仅显示过程状态”也是旧口径；需与后来确认的可选 provider-displayable reasoning 内容对齐，不因此删除 reasoning 内容能力。这些文档尚未在本轮改动。

## 实际检查与限制

- Node v24.21.0。
- 当前包 typecheck、声明 build、Biome 8 文件及 git diff --check 通过。
- 五个 TS 文件的主动 LSP probe：0 diagnostics。
- 根 Vitest：79 通过、2 失败；失败仍是旧 architecture tests 读取不存在的 apps/server/package.json 与 apps/server/src。
- 两个独立只读审查分别覆盖生命周期控制与 DTO/状态，主任务核对发现并剔除了把旧 root README 当现状的错误修正方向。
- 没有 SDK 运行、模型调用、取消／恢复／并发测试，也没有更改 contract.ts 或类型用例。上述检查不能证明列出的行为缺口已经解决。

下一轮应定点收敛已列出的公共规则，再写相应类型边界和原生行为验证；不是把本报告每个规则都展开成新的类型、状态字段或框架。
