# Claude 接入调研、审查与验收

> 2026-10-11。固定 SDK 0.3.295，不升级依赖。包级文本实现、静态研究、离线 SDK 回归、真实网关／CLI 验收与 secret audit 分开记录；这些证据不表示产品 Agent 或生产恢复已完成。API 与 ownership 见 [Claude 接入](../packages/harness/src/claude/README.md)。

## 1. 官方版本与原生事实

发布 tag `v0.3.295` 指向 commit [`da321bbe62ed45d10a1ff0e77a948253d9eee3e0`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/da321bbe62ed45d10a1ff0e77a948253d9eee3e0)，包声明 Claude Code parity 2.1.295。GitHub release tree 不是完整 SDK implementation source；实际生命周期同时核对安装包 `sdk.d.ts`／`sdk.mjs` 与静态 producer。

安装版 `sdk.d.ts` SHA-256：`e4d91d71404ce4ffc918aa590f545c7a67df6a1dfe5de8cd28a05db0a7fe872b`。主要类型证据：Query 2847 起，interrupt 2861、streamInput 3215、close 3244、query 3247；result 5705–5847、SDKUserMessage 6287 起、SpawnedProcess／SpawnOptions 9513–9600。行号属于这一 npm artifact，不冒充 GitHub 源码路径。

重新核对的官方指南包括 [TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)、[V2 removal](https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview)、[Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、[Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)、[Hooks](https://code.claude.com/docs/en/agent-sdk/hooks)、[MCP](https://code.claude.com/docs/en/agent-sdk/mcp)、[Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)、[Subagents](https://code.claude.com/docs/en/agent-sdk/subagents)。动态指南与精确安装版分开；Context7 额度耗尽，部分 platform URL 被 fake-IP／SSRF 防护拒绝，没有绕过防护。

确定的接入事实：

- V2 Session API 在 0.3.142 移除；本版使用 `query()`，不从旧 demo 推断当前 API。
- query 创建即启动 process／producer／native control reader；公开 iteration 不是 loop 的启动开关。SDK 的 consumer queue 无可见 capacity bound，wrapper 需要持续 drain。
- 一个持续 input iterable 承接多 turn；`streamInput` iterable 结束会 endInput，不能逐条调用来 append。
- native result 是 turn-complete receipt，informational／background frames 可以继续。success subtype 也可能 is_error。
- 用 prompt UUID 归属 receipt。新 producer 支持普通 UUID prompt 的 attribution；旧 producer／session-scoped failure 可能没有 attribution，必须 fail-closed，不能凭“只有一个 active”猜结果。
- interrupt 是 session-scoped control ACK，不绑定 prompt UUID，也不等待 result；result 可以先到。close 是 void，return 等待 SDK 有界 cleanup，不保证 OS exit／所有 MCP 与外部工作结束。
- `initializationResult()` 没有 session ID；新 ID 用 sessionId，恢复用 resume，普通情形不能同时传。persisted transcript reopening 不等于 crash recovery。
- 0.3.295 省略 settingSources 会加载全部 filesystem sources；allowedTools 是预批准、不是工具可见性限制。必经授权不只靠 canUseTool。

## 2. 三个真实 TypeScript 接入的完整链路

以下仅静态读源码／版本／测试意图，不运行第三方代码，不把“有测试”说成“测试通过”。三个案例都直接 import TypeScript Claude Agent SDK；没有拿 Python、CLI print 或 HTTP client 冒充。

| 案例与 source pin | 版本／许可证 | 实际路径与取舍 |
| --- | --- | --- |
| [Anthropic demos](https://github.com/anthropics/claude-agent-sdk-demos/tree/826b268506a5f3707623c9e6140b200befcbebae) | hello-world lock SDK 0.1.14；simple-chatapp lock 0.1.53；仓库级 license 未确认 | chat Session → AgentSession → query(long-lived async input) → 持续 listener → display store。借鉴 native Query continuity；不复制 queue close 不唤醒 pending waiter、没有 Query close／listener join 的 teardown。 |
| [Hankweave](https://github.com/SouthBridgeAI/hankweave-runtime/tree/9ea76bbb826becb6ab148bec9dd3aeb00b410c61) | 0.12.0；SDK 0.3.267；Apache-2.0 | CodonRunner → ClaudeAgentSDKManager.spawn/runQuery → string query → native resume／SessionStore → logs／events → abort／bounded query join。借鉴 execution-scoped native history；不复制默认 bypass、synthetic PID、关闭 log 未总是等待 callback 或 timeout race 当作退出证明。 |
| [Zed／ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp/tree/4e1fc1e8df2b9af3b1b2d6880ba90c5862283ba8) | 0.89.1；SDK 0.3.293；ACP SDK 1.8.0；Apache-2.0 | createSession → native Query／input → UUID startTurn → 单个 persistent consumer → approvals／cancel → explicit session disposal。借鉴 ID 分工、native resume、持续 consumer；不移植 12k 行 ACP compatibility／background joins。 |

精读文件：demos 的 `hello-world.ts`、`simple-chatapp/server/{ai-client,session,server,chat-store}.ts`；Hankweave 的完整 `server/claude-agent-sdk-manager.ts` 与 CodonRunner 装配／提交／清理；ACP 的 `src/{index,serve,utils,resumed-session}.ts` 和 `acp-agent.ts` 的 opening、submission、完整 consumer、permission、resume、cancel／dispose 段。

旧 `zed-industries/claude-code-acp` 已重定向到上述 ACP 仓库；其正常 ACP 路径是 SDK-backed，单独 `--cli` 才是 native CLI inherited stdio。OpenHands 的有限 inspection 未建立一个直接 Claude SDK lifecycle，故不凑成第四案例。ACP 的 protocol v2 也不等于已移除的 Claude SDK V2 Session API。

## 3. 实现与代码品味审查

保留小型公共 provider/session/run 合同与四个有完整职责的模块，不建设另一个 agent loop：

- adapter：trusted factory 与公开类型；opening request 私有快照、host 副本、returned binding 浅捕获；准入先于 process 分配，失败清理不丢失原错。
- session：普通状态与连续动作，唯一 native reader、一个 writer、新 UUID submission、interrupt fence、发布 closing 后 teardown。
- request：同步 ordered text 与持续单 slot handoff，不做 IO、不自建 prompt backlog；SDK 自己保留 queue／command／history semantics。
- projection：原生 receipt classification、顶层 consolidated text、wire UUID／supersession、settled full-text events；不解释工具或调度模型。

函数内注释聚焦：authority capture、输入 slot 与 session gate 的不同 owner、Query return 的取消含义、result／interrupt ACK 次序、无 fence 时不能额外 yield、subagent privacy boundary、refusal eviction、可恢复 turn error 与失败 reader、reentrant disposal、有界 cleanup 与实际 OS exit 的差别。没有拆成一次赋值的微型 helper，也没有用统一 state machine 强迫 SDK 对称。

审查实际发现并修复：

1. result 先于 interrupt ACK 时，旧 control 可能打到下一 turn。把已发 interrupt 的 fence 留在 writer 释放前，ACK 失败 fail-closed。
2. `await undefined` 也会 yield；reader 检查无 fence 后、释放 writer 前可以被 late interrupt 插入。改为只对存在的 stopping await，真实 SDK iterator 边界调度回归先看到一条错误 interrupt，再改为零。
3. assistant supersedes 不是完整撤回事实；同时处理 `model_refusal_fallback.retracted_message_uuids`，避免结算后重放旧 refusal text。
4. close 抛错不能跳过 return receipt 与 host cleanup；分别尝试，单失败原样、多失败 AggregateError。
5. 最终整轮审查发现 return receipt 拒绝会跳过 owned reader 的 join。新增独立延迟 reader 的 SDK regression，先看到 host cleanup 提前执行，再把 reader join 改为独立阶段。
6. ACK 拒绝且没有后续 result 时，失败报告原本一直等待 receipt。新增该次序的 SDK regression，先观察到 result 未结算，再改为立即拒绝本地 result／封锁准入；不清除仍未知的 native execution owner，host 仍须 teardown／reconcile。dispose 捕获到的失败 fence 也会保留。

上述行为回归均观察真实 RED 再 GREEN。第一轮完整 opening 尚未实现时，14 个 SDK cases 全部失败；后续独立 regression 分别覆盖 retraction、ACK fence／拒绝、close throw 和 late interrupt。factory／输入／原生类型有相邻检查。最后一轮覆盖四个实现模块、相邻测试、导出／文档与共享边界：projection 按 native frame family 平铺分派，去掉 UUID fallback 的嵌套三元；原生 error subtype 与 success-is_error 分开；public events 明确分开等待 receipt 与投影失败，不再二次 await receipt 猜错误来源。只有完整的 settled-text event 转换成为私有 helper，没有拆一次赋值。新增 5 个 characterization cases 在重构前后均通过，另补 returned binding 校验清理、各清理失败与 plural／merged／queued attribution 覆盖。独立审查没有要求新增 manager、registry、通用 cleanup runner 或 portable capability 白名单。

## 4. 离线与真实模型证据

正式 SDK suite 由 `session.test.ts` 启动白名单 env／临时 HOME 的独立进程，`session.sdk.test.ts` 不直接进入 root suite。使用 installed SDK 的真实 Query／ProcessTransport，只替换公开 `spawnClaudeCodeProcess` IO；不运行 CLI、不读用户配置／credential／history。24 个 cases 覆盖 submission、observe return、writer、interrupt races、native error／same-Query recovery、identity／attribution fail-closed、EOF、dispose／close failure、text-only admission、wire UUID、refusal retraction 和 deferred receipt。

用户随后明确授权使用同级 pexo 的腾讯云**测试 key**。只读取被明确标注为 `pexo-agent-test` 非生产默认值的指定 binding，未读取生产 override；模型与 gateway 从相应配置核对。key 只经 private stdin／per-query native env 进入验收进程，不输出／写入脚本、报告、Git；不 mutate 共享 process.env。独立 HOME／workspace／transcript 都是合成资源，脚本和材料只在 `/tmp/mha-claude-live-review`。

前两次 `claude-sonnet-5`／`claude-sonnet-4-6` 都 HTTP 400 model-not-available，不能算通过；查到腾讯配置实际 vendor slug **`cd-sonnet-5`** 后正常运行。网关协议与模型 slug 不证明独立核验过上游模型身份。

最终品味审查前的真实验收使用 **Node 24.21.0 + production dist + SDK 0.3.295 + 原生 CLI + 腾讯 VOD AIGC Anthropic gateway + 测试 key**：

| 场景 | 结果 | 耗时 |
| --- | --- | --- |
| ordered text、native receipt、final public events | passed | 2806 ms |
| public observer return 不取消；同 Query 记住前 turn marker | passed | 2193 ms |
| 新 native process 按授权 ID 重开磁盘 history／marker 推理 | passed | 2394 ms |
| 官方 SDK MCP discovery／真实模型 tool-result loop | passed；一次真实工具调用 | 8288 ms |
| 真实权限 callback 等待中 interrupt；不执行拒绝工具；后续 turn | passed | 4768 ms |
| native JSON schema structured output 留在 private receipt | passed | 2471 ms |

矩阵 **6/6 passed**。host 使用公开 custom spawn 启动真实 packaged CLI，并独立观察到全部 **5 个 owned process 的 OS exit**；这是该验收 host 的额外证据，不把它提升为 adapter.dispose 的通用保证。取消项验证 permission wait 中断，不冒称所有 HTTP streaming／后台任务取消都验收。fixture process IO、原生 CLI、真实网关三种证据不混称。

前一轮 fresh local verification 使用 Node 24.21.0：frozen install、`pnpm check`（Biome 73 files、全仓 typecheck、13 test files／70 outer tests、全仓 build）、`pnpm test:e2e`（Web → real HTTP health 1 passed）与 production root／三个 native subpath identity smoke 均通过。当轮一个 outer Claude launcher 另执行 19 SDK cases，Pi launcher 保留原 17 cases；不把它们简单相加当独立测试总数。首轮 LSP probe 的 3 个辅助规则 findings 判定为 typed-domain false positives，1 个 push-only 路径曾未确认 clean；收尾再次主动检查 **11 个 touched TS paths，全部 confirmed clean、0 errors、0 inconclusive**，并有独立全量 tsc 通过证据。7 份改动文档的相对链接检查与 diff whitespace 检查均通过。

本轮最终品味／生命周期修复后重新使用 Node 24.21.0 执行 frozen install、`pnpm check`：Biome **74 files**、全仓 typecheck／build、**14 test files／78 outer tests** 均通过。Claude launcher 独立执行 **24 SDK cases**，Pi launcher 保留 17 cases；新 `projection.test.ts` 5 cases 明确区分私有执行失败与公开投影失败。`pnpm test:e2e` **1 passed**，production root／三个 native subpath identity smoke 通过。主动 LSP probe 覆盖 **12 个 touched TS paths**、零 error／inconclusive；2 个辅助规则命中分别是已声明 AG-UI content union 的 `typeof` narrowing 与 Promise rejection 的 `unknown`，审阅后记录为 false positive，没有为消除提示弱化类型或添加 inline ignore。

root exports smoke 初次从 workspace 根目录执行时因根包不依赖 harness 而 module-not-found，改从 harness package 的 self-reference scope 执行后通过；未为 smoke 添加虚假依赖。当轮 native 矩阵在 production build 后重跑，包含 late-interrupt 修复。之后本轮最终品味／生命周期审查的依据是新回归和重新执行的本地 gates；没有在发现测试 key 的既有 Git exposure 后继续复用该 key。上述 6/6 是明确的前一轮真实验收证据，不冒充最终重构后的 live rerun。

## 5. Secret audit 与未验收范围

独立使用官方 Gitleaks v8.30.1，下载后验证官方 archive checksum，启用默认规则、禁用项目忽略／inline suppress、`--redact=100`，未进行 remote credential validation。

- 非 shallow Git，所有本地 reachable refs 共 **10 commits**，history 无 findings。
- staged diff 为空，无 findings。
- 当时 **98 tracked + 8 nonignored untracked files**，全量扫描无 findings；71 个项目 build files 同样无 findings。
- 52,832 个 ignored dependency paths 只 inventory、不内容扫描；无 node_modules／dist 外的 ignored 项目文件。
- 另把本次授权测试 key 在内存对 **178 history blobs** 与 current project files 精确匹配，零命中。不打印 key、hash、前后缀或敏感 snippet。

最终增量／构建后再次独立扫描：**108 current project files、87 dist files、10 reachable commits／3 refs、空 staged diff**，全部零 findings、无扫描 warnings/errors。授权测试 key 对当前 108 files 与 178 history blobs 的内存精确匹配仍为零。

本轮最终 review／构建后再次用相同官方 scanner 与禁用 suppression 的配置检查：**109 current files、87 dist files、10 reachable commits／3 refs** 均零 findings，独立审查未发现新的 blocker。随后对正式待提交的 **20-file staged diff** 单独扫描，零 findings、exit 0。该轮未再读取测试 key，不把前轮 exact-key match 宣称成新的匹配结果；scanner／snapshot／report 不进入仓库。

另只针对这一个授权测试 credential 核对其来源：同级 **pexo 的 `infra/env/agent.env` 已 tracked，当前 HEAD 确实含有该测试 key**。这是既有 Git credential exposure，不是本次接入写入；本轮未修改 pexo、未读取生产 override，也未扩成 pexo 全部密钥审计。已告知用户应轮换测试 key、改用非跟踪的 secret injection；删除 working-tree 字段不能使历史里的旧 key 重新安全。轮换／部署与历史处置需另行授权，不为继续测试改用线上 key。

因此“本仓库未发现 key 泄漏”不能扩大成“所有相关项目都没有 key 进 Git”。检测也不能绝对排除未知 key 格式、编码／加密、dangling／reflog-only objects 或未 fetch remote refs。

未验收：生产 tenant／OS isolation、跨进程 writer／物理 fencing、crash recovery、后台 subagent 生命周期、token 实时 UI、文件／媒体、完整 permission/defer/control UI、Claude compaction。native配置保留不等于所有原生能力已验收；当前不能从包级成功宣称 Agent 产品可用。
