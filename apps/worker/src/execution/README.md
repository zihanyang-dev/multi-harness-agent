# 执行监督

`executeTurn(database, { turnId, host, signal, maxRunMs })` 执行一个已接受的文本 Turn。数据库 claim 提交后才打开原生 session；重复通知、已 claim 或未知执行不重跑，也不自动接管。

顺序是：claim → host open → Attempt 记录原生 ID → 持久取消／shutdown／deadline 检查 → 唯一 invocation → 独立读取 owned `run.result` → 停止并 join 控制 monitor → join `session.dispose()` → fenced 正式结果事务。不会消费 events，也不会建立另一个 SDK loop。

取消和 deadline 只合作请求 interruption；ack 不代表停止，仍等待结果及 cleanup，completion 可以赢过取消 race。`maxRunMs` 从尝试开始计时，包含 claim／open 的耗时；不以 timeout race 伪造 native 或 cleanup 已结束。不能合作结束的 native 调用仍需等待，不授权 takeover。

公开结果仅显式构造 assistant 文本 `{ id, role, content }`。Pi 已结算的 in-band provider failure（私有 Error 的 native assistant error cause）在 cleanup 成功后提交固定 `execution_failed`；其他观察／owner／控制失败及 unsupported pause 保持 reconciliation。cleanup failure 和正式提交未知也保持 admission fence。新 session 未 invocation 时只记录 Attempt 分配，不推进 Thread 的 native history ID。

本模块不接入队列或创建 host。所有异常对调用方仅携带固定代码，没有原始输入、供应商响应或私有异常 cause。集成测试使用隔离 PostgreSQL schema 与受控 PiTurnHost 验证执行边界；真实 SDK host 行为另由 `harness/pi/host.test.ts` 的隔离 SDK 检查覆盖。

`db/turns.ts` 拥有执行 SQL 和 Thread → Turn → Attempt 锁序；领取时解析未知 JSON 输入及私有 binding。不处理用户授权。根目录 `worker.ts` 拥有 BullMQ intake、合作中断和执行 Promise drain；生产 worker 不发布产品 outbox，server 负责命令投递。
