# @qingshaner/runtime

Node.js 24 ESM SDK，用 PGlite 管理会话、运行、审批与 AG-UI 事件。数据库与迁移资源随包交付，可从任意工作目录加载。

```ts
import { RuntimeManager } from '@qingshaner/runtime'
import { CodexRuntime } from '@qingshaner/runtime-codex'

const manager = await RuntimeManager.open({
  dataDir: './.agent-runtime',
  runtimes: [new CodexRuntime()],
})
try {
  const project = await manager.createProject({ name: 'Demo', workingDirectories: [process.cwd()] })
  const session = await manager.createSession({
    runtime: 'codex', projectId: project.id, cwd: process.cwd(), model: 'your-model',
    options: { sandbox: 'read-only' },
  })
  const { runId } = await manager.run(session.id, { text: 'Say hello without tools.' })
  for await (const envelope of manager.subscribe(runId)) {
    console.log(envelope)
    if (envelope.event.type === 'CUSTOM' && envelope.event.name === 'runtime.approval.requested') {
      for (const approval of await manager.listPendingApprovals(runId)) {
        await manager.respondApproval(runId, approval.id, 'deny')
      }
    }
  }
} finally {
  await manager.dispose()
}
```

调用方提供模型与已经鉴权的 Codex CLI。仅注册的适配器可用，每个 runtime 类型只允许一个实例。
公共导出包含 RuntimeManager、RuntimeError、RuntimeAdapter 和事件/会话/审批类型；内部 Store 不公开。

## 公共操作

| 操作 | 语义 |
| --- | --- |
| `createProject` / `getProject` / `listProjects` / `updateProject` | 持久化项目身份、名称和工作目录；目录更新不改变会话归属 |
| `createSession` / `getSession` / `listSessions` | 创建、读取、按项目/runtime/归档与游标分页；仅索引成功保存的 SDK 会话 |
| `resumeSession` | 使用公共 ID 续接其固定适配器的原生会话；不会自动执行输入 |
| `archiveSession` / `unarchiveSession` | 归档标记；有活跃运行时不能归档，归档会话不能运行 |
| `run` / `getRun` / `listRuns` | 接受文本输入并返回公共 runId；查询状态或分页历史 |
| `subscribe` | 持久化后发布的 AG-UI EventEnvelope，支持 afterSequence 和 AbortSignal |
| `listPendingApprovals` / `respondApproval` | 查询待处理/响应中的请求；单次 approve 或 deny，不重试不确定响应 |
| `cancel` | 请求取消；RPC 完成并非终态，继续观察事件或 getRun |
| `clearRunEvents` | 仅清理终态运行事件，保留状态；后续订阅报 EVENTS_CLEARED |
| `dispose` | 停止接纳工作、取消运行、关闭适配器与数据库；重复调用共享关闭结果 |

公共 ID 与原生 thread/turn ID 不同。订阅结束或断开不会取消执行；刷新保活要求宿主 Node 进程仍存活。
同一会话最多一个非终态运行，不同会话可以并行。重开会将遗留运行标记为 interrupted、过期审批，保留原事件；不会重试不确定的创建、执行或审批。

事件不自动过期，永久占用磁盘；数据可能包含敏感提示词、输出和审批信息。妥善控制目录权限与备份，不提交 `.agent-runtime` 或凭据。
一个本地数据目录只允许一个 Manager。`.manager.lock` 遗留后必须确认原进程及数据库已停止并备份，才可人工移除；不能在活跃或关闭状态不明时抢锁，不支持网络文件系统。
存储失效以 STORAGE_ERROR 停止服务，关闭不完全以 AggregateError 报告；无法确认数据库关闭时保留锁。

创建会话必须指定已存在的 `projectId` 和非空 `model`；`options` 仅放适配器专属配置，类型从注册的适配器推导。
目录绑定是项目元数据，不是访问沙箱；会话创建仍单独校验实际 `cwd`。更新项目目录不会重写既有会话的原生工作目录。
旧库按原 `projectId` 回填项目并保留会话、原生 ID、归档和历史；已存的 `options.model` 提升为公共字段。
未保存模型的旧会话以 `model: null` 表示，续接仍沿用原适配器的既有配置，不凭空选择新模型。

`run(sessionId, { text, requestId? })` 支持按会话去重：相同 requestId 和原样文本返回原 Run，不同文本返回 REQUEST_CONFLICT。
不传 requestId 始终视为新请求。重启、归档、运行失败或事件清理后仍可找回原记录，不重放原生执行。
SDK 示例可同时设置 SESSION_ID 和 REQUEST_ID 重试同一请求。

`listPendingInputs(runId)` 查询补充问题，`respondInput(runId, inputId, answers)` 按问题 ID 提供字符串数组。
InputEvent 的 runtime.input.requested / runtime.input.resolved 扩展在持久化后发布；waiting_input 仍占用会话。
回答待原生确认，发送结果不确定时保留 responding 且拒绝重发；终态与重启将旧请求过期。SDK 示例在终端交互回答，无终端时取消等待输入的运行。

批量审批仍使用 `listPendingApprovals` / `respondApproval`：batchId 和 batchIndex 标明成员与原生顺序。
部分决定为 decided，收齐后全批进入 responding 并仅提交一次；原生确认前不标 resolved。
工具审批使用 tool 种类；批次取消或重启后过期，结果不确定不自动重发。适配器提供 respondApprovalBatch 并在确认后发送 approval-batch-resolved。
