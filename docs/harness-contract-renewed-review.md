# Harness 公共合同重新调研与完整审查

> 本文审查当前 `packages/harness/contract.ts` 的全部 **32 个导出声明**、五个类型用例、公共入口和 README。重新读取固定版本的官方 SDK 源码与开源项目调用链，不把旧研究结论或类型通过当作运行证明。
>
> 审查阶段只新增本记录，未修改合同、用例或 README。随后用户批准了定点调整，落实状态见第 10 节；第 3 节和第 8 节保留调整前建议／验证快照。三个 SDK 仍无运行实现，“验收门槛”不是已经发现的 Harness 运行缺陷。

## 1. 总结

**当前责任分层可以保留，但还有几处安全与生命周期语义需要收拢，不能直接把 SDK 默认行为当作合同实现。**

保留：

- 原生 SDK 拥有模型／工具 loop、历史、retry、compaction 和 continuation；不建立第四套执行框架。
- 公共入口只提供普通数据与函数，不暴露 SDK 对象。
- Session 选择本次批准的 Tool／Skill／MCP 来源。声明范围不等于连接寿命，也不要求每个 prompt 重连。
- `ToolOutput` 是模型路径的数据，`ToolResult` 是公开投影；保留已批准的 `projectToolResult`。
- prompt 拥有正式结果；观察、异步交互、目标绑定控制和精确历史恢复各负其责。
- 不支持的配置明确拒绝；不以提示词、私有 state、重跑工具或 SDK fallback 伪装支持。

应优先明确：

1. 配置与控制 DTO 的捕获、隔离边界。
2. `projectToolResult` 的错误事实优先级、前瞻性抑制和空安全结果规则。
3. harness-level capabilities 是能力上限，而不是任意 Session 组合的保证。
4. MCP 初始缺名、后续撤回／替换／碰撞的处理范围。
5. 每个实现的固定 builtin baseline，以及 Skill 文件稳定性和无隐式附带装配。
6. 失败的会话装配由谁完成清理，以及资源变化何时仍能恢复原生历史。

不建议因此增加 registry、通用 loader／连接池、SDK bindings、第二套 Run handle、插件框架或事件协议。

## 2. 证据范围与固定版本

### 官方 SDK

| 来源 | 本轮固定版本／证据 | 检查方式 |
| --- | --- | --- |
| Pi | 1.1.0，commit `abe508e1b89912adde45528136c3221eb69acdd7` | 官方源码、完整相关文档与 SDK examples；16 份文档与安装版本逐字节相同 |
| OpenAI Agents JS | 0.20.0，commit `33e2741be9bb52c1d96a8b4dac0c68e46297b607` | 官方源码与文档；稀疏检出缺失文件通过固定 Git blob 读取 |
| Claude Agent SDK | 0.3.295 | 安装包的 `sdk.d.ts`、`sdk-tools.d.ts`、`core.d.ts`、公开可读实现 bundle，以及其 MCP SDK 1.32.1 |

Claude `sdk.d.ts` 与既有固定快照的 SHA-256 相同：

```text
e4d91d71404ce4ffc918aa590f545c7a67df6a1dfe5de8cd28a05db0a7fe872b
```

这是重新研究上述版本，不是声明它们是当前最新版本，也没有升级依赖。Context7 本轮再次返回 monthly quota exceeded；因此采用官方固定源码／安装声明，不把搜索生成的摘要当作证据。

### 开源实践

| 项目 | 固定版本／commit | 本轮使用的实践 |
| --- | --- | --- |
| LobeHub | 2.2.19，`a02b8af7ccdaa1920552c6c65216aecaa3514cdf` | 配置选择与连接缓存分层、工具错误与外层 success 分离 |
| OpenCode | 1.19.0，`733b2c627e5aec39cb33cc22373bdce33053ef2c`；2.0.27，`773d8621d6bcd311067b225d837c917b3e83573e` | 执行前等待审批、动态 MCP 更新与旧连接回调失效、Skill 激活 |
| OpenHands SDK | 1.54.0，`e3a26821f8f7c85e98078c7b5e1a80647fc7d0c7` | transient deltas 与正式记录、Skill 渐进披露、dispatch ACK 的反例 |

OpenCode 的 10 份旧版与 26 份新版 TypeScript 摘录重新与对应 Git blob 比较，均相同。上述产品有自己的执行层；这里只借鉴边界，不搬它们的 classes、services、registry 或 agent loop。

五个独立只读审查分别覆盖 Pi、OpenAI、Claude、开源实践和全合同一致性；主审重新阅读完整合同与 README，并抽查关键源码证据。图缓存曾提示 HEAD 不一致，本审查不依靠该旧图宣称引用／调用链完整。

## 3. 合同需要收拢的具体规则

### 3.1 高优先级：捕获配置，隔离控制输入

位置：`HarnessConfig`、`SessionOptions`、`PromptOptions`、`PermissionRequest`、`QuestionRequest`。

现有合同明确隔离 observer 与 projector 的 DTO，也明确捕获 `ToolDefinition` 数据／函数。但是整个 Session 的 permissions、projector、MCP headers/env、来源列表，以及 Prompt 的回调引用，没有同样明确的捕获点。

权限参数虽然是 JSON，仍可能通过传出的对象引用被改写。问题校验要求使用原始 IDs 和选择规则，也应明确不从可能被宿主修改的回调对象重新读取这些依据。

**建议最小规则：**

- factory、session、prompt 分别在准入时捕获本次批准的数据与 callback 引用，后续修改调用方对象不改变已准入配置。
- 权限／问题回调接收 detached DTO；校验和执行使用私有保留的原始请求、参数与绑定。
- 验证、授权、执行必须对应同一份实际参数与 executable route；不允许通过 callback DTO mutation 改写执行。
- Tool callback 返回的媒体 bytes 明确为捕获时复制，或者明确借用期限；不能把 prompt 输入的借用条款含糊套到 callback 输出。
- 捕获普通声明不要求 deep-copy/freeze SDK graph，也不表示快照整个 Skill 文件树或保证远端实现不变。

### 3.2 高优先级：projector 不拥有错误分类

位置：`SessionOptions.projectToolResult`、`ToolResult.isError`、`ToolOutput`。

当前条款说确认的错误事实仍可观察、projector 不改变原生分类，但返回类型允许 projector 自由填 `isError`。需要决定返回 false、true、缺失与原生证据冲突时的公开处理。

**建议：实现拥有最终公开 `isError`，取自确认的 native evidence。** 对 projector 的冲突值采用确定规则，例如忽略／覆盖；没有原生分类证据时不因 projector 填 true 就创造事实。已确认的错误不能因 payload 抑制而消失，projector 抛错也不变成 native tool failure。

还需明确：

- 抑制是**前瞻性的**：已经公开的旧 partial 不被“撤销”，仍只是 partial，不进入最终结果。现有省略 result 的规则就是保留旧展示，不应假装它会清空。
- projector 失败后的抑制范围按现有文字为整个 invocation，而不是仅当前 tool；应明说后续行为。
- 只有有依据的最终结果才可形成 `{ content: [] }` 等空安全投影，并独立保留确认的错误事实。
- native lifecycle finished、取消或未观察到最终结果，不能凭空创造最终输出。
- 不能完整表示的 native rich result 保留在 SDK 内；空公开视图是披露策略，不是假装把 private native result 转换成空的模型结果。

不建议为了此处新增清空事件。如果产品确实要求撤销当前 UI 视图，再另行定义显式清空；这仍无法撤销已交付的 bytes。此回调只控制直接公开的工具负载，不保证模型不会在 assistant text 中引用已经进入模型的内容；模型输入授权仍是另一道边界。

Pi 的 `tool_result` hook 会修改模型路径，**不能用它返回 projector 的安全视图**。公开投影必须是旁路观察。[Pi hook 源码](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts#L684-L723)。

### 3.3 中优先级：capabilities 是不可变能力上限

`Harness.capabilities` 在打开 Session 前已经存在，而 `stateDirectory`、工具、Skill、MCP 和权限策略在 Session 才提供。

**建议：** capabilities 表示 factory 配置下实现潜在可提供的功能；true 不保证任意存储、模型输入、资源组合都能实现。Session 装配／操作仍验证具体支持并拒绝不兼容组合。false 必须是不支持，不能之后静默改 true。无需增加 session capabilities API。

特别是 `permissionRequests: true` 不应承诺所有 hosted/native tools 都有可用的执行前审批路径；不能安全 gate 的组合拒绝，而不是绕过宿主策略。

### 3.4 中优先级：动态 MCP 的检查时点与失败范围

位置：`McpServerConfig.allowedTools`、`PermissionRequest.input`。

目前“reject missing names/unsafe collisions”缺少时点和被拒绝对象。需要区分：

- 初始完整 discovery 后显式名单中有缺名：建议拒绝装配，不默默等待未来出现。
- 已选工具后来撤回：立即取消 eligibility，不扩名单；待执行的旧 grant 不授权已撤回／替换的定义。
- 同名工具、schema 或本地连接绑定改变：使 pending approval 失效，重新确认 eligibility／实际参数／绑定；丢弃旧连接的迟到回调。
- 新 discovery 发生 route collision：受影响路径 fail closed，不能覆盖 callback／builtin／helper；若不能隔离并安全继续，则收尾后失败，停止不明为 execution_unknown。
- `allowedTools: []` 限制这个 server 的 **tools**，不自动意味着不开连接、禁止所有 resources/prompts 或授予它们访问权。其他原生 helper 的准入和权限也需明确定义。

这些是 native catalog 的薄层准入／授权约束，不是要求新建公共 discovery registry。协议身份不保证远端代码永不改变，不能宣称逻辑绑定等于 physical fencing。

### 3.5 中优先级：固定 builtin baseline 与 Skill 来源寿命

`nativeTools` 省略承诺“documented fixed SDK baseline”，但尚未逐实现列出 baseline。不能继续依赖滚动 CLI preset/default。

- Pi 的基线常见为 read/bash/edit/write，但 SDK selection 还能影响 custom tools，不能机械转发 selector。
- Claude 的名字是 `Read`／`Bash` 等；示例中的 `read` 应标为 Pi 示例，不声称跨实现别名。
- OpenAI 普通 Runner 没有同一套文件工具默认集；不能为了对称秘密装入 shell／filesystem。

具体默认名单需要在实现前明确并授权，不由本审查凭空扩大。

Skill 目录是 host 预先提供的授权来源，但尚无文件变化规则。建议第一版由宿主保证 handle 生命周期内来源及资源稳定；如果要支持 native reread，则在使用前重新核验 metadata／identity／授权，不能假装首次校验冻结了磁盘。

选择 Skill 不得自动装配 sibling plugin/MCP 配置，或在装配／披露时隐式执行 inline shell。技能正文要求调用已批准工具，与未经过授权桥接的 shell macro 是不同事情。无兼容 native 路径时拒绝，不手写 Skill loader/interpreter。

### 3.6 中优先级：失败装配和恢复兼容

- `newSession`／`resumeSession` 在返回 handle 前失败，也必须清理本次已创建资源，包括 partial MCP init；不能要求调用方 close 一个根本未返回的 handle。
- 失败装配需等待可确认的清理；无法确认停止时按 execution_unknown 处理，不把普通配置失败当作可安全重试证明。
- 恢复使用本次批准的资源快照，**变化不一律等于不兼容**。原生历史仍可回放、没有缺失的 replay-required routing／schema／search binding 时可接受；确实无法安全回放时 session_incompatible。
- 精确历史 reopen 与 suspended RunState continuation 分开；不能把缺少旧 runtime callbacks 的暂停执行伪装成正常恢复。

### 3.7 需求条件项：权限策略是否需要来源信息

当前 `PermissionRequest.toolName` 是可信 bound route，但没有标准字段表达 builtin／host callback／MCP original server/name。

如果宿主要按“某 server 的某 original tool”制定权限，**结构化 source 是一个有实际用途的候选**，而非靠 prefix 猜出处。可以只放在可信权限 DTO，不放 SDK objects 或 tenant pool 参数。

本轮不直接新增该 union。先确认是否确有源级策略需求，以及三个 native 路径能否提供可验证 provenance；也不能把一个显示名字改名就当作解决了身份问题。

## 4. 官方 SDK 不可直接透传的重点

### Pi 1.1.0

1. **原生校验存在有损 coercion。** plain schema 路径把 null 转 number 0、boolean false、string 空串，也会去掉部分 optional null。只读审查中的纯公开 validator 探针输入 `{"n":null,"optional":null}` 返回 `{"n":0}`，原对象不变；没有建立 agent 或执行模型。这证明 native helper 行为，不证明任何 Harness 行为。[validation.ts:59–126](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/utils/validation.ts#L59-L126)、[dispatch:707–775](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/agent/src/agent-loop.ts#L707-L775)。必须验证原始实际参数并绑定获批参数，或者拒绝不能兑现的 schema/config；不削弱合同。
2. **MCP 默认有 ambient config、字符串表达式解析、继承环境和 OAuth 路径。** 需使用公开注入边界实现显式配置、literal env/header、`inheritEnv: false` 与无隐式认证；deferred exposure 不代表首次使用才连接。[MCP 配置入口:69–95](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/extensions/mcp/index.ts#L69-L95)、[stdio:94–100](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/mcp/src/transports/stdio.ts#L94-L100)。
3. **同步 dispose 不等于 joined close。** 先 join native 执行／control／callbacks，再经支持的 session_shutdown 释放 MCP 等资源；runtime.dispose 的异步 shutdown 也不是替代 execution join。[session dispose:1393–1421](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts#L1393-L1421)、[runtime disposal:404–413](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session-runtime.ts#L404-L413)。
4. **SessionManager.open 可以新建／初始化缺失历史。** 需先核对准确身份、存储、格式和兼容性，不能直接调用后宣称 resume 成功。[open:1029–1054](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/session-manager.ts#L1029-L1054)。
5. SDK prompt 有 command／skill／template expansion，文件输入通常 text 后 images。exact text、任意 ordered input、控制 queue 的不溢出都要验证，不得绕到低层 Agent 来丢掉 AgentSession 的 retry/compaction 生命周期。[prompt:1968–2027](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts#L1968-L2027)、[steer:2174–2249](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts#L2174-L2249)。
6. `usage.input` 不等于 normalized cache-inclusive input；cache warming 有独立工作／usage。Session total 差值不能自动证明 invocation 总量。[usage totals:22–28](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/usage-totals.ts#L22-L28)。

### OpenAI Agents JS 0.20.0

1. **JSON Schema tool parser 不做一般 runtime constraints validation。** Zod／Standard Schema 有实际 validation；plain JSON path 主要是 parse 和 strict normalization。需在 native dispatch／approval 路径上验证，不能只在 execute 后校验。[utils/tools.ts:205–237](https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/utils/tools.ts#L205-L237)。
2. **空 MCP allowedToolNames 不表示 deny-all。** 静态 filter 中空 allowed list 是不限制，且 callable filter 缺上下文可能保留工具。本合同的 [] 必须显式实现，曝光过滤不是执行审批。[mcp.ts:650–699](https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/mcp.ts#L650-L699)。
3. **取消 readable stream 会立即关闭流，但工作不一定结束。** join 公共 `stream.completed`，并额外 join 已派发宿主 callbacks，不能用 stream EOF 或 internal promise 证明停止。[result.ts:573–585](https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/result.ts#L573-L585)、[cancel:658–685](https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/result.ts#L658-L685)。
4. 普通 native Session history 与 paused RunState 不同；process-local MemorySession ID 不等于 durable resume。`RunState.addInput` 不证明 active steering；未验证则 steer:false。
5. Native SandboxAgent／local skills 确实存在，但 source directory 形状、path grants、filesystem／shell 默认能力与公共单 Skill 目录不同。需显式装配或拒绝，不说“OpenAI 没有 skills”，也不偷偷加 shell。[localSkills.ts:16–100](https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/sandbox/localSkills.ts#L16-L100)。
6. Deferred tool search 有 native runtime install/replay 路径，但文档对 client execute 的概括与源码特例不一致；按选定路径验证，不建立自己的 search loop。[toolSearch.ts:570–663](https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/runner/toolSearch.ts#L570-L663)。
7. Usage 的默认零不证明报告完整；compaction 有单独计数。cacheWrite 没报告则缺失。Native tracing 默认开启，也需显式避免未批准的 trace export。

### Claude Agent SDK 0.3.295

以下行号指固定安装包，SDK implementation bundle 为 minified；不把物理长行当作清晰的逐函数 source map。

1. **allowedTools 是自动许可，不是 availability。** `Options.tools` 才是 builtin selection，`disallowedTools` 还影响 internal direct calls。`Options.env` 明确 replace 子进程环境；settings/skills/MCP strictness 都要显式装配。证据：`sdk.d.ts:1579–1665,2243–2302`。
2. **canUseTool 不足以证明每次动作都问宿主。** Native preapproval／read-only paths 可能不派发 permission prompt；需核验公开 PreToolUse／callback gate 等路径，含子代理、Skill macro 和 discovery helpers。证据：`sdk.d.ts:1982–2020,2741–2757,5547–5577`。
3. Convenience `tool()` 用 Zod raw shape；`createSdkMcpServer` 可能警告后省略不能转换的工具。不能静默丢失 schema 或声明。lower-level public MCP server 支持 outputSchema，不应误判“Claude 没有输出 schema”；nested structuredContent 仍需正确映射／验证。证据：`sdk.d.ts:602–644,1206–1212,5322–5330,9797`，MCP `server/mcp.d.ts:161–170`。
4. Handler `extra: unknown` 不代表没有 per-request AbortSignal：协议层实际提供 signal、requestId 等。但 **JSON-RPC requestId 不等于 assistant tool_use ID**；并发相同调用不能按名字、参数或到达顺序配对。需单独证明 callback correlation。证据：MCP `shared/protocol.d.ts:169–205`、SDK bundle `handleMcpControlRequest`。
5. Native control 取消后仍存在 late callback response 写回路径；适配层需显式使 late allow/answer 失效，并 join 所有 callbacks。Native timeout 不能证明宿主 executor 停止。证据：SDK bundle `handleControlCancelRequest`／`handleControlRequest`。
6. `result.usage` 是主 loop per-turn；`modelUsage` 是 query-pipeline 累计，可能包含恢复的旧总计。必须有可靠 baseline/reset 边界，不能累加多条累计 result 或套用 Pi 算法。证据：`sdk.d.ts:5817–5827`。
7. 多 assistant frames 可共享 message.id；supersedes、retracted UUIDs、abort/continuation flags 要留在 native state 并正确映射公开 replacement snapshots。证据：`sdk.d.ts:3610–3650,5443–5471`。
8. Public startup/WarmQuery、session history inspection 等路径值得验证；不能仅凭 query(prompt) 的形状断言 no-prompt resume 不可能。另一方面 cleanup 的 bounded process-exit race 和非 awaited MCP closures 不能直接当 joined close。证据：`sdk.d.ts:869–930,2428–2445,9518–9590,9984–9999`，SDK bundle `performCleanup`。
9. `SkillSource.directory` 比 native skills 名字 filter 更强；须证明准确来源、不附带 plugin、无 ambient scan。MCP structuredContent 要 object，与本地任意 JSON DTO 不同；只能 lossless mapping 或拒绝，不能静默包装／下载。

## 5. 优秀开源实践：借边界，不照搬实现

| 实践 | 固定源码 | 对本合同的意义 |
| --- | --- | --- |
| 权限通知与真正等待决策分开 | [OpenCode permission.assert:223–247](https://github.com/anomalyco/opencode/blob/773d8621d6bcd311067b225d837c917b3e83573e/packages/core/src/permission.ts#L223-L247)、[MCP call 前审批:49–70](https://github.com/anomalyco/opencode/blob/773d8621d6bcd311067b225d837c917b3e83573e/packages/core/src/tool/mcp.ts#L49-L70) | onRequest 必须 await 决定再产生动作，不能把通知 ACK 当授权 |
| 旧连接回调失效、动态列表与 partial init 清理 | [OpenCode mcp:326–346](https://github.com/anomalyco/opencode/blob/773d8621d6bcd311067b225d837c917b3e83573e/packages/core/src/mcp/index.ts#L326-L346)、[init/teardown:469–493](https://github.com/anomalyco/opencode/blob/773d8621d6bcd311067b225d837c917b3e83573e/packages/core/src/mcp/index.ts#L469-L493) | 需要 binding 生命周期，而非把“名字还存在”当作旧 grant 安全 |
| 连接缓存与会话配置选择分层 | [LobeHub cache:245–263](https://github.com/lobehub/lobehub/blob/a02b8af7ccdaa1920552c6c65216aecaa3514cdf/apps/server/src/services/mcp/index.ts#L245-L263) | Session 字段不会本身导致每 prompt 重连；不照抄全局参数 cache，也不宣称其替换处已 joined dispose |
| outer success 不是 tool success | [LobeHub result:33–81](https://github.com/lobehub/lobehub/blob/a02b8af7ccdaa1920552c6c65216aecaa3514cdf/apps/server/src/services/mcp/index.ts#L33-L81) | success:true 可以伴随 isError；error fact 与业务成功不能合并 |
| delta transient，final message 独立保留 | [OpenHands streaming_delta:5–13](https://github.com/OpenHands/software-agent-sdk/blob/e3a26821f8f7c85e98078c7b5e1a80647fc7d0c7/openhands-sdk/openhands/sdk/event/streaming_delta.py#L5-L13) | 正式结果不靠公开 deltas 拼回 |
| client dispatch ACK 与外部实际完成分开 | [OpenHands client_tool:152–172](https://github.com/OpenHands/software-agent-sdk/blob/e3a26821f8f7c85e98078c7b5e1a80647fc7d0c7/openhands-sdk/openhands/sdk/tool/client_tool.py#L152-L172) | 此设施不满足本合同 awaited ToolOutput，不能照搬并当作真实执行结果 |

开源中的 JSON-looking text heuristic、全局缓存、dynamic skill shell、外部执行 ACK 都不是本合同应默认采用的模式。没有做这些产品的运行或性能 benchmark，不能从 source 推出耗时、吞吐或完整租户隔离。

## 6. 全部 32 个声明的处置

“保留”只表示未发现必须更换形状的理由，不表示已实现或已证明每个输入值安全。

| 声明 | 审查处置 |
| --- | --- |
| HarnessKind | 保留三个固定实现，不做 registry |
| CreateHarness | 保留函数入口类型；补 factory 捕获／失败清理规则，仍无 runtime factory |
| HarnessConfig | 保留显式凭据；避免 ambient auth、trace 与 mutable config 重读 |
| Harness | 保留 new/resume 分离；补装配失败和支持 envelope |
| HarnessCapabilities | 保留功能能力；澄清 true 与 Session 支持的区别 |
| SessionOptions | 保留会话批准快照与 projector；补全捕获与 omission 文档 |
| ResumeSessionOptions | 保留精确身份；明确资源变化与 replay compatibility |
| HarnessSession | prompt/result owner、control targeting、unknown 封闭成立；native join 待验收 |
| PromptInput | 保留 ordered/nonempty/exact text；native commands 和布局需拒绝／正确映射 |
| InputPart | 保留标准 URL/bytes，不加 downloader；补 callback 输出 bytes 所有权 |
| PromptOptions | 保留 signal、observer、reasoning、question 不同职责；捕获引用／late expiry |
| PromptResult | 保留一份正式结果；不补 fake stop，空公开 tool payload 不等于空 native output |
| AssistantMessage | 保留 public identity，非 native checkpoint |
| AssistantContent | 保留 text/reasoning blocks，签名／redacted replay 不公开 |
| TokenUsage | 保留四个计数；独立完整才报告，含 cache 不二次相加，缺失非零 |
| HarnessUpdate | 保留六种观察；partial/final、retraction 与不编造 activity 区间成立 |
| PlanEntry | 保留三个状态，不从文字猜 plan 或伪造清空 |
| ToolResult | 保留 local public DTO；明确 isError 由确认事实决定 |
| JsonValue | 保留 finite/acyclic JSON 约束；TypeScript 不证明 runtime validity |
| ToolDefinition | 保留 JSON schema 与 awaited executor；supported subset、无损转码／实际校验是门槛 |
| ToolOutput | 保留模型路径数据；验证 nested structuredContent，正确 capture media |
| SkillSource | 保留单个预配置目录；明确来源稳定、不附带插件／MCP／隐式 shell |
| McpServerConfig | 保留 plain transport、明确 allowedTools；补动态列表／失败清理边界 |
| QuestionRequest | 保留推送式请求；private originals 与 detached callback DTO |
| Question | 保留选择规则，不做通用 form；native text-key codec 有损则拒绝或用 SDK tool |
| Choice | 保留 IDs/labels，不能按 text 当身份 |
| QuestionAnswer | 保留 selections/custom text；原始规则 runtime 校验 |
| QuestionResponse | 保留 accept/decline/cancel；没有答案不取消 invocation |
| PermissionPolicy | 保留显式 allow_all/ask；证明所有所选 executable routes 在动作前 gate |
| PermissionRequest | 保留绑定实际参数；补 mutation isolation；source 是条件项 |
| PermissionResponse | 保留 single-use allow/deny，不做持久 native grant |
| HarnessError | 保留 11 codes、安全错误与 unknown 优先；不公开 native RunState/cause/stack |

## 7. 文档与格式的实际问题

- README 的待定范围仍把已经声明的 native/custom tools、MCP 配置列为未定稿；应改成“公共声明已存在，SDK 映射／验收未实现”，并补 Skill、cache counters、projector 的默认无 payload 行为。
- 评测示例没有 projector，默认仍能看到 lifecycle／确认错误事实，但不能承诺获得 private tool payload。需要与正式结果的介绍对齐。
- README 的“content 不为空”应限定 prompt/steer 输入；公开 tool content 可以为空。
- Build 生成 declarations 和空 JavaScript module entries，不生成 createHarness 或 SDK implementation。
- `resources.test-d.ts` 有两个格式位置未按 Biome 输出排版：resumeWithResources 签名、混合 transport 负例。它们属于同一个文件的一项 formatter failure，不是类型错误。本轮未自动修复。

## 8. 实际检查与限制

本轮主审使用项目 Node **24.21.0**，直接执行本地二进制，没有 pnpm exec/install。

| 检查 | 结果 |
| --- | --- |
| `tsc --noEmit -p packages/harness/tsconfig.json` | 通过 |
| `tsc -p packages/harness/tsconfig.build.json` | 通过；仅生成声明和空模块入口 |
| `biome check packages/harness` | 未通过：10 files 中 resources 用例一项格式错误 |
| 主动 LSP：contract、index、五个类型用例 | 无类型错误；resources 的 typeof 有一项辅助 ast-grep hint，未 suppress |
| 隔离类型 mutations | baseline/restored 通过，**37/37** mutation 被类型用例检出；只修改临时副本 |
| 根 Vitest | **79 通过、2 失败**；两项旧 architecture 测试引用已删除 apps/server |
| `git diff --check` | 通过；新增 Markdown 另行检查尾部空白和结束换行 |
| 新报告的固定 Git 源码引用 | 25 个行号范围对应的 commit/file 存在且范围有效；不是自动语义证明 |
| 合同／入口／README／五个用例的前后 SHA-256 | 相同；本轮未改这些文件 |

类型 mutation 包括控制目标、callback outcome、schema object root、MCP 显式 allowlist、SDK graph 禁入、projector 同步返回、cache counters 等。第一次 mutation driver 因没有把编译器的 TS2561 拼写建议错误纳入诊断分类而中止；增加该分类后重新完整执行，baseline/restored 均通过。不是 Harness 回归，也没有通过弱化类型修测试。

材料保存在本机 `/tmp/mha-contract-renewed-review.qpkYGu/`，含 tsc/build/Biome/root-test 日志、before hashes、固定 OpenAI source excerpts 和隔离 mutation driver。原有研究阶段“contract unchanged”的证据不被覆盖，也不冒充覆盖本轮新增声明。

没有创建／运行 native agent、执行 provider/model、连接 MCP 或读取个人凭证。Pi 子审做过一次纯公开参数校验 helper 探针；这不是 loop、权限、恢复、取消或 close 的验收。没有本轮生产／浏览器／性能验收，不能称全仓通过。

## 9. 下一步顺序

1. 先批准并定点写入第 3 节的必要语义与 README 同步；不因审查扩大接口。
2. 补格式、重新跑类型／构建／lint／LSP；它们仍只证明静态边界。
3. Pi 第一条纵向 native 实现，优先验证严格参数、permissions/callback correlation、explicit MCP、history reopen、joined close 和 late controls。
4. OpenAI 独立实现检验同一合同，尤其 empty-deny、before-approval validation、stream.completed 和 search/replay。
5. Claude 验证 exact source assembly、全路径 gate、并发 callback correlation、late response、cumulative usage 与 process-exit join。

不得以当前类型通过、SDK API 存在或优秀项目有类似代码，跳过上述原生行为验证。

## 10. 批准后的定点调整

用户批准后已收拢到 `contract.ts` 与 Harness README；公共声明仍是 32 个，去除注释／空白后与调整前相同，未新增来源 union、SDK 参数袋、registry 或运行实现。

- 明确 factory/session/prompt 捕获配置与回调，保留 live signal；权限／问题 DTO 独立，使用私有原始参数／规则，修改回调对象不改变执行。
- projector 的 isError 被忽略，公开分类只来自确认事实；undefined 仅抑制当次 payload，throw/Promise/invalid 抑制全 invocation 后续 payload。抑制不撤销已交付 partial；确认的空 final view 可替换展示，没有最终证据则不补结果。
- capabilities 是不可变潜在支持上限，具体存储／资源组合仍需准入；new/resume 失败时也清理已创建资源，无法确认停止是 execution_unknown。
- 规定 MCP 初始缺名拒绝装配、后续撤回／schema/route/connection 变化使审批失效、旧回调丢弃及碰撞 fail closed；明确 allowedTools 只约束 tools。
- 固定第一版 Harness builtin baseline：Pi read/bash/edit/write；Claude Read/Bash/Edit/Write/Glob/Grep；OpenAI 普通 Runner []。这是明确 availability 选择，不是完整 SDK defaults 或自动许可；另一次只读官方源码检查确认了名字与选择路径，未执行运行验收。
- Skill 来源由宿主保持 handle 寿命内稳定，不附带 plugin/MCP 或装配／披露阶段 shell；Tool callback 返回数据在移交时复制，prompt 输入 bytes 的借用规则保持不变。
- 允许仍能 native replay 的恢复配置变化，不按同名工具或 SDK fallback 判断兼容。
- 同步 README 的新资源、cache、默认无 payload 与空工具视图说明；资源用例标为 Pi 命名，并去掉 projector 手动搬运错误标记。

本轮主要是行为条款／人工文档调整，没有用正文字符串断言或 fake SDK 冒充回归测试。待实现的 native 验收应覆盖：配置及控制 DTO mutation、Buffer/Uint8Array 跨视图隔离、冲突 isError、partial 到空 final／无 final、并发 callback correlation、MCP 动态替换等待审批、失败装配清理和 late controls。

实际复验使用 Node 24.21.0：typecheck、声明 build、Biome 10 files 均通过；37 个隔离 type mutations 的 baseline/restored 通过并全部检出。LSP 没有类型错误，资源用例仍有一项辅助 typeof hint，未 suppress。独立复审未发现阻塞项；其 Node 26 检查只作补充，主审另用固定 Node 24 完整复验。

根 Vitest 仍为 79 通过／2 失败，分别是 architecture 测试的 `keeps product and execution processes independently consumable` 和 `prevents production source from crossing application ownership`，引用删除的 apps/server/package.json 与 apps/server/src。没有修改这些旧测试掩盖失败。

本轮材料：`/tmp/mha-contract-clarifications.ZFLTOh/`。声明兼容辅助脚本最初错误假定 TypeScript 7 仍有旧 JavaScript compiler API 路径而未运行，随后改为声明文本的注释／空白归一化比较并通过；没有降级编译器或修改依赖。格式化混合 transport 负例后，将 ts-expect-error 放到实际诊断属性行，保留原有拒绝边界。受保护的入口／package／tsconfig／lockfile／根架构及旧 E2E 文件 SHA-256 均未改变。
