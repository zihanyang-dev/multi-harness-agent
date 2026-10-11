# 会话 UI 与真实 E2E

> 2026-10-11。本轮实现真实文本会话的第一版 Web，而非完整通用 Agent 产品。前端使用 React 19.3、Tailwind CSS 4.3.3、Vite 8.3.4、TanStack Router / Query；认证客户端使用与 Server 相同的 Better Auth 1.7.7。

## 1. 工作流与 Agent 的位置

用户工作流是 **提出目标 → 观察执行 → 停止或等待 → 查看结果 → 继续迭代**，不是预定义的视频或编码节点图。

| 用户需要 | 当前实现 | 后续能力边界 |
| --- | --- | --- |
| 表达目标、补充限制 | 保留原始文本与空白；六个 starter 只填草稿 | 文件输入、项目指令需要真实归属与来源准入 |
| 让 Agent 判断怎么办 | 输入交给 Pi 官方 loop 与原生 history | 工具、Skills 与 sandbox 接入后，由 Agent 决定计划和工具顺序 |
| 知道任务是否被接受、是否仍在运行 | 持久 Turn 状态与 SSE 原生增量／工具活动 | 5 秒查询仅作断线／对账备援；不模拟 thinking、token 或百分比 |
| 改变主意 | 显式请求取消，等待正式终态；完成可能赢过取消 | 审批、重定向与原生暂停恢复分别验收 |
| 得到可使用的结果 | 安全 Markdown / GFM、复制完整回答、同 Thread 续聊 | 文件成果必须有独立身份、权限和交付记录，不能把模型 URL 当成果 |
| 返回之前的工作 | 真实 owner-scoped 侧栏、URL、分页历史 | 重命名、搜索、分享、跨设备草稿未实现 |

当前 Pi host 默认 `text-v1`，没有业务工具；可选不可变 `web-search-v1` 装配 native `web_search`，仍无 shell、文件系统工具或动态资源发现。composer 根据 Thread 的 `tools` 显示 text-only／web search，字段缺失显示未知文本输入，不猜测或升级策略。UI 不用“Agent”字样暗示这些能力已经开放，也不显示伪造的工具轨迹或内部推理。

## 2. 原型依据与视觉

实际参考文件是相邻仓库的 `.cache/prototypes/kimi-replica.html`：

- 标题 `Kimi UI 1:1 Replica (prototype)`，2,425,862 字节。
- SHA-256：`d850d77eccac60706905a5120dc89f90c1ee9bf03aa23b4c5ac0fc3546bc20a3`。
- 它是本地 ignored / untracked 备份，不能证明与曾删除的 `docs/*.html` 字节相同。
- 原型中的 streaming、thinking、search、tool、plan 演示是本地预设，不是后端能力。
- 按浏览器实际生效的 home / chat 布局测量，未直接复制其 2.4 MB DOM / CSS dump、第三方字体、图片或品牌资产。
- 本轮在用户授权的现有 Chrome 中进行了独立 Kimi / LobeHub 对话研究；Kimi 的浏览器停止观察与 LobeHub 的 HTML / JSON 错误边界见[研究报告](agent-product-research.md)，不把 UI 停止当 native 物理停止证明。

保留 240 px 侧栏、浅灰画布、6 px 外边距、12 px 主画布圆角、24 px composer 圆角，以及桌面和手机的空间比例。使用自己的 `AGENT` / Multi Harness 标识，把原型的插件、附件、模型选择和成果入口替换为真实的文本 / Pi 信息。

| 视口 | Home composer | Chat composer |
| --- | --- | --- |
| 1440 × 1000 | x453 / y420，768 × 186 | x453 / y871，768 × 114 |
| 390 × 844 | x19 / y354，352 × 186 | x19 / y703，352 × 114 |

此前文本实现的历史 UI 截图（不是新版 SSE／搜索证据）：

- [桌面首页](assets/conversation-home.png)
- [手机首页](assets/conversation-mobile.png)
- [真实模型回答与跨 Worker 续聊](assets/conversation-native-history.png)

## 3. 交互与失败语义

- 官方 Better Auth React client 使用同源 `/api/auth`；不自建密码或登录协议。
- 前端 `/api/*` 代理到原生 API，移除 `/api`。`BETTER_AUTH_URL` 必须是浏览器实际访问的根 origin，不是私有 API 端口；hostname 也必须精确一致。
- 侧栏来自 `GET /threads?after=<threadId>`，每页最多 25 条，按 PostgreSQL `(created_at, id)` 从新到旧分页。标题取第一条输入的安全预览，不发起额外命名模型调用。外来或不存在的 cursor 返回 404。
- owner 包含在查询 key 中；账户变更重建本地会话状态，退出清理 owner 缓存。native ID 从不作为授权。
- 仅有草稿不会创建 Thread；首次发送才创建，再提交不可变 Turn。输入保留精确空白，超过 32,000 UTF-16 code units 不截断、不发送。Enter 发送，Shift+Enter 换行，IME composition 不误发送。
- Turn POST 没有自动重试。不确定响应保留同一 `requestId` 与精确输入，锁住该 Thread 的新提交，显式 retry 只检查同一请求。
- 草稿与不确定请求是页面内状态，可跨 home / thread / `/status` 导航保留，不是持久 browser checkpoint。刷新、关闭页面或退出会丢失未确认请求身份；UI 明确提示保留期限，并在存在未确认提交时注册离页警告。用户选择离开后，应先查看历史，不能假定没有执行。
- 匿名草稿按其原始 route key 交接给登录后的组件，侧栏登录与 composer 登录均不把 Thread 草稿移到首页。
- accepted / running 展示真实状态；cancel HTTP 成功不立即显示 cancelled。`needs_reconciliation` 继续阻止新提交，不提供假安全重跑。
- 历史未完整加载时保守禁用发送，避免未观察到的 active Turn。分页需要用户点击加载更多。
- 页面断开只解除观察，不自动取消原生执行。`GET /turns/:turnId/events` 经认证与 owner 检查，以 native EventSource 接收 `turn`／`activity`／`gap`，自动重连携带 `Last-Event-ID`。临时预览可被 `MESSAGES_SNAPSHOT` 撤回，SQL 正式结果替换预览；raw reasoning／参数／signatures 不进入浏览器。
- 工具参数完成不是执行结果：展示名称与安全通用结果，只有 host allowlist 的只读搜索结果提供来源。Tavily 接入只调用固定 HTTPS endpoint，禁止 arbitrary fetch／redirect／自动重试，8 秒 timeout、64 KiB body、最多 5 个经校验来源 URL 与 8192 UTF-8 bytes JSON 结果；native cancellation 传入请求。来源文字是非可信数据，不是权限。
- Markdown 使用 react-markdown 10.1.0 / remark-gfm 4.0.1：不执行 raw HTML，不自动请求远端图片，保留库的安全 URL 转换。复制功能只复制正式回答文本。
- 手机 drawer 移入焦点、约束 Tab、支持 Escape、关闭后恢复焦点，并使遮挡的画布 inert。

## 4. 自动化验证

Node **24.21.0** 下的新验证：`pnpm check` 包含格式 / lint、全仓类型检查、**217 项单元测试 / 30 个文件**与构建；真实 PostgreSQL / Redis 集成 **105 项 / 15 个文件**；浏览器 **13 / 13**。最终发布核对见[验证记录](evidence/conversation-streaming-verification.json)，以其中对应版本和实际运行范围为准。

提供显式 loopback 测试服务后，浏览器 suite 启动隔离的真实 Server、原生 Better Auth、独立 PostgreSQL schema / queue prefix、Worker、Pi SDK loop 与 native history。**仅外部模型 / 搜索 IO 使用受控 fixture：官方 faux provider 与固定响应的 Tavily fetch；不替换原生 loop、工具调度、取消、history 或实时通道。** 临时 HOME 与 Pi 配置目录不指向个人配置，收尾 join 后清理。

```bash
TEST_DATABASE_URL='postgresql://agent:local-test-only@127.0.0.1:5432/agent' \
TEST_REDIS_URL='redis://127.0.0.1:6379' pnpm test:e2e
```

使用独立的 3001 / 5174 端口，不复用开发服务。未提供两个测试 URL 时，使用无 env-file 的独立 Server 命令并显式关闭后端，只执行 `/status` liveness 检查，会话用例跳过；不能把这一模式称为会话验收。

当前 13 项浏览器检查覆盖此前的 9 项交互，并新增 genuine native 增量、断线 cursor 回放、推理隐私与真实 native 搜索工具 / 取消：

1. durable 提交、持久侧栏恢复、页面刷新、复制回答、同 Thread native history 续聊。
2. Server 已接受后丢失响应，跨 `/status` 导航再 retry，精确相同请求与唯一 Turn。
3. running 取消、正式 cancelled、同 Thread 继续。
4. 跨账户 404、空历史与同一浏览器账户切换后的缓存隔离。
5. Markdown 的 HTML / javascript URL / 远端图片边界。
6. 原生 cookie 撤销后通过登录 UI 认证并提交。
7. 手机无横向溢出、drawer 键盘控制与实际发送。
8. 登录时保留原 Thread 的匿名草稿。
9. Web → HTTP liveness。
10. SQL 仍为 running / result null 时显示增量；真实 socket 断开后，同一个 native EventSource 携带 `Last-Event-ID` 恢复，预览仍是原文前缀，无重复。
11. 阻断备援 detail GET 后，SSE 仍能送达正式结果；推理仅发 process 状态，不向 wire / UI 发 private thinking。
12. native `web_search` 调用期间显示 arguments complete / awaiting result，完成回答提供真实 fixture source link。
13. 搜索 HTTP IO 期间请求取消，join native tool 后才能接收下一轮。

断线在仅供 E2E 的 loopback proxy 中注入，控制命令先经真实 owner API 授权，只关闭该 Turn 的 observer，不触及 native invocation。该 proxy 还阻断该 Turn 的浏览器 detail GET，避免 polling 掩盖 SSE 缺陷。不能用 Playwright `page.route` 注入这一故障：已复现 CDP interception 丢失 Chromium 自动生成的 `Last-Event-ID`；离线模拟也不会关闭已有 SSE socket。Vite proxy 必须传播 upstream aborted，已观察移除该处理时 RED、恢复后 GREEN。另用暂停 TCP 读取的真实 Node HTTP 回归验证 SSE write timeout / shutdown 的物理连接释放；健康连接正常 EOF，只有阻塞写入才释放 socket，不取消 native 执行。

审查发现的 `/status` 卸载状态、草稿 route 交接与手机焦点问题，均先在真实浏览器观察 RED，再修复并观察 GREEN；另验证侧栏登录入口的草稿交接，以及 fallback 不加载开发者 env-file / 不启用后端的配置回归。浏览器覆盖单条侧栏恢复，列表分页另由真实 SQL / HTTP 集成测试覆盖，不冒称已点选第二页浏览器记录。认证 setup 遇原生 429 时仅按该版本 `X-Retry-After` 有界等待；不关闭限流，也不把此策略用于 Turn POST。

frozen lockfile、依赖 audit、secret scans、主动 LSP 与 fallback 的最新结果单独记入验证记录，不把陈旧诊断缓存或上一版计数当作本次 clean 证明。原生 memory limiter 的可信 IP / 多进程边界仍未验收。

## 5. 用户授权的真实模型验证

新版[真实模型报告](evidence/conversation-streaming-live.json)使用 OpenAI **`gpt-5.5`**，**5 次真实调用（4 次完成、1 次取消），7 个场景组**：

- SQL 为 running / result null 时，真实浏览器预览从 212 增长至 221；正式结果替换预览，Copy 与 receipt 完全一致。
- fresh Worker 恢复原生历史并记住 nonce；4 条完成消息的 ID / 内容与 native history 精确一致。
- 可见增量后取消，5 次 native disposal 均 join，全部 SQL Attempt 停止；随后继续、创建新 Thread、移动抽屉、退出与匿名保护。
- 610 条 Redis activity 通过严格公开 schema，包括 594 条 text delta 与 6 条 reasoning 状态，无 private reasoning。
- [新版桌面首页](assets/conversation-streaming-home.png)、[真实正式回答](assets/conversation-streaming-answer.png)、[新版手机界面](assets/conversation-streaming-mobile.png)。图片来自 settled real UI；增量由 wire / SQL 观察证明，不伪造流式截图。

这次 live 使用 `text-v1`，**没有 live Tavily 调用**；搜索的 native 调度 / 来源 / 取消证据来自受控外部 IO 的浏览器及 SDK 回归。

以下保留此前文本实现的历史报告，不作为新版 SSE／搜索证据：

- [后端 sanitized report](evidence/conversation-backend-live.json)：8/8。
- [浏览器 sanitized report](evidence/conversation-browser-live.json)：5/5。

后端矩阵涵盖 native auth / Origin / owner、接受与 replay / busy / conflict、SQL outbox → BullMQ → Pi → 正式结果、fresh Worker 恢复、running 取消、取消后续聊、缺失 native history fail-closed、logout。浏览器矩阵涵盖原生认证 UI、真实回答展示、刷新与 fresh Worker 后模型记住随机 marker、joined cancellation、退出与手机首页。

凭据通过 Pi 1.1.0 官方 `ctx.modelRegistry.getApiKeyAndHeaders(model)` 获取。CLI 正常读取其自身授权配置；测试代码不解析、复制个人 auth 文件。解析的 provider / model / endpoint / key / plain headers DTO 只经私有 child stdin pipe 传递，不放 argv、前端、报告或全局 `process.env`。sentinel handler 的成功与失败分支都返回 `handled`，避免失败 fallthrough 引发意外 inference。

**验收范围是 built Server、built Worker / host factories、显式 CLI 解析的 endpoint binding，与开发 Web 服务。** 当前生产 Worker 环境入口只接受显式 API key，不自动发现个人 CLI 授权，也未提供任意自定义 endpoint / headers 配置；本次不能代替默认 env main、生产 Web 托管或网关部署验收。正式 CI 不使用付费模型凭据。

## 6. 尚未验收与下一步

- SSE 原生增量、浏览器回放与可选只读搜索已有新回归和真实模型证据；未进行 live Tavily 调用。审批、文件与成果、sandbox、重命名、分享未实现。
- 不确定请求与草稿没有跨刷新持久化。SDK compaction 未在本次短文本 UI 矩阵触发。
- 原生 memory auth limiter 仅保护单进程；本轮 loopback API 无可信客户端 IP，SDK 会退回共享 per-path bucket。生产需另外验证可信代理 / IP 传递和分布式限流，不能因浏览器测试通过即称生产认证入口就绪。
- 前端按 conversation／identity／status 特性组织，真实 Tailwind utilities 配合小型 theme／Markdown CSS；auth、status 与新 `answer-markdown` 按需加载。最近构建 main 为 484.68 kB（拆分前 648.19 kB），lazy Markdown 为 155.18 kB；这是构建体积记录，不是浏览器性能基准或 TTFT 改善证明。
- 生产 crash / network partition、Redis durability、旧 writer 物理 fencing、OS / tenant 隔离、负载和自动恢复未验收。

下一步应实际验证搜索 provider 与生产入口、限流和负载，再接入其他真实授权的工具 / Skills、运行环境和有身份的成果；不制作一个看似在搜索、思考或生成文件的 UI 模拟器。
