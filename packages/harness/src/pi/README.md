# Pi 原生接入

当前完成包级文本执行闭环，使用官方 Pi SDK 1.1.0。入口为 `@multi-harness/harness` 或 `@multi-harness/harness/pi` 的 `createPiHarness`；不是产品 Turn API，也不是 CLI 包装器。

```ts
createPiHarness({
  resumable: historySourceResumable,
  open: async ({ cwd, nativeSessionId }) => ({
    session: await openAuthorizedNativeSession({ cwd, nativeSessionId }),
    promptOptions: { expandPromptTemplates: false },
    dispose: closeTransferredSessionResources,
  }),
});
```

`openAuthorizedNativeSession`、资源与授权由 host 提供，示例不暗示 SDK 默认配置具备租户隔离。

## 原生装配与 ownership

host 直接返回已装配的官方 `AgentSession`。模型 Runtime、原生工具／schemas、extensions、MCP、skills、资源加载、settings 和 `SessionManager` 保留在原生图中，不复制配置、不重建 loop、不 deep-freeze SDK 对象。

- SDK 拥有模型／工具 loop、原生 history、重试、compaction 和原生队列。
- harness 拥有本地提交准入、同步文本快照、owned `prompt()` 的 join、结果观察、取消与已转交资源的释放。
- host 拥有授权、凭据、预算、IO、存储、原生扩展绑定、独立操作和跨 wrapper／进程 writer 协调。

SDK 默认设置、环境凭据发现、可执行资源 discovery 和 cache warming 不是云端租户策略。`cwd` 不是 sandbox，session ID 不是授权凭据。host 应在 SDK 原生装配处明确 scope 和开销策略，不能在共享 Runtime 上逐租户轮换凭据。

只有 `dispose` callback 明确转交收尾 ownership；未提供时，wrapper 不隐式销毁借用的 `AgentSession`。完整 extension shutdown／MCP hooks、runtime shutdown 和 detached work 仍由 host 通过真实原生 lifecycle 等待；裸 `AgentSession.dispose()` 不保证这些工作都已结束。

## 提交与结果

- `content` 当前仅支持有序文本，直接拼接，不 trim 或插入分隔符。文件明确拒绝，不下载、转换或忽略。
- 单次提交调用原生 `session.prompt()`，等待其 Promise；不在 `agent_end` 或 `agent_settled` 提前结算。fulfilled prompt 仍可能包含原生 error／aborted assistant。
- 普通 provider error 拒绝当前 result，保留私有错误及原生 message cause；允许后续正常提交，不照搬 OpenAI 的失败 owner／receipt gate。
- 公开消息采用本次最终选中原生分支中新增的非 error assistant 文本，ID 是原生 session entry ID。失败重试文本仍在原生 history 中，但不作为成功回答公开；取消的部分文本可以保留。公开消息不是 SDK model-context projection，不替代原生 context edits、compaction 或恢复 authority。
- events 当前输出结算后的完整文本事件，**不是实时 token stream**。不消费或关闭 events 不取消执行；公开错误脱敏，观察异常不替换私有 result。
- 原生 input hook／extension command 可以处理输入而不调用模型，此时正常返回 completed／空 messages。request mapper 不解释命令，不代表 `prompt()` 不解释；是否展开命令／模板由 native `promptOptions.expandPromptTemplates` 决定。
- 原生 deferred assistant 对应 paused；不是 OpenAI 审批 receipt，也不提供通用 continuation。deferred handle 仍由 host 从原生 session 读取并通过 SDK 管理。活审批 callback 不映射为提前返回的 paused。

`resumable` 仅声明 host 已验证按授权 ID 重开 history。host 必须核对来源存在、cwd／身份与版本，不能利用 SDK missing-path 行为偷偷新建。磁盘 history 重开不等于 crash recovery、workspace 恢复或跨进程互斥。

## 取消与释放

`interrupt()` 请求原生 `abort()` 并 join 本 wrapper 拥有的 prompt。Pi 没有 prompt 级 AbortSignal：输入 preflight 中的早期请求，会在随后开始的原生 agent／compaction 上重新请求取消。不可取消的 host hook 必须自己响应原生 signal 或 host 的截止时间；wrapper 不强杀代码。

旧 run handle 不会取消新的 invocation。dispose 先发布唯一 closing Promise 再取消，等待 owned prompt 后调用显式 cleanup 一次；abort 与 cleanup 双失败保留为 AggregateError。此边界不宣称 join 所有 SDK／extension 独立操作。

## 源码与验证

- `adapter.ts`：公共 binding、opening 快照、准入、原生身份校验与失败清理。
- `session.ts`：本地 writer、原生提交／join、取消与释放；不解释 SDK event 类型。
- `request.ts`：同步有序文本映射与文件拒绝。
- `projection.ts`：独立原生事实观察、终态分类、entry → message 与公开 event 转换；不拥有执行 loop。

```sh
pnpm check
pnpm exec vitest run packages/harness/src/pi
```

`native.test.ts` 在临时 HOME、白名单环境与离线配置的独立进程运行相邻 `session.test.ts`，使用真实 SDK／原生工具与官方 faux provider 替换模型 IO；不读取用户配置、凭据或 history。根 runner 有意排除 child suite，不要直接用根配置运行 `session.test.ts`。内存 history 测试验证记录与 entry ID，不声称磁盘耐久性。

用户授权后的真实模型测试使用本地 Pi 的原生鉴权绑定、生产 dist、实际模型／工具与临时磁盘 history；材料只放 `/tmp`，不进入默认测试或仓库。逐文件审查、真实结果和未验收范围见 [Pi 审查](../../../../docs/pi-review.md)。
