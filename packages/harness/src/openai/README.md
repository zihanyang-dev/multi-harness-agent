# OpenAI 接入

当前提供文字／文件输入、文本输出的会话 adapter，复用 OpenAI Agents SDK 0.20.0 的 Runner、Responses model 和 host 显式提供的官方 SDK `Session`。模型服务与会话后端独立装配；不自建 Agent loop，不将产品消息当作完整 RunState，也不建设通用存储框架。

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

- 保留文字与文件 parts 的交错顺序，不合并、丢弃或重排。文件通过官方 SDK 的图片／文件内容表示传递，不以 PDF 白名单限制通用附件。
- `input.ts` 只负责具体 OpenAI 输入映射，公共输入类型仍在 `contract.ts`；不下载、上传、读取本地路径、解析文档或自建媒体处理流程。
- `tools`、`mcpServers` 非空或传入 `skills` 时，在调用 host 会话装配前拒绝。空工具／MCP 数组表示未请求这些能力。
- `cwd` 不改变普通 SDK Agent 的进程工作目录，也不授予文件系统权限；当前没有 shell、sandbox 或 Skills 装配。
- `resume` 取决于所选会话装配的已验证能力；`steer`、`visibleReasoning`、`customTools`、`mcp`、`skills` 为 false，描述的是本 adapter 的边界，不代表官方 SDK 没有这些能力。
- 输出只含 assistant 文本，不包含工具结果、媒体输出、私有 reasoning 或公开推理摘要。

## 原生文件输入

`HarnessInputPart.file` 继续使用 `source: URL | Uint8Array`、`mimeType` 和可选 `filename`。host 在调用前完成授权、来源准备和大小准入；映射在占用本 wrapper 的 writer、访问 SDK 历史或请求模型之前完成，元数据错误不会启动 turn。

| 输入 | SDK 内容与处理 |
| --- | --- |
| PNG、JPEG、WebP、GIF MIME | `input_image`，由 SDK 转成原生 `image_url`；默认 detail 由 SDK 提供 |
| 其他有效 MIME | 通用 `input_file`，不设置 PDF／Office／文本扩展名白名单；不按 URL 后缀猜 MIME |
| `Uint8Array` | 按实际可见 byte view 编码为带 MIME 的 Base64 data URL；同步取得快照，不因 caller 后续修改数组而改变原生输入 |
| HTTP(S) URL | 保留原生 URL 引用，不在 host 侧请求文件；普通附件用 SDK `{ url }` 形式，避免其字符串 URL 判断只识别 HTTPS |
| data URL | 保留 inline 数据形式，不误传为远端 `file_url` |

元数据与能力边界：

- `mimeType` 是不带参数的 MIME media type，不是完整 HTTP Content-Type header；去除首尾空白、规范化大小写。空值、缺少 type/subtype 或带参数的值明确拒绝，没有 MIME 兜底。
- 非空 `filename` 按原值传给原生 `input_file`；URL 与 bytes 均不强制填写、不生成假名称。官方声明的 filename 为可选字段，具体服务的条件约束仍可能导致请求失败。
- 原生图片内容没有 filename 字段，不额外插入文字、私有字段或修改输入顺序来伪造文件名传递；业务文件名关联由 host 保留。
- 远端 URL 没有原生 MIME 覆盖字段。调用方 MIME 只选择内容路由，不证明服务器文件真实类型；inline bytes 的 MIME 才通过 data URL 携带。
- 本 adapter 的 URL 策略仅允许 HTTP、HTTPS 和 data；file／blob／ftp 等形式在 SDK turn 前拒绝。这不是源授权或 SSRF 防护：host 仍负责域名、访问范围和授权，SDK 可编码 HTTP URL 也不证明模型服务接受它。
- 官方 vision 支持的 GIF 范围是非动画 GIF；本映射不检测图像字节或动画。SVG、TIFF 等未列入 vision 格式的 MIME 仍走通用文件传输，不自动栅格化，也不宣称服务可读取。
- 通用传输包含 Office、文本、代码、表格、自定义 MIME 等表达；ZIP、音视频等同样可编码为附件，但这不提供解包、语音识别或视频理解能力。格式是否被接受、读取多少内容，由所选服务／模型决定；400 等原生失败保留，不改成文字或伪成功。
- URL 在原生历史中保留为引用，不自动缓存内容或刷新签名。host 负责有效期、重放时可访问性、字节大小与保留策略。文件输入不改变文本输出投影，也不是完整媒体功能或生产恢复验收。

官方依据：[文件输入指南](https://developers.openai.com/api/docs/guides/file-inputs)、[图片输入要求](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements)，及已安装 SDK 0.20.0 的公开 `InputImage`／`InputFile` 和 Responses 转换行为。文档列出的官方服务能力不等于任意兼容网关的能力。

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

相邻的 `input.test.ts`、`adapter.test.ts`、`output.test.ts` 使用公共 adapter、真实 Runner 和显式 OpenAI client，本地 HTTP fixture 模拟 Responses SSE 和显式选择的 Conversations 历史；官方 MemorySession 仅用于验证 SDK Session 注入与原生续轮，不冒充持久后端。可暂停的请求／响应体验证 setup、执行、历史写入和收尾顺序；子进程验证无人消费及取消订阅后的失败不形成未处理拒绝。

离线测试覆盖通用附件的 URL／bytes、四类 vision MIME 路由、文字／图片／文件交错顺序、byte view 快照、原生历史续轮、可选 filename、data URL、元数据拒绝和服务文件拒绝无回退；同时保留模型与历史 client 分离、恢复准入、无读者运行、中断／dispose 等生命周期回归。文件案例包含 PDF、TXT、Markdown、JSON、CSV、DOCX、XLSX、PPTX、ZIP、二进制、SVG、WAV、MP4、自定义 MIME；部分 bytes 仅为合成 byte vector，证明编码与路由，不证明相应文件可被解析。不使用云凭据、不调用模型服务；fixture 不是远端存储服务，结果不是模型质量或生产恢复验收。

### 真实文件验收

2026-10-10（UTC），通过构建后的公共 `createOpenAIHarness`，在 `https://sub2api-rd.pexoai.cn/v1` 使用网关模型名 `gpt-6.1-sol` 分两批验收：先测试五种图片／文档／表格，再追加音视频。全部为本地生成的小型合成文件，以 `Uint8Array` 输入；不使用真实业务文件、不由 harness 下载、转写或拆帧。每个案例独立使用官方 MemorySession、`resumable: false`、`store: false` 和流式输出；禁用 tracing、重试为 0，单次请求／响应体期限 35 秒。

| 格式 | 文件大小 | HTTP | 原生／公开文本 delta | 内容校验 |
| --- | --- | --- | --- | --- |
| PNG | 1,341 bytes | 200 | 4／4 | 随机排列的三个颜色面板，回答顺序完全一致 |
| PDF | 699 bytes | 200 | 8／8 | 找到 target 标签对应的随机值，精确一致 |
| DOCX | 939 bytes | 200 | 9／9 | 找到 target 标签对应的随机值，精确一致 |
| XLSX | 1,618 bytes | 200 | 10／10 | 找到 target 行对应的随机值，精确一致 |
| CSV | 86 bytes | 200 | 8／8 | 找到 target 行对应的随机值，精确一致 |
| WAV | 99,414 bytes | 400 | 0／0 | 文件输入被服务拒绝，未进行内容读取校验 |
| MP4 | 2,677 bytes | 400 | 0／0 | 文件输入被服务拒绝，未进行内容读取校验 |

五个成功案例的问题与文件名都不包含随机答案；SDK 原生 delta、公开事件拼接文本与最终消息完全一致，每例有一个 RUN_STARTED 和成功 RUN_FINISHED、无 RUN_ERROR，result 为 completed，SDK 会话内测得两条历史记录。音频是本机生成的约 3 秒单声道 16 kHz PCM WAV，视频是 FFmpeg 生成且经 FFprobe 确认的 3 秒 H.264 MP4；分别隐藏随机短语和时序颜色。两例均在 HTTP 边界收到 400，结果保留原生拒绝、发布 RUN_ERROR，不降级为文字或伪成功。

两批恰好发出 5＋2 次 `POST /v1/responses`，没有重试、重定向、工具、Conversations 或 Files API 调用。SDK 已成功编码 WAV／MP4 并发到服务，不表示当前 `input_file` 链路接受它们，更不表示语音识别或视频理解已实现；这两例失败也不能推断其他模型／接口没有音视频能力。没有为这次服务结果加入 PDF 白名单或音视频硬编码拒绝。

该验收证明当前网关／模型链路对五个小样例接受文件并能获取指定内容，不揭示网关内部解析机制，也不证明任意同扩展名文件、复杂 Office 内容、大表格、全部 MIME、远端 URL 拉取、文件历史重放或生产持久恢复。音视频后续需要验证可用的原生模态路径或由 Agent 自主调用 host 提供的媒体工具，不把转写／拆帧设成固定 Workflow。

凭据仅从已授权原用户消息在测试进程内读取，未显示或写入脚本、报告、请求头日志及仓库；临时脚本和素材已清理。这是显式授权的人工验收，默认离线测试和 CI 不发这些请求。

### 音视频路径调研与归因边界

2026-10-10 补充核对官方指南、API create schema、模型页、已安装 SDK 源码及公开网关源码；不追加模型调用。必须区分以下事实：

- 官方 [GPT-6.1 Sol 模型页](https://developers.openai.com/api/docs/models/gpt-6.1-sol) 的 Audio 和 Video 均为 Not supported。这是官方同名模型的能力声明，不能证明兼容网关实际映射到哪个上游模型。
- 官方 [文件输入指南](https://developers.openai.com/api/docs/guides/file-inputs) 的完整接受列表包含文档、表格、文本／代码等，不包含 WAV／MP4。将它们编码为 `input_file` 是通用附件探测，不是原生音频／视频模态的正确性验收。
- 本机 OpenAI 7.30.1 的 Responses 用户内容 union 为 `ResponseInputText | ResponseInputImage | ResponseInputFile`。Agents 0.20.0 的 `OpenAIResponsesModel` converter 只处理相应分支，不解析媒体；core `AudioContent` 的 `type: 'audio'` 在此处明确拒绝，发生在 HTTP 之前，与本次服务 400 不同。
- OpenAI 并非整体没有原生音频能力。[官方音频对话指南](https://developers.openai.com/api/docs/guides/audio-chat-completions) 使用 Chat Completions、支持音频的模型和 `input_audio`；Agents 0.20.0 的公开 `OpenAIChatCompletionsModel` converter 能把 core `{ type: 'audio', audio: rawBase64, format: 'wav' | 'mp3' }` 转为该协议。当前 adapter 固定装配 Responses model，没有接入这条路径；不能只换 MIME 或只换 client base URL 就得到它。
- [文件转写指南](https://developers.openai.com/api/docs/guides/speech-to-text) 的 `/v1/audio/transcriptions` 接受 WAV、MP4 等音频容器，这不等于 MP4 视觉理解，也不等于当前 Agent model 路径已支持。当前核对的 SDK／Responses schema 没有 `input_video` 内容分支，不能把视频生成接口或图像输入当作整段视频分析验收。
- 公开 Sub2API 源码快照 `3a6fd1c9db07203ca308aaba69e502bc1f35b307` 的 [Chat Completions → Responses 转换器](https://github.com/Wei-Shaw/sub2api/blob/3a6fd1c9db07203ca308aaba69e502bc1f35b307/backend/internal/pkg/apicompat/chatcompletions_to_responses.go) 只转换 text／image_url／file，native input_audio 会在该转换路径被忽略；另有 native Chat Completions 转发分支，不可推断所有路由都会丢弃音频。实际部署版本与选中的上游协议未确认，这不是本次 400 的归因证据。

本次报告只保留经过固定分类的错误，没有保留完整 provider message／code／param，无法精确判断两个 400 是网关本地校验还是上游拒绝。已确认存在所选官方模型的模态限制，以及当前 adapter 的接入路径限制；尚未证明具体服务拒绝发生在哪一层。需要精确归因时，应读取对应服务日志，或经批准做一次采集脱敏结构化诊断的重现，不根据 HTTP 400 直接宣布“SDK／OpenAI 原生不支持音视频”。

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
