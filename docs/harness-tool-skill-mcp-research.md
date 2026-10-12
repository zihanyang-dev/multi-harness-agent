# Tool、Skill、MCP 接入与懒加载研究

## 状态与范围

本轮只做研究与契约建议，**没有修改公共类型、安装依赖或实现 SDK adapter**。当前 `packages/harness/` 仍是 contract-first 包，不存在可执行的 `createHarness`。

目标是让生产与评测使用同一套 SDK-free 接入合同，同时保留 Pi、Claude Agent SDK、OpenAI Agents SDK 的原生 loop、工具发现、历史、恢复与资源机制。ACP 只作为职责参考，不引入 ACP transport、协议握手或 agent registry。

证据是固定版本的官方文档、声明和源码。没有执行目标 SDK 的模型调用、启动原生 agent、连接 MCP 服务、读取用户认证／配置，或运行行为测试。搜索生成摘要不作为源码证据。旧 [tool-integration-design.md](tool-integration-design.md) 描述过 SDK-native bindings 的历史实现；它不是当前运行状态，也不是本轮重新暴露 SDK 对象的依据。

## 一、先拆开“懒加载”

| 机制 | 真正推迟的东西 | 不自动保证的东西 |
| --- | --- | --- |
| 工具 schema 按需暴露 | 完整定义进入模型上下文／可见工具集 | 模块未导入、MCP 未连接、工具无执行权限 |
| 工具实现按需导入 | 执行器模块、昂贵依赖初始化 | schema 也延迟暴露 |
| 工具资源按需初始化 | 浏览器、进程、连接等资源分配 | 所有 SDK 都有相同的初始化时点 |
| Skill 渐进披露 | 摘要 → 指令正文 → 附属资源进入上下文 | 磁盘没有预读、脚本已获执行授权 |
| MCP 按需连接 | 连接／服务进程启动 | `deferred` 工具一定按第一次调用才连接 |
| MCP 列表分页、变更通知 | 分批接收／重新发现工具描述 | 标准定义了元数据目录 → 单项 schema 加载协议 |
| MCP task／延期结果 | 任务完成与结果取回 | 工具 schema 的懒加载 |

因此不建议一个跨 Tool、Skill、MCP 的 `lazy: boolean`。第一版最有价值的是表达**工具暴露意图**和**技能来源**，而不是承诺统一的加载算法。

## 二、官方标准能借鉴什么

### ACP：会话、观察、授权，不是通用工具注册合同

- v1 会话创建／加载提供 MCP server 连接声明；stdio 是必需支持，HTTP／SSE 是可选能力。这与 ACP client↔agent 的 JSON-RPC transport 不是一回事。[A1]
- tool-call 更新报告 agent 执行的动作。`name` 是可选的信息字段，不是能力声明或授权身份。[A2]
- v1 的 filesystem／terminal client callbacks 是具体能力，不是任意业务函数注册 API。
- 固定源码的 v2 文档明确说明：v2 整体仍标记 draft，即使存在称为 stable baseline 的 schema；不能把版本协商当成所有草案能力已启用。v2 删除 client filesystem／terminal 执行 API，建议通过 client-provided MCP 提供这类工具。[A3]
- 基线没有标准 skill catalog／load API，也没有通用自定义工具注册方法。`_` 方法与 `_meta` 是扩展机制，不是现成互操作合同。
- MCP-over-ACP 是独立 unstable RFD，不是基线。该草案要求 MCP 2026-07-28，并定义 `type: "acp"`、`serverId` 与 `mcp/message`；不能拿它证明当前安装 SDK 已支持。[A4]

**借鉴职责，不复制协议：**外部装配工具和来源；agent／SDK 执行；宿主审批；观察只报告事实。不要把观察事件反过来当执行分发命令。

### MCP：描述、调用、分页与变更，不负责模型的暴露策略

- 2025-11-25 的 `tools/list` 返回包含 `inputSchema` 的完整描述，支持 opaque cursor 分页；`tools/call` 用 name／arguments 调用。`list_changed` 提醒重新列举，不是 descriptor patch。[M1]
- 分页是延后接收下一批完整描述，不是先列元数据、再标准化地按名称获取 schema。
- 在本次固定的 2026-07-28 文档中，初始化握手与协议 session 被移除，新增 `server/discover`、逐请求版本／能力、缓存与订阅；tasks 移入扩展。不能将这些变化混进 2025-11-25 的 SDK 初始化／关闭设计。[M2]
- tasks 是执行延期；MRTR 的 `input_required` 是额外输入交互。两者都不是 schema lazy loading。
- descriptions／annotations 是不可信的描述信息；`readOnlyHint` 等不能授予执行权。服务自报名称也不是认证身份。

**选择安装 SDK 实际支持的版本与 transport。**不因为滚动规范更新而升级依赖，不自行实现 MCP 协议或通用 task 引擎。

### Agent Skills：最适合借鉴的渐进披露语义

官方规范定义：[S1]

1. 开始时暴露 `name`／`description`。
2. 激活时披露 `SKILL.md` 正文。
3. 需要时读取 references／scripts／assets。

这描述的是上下文披露，不要求磁盘 I/O 同样延迟。官方集成指南明确允许发现阶段已读取／保存正文，激活时才进入模型上下文；安装目录只是约定。[S2]

`allowed-tools` 是实验性、实现相关字段。它不替代宿主授权，更不能将安装技能等同于允许其执行脚本。

## 三、三套目标 SDK 的实际边界

| 项目 | Pi 1.1.0 | OpenAI Agents JS 0.20.0 | Claude Agent SDK 0.3.295 |
| --- | --- | --- | --- |
| 自定义工具 | 内部 `ToolDefinition`／extension registration | 内部 function `tool()` | 内部 SDK MCP server／`tool()` |
| 外部 SDK-free JSON schema | 原生 MCP 路径适配普通 JSON schema；仍有 provider 限制 | 直接接受 JSON schema；strict 转换不是完整本地校验 | convenience `tool()` 接受 Zod raw shape，不是任意 JSON schema |
| 原生按需工具暴露 | `deferred`／`codemode`，原生 `tool_search` 激活 | Responses `deferLoading`／namespace／`toolSearchTool` | 原生 MCP search，`alwaysLoad`、`searchHint` 等控制 |
| 搜索算法／形式 | session 内 BM25，下一模型调用声明命中工具 | server search；client loader；源码还包含 custom client executor | Agent SDK／CLI 管理的 MCP discovery，不是直接 Messages API loop |
| Skill | ResourceLoader 元数据；模型读文件或 `/skill` 加载正文 | Sandbox skills、local／container shell 的技能来源；不是通用 `Agent.skills` | 已发现技能的 main-session 选择；省略不是关闭 |
| 原生 MCP transport | stdio、Streamable HTTP；拒绝 legacy SSE | stdio、Streamable HTTP、legacy SSE | stdio、HTTP、SSE，另有内部 SDK transport |
| 延迟暴露是否等于延迟连接 | 否；启用服务在 session start 后台连接 | 不等价，连接归原生 MCP 接入层 | 不能由 deferred／alwaysLoad 声明推出 |

这些是静态确认的机制，不是三套实现已履行的公共能力承诺。

### Pi：发现可以原生完成，但 SDK 不会自动安装 CLI 的扩展

- SDK session 需要显式装配内置 search／MCP，按需要装配 codemode，并绑定 extension lifecycle；不能认为 CLI 自带能力已自动存在于 SDK。[P1]
- search 面向已注册的 inactive deferred／codemode 工具；搜索需要现存 name、description、schema 等元数据。命中后激活，下一模型调用才声明。[P2]
- Pi 的拼写是 `direct`，不是 `immediate`。`deferred` 表示不初始声明，不等于禁用；codemode 可以调用已注册且允许嵌套执行的 deferred 工具。[P3]
- Pi 1.1.0 没有专用 `searchHint` 字段。不能把 Claude 的字段机械提升成三套共同的原生字段。
- 所有 enabled MCP 服务在 session start 后台启动。search 等待 startup attempts；没有“搜到这个工具才首次连接服务”的原生保证。[P4]
- MCP runtime import 与 QuickJS 首次执行有各自的模块延迟加载。这不能推广到自定义工具模块。
- `McpExtensionOptions.loadConfig` 可以在内部替换默认配置加载；默认值会读取 agent／trusted project 的 `mcp.json`。credentials、日志、OAuth 浏览器打开等也有默认行为，必须显式处理。[P5]
- 默认 skill discovery 已读取完整文件来解析 frontmatter；提示词只暴露摘要和位置。虚拟 `filePath` 没有配套 reader 并不能加载正文。[P6]

恢复时持久化的是原生 discovery／loadout 状态，不是可执行模块。要重新绑定真实工具、服务器与当前授权，不能把历史工具声明视作实现或权限。[P7]

### OpenAI：不要把文档限制误读为源码没有路径

- Deferred functions／namespace 是 Responses 路径；Chat Completions 与 AI SDK adapter 不支持这套流程。文档还限制支持它的模型版本，不能因为同属 OpenAI 就承诺可用。[O1]
- 默认 client loader 接收 `{ paths: string[] }`，不是跨 SDK 的自然语言 `search(query)` API。
- **源码／指南差异：**指南称 custom client schema 需要 own Responses loop；固定源码只在没有 `execute` 时拒绝 custom parameters，并包含原生 custom executor、runtime tool 安装和路由冲突检查。[O1][O2]
- 因此不能说 native runner 完全不支持自定义发现；也不能未经行为验证就将其作为稳定的三套公共承诺。此路径无须在 harness 自建第四 loop。
- 恢复 custom discovery 可再次调用 search executor，重绑 executable callbacks 并核对路由身份。回调不得顺便执行业务工具；身份相同也不证明 schema／实现语义未变化。[O3]
- Raw JSON Schema 路径主要做 JSON parse 与 strict input normalization，不是完整 runtime JSON Schema validation。远端 strict sampling 不能代替本地参数验证。[O4]

### Claude：Agent SDK 的 MCP search 不等于直接 Messages API

- 自定义业务 callback 工具在内部成为 SDK MCP tools。外部不需要知道或传递 `McpServer` instance；该 instance 不可序列化。[C1]
- `tool()` 参数是 Zod raw shape。不可转换的 schema 会被 convenience server 从工具列表中省略并警告；harness 不能把这种省略当作成功装配。[C2]
- `alwaysLoad` 强制提前包含；`searchHint` 为原生发现提供信息。它们不等于直接 Messages API 的工具引用／search-result 交换合同。[C2]
- `skills: []`／名单与 `settingSources`、plugins、MCP 来源是不同控制。省略 skills 仍可能使用 CLI 默认值；名单是上下文过滤，不是文件系统隔离。[C3]
- `strictMcpConfig` 排除 ambient MCP 配置。权限 callback 的 `mcpServer.source` 能提供来源信息；声明明确警告不要按 `mcp__` 前缀做信任判断。[C4]
- 工具 handler 的 `extra` 是 `unknown`；query 和 permission callbacks 有显式 abort 合同。仅凭这个声明不能保证每个工具 handler 都有同样强的 per-call cancellation／correlation。

本轮没有核验 Claude search 阈值、环境变量默认值、模型／网关兼容性或闭源 CLI 内部时序。它们不进入公共默认值。

## 四、其他项目的外部接入方式与取舍

### OpenCode：函数合同可借鉴，plugin／解释器不能搬进 harness

- 1.19.0 自定义工具是 description、args、async execute；registry 初始化时扫描并 import JS／TS 模块。async callback 不意味着模块按模型调用才加载。[X1]
- 2.0.27 Promise-side tool 定义可接受普通 JSON schema 与异步函数。其插件 transforms／hooks／setup-cleanup 是更大的集成面，不是我们必须暴露的合同。[X2]
- 当前 native Code Mode 分开 direct tools 与 code inventory，提供 catalog／search signatures。它没有用“此前搜索过的名称集合”约束执行：搜索是发现，不是授权。解释器由 OpenCode 自己拥有，不是 harness 添加解释器的理由。[X3]
- Skill discovery 可以先保存全文，再向模型提供摘要／位置；激活才返回正文。
- enabled MCP 服务初始后台连接；动态 list changes 更新 native tools，并在实际调用独立检查权限。不是 first-use connect。[X4]

### OpenHands：数据边界有价值，dispatch-only 不是结果工具

- 常规 SDK 使用 tool config records，再由 native registry／factory 按 conversation materialize。可借鉴 scope，不能把 classes、process-global registry 或多层 factory 移到公共合同。[H1]
- Browser implementation 的 import 被推迟到 usability／materialization；schema 仍提前可用，而且 executor 可能跨进程实例共享。不是通用 tool search。[H2]
- `ClientToolSpec` 是 name／description／JSON schema／annotations 的纯数据边界，但 executor 返回的是 **“Tool call dispatched to client.”**，实际动作由客户端监听事件执行。它不是 awaited result callback，不能作为当前结果型工具合同的实现模板。[H3]
- MCP provider 提供 additions 和完整 reconcile callback，后者才能表达 schema／metadata 更新与移除。只处理 additions 会留下失效工具。[H4]
- 部分 skill activation 支持内联 shell 展开，不能仅凭 skill 工具的 read-only annotation 推导“激活无副作用”。

### Codex 与 Claude ACP adapter：保留原生状态，不复制注册框架

- Codex 该版本将 MCP 工具按 native search 是否启用选择 Direct／Deferred，仍先有 discovered descriptors。handler cache 保存不可变元数据，不是 connection 或 authorization snapshot。[D1]
- Claude ACP adapter 把 cwd、MCP servers、skills／SDK 配置等纳入 session fingerprint，避免 warm resume 保留旧配置。它通过 `_meta` 提供的 SDK option 转发不等于 ACP 标准技能合同；我们也不复制整张 SDK Options 转发表。[D2]

## 五、建议怎样对外暴露

原则：**统一装配责任，不统一发现／加载算法。业务声明依赖，原生 agent 使用依赖。**

### 1. 创建 harness 配置模型；会话装配执行依赖

建议 Tool、Skill、MCP 的初始装配靠近 `newSession`／`resumeSession`，对应 cwd、身份、授权和存储范围。业务可以先构造普通 definitions／callbacks，再交给会话；不必增加 factory 套 factory。

- 模型与凭据仍由创建 harness 的配置负责。
- 业务 clients、外部服务、artifact／workspace provisioning 由宿主拥有。
- 内部 native tool objects、SDK MCP server／connections、native resource loader 由 adapter 创建。
- callback 可闭包捕获已授权的业务依赖，不需要万能 context，也不需要向业务暴露 SDK `RunContext`、`ExtensionAPI` 或 `ResourceLoader`。
- 连接与已派发 callback 的收尾独立于“最后有哪些工具可见”。部分初始化失败或所有工具被过滤，仍要关闭已经创建的 owned 资源。

这不是宣布现行 `SessionOptions` 已增加这些字段。

### 2. Tool：普通描述数据＋异步执行函数

最小需要先确定的语义：

- 稳定、不会与 native／MCP／search 工具发生未授权覆盖的名称／身份。
- description、object-root JSON-compatible input schema；按实际需求支持 output schema。
- SDK-free 执行 callback，标准 `AbortSignal`；只提供可证实的调用身份，不通过 name＋arguments 猜测并发调用关联。
- await 后返回真实结果，不能将 dispatched／accepted 伪装完成。
- 输入 schema 声明、native 转换、provider strict 支持和 runtime validation 分开检查。不能静默删 constraint／tool，不能把 JSON parse 当校验。
- 表达 immediate／deferred 一类**暴露意图**，内部绑定到 native 机制。具体字段、默认值和更丰富的 codemode 能力待定。

**原生工具选择与业务 callback 定义分开。**不要为三套不同原生工具机械造同名同参数映射，也不要默认开启所有原生工具。Native toolset 的最小显式配置还需单独确定。

**模型结果与公共观察投影分开。**当前 `ToolResult` 是安全公开 DTO，不是任意 SDK callback result 的同义名。自定义工具的返回形状及披露方式仍要决定；不直接拿它回填 `execute` 返回类型，也不把返回值、private details／`_meta` 或工具搜索的完整目录自动广播。可以复用安全内容的数据形状，但不能共享可变对象或混淆受众。MCP rich results 留在原生路径，另做现行 updates／final 的安全投影。

实现按需导入可以由业务在 execute closure 内完成；仅为此不需要新建 `ToolLoader` registry。

### 3. tool_search：默认是模型使用的内部原生能力

**不建议第一版增加 `session.toolSearch()`，也不要求业务实现统一 `search(query: string)`。**

- 已知静态工具集合：宿主提供 definitions／bindings 与暴露意图，adapter 装配原生 search helper，SDK 负责激活与继续模型调用。
- 大型动态业务 catalog：只有确有需求、原生 SDK 路径可证明时，再引入 SDK-free discovery callback。外部请求／返回仍是普通数据＋callback bindings，不传 SDK tool 对象。
- 原生 Pi BM25、OpenAI server search／paths loader／custom executor、Claude 自动 MCP search 的查询语义不同。不要先发明共同 DSL、排序器或搜索协议。
- catalog callbacks 可能在恢复时再次执行；必须可重放地重绑实现，不能借此重执行业务动作。
- discovery／loaded schemas 留在原生 history/state；不通过 UI tool events 重建它们。

UI 将来需要目录快照时，另设计只读查询用途；它不应成为执行 owner 或本轮必需能力。

### 4. Skill：授权来源与选择，不是 ToolDefinition

最小接入应描述宿主批准的来源／真实资源位置及选择范围，而不是伪造一个跨 SDK `Skill.execute()`。

- 本地 pre-provisioned directory／bundle 优先；不默认扫描个人或仓库隐藏目录，不在第一版提供安装市场。
- 不仅传 name／description：正文和相对资源必须真实可访问。仅有虚拟路径不足以保证 native loader 工作。
- 由原生机制做 metadata → body → resources 的披露；不把所有全文拼入 instructions 作为共同 fallback。
- 明确启用与关闭；省略不能悄悄继承 CLI 默认的全部 skills。
- 普通 OpenAI Agent 与 Sandbox／shell skill capabilities 不等价。无法忠实接入该来源／runtime 时明确 unsupported，而不是自建通用 skill engine。
- 不为加载 skill 目录顺便加载整个 native plugin 的 hooks／MCP／命令。原生支持的动态执行或预处理仍需要执行授权。
- Skill 元数据、`allowed-tools`、激活成功都不授予文件、网络或 shell 权限。

### 5. MCP：plain connection declarations，不传 Client／Server instance

第一版优先 stdio／Streamable HTTP；legacy SSE 是可选、能力受限的接入，不对 Pi 承诺兼容转换。

需要确定：server identity、transport、command／argv 或 URL、显式 env／headers／credentials、允许的工具集合、连接 ownership／失败收尾。它们不是一般 Plugin API。

- 启动／连接服务器本身需要宿主授权，不是等第一次工具审批才授权：stdio 服务在启动时就可能有副作用。
- 不继承未授权配置、个人 OAuth store、默认浏览器登录、凭据环境。不能因为外层给了 env 就声称 child 没有继承其他环境；必须核验 native spawn／auth 行为。
- Pi 配置支持 env／header 的 `!command` 求值。公共凭据值不能被悄悄解释为命令；第一版不提供该语法，无法原样安全传入时拒绝。
- 内部使用 SDK 的 native MCP 接入。Claude 自定义 tools 需要的 SDK MCP transport 是内部细节，不要求业务包装成 MCP server 对象。
- exposure allowlist 与 execution permission、server-side auth 不同。空名单含义必须明确；OpenAI native filter 的空 allowlist 不表示 deny-all，不能原样当成公共 fail-closed 规则。
- 不承诺 connect-on-first-use；如果以后需要，必须是该 SDK 能忠实支持的独立能力。
- 动态列表变更不能自动增加宿主授权范围；schema replacement／withdrawal／名称转换冲突都要处理。
- disconnect／close 表示本地连接收尾，不代表远端服务器关闭或副作用回滚。
- 第一版不开放通用 resources／prompts／tasks／OAuth UI 管理面；已经必然涉及的 native 交互必须显式处理或拒绝，不能挂起或使用默认答案。

## 六、权限、恢复、收尾必须共同成立

1. **一次授权针对真实路由与实际将执行的参数。**display name、namespace、search result、MCP annotation 都不是授权证据。使用 SDK provenance／已绑定来源，不能按字符串前缀猜信任。
2. **校验后等待审批仍可能遇到变更。**Pi prepare 先查工具／校验，再 await hooks，之后执行 prepared object；MCP执行检查当前可用性，但没有证明会按 replacement schema 重新验证。[P8] 要落实局部 binding／变更检查，不能宣称 SDK 已提供 schema-version fencing，也不能保证远端服务实现冻结。
3. **恢复重新装配 executable bindings 与当前 policy。**原生持久化的 schemas、loaded tool names、skill 内容和 codemode values 不是 executable code 或执行许可。无法安全重新绑定应拒绝，不猜测实现。
4. **callback 是 cooperative cancellation。**SDK timeout race／控制 ACK 不证明业务 callback 已停止；native I/O 与已派发 callback 按当前合同 join，迟到结果不得改变已失效调用。也不把 callback 完成等同所有下游副作用完成。
5. **权限配置必须与整个工具集兼容。**provider-hosted action 若不能在副作用前经过所要求的审批桥接，就不能仅靠 `permissionRequests: true` 或事后事件声称可安全接入；已知不兼容应在执行前拒绝。
6. **安全投影单独负责。**模型私有结果、catalog／skill 正文、headers、native errors 不自动公开。公开 DTO 的变更不影响模型执行、原生结果或其他回调。

## 七、第一版决策顺序

建议先确认以下边界，再修改类型：

1. Session-scoped tool 装配：名称／冲突、受支持 schema、runtime validation、callback completion、结果披露。
2. Deferred exposure：使用 native discovery；明确 native/default 与强制意图的可表达性，不承诺通用 lazy initialization。
3. Skill：批准来源与选择、真实资源、原生 runtime 限制、禁止 ambient loading。
4. MCP：transport／凭据／允许集合、native 连接 owner、部分初始化失败与 close。
5. Native toolset：显式启用范围和可审批性，避免 schema 相似但语义不等价的机械统一。
6. 只为确有需求的功能增加能力声明；不新增另一份工具／事件目录。

**第一版不需要：**公共 ToolRegistry、SkillRegistry、Plugin 框架、通用搜索 DSL、通用代码解释器、多层 factory、第四套 loop，或长期 Memory。原生历史／compaction／resume 和明确的资源 ownership 不能延后。

之后再按批准的语义做类型 RED → GREEN，并进入 Pi 完整纵向验证。OpenAI custom client search 的文档差异、Claude handler correlation／cancel、动态 MCP 的权限等待变更等需要离线真实 SDK／后续获授权 live 验证；本研究不替代这些验收。

## 固定来源索引

以下链接均为固定 commit，不用滚动指南作为实现版本承诺。Claude 声明来自实际安装包／逐字节一致的研究副本。

- **A1** ACP `b0b0be076fb89b41cb05d9ec9a7875ee1a98d654`：[v1 session setup](https://github.com/agentclientprotocol/agent-client-protocol/blob/b0b0be076fb89b41cb05d9ec9a7875ee1a98d654/docs/protocol/v1/session-setup.mdx#L380-L440)。
- **A2** 同版本：[tool calls](https://github.com/agentclientprotocol/agent-client-protocol/blob/b0b0be076fb89b41cb05d9ec9a7875ee1a98d654/docs/protocol/v1/tool-calls.mdx#L6-L43)。
- **A3** 同版本：[v2 migration](https://github.com/agentclientprotocol/agent-client-protocol/blob/b0b0be076fb89b41cb05d9ec9a7875ee1a98d654/docs/protocol/v2/migration.mdx#L12-L30)、`schema/v1/meta.json`、`schema/v2/meta.json`、v1 extensibility。
- **A4** 同版本：[MCP-over-ACP RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/b0b0be076fb89b41cb05d9ec9a7875ee1a98d654/docs/rfds/mcp-over-acp.mdx#L9-L99)。
- **M1** MCP `1f520964b295d58494d944f2aea8a5ab51c79f77`：[2025-11-25 tools](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/1f520964b295d58494d944f2aea8a5ab51c79f77/docs/specification/2025-11-25/server/tools.mdx#L55-L185)、同版本 pagination／tasks。
- **M2** 同版本：[2026-07-28 changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/1f520964b295d58494d944f2aea8a5ab51c79f77/docs/specification/2026-07-28/changelog.mdx#L12-L36)、该版本 server/tools／basic/index。
- **S1** Agent Skills `69ef37e9424c0a7ea9dd2293b559e43ec8176379`：[specification](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx#L216-L237)。
- **S2** 同版本：[adding skills support](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/client-implementation/adding-skills-support.mdx#L143-L165)。
- **P1** Pi `abe508e1b89912adde45528136c3221eb69acdd7`：[SDK MCP example](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/examples/sdk/14-codemode-mcp.ts#L26-L50)、该版本 SDK docs 112–118。
- **P2** 同版本：[tool search](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/extensions/tool-search/tool.ts#L194-L247)。
- **P3** 同版本：[tool definition](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/extensions/types.ts#L500-L641)、codemode/tool.ts 342–379。
- **P4** 同版本：[MCP startup](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/extensions/mcp/index.ts#L1111-L1210)。
- **P5** 同版本：[MCP extension options](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/extensions/mcp/index.ts#L70-L100)、MCP docs 32–86／127–179。
- **P6** 同版本：[skills](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/skills.ts#L279-L390)、resource-loader.ts 153–165、agent-session.ts 2143–2166。
- **P7** 同版本：agent-session.ts 1809–1829／3588–3592，codemode/execute.ts 492–506。
- **P8** 同版本：[prepare／execute](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/agent/src/agent-loop.ts#L717-L857)、MCP index.ts 426–442。
- **O1** OpenAI `33e2741be9bb52c1d96a8b4dac0c68e46297b607`：[tools guide](https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/docs/src/content/docs/guides/tools.mdx#L227-L253)。
- **O2** 同版本：[native client search](https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/runner/toolSearch.ts#L570-L583)，791–967。
- **O3** 同版本：[search rehydration](https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/runState.ts#L5579-L5612)。
- **O4** 同版本：[schema parsing](https://github.com/openai/openai-agents-js/blob/33e2741be9bb52c1d96a8b4dac0c68e46297b607/packages/agents-core/src/utils/tools.ts#L205-L237)、utils/strictToolSchema.ts 209–248／521–547／730–789／805–867。
- **C1–C4** Claude Agent SDK 0.3.295 `sdk.d.ts`，SHA256 `e4d91d71404ce4ffc918aa590f545c7a67df6a1dfe5de8cd28a05db0a7fe872b`。C1: 1206–1216／5318–5329；C2: 603–641／9797–9801；C3: 2242–2276；C4: 231–239／2296–2302。没有据此审计闭源 CLI。
- **X1** OpenCode 1.19.0 `733b2c627e5aec39cb33cc22373bdce33053ef2c`：[registry](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/tool/registry.ts#L121-L143)，183–203；plugin/src/tool.ts 3–54。
- **X2** OpenCode 2.0.27 `773d8621d6bcd311067b225d837c917b3e83573e2`：[Promise tool](https://github.com/anomalyco/opencode/blob/773d8621d6bcd311067b225d837c917b3e83573e2/packages/plugin/src/promise/tool.ts#L12-L27)、packages/schema/src/tool.ts 27–44／92–102。
- **X3** 同版本：[snapshot](https://github.com/anomalyco/opencode/blob/773d8621d6bcd311067b225d837c917b3e83573e2/packages/core/src/tool.ts#L225-L262)、packages/codemode/src/tool-runtime.ts 302–354／443–454。
- **X4** 同版本：[MCP startup](https://github.com/anomalyco/opencode/blob/773d8621d6bcd311067b225d837c917b3e83573e2/packages/core/src/mcp/index.ts#L534-L555)、tool/mcp.ts 48–67／125–151。
- **H1** OpenHands SDK 1.54.0 `e3a26821f8f7c85e98078c7b5e1a80647fc7d0c7`：[registry](https://github.com/OpenHands/software-agent-sdk/blob/e3a26821f8f7c85e98078c7b5e1a80647fc7d0c7/openhands-sdk/openhands/sdk/tool/registry.py#L130-L176)、agent/base.py 571–599。
- **H2** 同版本：[browser materialization](https://github.com/OpenHands/software-agent-sdk/blob/e3a26821f8f7c85e98078c7b5e1a80647fc7d0c7/openhands-tools/openhands/tools/browser_use/definition.py#L804-L859)。
- **H3** 同版本：[client tools](https://github.com/OpenHands/software-agent-sdk/blob/e3a26821f8f7c85e98078c7b5e1a80647fc7d0c7/openhands-sdk/openhands/sdk/tool/client_tool.py#L99-L172)。
- **H4** 同版本：[MCP reconciliation](https://github.com/OpenHands/software-agent-sdk/blob/e3a26821f8f7c85e98078c7b5e1a80647fc7d0c7/openhands-sdk/openhands/sdk/mcp/utils.py#L254-L298)、conversation/impl/local_conversation.py 1381–1388。
- **D1** Codex `a9b0815167c27ab13719dd12d13b63e02b70d221`：[MCP exposure](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/mcp_tool_exposure.rs#L68-L155)。它是产品实例，不是 OpenAI Agents SDK。
- **D2** Claude ACP adapter `4e1fc1e8df2b9af3b1b2d6880ba90c5862283ba8`：[session fingerprint](https://github.com/agentclientprotocol/claude-agent-acp/blob/4e1fc1e8df2b9af3b1b2d6880ba90c5862283ba8/src/acp-agent.ts#L1491-L1524)。

本地证据目录：`/tmp/mha-tool-skill-mcp-research.OSmpRG/`；Agent Skills：`/tmp/mha-agentskills-research.dfCjho/agentskills/`；OpenCode／OpenHands 摘取：`/tmp/mha-external-contracts/`。这些路径是本次会话证据，不是产品运行配置。

验证记录：固定 Git blobs 的 13 项重点引用范围、报告 26 个源码链接的路径／行号范围、Claude 实际安装声明 hash、本地 Markdown 链接，以及本轮前后的 contract／index hash 均核验。`sources.json` 保存源码 hash。另做一轮只读独立语义复核，未发现需修改的问题；Markdown LSP 为 0 diagnostics。仅新增研究文档，不运行或宣称 SDK／全仓行为测试通过。
