# 多模态输入与顺序：调研记录

调研日期：2026-10-09。本文记录研究、离线 SDK 接入实验与随后批准的输入边界，不宣称已实现生产多模态。`HarnessTurnInput` 已收敛为有序 text / file，文件来源由 host 准备，不携带业务 `fileId`。当时增加了三个 SDK 的离线实验。相关旧 fixtures 已在 OpenAI 重写中删除，不再是当前可执行测试；当前相邻测试及依赖见 [Harness 接入](../packages/harness/README.md)。研究结论不追认为新版实现的验收，没有新增执行框架。

## 1. 问题不是给媒体逐个起类型名字

第一场景很可能是视频 Agent，用户会提供图片、视频、音频或文档作为参考。必须分别回答：

1. 用户表达的文字与素材顺序如何保存。
2. 文件在哪里、由谁授权读取、如何在执行环境中访问。
3. 选定 SDK / provider / model 能原生接收什么。
4. 不能原生接收的素材，是否有已授权的工具处理。
5. 转换后的模型请求、原生历史与用户可见消息是否仍表达同一份输入。

仅用 `text + files` 不能表达任意穿插顺序。仅把它改成数组，也不能证明 adapter 与原生 SDK 保序。文件能上传、消息能引用、模型能理解、工具能操作是不同能力。

## 2. 社区与标准：有共同方向，没有统一最优结构

| 对象 | 核实的表示方式 | 可以借鉴 | 不能据此推导 |
| --- | --- | --- | --- |
| OpenCode JS SDK 1.18.35 | 请求 `parts[]`；TextPartInput 与 FilePartInput；file 有 mime、url、可选 filename/source | 顺序属于消息；文件按 MIME 描述，不为 PDF/视频逐个新增公共文件类型 | 所有素材都原样进入模型；所有 CLI/UI 入口都保留任意交错 |
| AI SDK provider-utils 5.0.58 | TextPart、通用 FilePart；文件有 mediaType，来源可为数据、URL、供应商引用、内联文字 | 媒体类别与获取方式分开；不让一个字符串同时承担所有来源含义 | 为此必须引入 Vercel 的执行框架；所有 provider 都支持所有 file MIME |
| AG-UI core 1.0.2 | 有序 ContentPart；text/image/audio/video/document 共享 PartSource | 已有公开消息与活动协议可以复用，避免再造 UI 事件 | 已有通用 binary 公共输入；AG-UI 是 native checkpoint；schema 覆盖等于 SDK 支持 |
| ACP SDK 1.7.0 的非 v2 路径 | prompt 内容块，区分 text、image、audio、resource_link、resource | 资源引用不等于原生媒体；接收能力需要声明 | 本项目必须增加 ACP 运行层；resource link 自动可访问或可理解 |
| A2A 1.0.1 规范 / JS SDK 1.3.0 | parts；文本、原始字节、URL、结构化数据；文件带 mediaType/filename | 文件类型与内容来源不必绑成媒体种类大全 | 本项目需要 Agent-to-Agent 协议；其 wire JSON、生成的 protobuf 类型与 native SDK 输入相同 |
| OpenHands | 示例 Message.content 包含 TextContent / ImageContent；图像列表与 workspace 文件传输是不同机制 | 模型看到的图片与工作环境中真实存在的文件必须分别验证 | 原生视觉输入自动把图片放到 workspace；示例覆盖原生视频或所有穿插形式 |
| Goose | ACP 边界、MCP 内容与 provider 图像接入有公开资料 | 现成内容块与能力准入可借鉴 | 本轮未获得其完整 provider 转换链路，不能将它算作端到端保序证明 |

### OpenCode：普通 file，不等于省掉转换逻辑

已发布 SDK 的 v2 `FilePartInput` 字段是 `type: "file"`、`mime: string`、`url: string`，以及可选 id、filename、source。SessionPrompt 请求使用 `parts` 数组。源类型可以携带文本位置或资源来源，并非每个文件只有一个 HTTPS 地址。

通过 Context7 核对的项目源码还显示：文件会先被 resolve，可能展开成文字、数据 URI 或 MCP 资源；模型转换层按能力处理媒体。不支持的输入可被替换为明确的错误提示文字。这个策略是它的实现选择，不等于本项目应该静默接受后再降级。

### AI SDK：借鉴结构，不引入执行依赖

已发布 `@ai-sdk/provider-utils@5.0.58` 声明将 ImagePart 标为 deprecated，推荐 FilePart。FilePart 的 data 支持具名来源与部分简写。这里核对的是指定发布包，不声称滚动文档或所有旧版本已同步。

本项目没有安装这个包，不采用 AI SDK 的模型调用、Agent loop 或工具执行层。社区参考不自动成为技术选型。

### AG-UI：版本差异必须明确

本地 1.0.2 不公开旧的 BinaryInputContent。ContentPart 为明确的媒体种类联合，来源为 data / url / file；其中 file 是供应商私有 handle，不是平台通用文件 ID或可任意下载的路径。

因此“直接用 AG-UI 通用 binary 避免枚举”不是当前版本的可用结论。复用现成枚举与我们自己维护一套媒体枚举也不是同一回事。

## 3. 三个原生 harness：静态顺序核查

### Pi 1.1.0

已安装 `agent-session.js` 的相关路径：

- `prompt()` 构建 `[{ type: "text", text: userText }, ...normalized.images]`，文字在前，图片在后。
- `sendUserMessage()` 虽接受 text/image 数组，仍收集所有 text 并以换行拼接，收集 images 后调用 prompt。它不保留跨类型穿插顺序。
- extension input hook 接收 text/images，并不提供完整 content 返回路径。
- 官方 context hook 可以变换请求时的完整消息，包括合法的 text/image 排列；它处理克隆的请求上下文，不等于修改原生用户消息与持久历史。
- pi-ai 的公开 UserMessage 只有 text/image；不能据 context hook 宣称支持原生视频或通用 file。

因此不能承诺“把公共 parts 直接传给 sendUserMessage 即可原样保序”。也不默认使用 agent 底层入口绕过原生 session，或引入额外历史映射来掩盖限制。

### OpenAI Agents 0.20.0

已安装 Responses converter 对 user 的 content 调用 `map(getInputMessageContent)`，受支持的 text/image/file 各转换成一个对应块。在这段成功转换的路径中，同索引顺序保持。

这只是请求数组构造的静态证据，不证明所有模型接受所有文件。默认 Responses 转换器没有 audio 分支，也没有已核实的直接 video 输入分支；不能因为 core 类型存在 audio 就承诺默认路径可用。

### Claude Agent SDK 0.3.295

公开 SDKUserMessage 允许 MessageParam 的 content 数组，注释明确包括 text/image/document。已安装 SDK 的 streaming input 将每条消息 JSON.stringify 后写入子进程 stdin，未重新分组 content。

这证明的是 SDK 到 stdin JSON 帧的数组顺序。交付的本机 CLI 是原生可执行文件，本轮未运行它，未静态证明 CLI 后续归一化或实际模型请求的保序。PDF document 有公开类型证据，但仍需运行验收。

## 4. 顺序要分三个层级

| 层级 | 要证明什么 |
| --- | --- |
| 产品输入 | 文字、资源引用的相对位置被完整接受、保存、展示 |
| adapter 转换 | 不按媒体种类重新分组；展开与降级规则明确，保留关联与位置 |
| 原生执行 | SDK 实际构造的模型输入与原生持久状态是否保留相应语义 |

不能拿第一层的数组结构代替第三层的保证。后续 compaction、恢复可能进一步改变上下文，但原始产品输入仍有独立的事实归属。

“图片后来通过工具结果进入上下文”与“图片原本就在用户文字中间”不相同。可以作为明确的工具处理方式，但不能称为无损原生映射。

## 5. 已有依据的方向与尚未决定的部分

### 已有充分依据

- 需要能够表达穿插顺序的有序内容，而不是唯一 text 加独立附件列表。
- 普通文件/资源按 MIME 描述，不为每个扩展名或媒体类别创建一套业务输入类型。
- 文件身份、读取授权与实际获取方式是独立职责；只规定 url 不足以覆盖所有来源。
- 保留三个官方 harness；不为输入类型引入第四套执行框架。
- 原生媒体与可被工具访问的工作文件分别验证；不把“可表达”当成“已支持”。

### 已确定的最小执行边界

- `HarnessTurnInput.content` 是有序 text / file；file 使用 MIME、可选 filename，以及标准 `URL` 或 `Uint8Array` 来源。类型留在 `contract.ts`，不为少量字段另拆输入模块。
- 产品文件 ID、对象存储与读取授权由 host 管理；harness 不导入业务文件系统，也不拥有来源注册中心或存储客户端。
- download / upload 是 host 提供的普通工具，OpenAI 当前通过 factory 返回的原生 Agent 注入；此前规划的共享 `tools` 路径及 portable 契约已删除，不在 harness 新建文件工具工厂。模型参数、返回事实与 host 责任见 [Harness 接入说明](../packages/harness/README.md#文件输入与业务传输)。

### 仍需验收
- Pi 的交错输入限制在首版如何呈现：明确受限、选择另一入口组合，还是采用已验证的官方扩展。不能先承诺无损后补上下文补丁。
- 各 SDK 的工具结果图片/PDF 映射、来源过期与恢复行为。

本文不声称存在“全社区唯一、最干净的最佳实践”。干净的判断标准是保留需求语义、真实支持可验证、责任清楚，不只是字段少。

## 6. 历史离线 SDK 接入实验

下述记录属于旧快照。当时的代码位于 `packages/harness/tests/sdk/`，素材位于 `packages/harness/tests/fixtures/media.ts`；这些文件现已删除，下面的旧命令不能在当前工作区重跑。这是历史 SDK 接入／契约证据，不是新版验收或任务效果评测。当前验证入口为相邻 OpenAI 测试，不运行真实 Pi session／Claude CLI。

三个执行 fixture 按 `pi-session`、`openai-responses`、`claude-stdin` 命名，通过公开 SDK 入口运行，不调用私有 converter、不下钻 `session.agent`、不自建 loop。图片是合成的 1×1 PNG，PDF 是合成单页文档。主样本为 text A → red image → text B → blue image → text C；OpenAI / Claude 再追加 PDF 与 text D。

### 运行与隔离方式

- 每个 SDK 在独立 Node 子进程内运行；临时 HOME、cwd、XDG 与 Pi 配置目录，环境变量使用白名单，不继承云凭据或读取项目 `.env`。
- Pi 使用公开 `fauxProvider()`、`createAgentSession()`、内存凭据与空资源加载器；禁用模型网络刷新、重试、自动 compaction 与 cache warming。保留真实 session、工具执行与 JSONL 写入。
- Pi 的 provider 注册仍会刷新 builtin availability；不能把 `allowModelNetwork: false` 说成 SDK 禁止所有自动凭据发现。临时 HOME／白名单环境与内存凭据用于隔离这些路径。
- OpenAI 使用公开 `Runner`、`OpenAIResponsesModel` 与 `tool()`；显式占位 key、`.invalid` baseURL、禁用 tracing、零 retry、注入本地 HTTP fetch 捕获真实请求 JSON。
- Claude 使用公开 `query()` 与 `spawnClaudeCodeProcess`，仅以内存 streams 完成 initialize 握手并捕获 SDK stdin，不运行真实 CLI、不生成假模型结果。
- 子进程有 20 秒超时并清理临时目录；常见 Node fetch / TCP 路径被阻断。这是测试防护，不是操作系统级网络 sandbox，不覆盖所有 DNS、UDP、原生或新子进程网络路径。

### 已观察结果

| 路径 | 离线运行结果 | 证据边界 |
| --- | --- | --- |
| Pi `sendUserMessage()` → provider context | 所有文字以换行合并在前，红／蓝图片在后；交错顺序丢失 | 真实 session 到公开 faux provider 的上下文，不是生产 provider 的 wire 请求 |
| Pi 原生 JSONL → `SessionManager.open()` → 新 session | 保存的是上述归一化顺序；重新打开后相同历史进入下一次 provider context | 本地完成轮次恢复；未测试 compaction、崩溃中的工具、换 host 或云凭据 |
| Pi 工具 text + image 结果 | 真实 SDK 执行一次工具，图片以 `toolResult` 内容进入下一次 context、JSONL 与恢复后的 context | 不证明图片理解、PDF 工具输出或视频处理 |
| OpenAI user text / image / PDF | 捕获的 Responses 请求保留所有块的原顺序 | 本地响应替身，不证明真实 provider／模型接受或理解这些素材 |
| OpenAI 工具 text + image + PDF | 真实工具执行一次；第二请求保留结构化 `function_call_output`，没有额外合成 user 消息 | SDK 转换与 loop 接入；工具选择来自响应 fixture，不是模型自主选择证据 |
| OpenAI 原生 RunState | `toString()` / `fromString()` 往返保留用户块与工具结果；工具 run 状态写入／读回本地文件后，其 history 可用于下一轮真实 SDK 请求 | 原生序列化与已完成历史续轮；不是远端 Conversations session、任意中途恢复或跨 harness checkpoint |
| OpenAI 交错视频／音频文件 URL | `input_file` 的 `.mp4` / `.wav` 引用按位置转换成 `file_url` | URL 未访问，没有 MIME／媒体接受验证，不能称为原生视频／音频支持 |
| OpenAI core `audio` 内容 | 默认 Responses 路径报 `Unsupported input content type`，HTTP transport 未被调用 | 已验证明确拒绝，不因为 core 类型可表达就声称默认 adapter 支持 |
| Claude text / image / PDF | SDK 写入 stdin 的 user JSON 帧保序 | 仅 `sdk-stdin`；未证明 CLI 后续转换、模型请求、原生历史或工具媒体结果 |

当时这些结果由 3 个测试文件、10 个接入断言覆盖；旧命令为 `pnpm exec vitest run packages/harness/tests/sdk`。捕获的请求、native items、context、JSONL 和 stdin 帧保留在 fixture 报告中，用 unknown / Zod 校验，不拿源码字符串断言替代运行行为。

### 工具结果必须使用对应 SDK 的公开类型

OpenAI 的工具回调结果是 `text/image/file`，用户输入与归一化后的历史才使用 `input_*`。实验最初把 `input_*` 数组从工具回调返回，实际请求将它序列化为 JSON 字符串，而不是原生多模态工具结果。改用 `ToolOutputText` / `ToolOutputImage` / `ToolOutputFileContent` 后，结构化结果进入了第二请求与 native history。

这是接入格式错误，不是 OpenAI 不支持图片工具结果的证明。当时修正后的测试回调有明确的公开结果类型；也不能把 MCP `CallToolResult` 不经映射直接传入每个 SDK。旧公共 Tool 契约现已删除，当前由 host 使用对应 SDK 的原生工具／MCP 接口装配；这些历史实验不作为其他内容分支的验收证据。

Claude 报告中的 `fixtureCleanup` 仅检查测试替身完成收尾，不作为 SDK 无资源泄漏的证明。

### 对输入设计的收敛

1. 公共执行输入已采用有序 text / 通用 file；不回到 `text + files`，也不引入第四套执行框架。
2. 产品保存原始顺序；adapter 的能力准入与来源准备单独处理。来源授权、获取方式与模型表达不是一个字段能承担的职责。
3. Pi 的高层入口限制已经由运行实验确认。首版不能承诺三个 SDK 任意交错都无损；拒绝不支持的表达或采用经验证、明确告知的准备路径，需要作为显式设计选择，不能静默重排。
4. 视频／音频可作为资源引用不等于可原生理解；Responses 的 file URL 转换成功也不等于供应商接受其 MIME。抽帧／转录属于另外的已授权处理，不假装原样输入。
5. 输入类型已调整；旧 `tests/input.test-d.ts` 已删除。当前 OpenAI adapter 已接入有序文字／图片／通用文件映射，相邻测试覆盖可见字节快照与官方 Responses 转换器的请求构造；不代表真实模型接受或理解所有 MIME。host 来源准备、文件传输、业务上传及媒体处理仍未实现。

下一阶段仍需验证 Claude 原生 CLI 请求与保存／恢复、真实模型的素材接受、授权来源过期、更多工具内容分支和 compaction 后的语义。需要网络模型验收时另行明确范围与凭据，不默认上传用户私有素材。

## 7. 证据范围与来源

### 固定版本直接核对

- 项目已安装 Pi 1.1.0：`dist/core/agent-session.js` 的 prompt/sendUserMessage；`dist/core/extensions` 的 input/context；关联 pi-ai 1.1.0 用户内容类型。
- 项目已安装 OpenAI Agents 0.20.0：`agents-core` protocol 用户输入、`agents-openai` Responses converter。
- 项目已安装 Claude Agent SDK 0.3.295：sdk.d.ts 与 sdk.mjs 的 streaming input；关联 Anthropic SDK 0.129.0 document/PDF 类型。
- 项目已安装 AG-UI core 1.0.2：公开 ContentPart、PartSource 和消息类型。
- 临时目录下载的 npm 发布包：provider-utils 5.0.58、OpenCode SDK 1.18.35、ACP SDK 1.7.0、A2A JS SDK 1.3.0。只读取声明；未安装到项目、未执行包脚本。

### 公开项目与协议

- [OpenCode file schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/session.ts)、[prompt](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts)、[model conversion](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts)、[provider transform](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts)。滚动分支，源码片段通过 Context7 和官方索引核对，不能当作固定 npm 版本全链路运行证据。
- [AI SDK ModelMessage](https://ai-sdk.dev/docs/reference/ai-sdk-core/model-message)。具体类型结论优先采用上述固定发布包。
- [AG-UI 1.0 migration](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/migrating-to-1-0.mdx)。滚动页面与本地 1.0.2 声明交叉核对。
- [ACP content](https://agentclientprotocol.com/protocol/content)。本轮区分已发布 SDK 的非 v2 类型与 v2 draft，不把 draft 默认当稳定接入合同。
- [A2A 1.0.1 specification](https://a2a-protocol.org/v1.0.1/specification/)。生成的 protobuf 类型与 wire JSON 是不同表示，不直接拿生成类型当本项目输入。
- [OpenHands image example](https://github.com/OpenHands/software-agent-sdk/blob/main/examples/01_standalone_sdk/17_image_input.py)、[workspace materialization issue](https://github.com/OpenHands/software-agent-sdk/issues/4111)。示例与 issue 由官方索引核对；未本地执行，issue 不视作所有版本都存在的稳定结论。
- [Goose ACP schema](https://github.com/aaif-goose/goose/blob/main/crates/goose/acp-schema.json)、[provider source](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/providers/githubcopilot.rs)。本轮仅作边界参考，不作完整保序证明。

部分页面直接抓取受 fake-IP/安全限制，未绕过限制。已在本地运行上述三个官方 SDK 与测试替身，但未登录产品、运行 Claude 原生 CLI、向真实模型发请求、上传媒体或进行故障验收。研究资料、静态代码、离线运行证据、设计判断与待验证能力分开记录。
