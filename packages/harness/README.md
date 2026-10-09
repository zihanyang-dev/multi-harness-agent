# Harness 接入

生产执行与评测共用的原生 SDK 接入边界。依赖已安装，`src/contract.ts` 是初始契约，尚无可用 adapter。

- Pi 1.1.0、OpenAI Agents SDK 0.20.0、Claude Agent SDK 0.3.295。
- 保留官方 loop、session、compaction 和实际控制能力，不编排创作步骤。
- 契约当前仅定义文本输入；多媒体、恢复、steer 和公开推理须逐 SDK 验证。
- 公开消息不是 checkpoint；不实现跨 harness 通用上下文。
- MCP 连接配置、工具 SDK 包装与 Skills 装配属于本包；业务工具的授权、IO 与业务规则由 host 提供。
- Tool、MCP、Skills 是确定的必备接入边界，现在建立公共契约；当前仍无 adapter，不能宣称三个 SDK 都已支持这些能力。
- 没有默认 provider、模拟输出或自动云端调用。

## 契约组织

```text
src/
  contract.ts
  tool.ts
  mcp.ts
  skill.ts
  index.ts
  pi/
  openai/
  claude/
```

`contract.ts` 只持有 session、run、provider 与能力声明；引用三个具名模块，不在每个小目录中重复放 `contract.ts`。SDK 特有的装配留在 adapter；模块出现真实的多文件职责后再扩成目录。

### Tool

`tool.ts` 定义注入的自定义工具。当前借用官方 MCP Tool / CallToolResult 类型描述，并不要求进程内工具走 MCP 连接；实际 SDK 映射仍需验证和收敛。不编写通用 schema 转换引擎。

原生文件、终端等工具保留 SDK 定义与行为。业务实现由 host 注入并负责输入校验、授权与幂等；不建立全局工具注册中心。

### MCP

`mcp.ts` 定义可信 host 提供的 stdio / Streamable HTTP 连接配置。官方 MCP SDK 是直接依赖；连接与关闭使用各 adapter 公开支持的机制。

不接受模型授予的连接权限，不将环境变量或 headers 写进日志和恢复快照。当前没有连接实现，不会启动子进程或请求远端。

### Skills

`skill.ts` 定义原生加载配置，通过 `OpenHarnessSessionOptions.skills` 传入受信目录；各 adapter 使用官方机制，不自造 SKILL.md parser、检索服务或 loader。

`video-editing/SKILL.md`、脚本和参考资料属于业务技能资源，不放在本包源码中。没有默认技能 bundle，也不照抄参考项目的双端固定路径要求。

发现、加载与执行脚本分别看待；技能不是自动授权，不伪造统一 load_skill 事件。adapter 对不支持的请求应明确拒绝，不能静默丢弃配置。
