# Claude 原生接入

固定 `@anthropic-ai/claude-agent-sdk` **0.3.295**，使用公开 `query()` 与 `Query`，不围绕已在 0.3.142 移除的 V2 Session API 建壳。当前完成包级**文本切片**，尚未接入产品 API／Worker／Web。研究、审查与真实验收见 [Claude 审查](../../../../docs/claude-review.md)。

## 入口与原生装配

根入口与 `@multi-harness/harness/claude` 导出 `createClaudeHarness`、`ClaudeHarness`、`ClaudeSessionConfig`、`ClaudeSession`、`ClaudeRun`、`ClaudeTurnResult` 与 `CreateClaudeHarnessOptions`。

```ts
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeHarness } from '@multi-harness/harness/claude';

const harness = createClaudeHarness({
  resumable: verifiedHistoryReopening,
  open: async ({ cwd, nativeSessionId }, prompt) => {
    // The host authorizes workspace/history before allocating the native process.
    await authorizeNativeBinding({ cwd, nativeSessionId });
    const id = nativeSessionId ?? randomUUID();
    return {
      nativeSessionId: id,
      query: query({
        prompt,
        options: {
          cwd,
          model: authorizedModel,
          env: scopedCredentialEnv,
          settingSources: [],
          strictMcpConfig: true,
          permissionMode: 'default',
          persistSession: true,
          ...(nativeSessionId === undefined ? { sessionId: id } : { resume: id }),
          // Native MCP servers, hooks, subagents, outputFormat and tools are host bindings.
        },
      }),
    };
  },
});
```

示例中的授权、模型、env overlay 与历史能力声明均由 host 提供，不是包内默认服务。`sessionId` 是新会话的有效 UUID；恢复用 `resume`，不得同时带普通 `sessionId`／`continue`。账号、模型、工作目录与 SDK 配置不会从本包全局状态读取；SDK 自身仍有原生默认，host 必须显式控制。

`open(request, prompt)` 的第二个参数是 wrapper 拥有的**持续输入 iterable**，直接传给原生 `query({ prompt, options })`。host 不消费该 iterable、不加另一个输出 reader、不另投 prompt；可以保留 Query 引用做经过协调的原生控制。不要逐 turn 调用 `streamInput(finiteIterable)`：该 iterable 结束会关闭原生输入，不能当成 append 方法。

返回 config 后，Query 的唯一 reader 与 close ownership 转交给 harness。factory 返回前失败，部分资源仍由 host 收尾；返回后 opening 校验失败也会尝试 Query close、bounded return 与显式 `dispose`，保留各失败。额外 `dispose` 仅释放明确转交的 host 资源，不重复关闭 Query 或清空 transcript。

## 身份、执行与观察

- opening 对 caller request 与 host 副本分离，浅捕获 returned binding，不重建／serialize／deep-freeze Query 或工具 graph。
- `nativeSessionId` 先取 host 选择／授权的 ID，之后对原生 frame 核对。`initializationResult()` 不含 session ID；opening 本身不是 transcript 已建立或 resume 已成功的证明。
- 一个 live HarnessSession 保留一个 Query。SDK 自己运行 subprocess／agent loop、原生工具、重试、compaction 与 transcript；wrapper 持续 drain 原生消息，避免无人观察时不结算或 native queue 累积。
- 一个本地 writer，一次投一条带新 UUID 的 `SDKUserMessage`；没有 wrapper prompt backlog。result 必须归属于这一 UUID，未知／合并多 writer／额外 queued turn 不能猜给当前请求，reader 或身份异常使 session fail-closed。
- 需要当前 producer 支持普通 UUID prompt 的 result attribution；较旧／自定义 CLI 缺少 attribution 时明确拒绝，不把无归属的启动失败或其他结果伪装成成功。
- native `result` 是 turn receipt，不是 `system/init`、compaction/status、token EOF 或任意后台任务结束。`subtype: success` 仍可能 `is_error: true`；execution error 拒绝 private result，public error 脱敏。
- result 的 `native` 保留官方 `SDKResultMessage`：structured output、usage、deferred tool 等只留可信服务端；不把完整对象 spread 到浏览器。
- public messages 选择本 turn 顶层、非 error assistant text，按 **wire UUID** 区分 split content blocks；API message ID 可能复用。subagent、tool、thinking 不当成公开回答。按 `supersedes` 和 refusal-resolution notice 删除撤回文本。
- public events 是**结算后的完整文本**，不是实时 token stream。它不直接借用 Query iterator、不建立另一份 SDK 输出队列；不消费或 return public events 不停止原生执行。

原生 structured output／工具终态可以没有公开 assistant text，不从 `result.result` 伪造另一份回答。公开 display messages 不是 model context 或可恢复 checkpoint。

## 中断、暂停与释放

`interrupt()` 使用公开原生 `Query.interrupt()`，等待 ACK；是否 cancelled 取实际原生 outcome，不取请求标记。结果可能先于 ACK 到达，因此已发出的 session-scoped interrupt 必须先结算，再放行下一 turn；无 interrupt 时结算不额外 yield，防止 late interrupt 从 writer 释放间隙进入。旧 handle 不能中断新的 turn。ACK 失败无法建立 fence，立即拒绝本地 result 并封锁新提交，不再等下一条 native receipt。失败不证明原生执行已停止：owner 仍保留到 receipt／EOF 或 dispose，host 必须 teardown／reconcile。

`terminal_reason` 的原生 abort 映射 cancelled；`tool_deferred` 映射 paused，保留 native receipt，但**不提供虚假的公共审批 continuation**。`canUseTool`／hook 活等待仍是 active run，不提前返回 paused。普通 attributable turn error 与 reader／身份失败不同：前者可以在同一 live Query 再开 turn，后者需 host 核对后重开。

`dispose()` 先关闭准入并发布共享 Promise，再唤醒／结束自有 input、调用 Query close、等待公开 return 与 reader、等待已发 interrupt，最后尝试转交的 host cleanup。close 失败不能跳过 return，return 拒绝也不能跳过 owned reader join；各阶段分别尝试，保留失败，包括 dispose 捕获到的失败 interrupt fence。SDK `close(): void` 不能 await；`return()` 是 SDK **有界清理 receipt，不是 OS 进程退出或全资源图完成证明**。严格进程退出、后台工作与外部副作用的核对属于 host；不因 transcript 可重开而宣称 crash recovery。

## 原生配置的安全边界

0.3.295 的 `settingSources` **省略时会读取全部 filesystem sources**；不要套用旧的“SDK 默认不读配置”说明。显式 `[]` 与 `strictMcpConfig` 用于本轮隔离，但不是 OS sandbox。host 可以按授权使用项目设置／skills，不由 wrapper 做 portable capability 白名单。

`allowedTools` 是预批准，不是工具可见性白名单；`canUseTool` 不是每次调用都会进入的强制授权拦截器。需要必经检查时使用原生 `PreToolUse`／业务执行边界。默认不 bypass，不自动保存建议权限。callback 必须遵守 native abort signal；`cwd`、native ID、tool schema 都不是租户授权。

不要在共享进程轮换 `process.env`。凭据通过 per-query native `Options.env`／已授权的 native mechanism 装配；Query graph、MCP instance、hooks 与资源 scope 由 host 保留。root SDK 与 `/core` 不在同一进程混用。

## 源码与检查

- `adapter.ts`：公开合同、trusted host binding、opening 准入／快照／失败收尾。
- `session.ts`：本地 writer、唯一 native reader、submission、interrupt fence、dispose。
- `request.ts`：同步文本映射与持续单 slot 输入；文件当前明确拒绝，不做媒体 IO。
- `projection.ts`：原生消息事实、终态分类、顶层文本与 public events；不调度 loop。
- `session.test.ts`：临时 HOME／白名单 env 的正式 isolated launcher。
- `session.sdk.test.ts`：真实 installed Query／ProcessTransport，只有 process IO 被替换；不启动 CLI，不使用用户配置／凭据。
- `adapter.test.ts`、`request.test.ts`、`projection.test.ts`、`adapter.test-d.ts`：opening／输入、公开投影与原生类型回归。

```sh
pnpm exec vitest run packages/harness/src/claude
pnpm check
```

真实模型脚本与合成 history 仅在 `/tmp`。用户另行授权后的 Node 24 生产 dist／原生 CLI／腾讯云测试 key 前一轮验收为 **6/6 passed**，包括新进程 disk resume、真实 SDK MCP loop、权限等待中的 interrupt 后再执行、structured output；报告不含 key。它不代替生产租户隔离、跨进程 writer、crash recovery、实时 UI、文件、后台任务、完整审批／defer 和 compaction 的专项验收。
