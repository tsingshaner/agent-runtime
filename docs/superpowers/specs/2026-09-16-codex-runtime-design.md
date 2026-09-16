# 子项目一：Codex SDK 与统一会话管理

状态：用户已确认书面 spec（2026-09-16）；按后续要求采用 Drizzle 1.0.0-rc.4 与 Valibot，已同步实施计划。

## 1. 项目拆分与本次目标

整体项目按以下独立交付推进，每个子项目单独完成 spec、implementation plan 与验收：

| 子项目 | 交付能力 |
| --- | --- |
| 1. Codex SDK | 最小 runtime 接口、PGlite 会话管理、AG-UI 事件、可恢复订阅、审批与取消 |
| 2. 本地服务与协议 | HTTP 管理接口、AG-UI SSE 重连、TanStack AI 客户端示例、A2A 服务端 |
| 3. 资源管理 | knowledge Markdown 管理、skill 本地管理、stdio/Streamable HTTP MCP 管理及接入 |
| 4. Memory | TencentDB Agent Memory SDK 封装、本机 Node 服务安装启停、召回与会话写入 |
| 5. 其他 runtime | Deep Agents 适配；官方 DeepSeek Harness SDK 与 Cordis 审批/取消扩展，分别验收 |

本次只详细设计子项目一。交付一个 Node 应用可以直接使用的 SDK：创建会话、运行 Codex、处理审批、取消、续接，并在订阅断开后补发事件。网页刷新需要子项目二提供 HTTP/SSE；本次以 SDK 重订阅验证其底层能力。

保留已确定的整体方向：三个 runtime、memory、knowledge、skill、MCP；AG-UI 负责交互事件、A2A 负责对外 agent 通信、TanStack AI 负责协议消费集成。统一命名 knowledge，不保留 wiki 别名。PGlite 替代早期计划中的 SQLite。

## 2. 仓库现状与目录

仓库已有 pnpm workspace、runtime-codex 和 shared。Codex 入口仍是模块加载时立即启动 app-server 的通信示例；构建、类型检查与覆盖率配置仍偏向根 src。设计期间根 src 模板已在用户暂存改动中删除，实施时以最新工作区为准，不重建模板、不覆盖其他改动。

本次交付目录：

```text
packages/
├── runtime/                 # @qingshaner/runtime
│   └── src/
│       ├── index.ts         # 公共 SDK 导出
│       ├── manager.ts       # 会话与执行协调
│       ├── store.ts         # PGlite 表、事务、查询与事件存储
│       ├── types.ts         # 最小适配器及公共对象类型
│       └── ag-ui/           # 事件契约与具名扩展
├── runtime-codex/           # @qingshaner/runtime-codex
│   └── src/
│       ├── index.ts         # CodexRuntime 导出
│       ├── client.ts        # 子进程与 JSON-RPC
│       └── events.ts        # 原生事件转换
└── shared/                  # 复用已有内部日志
examples/
└── sdk/                     # 执行、审批、取消、重订阅与重启续接
docs/superpowers/specs/
```

这是职责边界，不要求每个函数独占文件。测试与对应模块邻近。不建立空的 HTTP、A2A、其他适配器或资源包，也不单独拆 types、storage、protocol 包。

## 3. 模块职责与依赖

### runtime

RuntimeManager 拥有一个 PGlite 实例，注册 runtime 适配器并统一管理 SDK 创建的会话。SessionStore 是包内模块，不公开 SQL 或数据库句柄。

负责公共会话 ID、项目归属、原生 ID 映射、运行状态、审批状态、AG-UI 事件持久化与订阅。按会话限制并发，负责取消/审批路由及关闭顺序。

适配器通过构造配置注入；核心包不导入 Codex 实现。首版每个 runtime 类型注册一个适配器实例，不增加多账号或多个同类后端路由。数据库中的 runtime 标识必须能在重启后匹配注册项。

### runtime-codex

每个 CodexRuntime 实例拥有一个 app-server 子进程，进程内承载多个原生会话。仅在首次实际操作时启动，导入包或构造对象不启动进程。

负责初始化、JSON-RPC 请求关联、通知与服务端请求处理、原生会话操作、执行、取消、审批与事件转换。原生消息及模型上下文由 Codex 保存。适配器不访问 PGlite。

### shared 与 examples/sdk

shared 复用日志并处理密钥脱敏，不承载业务状态。examples/sdk 展示通过 Manager 使用公共 ID 完成全部流程，不绕过 Manager 驱动原生会话。

依赖方向：调用方 → RuntimeManager → 注入的 CodexRuntime → app-server；Manager → SessionStore → PGlite。runtime-codex 可以依赖 runtime 的公共契约，反方向禁止。

## 4. 公共能力

以下为语义契约；实现计划细化 TypeScript 声明，不能改变归属和生命周期。

| 接口 | 行为 |
| --- | --- |
| RuntimeManager.open({ dataDir, runtimes }) | 打开持久化数据库、执行版本化建表/迁移、处理上次中断的运行 |
| createSession({ runtime, projectId, cwd, title?, options? }) | 创建原生会话并保存映射，成功后返回公共会话对象 |
| listSessions({ projectId?, runtime?, archived?, limit?, cursor? }) | 默认列出未归档会话，使用稳定分页 |
| getSession(sessionId) | 查询元数据与当前活动 runId |
| resumeSession(sessionId) | 校验公共记录并加载原生上下文，不启动新轮次 |
| archiveSession(sessionId) / unarchiveSession(sessionId) | 仅修改统一层归档状态，不删除或归档 Codex 原始数据 |
| run(sessionId, { text }) | 接受一轮文本输入，返回 { runId, sessionId }，执行不依赖订阅存在 |
| getRun(runId) / listRuns(sessionId) | 查询持久化运行状态与历史运行，支持找到刷新前的运行 |
| subscribe(runId, { afterSequence?, signal? }) | 返回 AsyncIterable<EventEnvelope>，补发历史后等待新增事件 |
| listPendingApprovals(runId) | 返回仍可响应的审批，不依赖客户端是否保存旧事件 |
| respondApproval(runId, approvalId, decision) | 一次性处理该运行的有效待审批请求 |
| cancel(runId) | 请求中断对应轮次，返回时不把 RPC 应答误当成原生轮次已结束 |
| clearRunEvents(runId) | 仅清理已终止运行的事件，保留运行状态并标记历史已清理 |
| dispose() | 幂等关闭 Manager、适配器及数据库 |

首版输入仅文本，不包括图片、动态工具注册、用户提问表单或执行中 steering。公共 ID 不等于原生 thread/turn ID。run 自动加载尚未加载的原生会话；调用方无需每轮显式 resume。

同一会话只能有一个非终态运行（包括正在启动、审批等待与取消中）；并发 run 直接返回 SESSION_BUSY，不排队。不同会话可并行。归档中的会话仍可查询/回放，但必须取消归档才能新开运行；活动会话不能归档。元数据和 cwd 在创建后固定，首版不做项目移动或 runtime 切换。

## 5. PGlite 数据与所有权

仅管理通过本 SDK 创建并成功保存的会话，不扫描、不导入 Codex CLI 会话。原生 ID 不存在或无法续接时保留公共记录并返回明确错误，不静默创建替代会话。

PGlite 保存在调用方指定的本地 dataDir。一个数据目录只能由一个活跃 Manager 拥有；同进程重复打开与跨进程占用均明确拒绝。采用文件锁实现所有权，无法确认失效的锁不自动抢占；文档给出确认旧进程退出后的恢复方法。首版不支持多进程共享写入或网络文件系统。

最小数据集合：

- sessions：公共 ID、runtime、原生会话 ID、项目、cwd、标题、创建/更新时间、归档状态。
- runs：公共 ID、会话 ID、原生轮次 ID、状态、错误、起止时间、最后事件序号、事件清理标记。
- events：runId、递增 sequence、AG-UI JSON 事件；以 (runId, sequence) 唯一约束排序。
- approvals：公共审批 ID、runId、原生请求标识、请求内容、允许决定、处理状态。

schema 使用 Drizzle ORM 1.0.0-rc.4 定义，配套 drizzle-kit 1.0.0-rc.4 生成并提交版本化 SQL 迁移；运行时使用 drizzle-orm/pglite 和配套 migrator。查询与事务通过 Drizzle 执行，需要 SQL 表达式时使用参数化 sql 标签，不插值拼接用户输入。每条事件追加及其对应状态更新在同一事务提交；终态和最终事件原子落库。每个会话的活动运行约束同时受数据库唯一性约束保护。

运行创建、原生调用和数据库不能组成跨进程事务。先保存启动中的运行，再发起原生调用；失败记录到该运行。不自动重试结果不确定的创建或执行请求，避免重复工具副作用。原生会话创建成功但索引写入失败时报告失败，可能留下未管理的原生会话，不自动删除或扫描它。

## 6. 事件与可恢复订阅

EventEnvelope 包含 sessionId、runId、sequence 和 event。sequence 在单个运行内从 1 递增，AG-UI 事件内容不增加自定义协议字段。公共 sessionId 映射到 AG-UI threadId。

Manager 拥有运行开始与唯一终态事件；适配器提供文本、工具、审批及原生完成信息。避免 Manager 和适配器各自重复发运行开始/终态。

文本映射为 TEXT_MESSAGE_START/CONTENT/END；工具调用映射为 TOOL_CALL_START/ARGS/END/RESULT，END 表示参数流结束，不等于工具执行完成。原生输出若只有完成态，发送完整内容一次；存在增量时不重复发送最终全文。命令/文件变更按稳定 item ID 转换，进度与无法标准化的已支持内容使用具名 CUSTOM 事件，不伪造工具参数。

成功使用 RUN_FINISHED；失败、取消及进程重启中断使用 RUN_ERROR，分别携带稳定错误码（例如 CANCELLED、PROCESS_EXITED、INTERRUPTED），运行记录区分这些状态。仅正常成功标记 succeeded。非正常退出不伪造缺失的工具成功结果。

追加事件必须先持久化再通知订阅者。订阅以数据库为唯一事件来源，内存通知仅用于唤醒：先注册唤醒监听，再反复查询 sequence 大于游标的数据；读取期间发生的新通知保留脏标记，避免查空与等待之间丢失唤醒。按页查询避免慢订阅者积压无限内存。写入链有界，超限明确终止异常流，不静默丢弃事件。

订阅者可独立断开；AbortSignal 或退出异步迭代仅移除该订阅，不中断执行。已终止运行补发后关闭订阅。跨订阅允许重复投递，调用方按 (runId, sequence) 去重；不承诺传输级 exactly-once。游标必须是 0 至已提交最高序号内的整数；未知运行和非法游标明确报错。

首版不自动过期/裁剪事件。显式清理仅允许终态运行，历史已清理后订阅返回 EVENTS_CLEARED，不能伪装为空历史；清理期间仍存在的订阅也收到该错误。事件及工具内容可能包含敏感业务数据，文档说明本地数据目录的保护与清理方式，日志不输出完整原生帧。

页面刷新恢复条件是宿主 SDK 进程仍存活。未来 HTTP 服务将持有 Manager，页面通过 sessionId 查询运行，再以游标补发；无游标时从 0 回放。首版不包含 SSE、浏览器或 A2A 实现。

## 7. 审批、取消与故障

首版支持命令执行和文件修改审批，仅允许单次同意/拒绝，映射到 Codex 提供的对应决定。不添加永久授权或放宽沙箱的默认策略。

审批请求先保存并发出 runtime.approval.requested CUSTOM 事件，再等待响应；客户端刷新不会自动拒绝它。响应时校验 runId、approvalId、运行状态和允许选项；并发响应只能有一个进入发送阶段。原生确认后保存结果并发出 runtime.approval.resolved。写入决定和发送原生响应之间存在故障窗口，因此审批发送结果不确定时不自动重发。

运行终止或原生请求失效时，关闭关联待审批记录并持久化解决事件，防止 UI 恢复后显示可操作的旧请求。首版未支持的服务端交互请求按原生协议明确拒绝；无法安全拒绝时让运行失败，不自动批准、不无限等待。

cancel 幂等发送目标轮次中断请求，以原生完成通知确定最终状态。取消与成功竞争时以已确认的原生结果为准。普通取消超时返回可诊断错误并保持会话忙；不为取消一个会话而杀掉承载其他会话的进程。调用方可选择 dispose 整个实例。

进程异常退出使该适配器全部活动运行失败，清理 pending RPC/审批，不重试执行。之后的显式新操作可重新启动进程并续接已保存会话，已失败运行不会复活。

数据库写入失败时不能继续宣称流可恢复：停止接收新运行，尽力中断活动执行，通知订阅者存储错误；不能写入终态时保留磁盘已有状态，下一次正常打开由恢复流程标记中断。

Manager 打开数据库时，将遗留非终态运行改为 interrupted、关闭其审批并追加唯一中断终态。不尝试接管旧进程或重放工具。续接是显式发起新一轮，之前尚未持久化的输出无法恢复。

dispose 停止接受新操作，尝试取消运行并等待有界退出，然后关闭适配器；必要时强制结束其拥有的子进程。等待事件持久化完成后关闭订阅和数据库，最后释放目录锁。只关闭本实例拥有的进程。

## 8. Codex 配置与版本边界

保留 app-server JSON-RPC 通信，使用实际安装版本生成的类型核对协议。实现时锁定测试过的 Codex 协议基线及依赖版本，记录最低支持版本；未知通知可忽略，畸形响应和未知服务端请求不能误当成功。

模型、工作目录和权限策略由调用方配置，不硬编码现有示例的模型。复用用户已完成的 Codex 登录态；不实现登录 UI、不修改全局配置文件。调用方可显式提供 Codex home；默认权限采用 workspace-write 与 on-request，拒绝未经调用方配置的权限升级。配置按受支持的原生类型校验，不接受任意 shell 拼接。

Node.js 24 LTS、ESM、pnpm workspace。数据访问使用 Drizzle 1.0.0-rc.4，应用侧校验使用 Valibot 1.5.0。build/typecheck/test 必须覆盖实际包，而非仅根 src；保留用户正在进行的配置调整。公共方法输入、游标、Codex 原生消息消费字段使用 Valibot 校验，并从 schema 推导输入类型；数据库行 schema 可复用 drizzle-orm/valibot。AG-UI 使用官方类型和校验器，不用 Valibot 重写官方事件 schema，TanStack AI 客户端集成留在子项目二，不为名称一致在本次引入执行引擎。

## 9. 验收

沿用 Vitest，以真实 PGlite 临时目录与可控 app-server 协议测试进程验证，不依赖 CI 模型凭据。

1. 导入/构造无进程副作用；首次操作握手；初始化失败可诊断；关闭不泄漏进程。
2. 公共会话创建/查询/分页/归档及 ID 映射；重启后按公共 ID 续接；拒绝未管理会话。
3. 同会话并发拒绝、跨会话事件不串流；run 没有订阅也持续执行。
4. 文本与工具事件符合 AG-UI schema、增量不重复、终态唯一。
5. 断订阅后继续写入；重订阅补齐；补发与实时交接不漏事件；慢订阅者与多个订阅者独立。
6. 已完成运行可回放；非法游标、显式清理、清理与订阅竞争均有明确结果。
7. 审批等待期间断开，重连仍可响应；重复/跨运行/已失效响应拒绝；拒绝不会执行受控操作。
8. 取消只影响目标运行；取消与完成竞争；进程退出、存储失败、Manager 重启和 dispose 各有明确终态与清理。
9. 同数据目录的重复所有权被拒绝，数据重开保留；迁移与 SQL 使用真实数据库验证。
10. 显式启用的真实 Codex 冒烟脚本覆盖文本执行、续接、重订阅、审批及取消；没有凭据时报告未运行，不能以模拟测试冒充真实通过。

交付需通过 workspace 构建、类型检查、只读 lint 和自动测试；SDK 示例可直接运行。精确测试文件与实现任务由书面 spec 确认后的 writing-plans 产出。

## 10. 参考与审阅门槛

- [Codex app-server](https://developers.openai.com/codex/app-server/)：初始化、会话/轮次及服务端审批协议。
- [PGlite](https://pglite.dev/docs/)：Node 文件系统持久化。
- [Drizzle PGlite](https://orm.drizzle.team/docs/connect-pglite)、[Drizzle Valibot](https://orm.drizzle.team/docs/valibot)：数据库驱动与校验集成。
- [AG-UI 事件](https://docs.ag-ui.com/concepts/events)：标准事件及 CUSTOM 扩展。

本文件只定义首个子项目。用户确认书面 spec 后才使用 Superpowers writing-plans 生成实施计划，不在本轮实现代码。
