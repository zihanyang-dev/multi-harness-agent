# Harness 接入

生产执行与评测共享的原生 SDK 接入边界。当前有 OpenAI 原生 adapter、Pi 与 Claude 包级文本 adapter。认证产品 API 已通过 PostgreSQL、outbox、BullMQ 和 Worker 接通 Pi `text-v1` 执行与正式结果落库；Web 仍只有 health 页面，OpenAI 与 Claude 尚未接入这条产品执行路径。已实现不等于生产全量验收，当前边界与验证见 [Thread／Turn 设计](../../docs/thread-turn-design.md)。

版本固定为 Pi 1.1.0、OpenAI Agents SDK 0.20.0、Claude Agent SDK 0.3.295。保留官方 loop、原生 history／RunState、compaction 和能力差异，不编排视频或编码 Workflow，不建立第四执行框架。

OpenAI 使用 SDK 结果与原生 iterator；Pi 等待官方 prompt 并观察原生事实，当前输出结算后的完整文本，不是实时 token stream。两者不接管未转交的资源，也不另建主动事件 pump。Claude 转交一个持续 Query 的 sole reader／close ownership；持续 drain 原生结果与公开 settled-text 观察分开，不重写 SDK loop。生产服务尚未全量验收，不能把包级测试当作产品验收。API 与限制见 [OpenAI 接入](src/openai/README.md)、[Pi 接入](src/pi/README.md)、[Claude 接入](src/claude/README.md)，证据见 [OpenAI 审查](../../docs/openai-review.md)、[Pi 审查](../../docs/pi-review.md)、[Claude 审查](../../docs/claude-review.md)。官方资料、六个业内实际接入与整个包的逐函数重新审查见 [Harness 接入审查](../../docs/harness-integration-review.md)。

## 当前入口与 ownership

`createOpenAIHarness({ resumable, open })` 接收可信 host 的 per-session factory。返回普通原生 binding：`{ agent, runner, session, context?, runOptions?, runState?, dispose? }`。不镜像 SDK client／model／nativeTools 配置，不 serialize、重建或 deep-freeze SDK 对象。

- SDK 拥有模型／工具 loop、handoff、schemas、guardrails、compaction 和原生审批。
- harness 拥有本地 writer gate、输入映射、非取消观察、结果投影与显式取消／释放。
- host 拥有身份授权、工具闭包与 context 作用域、凭据、预算、IO、历史后端、资源和跨 wrapper／进程协调。

`resumable` 只表示 host 验证过 history 按 ID 重开。公开消息不是 checkpoint；RunState 与 history 分开。SDK normal interruption 返回 paused，同一 owner 可以通过精确 native receipt、同步 updater 继续原 root／Runner／Session。SDK／持久化失败 fail-closed，不自动 retry 或猜测 rollback。

OpenAI 的 `result.native` 是官方非 streaming RunResult 的 live view，只供可信服务端。Pi 没有对应的原生结果对象，不造替身；host 保留原始 AgentSession。Claude 的 `result.native` 是官方 SDKResultMessage，不直接公开给浏览器；host 通过 `open(request, prompt)` 将持续 input 接入原生 query，returned Query reader／close 由 harness 拥有。`cwd` 不自动授权文件系统，也不是 sandbox。借用 client、MCP、Runner 和 history 不隐式关闭或清空，只调用显式转交的 cleanup。

## 文件输入与业务传输

输入是有序 text／file；文件 source 为 URL 或 Uint8Array，带 MIME 与可选 filename。host 校验业务 fileId 归属并准备来源，harness 不查询文件表、不持有对象存储 client。

OpenAI 将官方 vision MIME 映射为 input_image，其他有效裸 MIME 为 input_file；同步快照 URL／可见字节，不下载、转写、拆帧、上传或推断 metadata。原生 URL／图片字段不能表达所有业务 MIME／filename，host 自己保留这些事实。映射成功不等于模型接受或理解。

文件传输是 host 的普通原生工具，不在 harness 新建文件工具工厂或文件系统接口：

| 工具约定 | 模型输入 | 返回事实 |
| --- | --- | --- |
| download_file | source、环境内 destination | path、sizeBytes |
| upload_file | 环境内 path | uri、filename、mimeType、sizeBytes |

host 负责来源准入、路径／symlink 边界、取消、大小限制、授权与交付。工具返回引用不代表自动加入模型上下文或公开文件。当前无生产传输实现，Agent 自己决定是否下载处理或上传，不设固定步骤。

## 原生 Tool／MCP／Skills

没有消费者的 portable Tool／MCP／Skills 类型、选项和 capability map 已删除；不保留只有拒绝分支的公共接口。provider 只公开实际的 history `resumable` 声明，不另建 SDK 能力清单。

host 直接使用官方 Agent／扩展／Query 配置装配工具、MCP 与 skills，并管理授权、资源和 scope。harness 不另造工具 schema、loader、registry 或权限引擎。业务技能资源不放在本包源码中。

## 源码与验证

- `contract.ts`：小型公共 provider／session／run／有序输入合同。
- `openai/adapter.ts`：OpenAI 对外类型、唯一 factory 与接入准入。
- `openai/session.ts`：私有普通状态与模块级完整动作，拥有执行／continuation／取消／释放。
- `openai/request.ts`：明确官方内容类型的有序映射与快照。
- `openai/projection.ts`：生成器内部观察状态、平坦 native family 分派与完整转换函数。
- `pi/adapter.ts`：原生 AgentSession binding、opening 快照与准入／清理。
- `pi/session.ts`：本地 writer、官方 prompt join、取消与显式 cleanup。
- `pi/request.ts`：同步有序文本映射，文件明确拒绝。
- `pi/projection.ts`：独立原生事实观察、entry ID 文本选择与 final-text 事件转换。
- `claude/adapter.ts`：native Query ownership、opening 快照与准入／清理。
- `claude/session.ts`：持续 sole reader、UUID submission、writer／interrupt fence、dispose。
- `claude/request.ts`：文本与单 slot 持续 input；不把 streamInput 当 append。
- `claude/projection.ts`：attributable receipt、顶层 wire UUID／撤回、full-text events。

相邻运行测试为 adapter、session、request、projection；`adapter.test-d.ts` 由类型检查验证 native schema／context。真实 Runner／工具／Session 使用官方 `@openai/agents/testing` 替换模型 IO，禁用 tracing。Responses 请求转换使用官方 client 的离线 fetch；不是伪造 loop，也不是 live 模型 E2E。

```sh
pnpm check
pnpm exec vitest run packages/harness/src/openai
pnpm exec vitest run packages/harness/src/pi
pnpm exec vitest run packages/harness/src/claude
pnpm test:e2e
```

E2E 只验证 Web → Hono HTTP health。真实模型、MCP、工具搜索、sandbox 隔离、生产持久恢复和跨进程 writer 尚未全量验收。旧 `tests/sdk/` 与其 fixtures 已删除，不再提供该命令或旧 Pi／Claude 测试作为当前通过证据；历史结论见 [输入研究](../../docs/input-research.md)。当前 Pi 相邻 native suite 通过独立离线进程运行真实 SDK／faux provider，另有用户授权的生产 dist 真实模型矩阵，不能混为一次验收。Claude 另有隔离的真实 Query／custom-spawn IO 回归，以及原生 CLI／腾讯云测试 key 的生产 dist 6/6 真实矩阵；测试 key 不入 Git，也不使用线上覆盖配置，见 Claude 审查。

用户授权后已对新版生产 dist 另跑真实网关／模型矩阵：文本、history、审批／部分批准、handoff、nested agent、schema、fresh context 恢复、取消与恢复、本地 MCP、原生 deferred tool search、PNG／PDF／DOCX／XLSX／CSV 及交错文件顺序通过。完整结果为 22 passed／1 failed，包含两个 AV 拒绝边界检查；WAV／MP4 仍 HTTP 400，原生 Responses compaction HTTP 502。后者绕过 harness 用官方 client 也失败，不加替代 compaction。证据见完整审查，临时材料放 /tmp，不增加正式测试文件／脚本／依赖。构建前清理本包 dist，避免旧输出残留。
