# Harness 接入

生产执行与评测共用的原生 SDK 接入边界。`src/contract.ts` 是公共契约，当前提供最小 OpenAI 文本会话 adapter；Pi 和 Claude 接入尚未实现。

- Pi 1.1.0、OpenAI Agents SDK 0.20.0、Claude Agent SDK 0.3.295。
- 保留官方 loop、session、compaction 和实际控制能力，不编排创作步骤。
- 输入是有序 text / 通用 file；adapter 使用原生内容机制，不自建 loop 或媒体解释器。类型可表达不代表所有 SDK／模型都支持。
- 公开消息不是 checkpoint；不实现跨 harness 通用上下文。
- MCP 连接配置、工具 SDK 包装与 Skills 装配属于本包；业务工具的授权、IO 与业务规则由 host 提供。
- Tool、MCP、Skills 是确定的必备接入边界，现在建立公共契约；当前 OpenAI adapter 明确拒绝这些配置，不能宣称三个 SDK 都已接入这些能力。
- 生产入口没有默认 provider、模拟输出或自动云端调用。离线接入测试使用明确标注的模型／transport 替身。

## 当前可用入口

`createOpenAIHarness({ client, model, sessions, instructions?, modelSettings? })` 由可信 host 显式装配，固定配置不混入 session 或 turn。模型服务与会话后端独立：必填的 `sessions` 通过 `open(nativeSessionId?)` 返回官方 SDK `Session`，`resumable` 声明 host 已验证的恢复能力。packages 不选择文件／数据库，不提供默认 Conversations 或内存回退；业务侧负责授权、存储与连接生命周期。原先只传 client／model 的 OpenAI 装配需要更新，公共多 harness 契约不变。

最小实现支持有序文本输入、文本事件与结果、SDK 原生历史续轮、本 wrapper 内的单 writer、请求中断及等待收尾的 dispose。`resume` 取决于所选会话装配；同一 ID 重开不是跨后端迁移或任意执行 checkpoint 恢复。

当前公共 adapter 已通过一次兼容网关的真实两轮文本验收：官方 MemorySession、`resumable: false`，验证流式输出、最终结果和同会话原生历史，不依赖 Conversations。这不是完整通用 Agent 或生产持久恢复验收。文件输入、工具、MCP、Skills 和公开推理摘要尚未接入；请求不会被静默忽略。`cwd` 不改变普通 SDK Agent 的进程工作目录，也不授予文件系统访问。详细使用与边界见 [OpenAI 接入](src/openai/README.md)。

## 契约组织

```text
src/
  contract.ts
  tool.ts
  mcp.ts
  skill.ts
  index.ts
  pi/
  openai/
  claude/
```

`contract.ts` 持有输入、session、run、provider 与能力声明；引用三个具名模块，不为少量输入类型另拆 `input.ts`，也不在每个小目录中重复放 `contract.ts`。SDK 特有的装配留在 adapter；模块出现真实的多文件职责后再扩成目录。

## 文件输入与传输

产品 API 可以接受业务 `fileId`，但 host 在进入 harness 前负责校验归属并准备来源。`HarnessTurnInput.content` 只包含有序文字和文件；文件带 `mimeType`、可选 `filename`，`source` 为标准 `URL` 或 `Uint8Array`。这是执行侧类型，不是前端上传或消息 JSON 协议；前端不必重复发送文件内容。

harness 不查询业务文件表、不持有对象存储客户端或账号凭据。host 提供已授权来源；adapter 按原生 SDK 需要准备输入，不静默丢弃或重排不支持的表达。临时 URL 不是永久文件身份，产品持久记录仍由 host 管理。

两个文件工具只是普通 `HarnessTool`，由 host 在工具装配处实现，通过现有 `OpenHarnessSessionOptions.tools` 注入；不在 harness 新建 `file-tools.ts`、工具工厂或文件系统接口。

| 工具 | 模型输入 | 返回事实 |
| --- | --- | --- |
| `download_file` | `source`、工作环境内的 `destination` | `path`、`sizeBytes` |
| `upload_file` | 工作环境内的 `path` | `uri`、`filename`、`mimeType`、`sizeBytes` |

host 绑定工作环境与存储策略，负责来源准入、路径边界（包括 symlink）、取消、大小限制和授权交付；模型不选择 bucket、账号或发布权限。传输失败应保留失败语义，不返回伪成功，也不把凭据或带令牌的来源写入普通日志。工具返回文件引用，不代表文件内容自动进入模型上下文，更不代表上传后自动公开。

上述是工具注入约定，当前没有生产传输实现。原生输入不要求 Agent 先调用下载工具；是否下载处理或上传交付由 Agent 决定，不设固定步骤。

### Tool

`tool.ts` 定义注入的自定义工具。当前借用官方 MCP Tool / CallToolResult 类型描述，并不要求进程内工具走 MCP 连接；实际 SDK 映射仍需验证和收敛。不编写通用 schema 转换引擎。

原生文件、终端等工具保留 SDK 定义与行为。业务实现由 host 注入并负责输入校验、授权与幂等；不建立全局工具注册中心。

### MCP

`mcp.ts` 定义可信 host 提供的 stdio / Streamable HTTP 连接配置。官方 MCP SDK 是直接依赖；连接与关闭使用各 adapter 公开支持的机制。

不接受模型授予的连接权限，不将环境变量或 headers 写进日志和恢复快照。当前没有连接实现，不会启动子进程或请求远端。

### Skills

`skill.ts` 定义原生加载配置，通过 `OpenHarnessSessionOptions.skills` 传入受信目录；各 adapter 使用官方机制，不自造 SKILL.md parser、检索服务或 loader。

`video-editing/SKILL.md`、脚本和参考资料属于业务技能资源，不放在本包源码中。没有默认技能 bundle，也不照抄参考项目的双端固定路径要求。

发现、加载与执行脚本分别看待；技能不是自动授权，不伪造统一 load_skill 事件。adapter 对不支持的请求应明确拒绝，不能静默丢弃配置。

## 离线 SDK 接入测试

`tests/sdk/` 通过三个真实 SDK 的公开入口捕获本地行为，合成素材在 `tests/fixtures/`；不属于 `evals/`，不实现生产 adapter。

```sh
pnpm exec vitest run packages/harness/tests/sdk
```

从仓库根目录运行。根 Vitest 已发现这些测试，harness typecheck 包含测试目录；生产构建仅包含 `src/`。

- Pi：公开 faux provider、真实 session／工具 loop、原生 JSONL 保存与重新打开。已确认高层入口将文字合并后置图片，不能保留任意交错。
- OpenAI：真实 Responses 请求转换、结构化工具图片／PDF、原生 RunState 序列化与历史续轮；同时验证默认 Responses 拒绝 core audio。文件 URL 可转换不表示原生视频／音频已支持。
- Claude：真实 SDK 到 stdin 的输入帧；内存进程替身仅完成握手，不运行原生 CLI，不验证工具媒体或历史恢复。

执行 fixture 按 `pi-session`、`openai-responses`、`claude-stdin` 命名，子进程运行入口是 `run-sdk-fixture.ts`；`tests/input.test-d.ts` 由 harness 类型检查验证输入边界。

各 SDK fixture 使用隔离的临时 HOME、白名单环境、本地替身与常见 Node 网络路径阻断；不使用云凭据、不发真实模型请求。这不是操作系统级网络隔离，也不是模型理解或生产恢复验收。完整结果与限制见 [输入调研记录](../../docs/input-research.md)。
