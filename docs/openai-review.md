# OpenAI 代码审查与验收边界

日期：2026-10-10。对象是本次未提交工作区。审查覆盖实际源码、相邻测试、公开入口、构建与文档，原生版本固定到 0.20.0。

## 1. 更正上一轮归因

上一轮把 SDK completed 当成“所有原生资源已经销毁”的通用 join，并把不满足这个自定保证称为 SDK P1。这个归因不充分，撤回；没有修改 SDK，也不以 SDK 内部 promise、代理或白名单补洞。

公开声明对 completed 的描述是等待 stream 完成。离线 sandbox probe 证明某个失败路径的 outcome／stream 结束可以早于 SDK-owned sandbox close；它没有证明 SDK 违反该公开契约，也没有证明 probe 中只记录日志的 host dispose 实际破坏了某个资源。

问题应先在我们的边界修正：

- wrapper 等待官方结果、维护本地 writer，不自称 SDK 的全资源管理器。
- SDK 管理其 SDK-owned 资源；不由 wrapper 代为 close。
- host 的显式 dispose 只释放它真正拥有的资源，按这些资源自己的生命周期等待；跨资源依赖由真实 owner 协调。借用 client／Runner／history 不自动关闭或清空。
- 失败 owner 禁止新的执行；不能因为 observer EOF／interrupt 就猜测 SDK 成功或允许失败 receipt 重用。

**当前按官方公开结果语义运行，不宣称已经证明任意 resource graph 的物理收尾。** 特定 provider／sandbox 的实际依赖还需对应服务验收，而不是平台造一套通用 finalization。

## 2. 删除我们多余的事件层

旧 session.ts 启动一个主动 pump，把生成器投影逐条 enqueue 到自造公开 ReadableStream。官方 Runner 本来就独立于消费者执行，这层并不是运行 SDK 所必需的，反而额外保留一份无界事件队列。

现已删除 pump、公开 ReadableStream／controller 和 executeRun 的搬运循环：

- startExecution 直接 await 官方 Runner 的 streamed result。
- result 单独等待 SDK completed；即使没人读取事件，也会执行、保存历史和报告失败。
- events 直接由 createRunEvents 生成，按消费者读取映射唯一 native iterator。
- reader 只在观察时获取，使用 preventCancel；关闭观察者不取消 SDK。
- 不新增 cache limit、gap event、sink 配置或持久分发框架。

这是去掉 wrapper 的重复 buffering，不是宣称 SDK 自身的 buffering、长任务负载或生产回放已验收。

同时修正了另一处混淆：观察失败不改变执行结果。事件生成器只给出脱敏终态，不把私有异常抛进公开事件迭代；原始 SDK 错误仍在 result 上拒绝。新增回归先确认 RED，再验证该分离。

## 3. 继续删除非原生的预留层

没有实际消费者的 HarnessTool／HarnessMcpServer／HarnessSkillsOptions、对应 options 与导出、只有拒绝实现的分支和 capability map 已删除。保留真实的 provider.resumable 历史重开声明；SDK 原生能力不再用另一份 false inventory 描述。直接 MCP 开发接口依赖也随之移除，原生 SDK 依赖不变。

输入 mapper 删除 SDK schema 未要求的 filename 非空限制和不执行 IO 的 URL 协议白名单。测试同时使用官方 InputFile／InputImage safeParse 与实际 mapper，不把 schema 接受等同供应商接受；file URL 只是引用，不读取或上传本地文件。

stream／session／signal 在 Runner 调用中无条件最后提供，删除重复的运行时拒绝；仍拒绝会改变 context／history authority 的三个字段，没有新 sanitizer。

发现并修正了确实属于 wrapper 的 disposal 重入错误：之前先 abort，再发布 closing Promise，signal listener 同步重入会两次 cleanup。真实 Runner／官方 stream responder 回归确认 RED，改为先发布同一 closing Promise 再 abort。

## 4. 代码与原生架构

adapter 是公开合同与准入；session 以私有普通状态和完整动作维护 writer／continuation；request 完整映射有序内容；projection 在生成器内部持有观察状态，平坦分派交给完整转换函数。

实际调用官方 Runner.run；工具、approve／reject、nested agent、handoff、schema、history 和 compaction 仍由 SDK 执行。没有工具 registry、公共 mutable projector、通用 checkpoint、固定 Workflow 或第四执行框架。SDK 图保留不是所有服务／失败组合已验收的证明。

原生 message ID 可选，之前的投影把无 ID 的成功 run 判失败，已用真实 Runner 回归修正：省略不能稳定标识的公共文本，native 内容与执行仍保留，不造假 ID。

之前 values 的 ts2339 来自我们创建的全局 DOM ReadableStream。该多余 stream 已删除，现在只使用官方 SDK 的原生 iterator，不用断言／ignore 掩盖类型错误。

## 5. 检查与尚未验收的范围

当前验证命令：

- pnpm check：formatter／lint、所有项目类型检查、运行测试与构建。
- pnpm test:e2e：仅 Web → Hono HTTP health，不调用 Agent。
- built exports：包根与 openai 入口调用同一真实 factory，dist 不含旧实现或测试。
- 主动 LSP：类型诊断与辅助规则提示分开，不以被隐藏的 finding 声称全 clean。

相邻测试使用官方 testing Model 与真实 Runner／工具／Session，覆盖文本、history、writer、批准／拒绝／部分决定、nested approvals、handoff、具体 context／schema、取消 continuation、失败后的 gate、恢复 receipt、无观察者执行、observer close、持久化等待与 cleanup、输入快照、官方 Responses converter／client。type-d 保留 native 类型回归。

### 新版真实模型验收

用户补充凭据并授权新增预算后，实际对当前生产 dist／公开包入口运行官方 OpenAIResponsesModel、Runner 与 Session。网关为 https://sub2api-rd.pexoai.cn/v1，模型 gpt-6.1-sol；tracing 关闭，client 自动重试为 0，只发送合成数据。

最终完整矩阵：**23 项，22 passed，1 failed，6 个临时测试文件**。失败不是忽略或转成 skip。22 项包含两个 AV 拒绝边界检查，不能理解成 22 项模型能力都成功。

| 范围 | 实际结果 |
| --- | --- |
| 流式文本、原生 history 重开、无人消费事件 | 通过，原生响应与持久化实际完成 |
| 原生批准、拒绝、部分批准、陈旧 receipt、追加输入 | 通过，工具次数与返回 marker 精确检查 |
| local context／structured output | 通过，模型只经工具取得隐藏 marker |
| handoff／nested agent approval | 通过，继续原 graph，不换 lastAgent 或重建 transcript |
| RunState 序列化与重建 Agent／Tool／Runner、fresh context | 通过，恢复执行使用新 context 的不同 marker |
| 已取得 reader 后关闭观察 | 通过，SDK 继续完成 |
| 实际 HTTP 取消、原生 SDK 对照、取消后恢复 | 两边均 cancelled；wrapper 恢复后完成，新输入不重复原输入 |
| 本地真实 stdio MCP | 通过，官方 MCP 服务、真实 native function call／result 和隐藏 marker |
| 原生 server tool search＋deferred function | 通过，真实 search call／output、发现与执行证据 |
| PNG／PDF／DOCX／XLSX／CSV | 均精确读出文件内隐藏 marker；交错 PNG／CSV／PDF 顺序也通过 |
| 输入 guardrail／maxTurns handler＋host compaction 故障 | 正确保留 SDK 拒绝与失败 gate；guardrail 拒绝不是一次模型成功调用 |
| WAV／MP4 通用 input_file | 网关均 HTTP 400、code invalid_value；零公开文本、脱敏 RUN_ERROR；AV 理解不通过 |
| 官方 OpenAIResponsesCompactionSession | HTTP 502 upstream_error，未通过 |

compaction 失败在真实 SDK Session 下复现两次；绕过 harness 直接调用官方 client.responses.compact 也返回 502。响应只含 upstream_error／Upstream request failed，客户端看不到更深的上游原因。直接调用的 request ID 为 fdf91a92-3955-47d2-8a4b-857d894f6bc0，可由服务运营者关联服务端日志。

公开 Sub2API 项目有 [compact 路由](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/handler/endpoint.go)，也有 [同类 502 报告](https://github.com/Wei-Shaw/sub2api/issues/1298)；不能将该部署的 502 归纳为 Sub2API 整个项目不支持，当前部署版本、账号调度、模型映射及真实上游原因仍未知。不能据此判 SDK 有 bug，更不能加模拟 compaction 把验收改绿。需要该网关／上游请求成功，才能完成此项。

此前 controlled Model 抛 APIUserAbortError 的离线结论不能扩张成实际 HTTP 取消失败；这次实际链路已证明 fulfilled cancelled 与 continuation 正常。任意 SDK／存储错误仍不吞成取消。

临时 live runner、媒体、MCP fixture 放在 /tmp，不加入正式源码、依赖、脚本或默认测试命令。正式目录仍为相邻 xxx.test.ts／类型测试。旧网关结果仍只算历史，以上才是新版证据。

产品 Web／Turn API 尚未接通 Agent；sandbox OS 隔离、生产 durable history／跨进程协调、进程／节点故障恢复、Claude adapter 仍未实现或验收。Pi 后续完成的包级文本切片与独立证据见 [Pi 审查](pi-review.md)，不纳入这份 OpenAI 矩阵。包级真实模型路径通过不代表这些产品能力完成。

### 最后一轮独立审查

分别进行只读正确性／安全审查与原生设计／代码品味审查，未发现当前包级实现的提交阻断问题。检查 writer、同步重入、exact receipt、SDK 初始化与结算错误、observer independence、原始异常、缺失 message ID、原生 graph／history 保留及导出／构建边界。修正 README 与输入研究中误称已删除 portable 契约仍存在的文案和链接，不新增替代抽象。

最终本地 frozen install、pnpm check（51 tests／7 files、lint、全仓类型检查与构建）、health E2E（1 passed）及生产 root／openai exports 烟测通过。主动 LSP 无 TypeScript 错误，仍有辅助规则提示与已隐藏 finding，不宣称全部诊断 clean。本轮未重新执行付费矩阵；上面的 live 结果保留原证据及失败项，不用离线通过替代。

## 6. 清理

harness build 清理其 dist 后构建；旧 ag-ui／input／output 输出已移除。删除未用直接 pi-ai／protocol AG-UI 依赖，测试 client／zod 放在 devDependencies，lockfile 与供应链校验保持一致。config 不再保留已经交接的初始 runState。

修正文档断链、已删除 fixtures 的运行承诺与 UI scope；历史证据保留为历史。清理拥有的 browser／测试产物与临时研究文件，不恢复用户删除的实现，不动凭据、用户历史或未知资源。未提交、push 或修改 SDK。
