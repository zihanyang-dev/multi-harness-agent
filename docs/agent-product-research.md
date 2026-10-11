# 2026 Agent 产品源码研究：观察原生执行，而不是再造运行时

> 调研截止：2026-10-12。固定源码 revision + 已安装 SDK 源码／文档重读 + 经授权的产品浏览器观察。
> 本文是取舍依据，不是上游产品性能排名或本项目功能验收。

## 1. 结论与范围

**采用有身份的临时活动、正式快照对账、薄的工具／来源呈现和特性邻近组织；拒绝第四执行 loop、万能 transcript、乐观停止、原始思考展示与预造平台框架。**

五个项目的共同价值不是功能数量，而是让用户看见真实工作并能找回结果。
它们的执行权、停止确认、审批和恢复边界不同，不能因为 UI 相似就统一语义。
本项目保留 Pi / OpenAI / Claude 官方运行时；产品控制面仍拥有 Thread、Turn、授权与正式结果。

本报告合并两份独立只读研究：三仓聊天产品报告与 LobeHub / OpenHands 报告，均已全文阅读。
研究者通过公开 HTTPS 浅克隆定位准确上游，未安装／运行上游、调用模型或读取凭据。
下列“完整”是独立研究者逐文件读至 EOF（长文件分段续读）；“选段”明确只覆盖指定调用链。
本报告作者阅读完整研究报告并复核当前本项目文件树，不声称亲自重读所有上游文件。
源码报告总计覆盖三个聊天项目的 20 个完整模块，以及 LobeHub / OpenHands 的完整模块清单。
README 仅定位仓库／责任转移，不作为能力、可靠性或安全性证据。

### 固定版本

| 项目 | 默认分支／范围 | 完整 SHA | committer date |
| --- | --- | --- | --- |
| LibreChat | 聊天／流／权限模块 | `e1dfc10449ff713faffacd60273fddcfe2c0a698` | 2026-10-06T07:43:07-04:00 |
| assistant-ui | react-pi、stream、Markdown | `b6647843760d322574aff8cca7d5cc8e1e6e51a0` | 2026-10-11T23:59:47+08:00 |
| Open WebUI | 前端与 Python tasks | `f8ae8a6c328946dc62cd0712961a0632574581bf` | 2026-10-10T16:10:07-05:00 |
| LobeHub | 默认 canary，非稳定发行版 | `9ac4ae7a3150fa9ea97ae9d2991ab5a8b4366a18` | 2026-10-11T23:56:26+08:00 |
| OpenHands | main，当前 Agent Canvas 前端 | `2d174175cedeac45a0bd7c776728464d7c1140a7` | 2026-10-11T07:00:05+02:00 |

“最新”只指本轮获取的默认分支 HEAD，非声称所有项目使用同一发布周期或稳定版本。
**OpenHands 当前仓库不是旧 Python Agent core**：canonical Agent Server / tools / conversations 在外部 software-agent-sdk，TS client 在 typescript-client。
本轮没有读这些外部实现；Canvas 类型与调用只能证明前端如何观察，不能证明服务端恢复／审批正确。

## 2. 五项目：准确源码与采用／拒绝

每仓至少列出三个有意义完整模块的永久链接；更多模块阅读范围见本节末尾。
链接固定到上述 SHA，不用漂移的 main 链接替代证据。

### LibreChat：交接与竞争边界有价值，整个平台不是模板

- **完整** [client/src/hooks/SSE/transport/sse.ts](https://github.com/danny-avila/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/client/src/hooks/SSE/transport/sse.ts)（251 行）：`createSSETransport` 区分提交／reattach，静默 EOF 无 final 时报告连接错误；刷新等待期间检查 abort。
- **完整** [packages/api/src/stream/implementations/InMemoryEventTransport.ts](https://github.com/danny-avila/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/packages/api/src/stream/implementations/InMemoryEventTransport.ts)（403 行）：`subscribe` 先挂 listener、暂存 live，再派 replay；有 items/bytes/TTL 上限。
- **完整** [packages/api/src/stream/ApprovalLifecycle.ts](https://github.com/danny-avila/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/packages/api/src/stream/ApprovalLifecycle.ts)（509 行）：`pause/resolve`、action/generation 检查与 persistence barrier 防止旧决定或竞争重复恢复。
- **完整** [packages/api/src/tools/rolePermissions.ts](https://github.com/danny-avila/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/packages/api/src/tools/rolePermissions.ts)（353 行）：provider-native 工具配置同样经过权限入口，执行失败关闭与配置写入失败有不同处理。

**采用**：EOF≠完成；replay/live 不留间隙；审批绑定 action 与 generation；原生工具不能绕过授权。
**拒绝**：复制 GenerationJobManager、metadata 兼容层与审批 store 框架；无订阅者就取消；权限 filter 默许未来能力。
其 `internal/replay.ts` 是 Redis Pub/Sub + List + Lua，不是 Redis Streams，也不是 durable Turn。
`useContentHandler.ts` 按 part index 覆盖并在快照后清缓存，`MarkdownBlocks.tsx` 只为增长块解析，值得参考但无需搬入 splitter／artifact 栈。
源码中的 CAS 设计不等于本轮验证了跨进程 store 实现。

### assistant-ui：最贴近“SDK owner + UI projection”

- **完整** [packages/react-pi/src/node/ThreadSupervisor.ts](https://github.com/assistant-ui/assistant-ui/blob/b6647843760d322574aff8cca7d5cc8e1e6e51a0/packages/react-pi/src/node/ThreadSupervisor.ts)（852 行）：`send/cancelRun/subscribe` 使用 native prompt/abort/subscribe；最后 observer 离开不停止执行。
- **完整** [packages/react-pi/src/client/eventSource.ts](https://github.com/assistant-ui/assistant-ui/blob/b6647843760d322574aff8cca7d5cc8e1e6e51a0/packages/react-pi/src/client/eventSource.ts)（435 行）：增量解码、帧大小与身份校验，close 收尾 reader／重连等待。
- **完整** [packages/react-pi/src/runtime/threadState.ts](https://github.com/assistant-ui/assistant-ui/blob/b6647843760d322574aff8cca7d5cc8e1e6e51a0/packages/react-pi/src/runtime/threadState.ts)（442 行）：`applySnapshot` 全量替换、清临时状态；message_update 覆盖 native message。
- **完整** [packages/react-pi/src/runtime/messageProjection.ts](https://github.com/assistant-ui/assistant-ui/blob/b6647843760d322574aff8cca7d5cc8e1e6e51a0/packages/react-pi/src/runtime/messageProjection.ts)（916 行）：工具按 toolCallId 配对，partial 与正式结果区分，不把 length 截断当成功。

**采用**：node／browser SDK 边界、snapshot authority、按 ID 配对、不隐式取消。
**拒绝**：内存 supervisor 作集群 owner；`send` preflight 当完成；`dispose` 当 graceful drain；引入第二客户端执行路径。
react-pi 断线后拉 snapshot，不是 replay；同仓 `ResumableStreamContext.ts` 是另一条 byte store 恢复路线，不等于 execution resume。
`hostUi.ts` 的 confirm 来自显式 extension bridge，不意味着 Pi 有可移植的原生审批 checkpoint。
`MarkdownText.tsx` 的 memo／defer 是呈现优化，smooth 不是 provider token transport。

### Open WebUI：学真实活动与简单合并，不学停止语义

- **完整** [src/lib/apis/streaming/index.ts](https://github.com/open-webui/open-webui/blob/f8ae8a6c328946dc62cd0712961a0632574581bf/src/lib/apis/streaming/index.ts)（142 行）：`createOpenAITextStream` 把 EOF 与 DONE 都映射 done，随机小块只是视觉平滑。
- **完整** [backend/open_webui/tasks.py](https://github.com/open-webui/open-webui/blob/f8ae8a6c328946dc62cd0712961a0632574581bf/backend/open_webui/tasks.py)（315 行）：local cancel 等待 Task；Redis stop publish 后立即删活动索引并返回 stopped，没有远端 join receipt。
- **完整** [src/lib/components/chat/Messages/Markdown.svelte](https://github.com/open-webui/open-webui/blob/f8ae8a6c328946dc62cd0712961a0632574581bf/src/lib/components/chat/Messages/Markdown.svelte)（127 行）：rAF 合并 lexer，done 立即 flush，destroy 清 frame。
- **完整** [src/lib/components/common/ToolCallDisplay.svelte](https://github.com/open-webui/open-webui/blob/f8ae8a6c328946dc62cd0712961a0632574581bf/src/lib/components/common/ToolCallDisplay.svelte)（385 行）：折叠 input/output、键盘操作、文本 preview；object 分支不具同一限额。

**采用**：真实 search/no-results/error 与来源；工具默认折叠；语义边界前 flush；长结果有预算。
**拒绝**：停止通知当远端停止证据；随机 chunk 假流式；载荷正文日志；字符串启发式状态；工具返回 iframe 就允许脚本。
`tool_search.py` 完整阅读；工具 schema 延迟发现不是权限，当前规模无需复制 BM25 manifest 目录。
**选段** `Chat.svelte`（1470–1589、3220–3324、4271–4370）与 `middleware.py`（1607–1801、2710–2769、4948–5092）：只评价 response accumulation、stop、search 与 delta 合并，不推断全链。
其活动 Redis 快照在 cleanup 删除，不是完整 journal，更不是可靠任务队列。

### LobeHub：顺序边界比动画更重要

- **完整** [packages/fetch-sse/src/fetchSSE.ts](https://github.com/lobehub/lobehub/blob/9ac4ae7a3150fa9ea97ae9d2991ab5a8b4366a18/packages/fetch-sse/src/fetchSSE.ts)（592 行）：区分 text/tool/usage/grounding 与 abort，但混有动画及私有 reasoning 元数据。
- **完整** [src/store/chat/slices/agentRun/actions/transports/gateway/gatewayEventBuffer.ts](https://github.com/lobehub/lobehub/blob/9ac4ae7a3150fa9ea97ae9d2991ab5a8b4366a18/src/store/chat/slices/agentRun/actions/transports/gateway/gatewayEventBuffer.ts)（263 行）：只合并相同 operation/step/kind/snapshotMode，工具／终态前 flush。
- **完整** [packages/agent-gateway-client/src/client.ts](https://github.com/lobehub/lobehub/blob/9ac4ae7a3150fa9ea97ae9d2991ab5a8b4366a18/packages/agent-gateway-client/src/client.ts)（549 行）：带 lastEventId 重连，本 operation 终态才关闭，`resume_complete` 提供状态。
- **完整** [packages/builtin-tool-web-browsing/src/ExecutionRuntime/index.ts](https://github.com/lobehub/lobehub/blob/9ac4ae7a3150fa9ea97ae9d2991ab5a8b4366a18/packages/builtin-tool-web-browsing/src/ExecutionRuntime/index.ts)（162 行）：model content 有界，UI state 保存来源；截断后只有实际启用 readDocument 才给继续读方法。

**采用**：有界内容与可追溯来源；按语义身份合并；临时显示与最终结算分开。
**拒绝**：通用 operation 树、巨型 Zustand actions、浏览器执行 runtime、推理 signature 进入公共 DTO。
完整 `conversationControl.ts`（2381 行）检查 operation/batch/toolCall 与 resolutionRequestId；但超时无 ACK 后 settle 卡片不能证明 producer 消费决定。
完整 `operation/actions.ts` 的本地 cancelled／handler 等待也不是 PostgreSQL fence 或物理 writer join。
完整 memory runtime 与 restricted manifest 展示可见性／执行授权双层检查，不提供理由预建五类长期记忆。
完整 `publishWorkspaceHtmlArtifact.ts` 验证 unresolved assets 与 revision；可学交付检查，不让合成 assistant message 拥有正式成果身份。
完整 fetchEventSource `index.ts` 注释声称 retry，实际 catch resolve 无 retry loop：注释不能替代实现。

### OpenHands Canvas：durable 与 provisional 分开最值得采用

- **完整** [src/stores/use-event-store.ts](https://github.com/OpenHands/OpenHands/blob/2d174175cedeac45a0bd7c776728464d7c1140a7/src/stores/use-event-store.ts)（256 行）：正式 events 与含 streaming slot 的 uiEvents 分开；迟到 delta 不重开正式 bubble。
- **完整** [src/utils/handle-event-for-ui.ts](https://github.com/OpenHands/OpenHands/blob/2d174175cedeac45a0bd7c776728464d7c1140a7/src/utils/handle-event-for-ui.ts)（335 行）：item+attempt 防旧重试污染，正式事件原位替换 slot，工具按 ID 更新卡片。
- **完整** [src/utils/streaming-delta-batcher.ts](https://github.com/OpenHands/OpenHands/blob/2d174175cedeac45a0bd7c776728464d7c1140a7/src/utils/streaming-delta-batcher.ts)（72 行）：enqueue/flush/reset 小闭包，注入 scheduler 可测。
- **完整** [src/utils/session-seq-cursor.ts](https://github.com/OpenHands/OpenHands/blob/2d174175cedeac45a0bd7c776728464d7c1140a7/src/utils/session-seq-cursor.ts)（63 行）：连续 cursor 而非 max seq；超过 1024 静默跨 hole 不适合本项目。

**采用**：正式替换临时、attempt 隔离、简单 batcher、连续游标、重放 UI side effects 去重。
**拒绝**：1470 行 global socket provider、默认换 WS、本地 submitted 布尔当审批权威、静默跨洞。
完整 `session-frames.ts` 是待 TS client 发布的本地类型 mirror，`asSessionFrame` 不是完整 schema 校验。
完整 provider 的 pause/interrupt 调用不证明服务端 join；完整 confirmation UI 提交 `{accept}` 不足以证明后端审批绑定。
`group-events.ts`、Markdown preview 展示折叠活动／成果预览；路径卡片不是独立 Artifact 授权模型。
`search/search.tsx` 是 grep/glob 文件搜索，不是 websearch；CondensationEvent 类型不证明长期记忆或 compaction core 已读。

### 补充阅读口径

三仓报告另完整覆盖 LibreChat `useContentHandler.ts`、`MarkdownBlocks.tsx`、`useToolCallState.ts`、`internal/replay.ts`；assistant-ui `ResumableStreamContext.ts`、`hostUi.ts`、`MarkdownText.tsx`；Open WebUI `tool_search.py`。
两仓报告另完整覆盖 LobeHub SSE byte parser、StreamingHandler、message reducer、chat store、operation/approval、memory/artifact；OpenHands provider、session frames、stop/confirmation hooks、groupEvents、Markdown/file-search visualizers、event 类型。
未运行上游测试、构建、故障注入或模型执行；源码风险不写成已复现产品 bug。

## 3. 官方 SDK 重读：按锁定版本缩小公共承诺

静态重读版本：Pi **1.1.0**、OpenAI Agents JS **0.20**、Claude Agent SDK **0.3.295**。
这些事实来自已安装发布包的官方源码／文档，不用当前官网漂移推断锁定版本能力。

| SDK | 重读发现 | 对本项目的约束 |
| --- | --- | --- |
| Pi | 官方 `message_update/text_delta` 与 `tool_execution_start/end` | 用真实文本／执行事件，不模拟 token 或用提议充当执行 |
| Pi | subscribe `_emit` 不捕获 callback 异常 | 同步公开投影不抛、不 await；存储观察由 host 有界收尾 |
| Pi | `message_end` 在 append 之前 | local streaming ID 与正式 entry ID 分离，不假定已有正式记录 |
| Pi | thinking_delta 混合 OpenAI reasoning_text 与 summary | 仅 PROCESS 状态，不透传原始片段 |
| Pi | 工具通过 `customTools`；MCP 需 factories 与 session_start 绑定 | host 显式装配；没有内置 websearch，不假定 MCP 自动接好 |
| OpenAI | `nativeStreamResult.toStream()`，`values({preventCancel:true})` | observer return 不取消；native completed 仍须 join |
| OpenAI | Tool_called 不等于 execution start | 不把模型提议显示为正在执行 |
| OpenAI | provider-specific summary 可 typeguard | 允许精确受审摘要边界，但 raw thinking 私有；当前公共推理仍 status-only |
| OpenAI | approvals/resume 使用 originalRunState | 不由公开 transcript 重建 RunState |
| OpenAI | hosted `webSearchTool` 原生；compaction 是 nativeSession decorator | 不添搜索规划 loop；默认 candidate count 不是 token 阈值 |
| Claude | persistent Query 是唯一 reader；host 提供 `includePartialMessages:true` | 单 reader 投影；保留 user/session attribution fences |
| Claude | supersedes/refusal 可能撤回；interrupt ACK≠result | 临时回答可撤回，不宣告已停止／已完成 |
| Claude | canUseTool 是 live callback wait | 不是可移植 pausedRun；hooks 由 provider 拥有 |
| Claude | 支持原生 summarized display 配置 | 自定义 gateway 不自动安全，不能放开所有 thinking |
| Claude | 内置 WebSearch 有已知 input 类型 | 保留供应商能力，不用通用工具替换全部原生行为 |

当前 `packages/harness/src/{pi,openai,claude}/projection.ts` 已存在三个 SDK streaming projector。
这说明观察 seam 已落在真实 owner 旁，不证明所有 SDK 已完成真实模型／恢复验收。
公开 reasoning 仅过程状态；工具参数完成不等于执行结果；结果默认安全通用提示，host allowlist 明确审阅的只读搜索结果才可显示。SDK 原生审批／shell／成果 API 支持不等于产品已装配或具有安全能力对等。
产品执行路径当前为 Pi；共享包有三 adapter 不等于 UI 已提供三个可任意切换的模型。

## 4. 产品浏览器观察：事实、失败和未知分别保留

使用用户授权的现有 Chrome 页面，创建自己的新对话；不读取／报告个人历史、用户名、chat ID、认证数据或原始 thinking。
原生 CLI 的独立 research session attach 9222 失败后，使用授权 MCP 继续；不把 attach 失败隐藏成成功。

### Kimi：真实变化与 UI 停止，非底层执行证明

- 新对话请求官方 React/Tailwind 来源，实际显示 Search **31 results** 与 Fetch URLs **3 pages**。
- 100ms DOM 采样得到 **1994 个不同 Markdown 长度**：证明呈现持续变化，不证明网络 token 粒度或 provider streaming 实现。
- 点击实际 `.send-button-container.stop`；停止前长度 **22502**，一秒后不变，stop UI 消失。
- 这是 UI 层停止观察结果，不证明物理 runtime、远端请求或已发出工具动作全部停止。

### Lobe：可展开活动与来源成立，停止研究失败

- 新对话搜索官方资料，最终有 **4 steps / 26s** 的可展开过程、citation chips／source cards 与手动审批 affordance。
- 后续长回答实际渲染 **166 段**；初轮只观察到最终来源，没有初轮实时 DOM 采样，不能补写“验证了逐 token”。
- 后续停止研究被 UI JSON 错误阻断：`Unexpected token '<'`，响应表现为 HTML。
- 保留失败：不能声称本轮验证 Lobe stop works，也不能由 UI affordance 推断后端审批安全。

跨页面全局键盘焦点不安全；后续尝试显式选取 15 的 marker 提交失败，不计为成功请求。
浏览器现象只支持“真实活动可解释、来源可核对、长内容可阅读”的体验目标，不支持运行时可靠性结论。

## 5. 本项目落点：少一层，而不是少一个正确性边界

### 三条实际路径

1. **PostgreSQL authority**：接受、outbox、Thread admission、Attempt claim/fence、正式终态；未知执行保持 reconciliation。
2. **BullMQ dispatch**：引用型通知加速领取，数据库可重发现；Queue success 不是 Turn success。
3. **Redis Streams observation**：白名单活动、有界 replay 与 SSE；断线／裁剪退回快照，observer 不决定执行权。

它们不是三个互相竞争的状态 owner。原生 SDK loop 不成为第四个平台 loop，也不由活动 reducer 驱动工具轮次。
当前实现使用原子 metadata + `XREAD COUNT 100` Lua 识别 retention／新 0 cursor 缺口，Redis `MAXLEN ~ 2048`／滑动 TTL 24h。native channel 为 256 events／256 KiB，result settled 后 drain 窗口 250 ms、Redis command 上限 1 秒；同步 callback 失败隔离，return／overflow 独立唤醒 receipt pending 的 observer。这些边界仍需最新测试证据，不在这里宣告性能或生产可靠性已通过。

### 文件与前端 owner

- `apps/server/src/conversation/activity-stream.ts`：归属授权与 SSE 观察；不装配 SDK。
- `apps/worker/src/execution/activity-publication.ts`：公开白名单、有界写入；`execute-turn.ts` 保留 claim/invoke/join/finish。
- `packages/protocol/src/activity.ts`：公共校验；private SDK payload 留在 harness。
- `apps/web/src/conversation/{activity.ts,use-turn-events.ts}`：临时 reducer／订阅；正式消息仍从 owner-scoped Query snapshot 得到。
- `workspace.tsx` 持续挂载会话；认证与 status 按需加载，不因辅助页面切换销毁正在观察的会话。
- `styles.css` 已使用 Tailwind import/theme/base；布局 utility 在 JSX，`conversation/markdown.css` 承接 Markdown 后代结构样式。
- `turn-view.tsx` 按需加载 `answer-markdown.tsx`，保留 react-markdown/GFM、skipHtml、无远程图片、memo；没有理由立刻复制块 splitter 或可执行 HTML/artifact renderer。

组织采用特性邻近，不建立全局 events/utils/messages store 或对称 controller/service/repository 四层。
React state 选择先区分派生值、Query snapshot 与局部交互；Tailwind token 全局、语义内容 CSS 邻近；htmx locality-of-behaviour 思想只作归属启发，不引入另一套前端。

### 能力矩阵：方向不是假功能

| 能力 | 当前事实／限制 | 后续准入 |
| --- | --- | --- |
| 文本／工具活动 | 三 projector 与产品观察代码存在，真实验收按测试记录 | ID、attempt、replay、快照与官方结果对账 |
| 公开推理 | status-only，raw thinking 私有 | 仅供应商有支持且逐字段审阅的摘要，不默认扩张 |
| Websearch | 已实现 Pi native customTools `web_search` 与 native／工具测试；不可变 `web-search-v1`，默认仍是 `text-v1` | 仅 Worker 搜索策略要求私有 Tavily key；未验收 live Tavily 或新版完整浏览器 |
| 审批 | 没有公开产品审批实现；SDK 原生语义不同 | action/参数/version/attempt、first winner 与原生 continuation 分别验证 |
| Artifact | 没有独立公开成果实现 | PG 元数据／对象存储、revision、资源完整性、预览授权 |
| 不安全 shell | 没有公开产品能力 | 威胁模型、隔离、凭证、授权与物理 writer 验收先行 |
| 长期记忆 | 原生 session/compaction 不等于产品记忆 | 有业务需求后再定 owner 与删除／共享规则 |

不引入 SSO registry、operation 树、工作流引擎、假进度条、raw-thought 面板或动态模型 dropdown 作为“成熟产品”装饰。
工具顺序仍由 Agent 决定；websearch 的来源是受限数据，不是模型授权来源。host 的 policy／webSearch 配置须一致，actual tools 与 publicTools 均为 `['web_search']`；旧 Thread 不静默升级，binding 不匹配须 reconciliation。固定 Tavily HTTPS 请求禁止任意 fetch、redirect 与自动重试，8 秒 timeout、64 KiB body、5 个经校验 URL、8192 UTF-8 bytes JSON 上限，并接收 native cancellation。Thread create/get/list 返回 tools，optional wire 兼容不等于缺失时猜测策略。

## 6. 来源与验收边界

一手网页定位包括 [React Choosing the State Structure](https://react.dev/learn/choosing-the-state-structure)、[Tailwind Theme Variables](https://tailwindcss.com/docs/theme)、[htmx Locality of Behaviour](https://htmx.org/essays/locality-of-behaviour/)。
网页研究先搜索第一方来源；直接 fetch 受 fake-IP/TUN 网络限制，**未声称全文读取这些动态网页**。
Context7 此前月度额度耗尽，版本相关结论使用已安装 SDK 官方源码／文档，而非编造 Context7 返回。
社区取舍证据是本报告固定 revision 的源码，不是搜索摘要或 README 品牌宣称。

文档验收：检查本项目实际文件树、相对链接、固定 SHA permalink 与定向 diff；文档变更不运行构建／测试。
上游没有安装依赖，因此没有 formatter/lint/typecheck/test/build 通过结论。
生产断线、跨进程接管、SDK live 执行、审批恢复、工具副作用停止、负载与浏览器性能仍需独立验收。
最终代码检查与浏览器证据由对应交付记录负责，不能用本文的静态研究替代。

相关阅读：[架构品味](architecture-taste.md)、[代码品味](code-taste.md)、[目录结构](directory-structure.md)、[技术选型](technology-stack.md)。
