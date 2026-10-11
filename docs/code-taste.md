# 代码品味

**好代码读起来像一份准确、连贯的说明：先知道有哪些事物，再知道能做什么，最后知道怎样完成。**

我们追求的不是最少行数、最多抽象或某种编程范式，而是清楚的概念、舒展的形状、稳定的阅读节奏，以及容易修改的边界。

本文只规定代码表达的品味，不替项目确定功能和架构。代码中的标识符、注释、错误、日志、UI 文案和测试文字均使用英文；说明文档使用中文。示例展示局部表达，不代表已经决定实际领域或运行行为。

## 1. 先明确：我们不采用“纯面向对象”作为默认

默认使用普通数据、独立函数和 ES 模块。需要一组固定依赖时，可以用函数组合或闭包；需要维护实例状态、不变量或资源生命周期时，类也自然。

TypeScript 官方明确提醒 Java／C# 开发者：不必把所有数据和行为放进类；独立函数操作数据通常是自然的 JavaScript 写法。Google 的规范也反对仅充当静态命名空间的类，并没有禁止有意义的类。[1]、[2]

因此：

- 计算、解析、查询、映射：默认函数。
- 数据与结果：默认明确的数据类型。
- 固定依赖与一组能力：按实际需要使用函数参数、闭包或对象。
- 持续变化的实例及其收尾责任：可以使用类。
- 不为每个概念建立类，不默认建立继承树、容器和多层 factory。
- 也不为了“函数式”制造大量闭包、组合器和难懂泛型。

**代码的美感与是否使用 `class` 是两件事。**

## 2. 从一份赏心悦目的声明学什么

用户提供的 Pi `agent-session-runtime.d.ts` 值得借鉴的是以下形状：

```typescript
export interface CreateAgentSessionRuntimeResult
  extends CreateAgentSessionResult {
  services: AgentSessionServices;
  diagnostics: AgentSessionRuntimeDiagnostic[];
}

export type CreateAgentSessionRuntimeFactory = (options: {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
}) => Promise<CreateAgentSessionRuntimeResult>;
```

它先给出一个**具名结果**，再给出**输入与输出都可见的创建能力**。没有用工厂类、注册表和多层泛型包住这个概念。

它的好注释也不只有“为什么”：它说明拥有谁、操作顺序、失败后果和调用方责任。这是接口契约本身的美感。

但 `.d.ts` 隐藏了实现体、局部变量和分支，天然比源码轻。我们借鉴它的契约和排列，不手写一套声明掩盖复杂源码，也不照搬 `declare`、下划线字段、所有 callback setter 或 re-export。

同名实现显示，某些操作先关闭旧 session 再创建新的；失败并不自动回滚到仍可用的旧 session。**签名舒服不等于行为简单，更不等于行为正确。**[3]

## 3. 文件展开后，应当先出现什么

文件默认按阅读关系组织：

```text
imports
→ 理解入口所需的少量类型与常量
→ 公共能力及其实现
→ 私有阶段和算法细节
```

类型有独立契约、篇幅显著且被多个消费者使用时，可以放到邻近的具体合同文件。只有几个局部类型时，直接放在使用文件里。

不要让公共入口被一堵类型墙埋住，也不要为了让入口在第一屏，强制把所有类型搬进全局 `types/`。

对类，通常这样排列：

```text
字段
→ 构造与初始化
→ 观察入口
→ 公共动作
→ 私有步骤
```

对函数模块，入口在前、支持入口理解的细节随后展开。很短的相关 helper 可以紧邻调用处。排序服务于阅读，不服务于模板对称。

## 4. Imports：交代依赖，不抢占阅读中心

类型依赖使用 `import type`，运行时依赖使用正常 import。来自同一模块、承担同一角色的导入合理聚合。

```typescript
import { readFile } from 'node:fs/promises';

import type { Document, DocumentStore } from './document.ts';
import { parseDocument } from './document-format.ts';
```

默认按来源分组：标准库、外部依赖、内部模块。组内排序交给 formatter／lint，不靠手工对齐维护美感。

不把每个名字拆成单独一行 import，也不为了减少 import 行数经过无意义 barrel。路径扩展名服从项目运行时与工具链，不照抄生成声明中的 `.ts` 或 `.js`。

一个文件需要知道很多无关领域的内部对象，首先检查职责是否过大；不要先把它们隐藏到 `imports.ts`。

## 5. 签名：让调用者不用猜

### 主对象直接，附加选择具名

```typescript
openDocument(path, {
  encoding: 'utf8',
  createIfMissing: false,
});
```

比 `openDocument(path, 'utf8', false)` 更容易理解。

只有一个明显参数时，不必全部包成对象。相邻身份、多个同类型参数或多个布尔选项容易交换时，使用具名参数：

```typescript
moveDocument({
  documentId,
  sourceFolderId,
  targetFolderId,
});
```

### 固定依赖与每次输入分开

```typescript
export type PublishDocument = (
  options: PublishDocumentOptions,
) => Promise<PublishDocumentResult>;
```

连接、凭证和固定配置通常在装配时绑定；一次操作的对象和选择进入 options。不要让调用者每次带一个包含全部环境的 `Context`。

这不要求创建工厂。显式传入一个 store 也可以很好读；只有绑定依赖确实减少调用噪音时，才引入创建函数。

### 返回值说出事实

```typescript
Promise<{ cancelled: boolean }>
```

比裸 `Promise<boolean>` 更容易辨认事实含义。但 `{ cancelled: boolean }` 不是万能模板：如果成功与取消携带不同数据，返回判别联合；只是判断“是否存在”的谓词，返回 boolean 就很好。

公开边界优先显式写返回类型，便于看到契约和阻止意外泄漏字段。局部 helper 的返回值清楚时，让推导工作，不为每个表达式补满 annotation。

## 6. 类型的形状：有名字，但不把每个形状都命名

一个类型值得命名，通常因为它有领域含义、是公共契约、被真实复用，或者内联后已经妨碍阅读。

短小、只用于一个签名的 options 可以内联：

```typescript
export function readDocument(
  path: string,
  options?: { maxBytes?: number },
): Promise<string>;
```

这里是签名示意；普通实现仍需函数体，不在业务源码里用声明冒充实现。

当选择项变多或需要文档时，命名展开：

```typescript
export interface ReadDocumentOptions {
  encoding?: 'utf8';
  maxBytes?: number;
  signal?: AbortSignal;
}
```

不要为每一个局部对象创建 `Options`、`Params`、`Input`、`Context` 四个同义类型，也不要一律把复杂对象塞进方法签名。

### 直接看出形状，比推导表达式更重要

```typescript
// Makes readers walk through another implementation to find the contract.
type OnText = NonNullable<Parameters<AgentHarness['run']>[0]['onText']>;

// Names the actual capability.
type TextObserver = (delta: string) => void;
```

如果已有官方 callback 类型，优先直接 import；不要重复拥有它。`Parameters`、`ReturnType`、`Pick` 等在真正需要跟随来源变化时很有价值，但不能让公共契约变成类型迷宫。

数据记录、联合和函数类型用 `type` 很自然；稳定的对象能力或确有语义扩展的合同用 `interface` 很自然。二者不与 OOP／函数式绑定，不为争论关键字制造大量重写。

`extends` 应表达真实扩展。减少两行重复，不足以证明 `Partial<Pick<A, ...>> & Omit<B, ...>` 是一个好公共类型。

## 7. 状态：字段之间的关系也要读得出来

```typescript
type JobState =
  | { kind: 'queued' }
  | { kind: 'running'; startedAt: Date }
  | { kind: 'succeeded'; output: string }
  | { kind: 'failed'; error: Error };
```

比 `isRunning`、`isDone`、`hasError` 和几个无关联 optional 字段更清楚。读者不必猜哪些组合合法。[4]

- 可选字段表示真正允许缺失，不表示“不知道怎么建模”。
- `null`、缺失、空字符串和空集合有不同含义，不随意替换。
- 枚举闭合的分支保持穷尽检查，不写一个静默默认值掩盖新状态。
- 彼此独立的开关仍用 boolean，不为所有数据建设状态机。
- 状态类型不代替转换规则、持久约束或并发控制。

`readonly` 表达不应修改的意图，readonly 数组不等于深度冻结。构建结果时不要先宣称所有字段只读，再用断言偷偷逐字段修改。

## 8. 函数体：一段决定有完整的段落

正常路径顺着读；拒绝条件先处理，但不机械禁止 `else` 或提前返回之外的形状。

```typescript
const document = await store.find(documentId);
if (document === undefined) throw new DocumentNotFoundError(documentId);
if (document.archived) throw new Error('Archived documents cannot be published');

const published = {
  ...document,
  status: 'published' as const,
  publishedAt,
};

await store.save(published);
return published;
```

这是局部表达示例，不代替实际存储的事务、授权或并发要求。

空行分隔有意义的阶段：读取与判断、计算与组装、写入与返回。不要每行插空行，也不把所有动作挤成连续一块。

函数抽取应增加一个概念、封装完整细节或消除真实重复。`teardownCurrent()` 可以封装完整收尾；`doStep2()` 或只包一次赋值的 helper 通常没有收益。

一段授权判断、锁序或原子写入属于同一决定时，不为缩短函数拆散它。复杂算法则可以有独立名字，不让主路径被索引和字节细节淹没。

## 9. 表达式：别让语法占据阅读中心

### 先命名中间含义，再组装结果

```typescript
// The identity rule is buried inside interpolation.
const eventId = `${fact.id}:${frame.type}:${'messageId' in frame ? frame.messageId : ''}`;

// The optional dimension has a name.
const messageId = 'messageId' in frame ? frame.messageId : '';
const eventId = `${fact.id}:${frame.type}:${messageId}`;
```

这类小变量不需要再抽成一个文件或函数。一次阅读成本高的表达式，就值得命名；不要求必须复用两次。

### 简单映射用链，复杂累积用循环

`items.map(toSummary)` 很清楚。需要过滤、维护优先级、更新多个集合，且夹杂断言的 `map/filter/flatMap/spread` 链，通常显式循环更好读。

不要默认认为 loop 比 map 高级，也不要把多步循环压成“一行函数式”。

### 对象组装先有主体，再处理附加部分

简单的一个 conditional spread 可以接受；多层条件、解析和转换混在属性中时，先给计算结果命名，再组装。

保持字段缺失与显式 `undefined` 的语义，不为了好看互换。公共输出用明确白名单，不 spread 整个私有 SDK 对象；美化不能扩大数据暴露。SDK streaming projector 只认官方有支持的事件：工具被提议不等于已执行，推理片段不等于公开摘要。临时 message identity 与正式 entry identity 可以不同，不靠拼接它们制造 checkpoint。

### 使用嵌入语言自己的布局

SQL 的 `select/from/where/and`、长模板和协议载荷按语义分行。formatter 不会自动理解字符串里的 SQL；不必为了每个 predicate 创建 helper。

## 10. 一份完整的函数模块也可以很舒展

下面是独立的代码形状标本。它展示固定依赖、具名输入／结果、公共能力、具体错误和完整动作；**不包含真实数据库、授权或并发发布合同**。

```typescript
export interface Document {
  id: string;
  status: 'draft' | 'published';
  publishedAt?: Date;
}

export interface DocumentStore {
  find: (id: string) => Promise<Document | undefined>;
  save: (document: Document) => Promise<void>;
}

export interface PublishDocumentOptions {
  documentId: string;
  publishedAt: Date;
}

export interface PublishDocumentResult {
  document: Document;
  changed: boolean;
}

/** Publishes documents through the assigned store. */
export interface DocumentPublisher {
  publish: (options: PublishDocumentOptions) => Promise<PublishDocumentResult>;
}

export class DocumentNotFoundError extends Error {
  constructor(readonly documentId: string) {
    super(`Document not found: ${documentId}`);
    this.name = 'DocumentNotFoundError';
  }
}

/**
 * Creates a publisher bound to one store.
 *
 * The caller owns the store and its lifetime. Storage errors propagate.
 */
export function createDocumentPublisher(store: DocumentStore): DocumentPublisher {
  return {
    async publish({ documentId, publishedAt }) {
      const document = await store.find(documentId);
      if (document === undefined) throw new DocumentNotFoundError(documentId);
      if (document.status === 'published') return { document, changed: false };

      const published: Document = {
        ...document,
        status: 'published',
        publishedAt,
      };

      await store.save(published);
      return { document: published, changed: true };
    },
  };
}
```

好看之处不在于有工厂，而在于读者能完整看见：输入是什么、输出是什么、固定依赖在哪里、失败如何表达、谁负责资源。

如果只有一次调用，直接用 `publishDocument(store, options)` 可能更简单；不为了模仿这个标本强行创建 `DocumentPublisher`。

## 11. 类：先说明它拥有谁，再列出动作

有意义的类拥有一个真实实例及其行为，而不是把相关函数装进命名空间。

下面也是代码形状标本，不是实际 session 替换方案：

```typescript
export interface Session {
  close: () => Promise<void>;
}

export type CreateSession = () => Promise<Session>;

/**
 * Owns the current session and replaces it on request.
 *
 * Replacement closes the old session before creating the next one.
 * If creation fails, the runtime has no current session.
 */
export class SessionRuntime {
  private current: Session | undefined;

  constructor(private readonly createSession: CreateSession) {}

  /** Returns a borrowed session; the runtime retains close ownership. */
  get session(): Session | undefined {
    return this.current;
  }

  async replace(): Promise<Session> {
    await this.close();

    const next = await this.createSession();
    this.current = next;
    return next;
  }

  async close(): Promise<void> {
    if (this.current === undefined) return;
    await this.current.close();
    this.current = undefined;
  }
}
```

注释准确说明失败后果，而不写“ensures seamless replacement”。观察入口返回借用对象，最终收尾仍通过 runtime 完成。先关闭再创建也不是普适规则；这里仅假定调用串行，关闭失败会上抛并保留引用，但不证明该 session 仍可复用，未展示并发互斥或失败后的完整恢复。

对有状态类，我们偏爱：固定依赖只读、状态修改集中、观察入口清楚、公共动作少而完整。getter 不暗中发起 I/O，setter 不让外部随意拼出非法状态。

不照搬下划线字段，也不为 getter 可读而宣称返回的对象不可变。使用继承前，先考虑组合；错误类继承 `Error` 与建立业务继承树不是一回事。

## 12. 能力接口：接口为消费者服务

```typescript
export interface FileReader {
  read: (options: ReadFileOptions) => Promise<string>;
}
```

消费方只需要读取，就不要给它完整客户端、全部配置和管理权限。接口不要只是复制供应商 SDK，也不要为了测试而给每个纯函数加接口。

可替换的回调／能力属性默认使用函数属性语法，便于在启用 `strictFunctionTypes` 时检查参数兼容性。类的普通实例方法照常使用方法语法，不能因此改成满屏箭头字段；框架要求另行遵循。[5]

匿名对象已经清楚时，不强行加 `Port`、`Provider`、`Capability` 后缀。命名说明意义，不说明我们采用了哪种设计模式。

## 13. 注释：摘要、契约、后果，密度恰好

### 公共声明的 JSDoc

我们喜欢这种形状：

```typescript
/**
 * Opens a document from the assigned storage.
 *
 * Missing documents return undefined. Parsing and storage errors propagate.
 * The caller owns the storage connection.
 */
```

第一句介绍能力；空行后补充签名无法充分表达的约束、失败和责任。不要求每个公共声明都凑满三句话。

公共方法值得解释“做什么”，不是只许注释“为什么”。准确的摘要让读者不打开实现也能理解契约。实现内部则更需要原因和不可见的限制。[2]、[6]

### 精确描述顺序，不做安全宣誓

```typescript
// Detach the host UI before invalidating its extension context.
// This callback must finish synchronously; do not await inside it.
```

`after A / before B / must not yield / why` 比“called before cleanup”更有信息。签名和注释不自动强制这些约束，重要行为仍需测试。

### `@returns` 与 `@throws`

只在有额外信息时写标签：返回某个取消事实是什么意思，调用方需要识别哪个特定错误。不要逐个复制类型名，不用 `@throws` 暗示枚举了全部 I/O 异常；TypeScript 不检查异常清单。

### 私有细节与临时限制

复杂算法、正则、协议、单位、第三方限制值得说明。兼容 workaround 附原因、适用版本及移除条件；TODO 说明待解决的问题，必要时附跟踪链接。

不写逐行翻译、无事实的“非常重要”、重复免责声明、注释掉的旧实现或长篇设计辩护。一个局部函数有必要的难点，就在旁边写清；整篇设计决策留在文档里。

**注释的长度取决于知识量，不取决于函数长短；没有信息的长注释和没有契约的短注释都不好。**

## 14. 名字和排版：准确、舒展，不炫技

- 动作用动词：`readDocument`、`publishEvent`、`closeSession`。
- 结果绑定动作：需要时使用 `CreateSessionResult`，不是到处共享一个 `Result<T>`。
- options 表示选择，context 表示真实上下文，不让两个名字变成万能袋子。
- 身份、时间和数量说明对象与单位：`documentId`、`timeoutMs`、`sizeBytes`。官方协议字段保持原名。
- `find` 可以说明允许缺失，`require` 可以说明必须存在；局部不明显时补名称，明显时不重复上下文。
- 文件用 kebab-case，名字说明主题；类用名词，函数用动作。

短作用域中的 `result`、`item`、`next` 可以自然，不把每个名字扩成一整句话。`Manager`、`Service` 等不是禁词，但必须能解释实际职责。

签名、对象和联合类型有完整形状；空行按段落使用。项目统一 formatter，不手工对齐空格，不为单双引号和分号反复讨论。

初始行宽可以评估 100 列，减少 TS 签名的无谓断行；这是版式候选，不是审美定律。类型嵌套、匿名阶段和长 SQL 不会因为从 80 改成 100 就自动清楚。

## 15. 文件：主题完整，不按“一文件一符号”机械切开

```text
src/
  documents/
    document.ts
    publish-document.ts
    publish-document.test.ts
    document-format.ts
    queries.ts
    http.ts
  billing/
    invoice.ts
    settle-invoice.ts
    settle-invoice.test.ts
  main.ts
```

这里只展示组织形状，不确定本项目会有哪些领域。

- 一起理解、一起变化的类型和实现默认邻近。
- 一个完整协议可以有多个类型，不为每个 schema 和常量建文件。
- 测试靠近行为；真正跨模块的集成测试另行组织。
- 私有 helper 先留在真实 owner 的文件，具有独立责任或稳定非平凡复用时才移出。
- 不把所有类型、SQL、服务和工具函数都强制集中到全局目录；领域内确有一组稳定查询责任时可以设 `db/` 或 `queries.ts`。
- 不默认建立 `utils.ts`、`helpers.ts`、`common/`、`shared/` 杂物箱。
- 前端按会话、身份、状态等实际特性邻近组织；Query 持久快照与临时活动 reducer 不平行拥有正式消息。全局 CSS 只承接 Tailwind theme/base，布局与状态 utility 留在 JSX；Markdown 后代结构样式可以放在会话邻近 CSS，不为“全 utility”逐节点造组件。
- 包的稳定公共入口可以有 `index.ts`；不为每个目录建立转发 barrel，不 re-export 全部内部符号。

拆文件应减少主题混杂、独立变化冲突或导航成本。不能只因为超过某个行数，也不能拆完只少一屏代码、多三次跳转。

导出是向外承担契约，不是给所有函数加一个关键字。没有消费者的 export、空占位和备用实现不提前创建。

## 16. 领域：先看语言、规则和 owner，再看目录

一个领域是在它的范围内，词语、规则和数据归属有一致含义的地方。不是一个数据库表、一个页面或一个 SDK。[7]

拆分前问：

1. 相同词是否已经在两处表示不同事物？
2. 规则和不变量是否不同？
3. 哪些数据由谁拥有并修改？
4. 哪些代码经常一起变化，哪些为了不同原因变化？

目录应反映这些真实关系。HTTP、查询、规则、格式转换可以围绕一个能力聚合，不强制建立对称的 `controller/service/repository/entity` 四层。

两个模块总是要了解彼此内部步骤、共同修改状态，可能切得太碎；一个模块总因互不相关的需求变化，可能装得太多。

跨领域依赖通过少量具名操作或合同发生。纯规则不为了方便导入 HTTP、连接管理或供应商 SDK。装配入口负责将实际依赖组合起来，领域模块不自行读取全局环境。

循环依赖先检查责任，不通过 barrel、公共事件总线或 `shared/` 隐藏。领域边界不自动变成服务边界，也不要求把简单数据包装成聚合根。

## 17. 错误、异步和测试也要看得懂

失败是代码形状的一部分，不把 `try/catch/finally` 隐藏到通用执行器里就算整洁。

- 在能作出决策、转换边界语义或收尾的位置捕获异常，不每层打印再抛。
- 业务拒绝、缺失、取消和未知结果有明确含义，不全部折叠成 `false` 或空字符串。
- 有消费者需要识别或携带上下文时才建立具体错误类，不为每条错误信息建文件。
- 创建资源的代码说明谁等待、停止和释放；监听器、定时器和异步任务也有归属。
- 同步 SDK subscribe 回调不 await、不向 SDK 抛公开投影错误；观察写入有界且由 host 收尾。单 reader 的 native Query 不再开第二个消费者，interrupt ACK 与 result 分开。
- fire-and-forget 必须是允许丢失、有人观察失败的工作，不能只是少写一个 await。
- Promise 链不掩盖实际执行顺序，清理失败不静默覆盖主错误。
- 注释与诊断不默认包含凭证、完整输入或外部响应正文。

测试也有阅读段落：最小准备 → 一个动作 → 可观察事实。fixture 只建立场景，不暗中替测试完成核心断言。复杂输入独立命名，不挤在断言里。

测契约而非私有布局，不用 mock 把整个被测逻辑替换成成功；真实边界仍需要相应集成验证。[8]

一次 diff 有一个清楚意图。格式整理、重命名、重构和行为变化尽量分开；美化不得改变缺失字段、顺序、权限、异常和资源收尾语义。

## 18. 最后判断是否真的更美

- 把函数体折叠后，类型、签名和注释是否已经能说明公共能力？
- 展开函数体后，是否能顺着读出一条完整路径？
- 每个新类型、helper、文件和层，是否确实增加了一个有意义的概念？
- 注释是否提供签名与代码之外的知识，而不是制造视觉噪音？
- 修改一个规则，是否主要发生在一个清楚的 owner 内？
- 少一层抽象、少一个无用 export、加一个中间变量，是否反而更容易理解？

**我们要的是契约清楚、实现连贯、组织内聚的代码。它可以由函数组成，也可以有少量有意义的类；但不应让读者穿过框架仪式才能理解一件普通的事。**

## 参考与阅读范围

调研口径：2026-10-12。新增[五项目源码与 SDK 重读](agent-product-research.md)，只补充当前观察、前端归属和生命周期边界，不以社区项目的复杂度为模板。原则综合官方资料与本地源码阅读，不是采用最新版本或某种范式的宣言。读取了示例项目的代码规范、目录文档、milestone 审查，以及历史 Handover 审查中有关代码形状的选段；未将历史拟议修改当作当前实现或已验证结果。

[1]: https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes-oop.html "TypeScript：Rethinking the Class、Free Functions and Data"
[2]: https://google.github.io/styleguide/tsguide.html "Google TypeScript Style Guide"
[3]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session-runtime.ts "Pi runtime 源码；本轮读取本机发布包 1.1.0 的声明与同名 JS，main 不是版本 pin"
[4]: https://www.typescriptlang.org/docs/handbook/2/narrowing.html "TypeScript：判别联合与穷尽检查"
[5]: https://www.typescriptlang.org/tsconfig/strictFunctionTypes.html "TypeScript：函数参数检查与方法语法例外"
[6]: https://google.github.io/eng-practices/review/reviewer/looking-for.html "Google：设计、复杂度、命名和注释评审"
[7]: https://martinfowler.com/bliki/BoundedContext.html "Martin Fowler：Bounded Context"
[8]: https://abseil.io/tips/135 "Abseil：Test the Contract, not the Implementation"
