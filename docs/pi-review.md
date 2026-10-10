# Pi 文本执行闭环审查

本次实现与验收针对官方 Pi SDK **1.1.0**，生产与评测共用同一 `createPiHarness`。这是包级文本切片，不是完整 Agent 产品，也不将 OpenAI 的 Agent／Runner／RunResult／RunState 形状强加给 Pi。

## 1. 架构与边界结论

host 提供已装配的原生 `AgentSession`。SDK 拥有 loop、工具执行、history、原生重试与 compaction；harness 只拥有本地提交、owned prompt 的 join、非取消观察与显式释放。

没有新增通用 session engine、工具 registry、统一 checkpoint、原生执行结果替身或模板 Workflow。Pi 没有会话级 context／output 泛型，不为形式对称添加虚构类型关系；原生工具的 schema／details 泛型仍在 host 装配时保留。

不同 SDK 的正常失败策略保留差异：Pi fulfilled prompt 可以携带 error assistant，当前 turn 拒绝但可继续新 turn；不复制 OpenAI 的 exact receipt／failed-owner gate。Pi deferred 对应 paused，但不提供审批 checkpoint；活授权 hook 仍是执行中的原生 Promise。

## 2. 逐文件、逐动作审查

### `pi/adapter.ts`

| 动作／类型 | 审查事实 |
| --- | --- |
| `createPiHarness` | 小 factory 固定 source binding，只暴露 provider 合同；不创建或修改 SDK 能力图 |
| `PiSessionConfig`／prompt options | 使用原生 `AgentSession`／`PromptOptions`；images 属于有序输入，当前文本切片不接受附件 |
| `openSession` | snapshot → admission → host allocation → native ID validation → wrapper；host 得到独立 request 副本，不能反改校验身份 |
| `assertSessionRequest` | 空 ID／不支持 reopening 在分配前拒绝；cwd 授权仍归 host |
| `validateSessionConfig` | 检查实际非空 ID 与请求身份；不推断文件存在、租户授权或 durable 恢复 |
| `closeFailedOpening` | 只调用已转交 callback；原失败和独立 cleanup 失败用 AggregateError 保留 |

发现并修复：原请求与 host request 的 alias 在跨 await 时允许 caller／host 替换身份。两条独立回归先观察到真实失败，再修复快照边界。

### `pi/session.ts`

| 动作 | 审查事实 |
| --- | --- |
| `createPiSession` | 普通本地状态与 forwarding methods；只浅快照 binding／原生 options，不 clone SDK 图 |
| `runSession` | writer admission、同步文本快照、已有 entry ID 快照、执行启动与独立输出；不消费 events 也会执行 |
| `settleRun` | 在 submit 前建立观察，await 官方 prompt，再分类与投影；finally 解绑观察、释放 writer／done latch |
| `requestInterruption` | 旧 handle 身份 guard；记录请求并 join 每次原生 abort，不把全 Session abort 当成 invocation-specific signal |
| `interruptExecution` | 等 owned prompt 完成，再等待原生 abort 请求；不把 native idle 当成任意 preflight／extension 工作完成 |
| `disposeSession` | 先发布 memoized closing Promise，再触发可同步重入的 SDK 取消 |
| `releaseSession` | 先 join owned prompt；abort 失败仍调用已转交 cleanup，单失败保留原值、双失败聚合 |
| `assertAvailable` | 本地 closed／active、原生 idle 与固定身份；不冒充跨 wrapper／进程 writer 协调 |

发现并修复：早期取消只在 agent 开始时补发，未覆盖 input preflight 之后开始的自动 compaction。使用原生 history、input／compaction hooks 和 SDK signal 做回归，移除 `compaction_start` 分支时失败，恢复时通过。测试历史必须有真实可摘要的旧 turn；仅伪增 usage 而所有文本仍被 retain 不会触发 SDK compaction。

另修复 abort 拒绝时跳过 cleanup 的路径。该回归只注入公开 abort 方法的拒绝，模型与 loop 仍是真实 SDK／faux provider；不把此故障注入当作“正常 SDK 会发生该错误”的证明。

### `pi/request.ts`

`toNativeInput` 是同步完整动作：有序文本直接拼接，保留空白／Unicode，文件明确拒绝。没有 URL 下载、媒体转换、原生命令解释或恢复逻辑。拼接后的字符串与 caller 后续修改无 alias。

### `pi/projection.ts`

| 动作 | 审查事实 |
| --- | --- |
| `subscribeRun` | 建立独立 SDK subscription，只记录原生事实；不启动模型、不等待公开 reader |
| `observeEvent` | 私有平坦分派只记录 assistant／settlement 和通知 operation start；不将所有公开事件转换堆在这里 |
| `toRunStatus` | 在 owned prompt fulfilled 后解释原生 stopReason／aborted；SDK throw 保留原异常，in-band error 保留 message cause |
| `createRunEvents` | 只编排 START → await result → final-message conversion → terminal；观察错误与执行错误分别脱敏 |
| `toMessages`／`toTextMessage` | 最终选中 raw branch 的新增非 error assistant 文本，用原生 entry ID；不修改历史或应用另一套 context-edit 算法 |
| `toFinalMessageEvents` | 独立完整文本 message lifecycle 转换；不是 token callback 队列 |
| `toRunOutcome` | 对共同 result status 做穷尽映射；不伪造原生 RunResult |

明确选择的是**用户展示投影**，不是 SDK model-context projection：SDK compaction／context edits 可能压缩或省略上下文，但 raw history 仍归 SDK。重试失败的 partial text 不作为成功回答公开，原始错误尝试仍在 SDK history；取消的部分文本可以公开。该策略有真实 native retry 回归，不将已有 failed-attempt 文本悄悄当作成功输出。

### 公共入口与测试

- 根入口和 `./pi` 指向实际 adapter；没有空 barrel 或另一份 native contract。保留已有 `./openai`。
- `adapter.test.ts` 验证入口／opening snapshot；`adapter.test-d.ts` 验证具体 SDK binding 与 wrapper-owned images。
- `request.test.ts` 验证有序文本和文件拒绝。
- `session.test.ts` 的行为测试位于前部，真实 SDK 装配在尾部；fixture 在分配目录时就登记 cleanup，工具上下文证据在动作后的断言中检查。
- `native.test.ts` 仅负责独立进程的隔离边界。根 Vitest 有意排除 child suite；正式入口运行 Pi 目录／launcher，不递归执行同一 suite，也不在共享测试进程加载用户配置。

## 3. 真实模型 E2E

用户授权后，使用本地 Pi **1.1.0** CLI 的公开 ModelRegistry 取得实际模型与原生鉴权绑定。实际选择为 **openai／gpt-5.5**，不同于静态 settings 中的默认 Codex 选择。直接 SDK Runtime 没有 CLI 的 runtime key 时确实返回 No API key；未把这个失败冒充一次模型成功。

临时扩展通过公开 SDK API 取得普通鉴权绑定，经私有 stdin pipe 交给独立 **Node 24.21.0** 测试进程，再由原生 API 装配内存凭据 Runtime、AgentSession、工具和临时磁盘 SessionManager，运行的是本包**生产 dist**。不序列化或重建现有 SDK 图；新测试进程自行按原生公开配置创建自己的 graph。不读取或输出密钥文件内容，不把凭据写入 fixture／报告；不修改用户 settings、SDK 源码或 process.env。官方 CLI 只承载这次 host 装配，生产 adapter 不依赖 CLI。

最终矩阵 **6／6 passed**：

| 场景 | 可观察证据 |
| --- | --- |
| 有序文本／完整事件／原生 history | 随机 marker、最终文本事件、真实 entry ID、磁盘文件存在 |
| fresh 原生 session 按授权 ID 重开 | 第一 binding dispose，SDK 重新 open 文件；模型从上一轮 history 回答未放进新 prompt 的 marker |
| 原生工具发现与执行 | 模型通过 native tool 取得不在 prompt 的隐藏 marker，toolResult 写入 history，执行一次 |
| gated native tool 期间关闭 reader | 工具仍在执行；关闭 events 不停止 loop，释放 gate 后模型完成 |
| 实际模型文本流取消与后续 turn | 收到真实 text_delta 后 interrupt，result cancelled；下一轮完成新的 marker |
| 原生 compaction 与后续推理 | 官方 `compact()` 生成真实摘要、写入 compaction entry；模型从摘要继续回答原 marker |

compaction 最初的短历史样本返回 Nothing to compact（没有可摘要前缀），不是服务／SDK 故障。修正测试 retained-tail 大小后执行的是同一官方 compaction，没有摘要替身或 fallback。

材料仅保留在 `/tmp/mha-pi-live-review`：`live-extension.mjs`、`node24-launcher.mjs`／`live-node24.mjs`、`live-report.json`／`runtime-report.json`、合成原生 history 和 red/green 调试证据。它们不进入正式默认测试、仓库或依赖。最终报告只记录 SDK／模型标识、用例结果与耗时，不记录凭据；模型上游映射和效果质量不由此推断。

## 4. 验收边界

真实 SDK 离线回归另覆盖 writer 冲突、in-band error／native retry、input handled／deferred、旧 handle、reader 关闭、early preflight／compaction cancel、dispose 重入、opening 双失败与 abort 故障后的 cleanup。

本轮不声称实时 token UI、文件输入、完整 tool／approval UI、全部 MCP／skills／search 服务、deferred retrieval、生产隔离、跨进程 writer、crash recovery、产品 Thread／Turn／Web／Worker 或 Claude adapter 已完成。它们保留原生装配入口，不通过便捷 wrapper 降级或模拟。

本地 fresh verification：frozen install、`pnpm check`（Biome／全仓类型检查／59 个 outer tests／构建）、17 个独立进程原生 SDK tests、root／Pi／OpenAI built exports、11 个 changed TS 路径的 LSP error 检查和 Web health Playwright 1 项通过。outer runner 的 59 包含 1 个 child launcher，不把它误计为 59 + 17 个互不重叠的用例。

提交后跟踪 exact commit 的 GitHub CI；CI 不持有本地模型凭据，不执行付费模型矩阵。单元绿灯不代替上述真实模型证据，也不代替产品验收。
