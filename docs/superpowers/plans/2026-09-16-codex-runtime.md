# Codex SDK 与统一会话管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 Codex SDK：PGlite 统一会话管理、AG-UI 持久化事件、断订阅后补发、审批、取消和重启续接。

**Architecture:** RuntimeManager 拥有 PGlite 和统一状态，通过注入的 RuntimeAdapter 驱动 CodexRuntime。每个 CodexRuntime 拥有一个懒启动的 app-server；执行独立于订阅，事件落库后再通知消费者。适配器不访问数据库，核心不导入 Codex 实现。

**Tech Stack:** Node.js 24 LTS、TypeScript、ESM、pnpm workspace、Vitest、tsdown、@electric-sql/pglite、drizzle-orm/drizzle-kit 1.0.0-rc.4、Valibot、@ag-ui/core、Codex app-server。

**Spec:** [2026-09-16-codex-runtime-design.md](../specs/2026-09-16-codex-runtime-design.md)

## Global Constraints

- Node.js 24 LTS、ESM、pnpm workspace。
- Drizzle ORM 与 Kit 精确锁定 1.0.0-rc.4（用户所指 RC4 的 npm 正式版本号）；Valibot 精确锁定 1.5.0。
- 仅管理通过本 SDK 创建并成功保存的会话，不扫描、不导入 Codex CLI 会话。
- 一个数据目录只能由一个活跃 Manager 拥有；首版不支持多进程共享写入或网络文件系统。
- 每个 runtime 类型注册一个适配器实例；每个 CodexRuntime 实例拥有一个 app-server 子进程。
- 公共 ID 不等于原生 thread/turn ID。会话固定绑定 runtime。
- 同一会话只能有一个非终态运行；不同会话可并行。普通取消不能杀掉共享进程。
- 首版输入仅文本；审批仅命令执行、文件修改的单次同意/拒绝。
- 每条事件先持久化再通知；首版不自动过期/裁剪事件。
- 不自动重试结果不确定的创建、执行或审批响应。
- 默认权限采用 workspace-write 与 on-request；调用方配置模型；不修改全局配置文件。
- 不建立空的 HTTP、A2A、其他适配器或资源包，也不单独拆 types、storage、protocol 包。
- shared 复用日志并处理密钥脱敏，不承载业务状态。
- 本计划只实现子项目一，不包含真实网页刷新、SSE、A2A、TanStack AI 客户端或资源管理。

---

## 执行准备与代码边界

计划编写时实测 Node v24.11.0、pnpm 12.4.1、codex-cli 0.153.4。首版协议基线固定为 Codex 0.153.4，仅声明此版本已验证；更高版本需运行兼容冒烟后才能扩大声明。注册表当时提供 PGlite 0.5.8、AG-UI core 0.0.59，实施时使用这两个精确版本，不跟随 latest。新增 drizzle-orm@1.0.0-rc.4、drizzle-kit@1.0.0-rc.4 与 valibot@1.5.0，不使用浮动 rc 标签。沿用仓库已有 Vitest 5、tsdown 0.23、TypeScript 7 及 LogTape，不升级其他依赖。

用户有大量已暂存和未暂存改动，根 src 已删除，shared 新增 utility/es-toolkit 依赖。开始实现前使用 using-git-worktrees 检查环境；隔离工作区必须包含当前已确认的工作树改动，不能只基于旧 HEAD 丢失 workspace 初始化。记录基线，不 reset/stash 用户改动、不执行 git add .。任务提交只包含本任务可核对的路径/代码块；混合用户改动的文件用交互或补丁暂存，不能整文件捎带提交。

任务 1–10 顺序执行。每项的 RED → GREEN → 提交是独立检查点，不先写全项目再补测试。所有测试遵循 unit-test-vitest：显式 describe/test/expect、一个主要行为、真实 PGlite、真实子进程边界，不 mock 内部方法。

### 文件职责

| 文件或目录 | 职责 |
| --- | --- |
| packages/runtime/src/types.ts、errors.ts、ag-ui/index.ts | 公共对象、适配器契约、稳定错误与官方 AG-UI 事件构造/校验 |
| packages/runtime/src/store.ts、schema.ts、validation.ts、lock.ts | Drizzle/PGlite 操作、表结构、Valibot 输入校验、目录所有权 |
| packages/runtime/drizzle.config.ts、drizzle/ | Kit 配置与生成并提交的迁移资源 |
| packages/runtime/src/subscription.ts | 按数据库游标读取、唤醒与订阅清理 |
| packages/runtime/src/manager.ts | 会话/执行协调、审批、取消及关闭 |
| packages/runtime/src/index.ts | 唯一公共导出，内部 Store 不公开 |
| packages/runtime-codex/src/client.ts、protocol.ts | 子进程、NDJSON、RPC、原生边界校验 |
| packages/runtime-codex/src/events.ts、runtime.ts、index.ts | 事件投影、RuntimeAdapter 实现、公开入口 |
| packages/runtime-codex/src/schemas/ | 0.153.4 生成的协议类型，仅保留所用类型的传递依赖 |
| packages/runtime-codex/test/fake-app-server.mjs | 可控协议对端，使用独立 loopback 控制 socket 而非 sleep |
| examples/sdk/main.ts、smoke.ts | 用户示例、真实 Codex 显式冒烟 |

测试与模块相邻，用 *.test.ts；跨模块验收放 packages/runtime-codex/test/integration.test.ts。无需单独测试工程。

## 任务间固定契约

下面是实现计划锁定的 TypeScript 形状，任务不能自行改名。可按职责分文件，但所有公共类型由 runtime/index.ts 导出。

```ts
import { EventSchemas } from '@ag-ui/core'
export type AgUiEvent = ReturnType<typeof EventSchemas.parse>

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }
export type ApprovalDecision = 'approve' | 'deny'
export type RunStatus = 'starting' | 'running' | 'waiting_approval' | 'cancelling'
  | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type ApprovalStatus = 'pending' | 'responding' | 'resolved' | 'expired'
export type RuntimeFault = { code: string; message: string }
export interface Session {
  id: string; runtime: string; nativeSessionId: string; projectId: string
  cwd: string; title: string; options: JsonObject
  createdAt: string; updatedAt: string; archived: boolean; activeRunId: string | null
}
export interface Run {
  id: string; sessionId: string; nativeTurnId: string | null; status: RunStatus
  error: RuntimeFault | null; createdAt: string; endedAt: string | null
  lastSequence: number; eventsCleared: boolean
}
export interface EventEnvelope {
  sessionId: string; runId: string; sequence: number; event: AgUiEvent
}
export interface Approval {
  id: string; runId: string; nativeRequestId: string | number
  kind: 'command' | 'file-change'; detail: JsonObject
  allowedDecisions: ApprovalDecision[]; status: ApprovalStatus
  decision: ApprovalDecision | null
}
export type AdapterNotice =
  | { kind: 'started'; nativeTurnId: string }
  | { kind: 'event'; event: AgUiEvent }
  | { kind: 'approval'; request: Omit<Approval, 'id' | 'runId' | 'status' | 'decision'> }
  | { kind: 'approval-resolved'; nativeRequestId: string | number }
export interface AdapterOutcome {
  status: 'succeeded' | 'failed' | 'cancelled'; error?: RuntimeFault
}
export interface NativeSession {
  nativeSessionId: string; cwd: string; options: JsonObject
}
export interface RuntimeAdapter {
  readonly kind: string
  createSession(input: { cwd: string; options?: JsonObject }): Promise<NativeSession>
  resumeSession(session: NativeSession): Promise<void>
  execute(session: NativeSession, input: { sessionId: string; runId: string; text: string },
    emit: (notice: AdapterNotice) => Promise<void>): Promise<AdapterOutcome>
  cancel(runId: string): Promise<void>
  respondApproval(runId: string, nativeRequestId: string | number,
    decision: ApprovalDecision): Promise<void>
  dispose(): Promise<void>
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface SessionFilter {
  projectId?: string; runtime?: string; archived?: boolean; limit?: number; cursor?: string
}
export interface ManagerOptions { dataDir: string; runtimes: RuntimeAdapter[] }
export interface CreateSessionInput {
  runtime: string; projectId: string; cwd: string; title?: string; options?: JsonObject
}
```

AdapterNotice 只是进程内生命周期回调，不是第二种公共消息协议。所有 kind:event 均为 AG-UI；适配器不得发 RUN_STARTED/RUN_FINISHED/RUN_ERROR，由 Manager 唯一生成。NativeSession.options 只保存经过适配器校验的非敏感配置，禁止凭据进入数据库。

固定公共方法：

```ts
class RuntimeManager {
  static open(options: ManagerOptions): Promise<RuntimeManager>
  createSession(input: CreateSessionInput): Promise<Session>
  listSessions(filter?: SessionFilter): Promise<Page<Session>>
  getSession(sessionId: string): Promise<Session>
  resumeSession(sessionId: string): Promise<Session>
  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  run(sessionId: string, input: { text: string }): Promise<{ runId: string; sessionId: string }>
  getRun(runId: string): Promise<Run>
  listRuns(sessionId: string, page?: { limit?: number; cursor?: string }): Promise<Page<Run>>
  subscribe(runId: string, options?: { afterSequence?: number; signal?: AbortSignal }): AsyncIterable<EventEnvelope>
  listPendingApprovals(runId: string): Promise<Approval[]>
  respondApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<void>
  cancel(runId: string): Promise<void>
  clearRunEvents(runId: string): Promise<void>
  dispose(): Promise<void>
}
```

class 代码块是声明契约，不可把无函数体的方法复制成实现。运行返回值不是完成结果；调用方通过 getRun 或订阅终态观察结果。

## Task 1: 公共事件契约与可构建的 runtime 包

**Files:** Create packages/runtime/package.json、src/types.ts、src/errors.ts、src/ag-ui/index.ts、src/ag-ui/index.test.ts、src/index.ts。Modify 根 package.json、tsdown.config.ts、.config/tsconfig.app.json、.config/tsconfig.node.json、vitest.config.ts、knip.json、pnpm-lock.yaml；shared/src/index.ts 仅补日志导出。

**Interfaces:** Produces 上述类型，以及 RuntimeError(code, message, options?)、startedEvent(sessionId, runId)、terminalEvent(sessionId, runId, outcome)、parseEvent(value: unknown): AgUiEvent。outcome 类型为 AdapterOutcome 或 { status: 'interrupted'; error: RuntimeFault }。

- [ ] 安装精确依赖：runtime 直接依赖 @electric-sql/pglite@0.5.8、drizzle-orm@1.0.0-rc.4、valibot@1.5.0、@ag-ui/core@0.0.59；根 devDependencies 加 drizzle-kit@1.0.0-rc.4；runtime-codex 直接依赖 valibot@1.5.0；新增包仅 ESM、types export 排在 import 前。保留现有工具版本与用户依赖。
- [ ] 写以下 RED 用例到 index.test.ts，显式导入 describe/expect/test、EventType 与同目录事件函数。

```ts
describe('terminalEvent', () => {
  test('represents cancellation as an error, not successful completion', () => {
    expect(terminalEvent('s1', 'r1', { status: 'cancelled' })).toMatchObject({
      type: EventType.RUN_ERROR, code: 'CANCELLED',
    })
  })
  test('rejects malformed event input', () => {
    expect(() => parseEvent({ type: 'TEXT_MESSAGE_CONTENT', delta: 12 })).toThrow()
  })
})
```

- [ ] Run `pnpm exec vitest run packages/runtime/src/ag-ui/index.test.ts`，预期模块/函数缺失导致 FAIL。
- [ ] 复用官方 EventSchemas.parse 做 parseEvent，使用 EventType 构造标准事件；失败错误码优先保留 outcome.error.code。RuntimeError 仅增加 code 属性和 cause，不另建错误框架。

```ts
export function startedEvent(sessionId: string, runId: string): AgUiEvent {
  return parseEvent({ type: EventType.RUN_STARTED, threadId: sessionId, runId })
}
```

- [ ] 改构建为对实际包数组 runtime/shared/runtime-codex 逐包输出 dist，ESM + dts，PGlite、Drizzle、Valibot 和 AG-UI 外置。runtime-codex 保留现有实现直到 Task 6；其导入副作用验收在 Task 6。发布包不能留下不可解析的 @internal/shared 引用：Codex 构建时内联该内部日志包，LogTape/utility 作为明确外部依赖。
- [ ] tsconfig 覆盖 packages/**/*.ts、examples/**/*.ts，Node 类型及 workspace 路径明确；check:type 分别对 app/node 配置执行 tsc --noEmit，不能只检查空 solution。Vitest alias 对应源码入口，覆盖率排除 schemas 与 test 对端；check 改为只读 biome check，额外 check:fix 用于显式修复，CI 不隐式改源码。
- [ ] GREEN：重复目标测试，执行 `pnpm build`、`pnpm check:type`，确认 runtime dist 可导入且无后台进程。提交本任务可核对变更，建议 `feat(runtime): define AG-UI execution contracts`。

## Task 2: PGlite 所有权、迁移与安全关闭

**Files:** Create runtime/src/lock.ts、schema.ts、validation.ts、store.ts、store.test.ts、runtime/drizzle.config.ts、runtime/drizzle/；package scripts 按需加入测试命令，不增加新框架。

**Interfaces:** Produces `acquireDirectoryLock(dataDir): Promise<{ path: string; release(): Promise<void> }>`；`SessionStore.open(dataDir): Promise<SessionStore>`、`close(): Promise<void>`。Store 获取锁后打开 dataDir/pgdata，并在失败路径释放本次锁。

- [ ] 写 RED：测试用 mkdtemp 创建独立目录，finally close/rm；不用共享固定数据库。

```ts
describe('SessionStore ownership', () => {
  test('rejects a second owner until the first closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-store-'))
    const first = await SessionStore.open(dir)
    try {
      await expect(SessionStore.open(dir)).rejects.toMatchObject({ code: 'DATA_DIR_BUSY' })
      await first.close()
      const reopened = await SessionStore.open(dir)
      await reopened.close()
    } finally {
      await first.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] Run `pnpm exec vitest run packages/runtime/src/store.test.ts`，预期 SessionStore 不存在导致 FAIL。
- [ ] 锁使用 Node fs open(path, 'wx', 0o600)，在 canonical realpath(dataDir) 下创建 .manager.lock，写 pid、hostname、随机 token。目录权限 0o700（已有目录不擅自修改）。释放前核对 token，不删除他人锁；启动不自动删除遗留锁。README 后续说明人工验证旧进程退出后才能清理。不要增加心跳租约或平台原生编译依赖。
- [ ] 用 PGlite.create(join(dataDir, 'pgdata'), { relaxedDurability: false })；创建 drizzle({client, schema})，使用 drizzle-orm/pglite/migrator 的 migrate(db, {migrationsFolder}) 应用 Kit 生成的迁移；迁移路径基于 import.meta.url 解析到包内 drizzle/，不要依赖 cwd。将 drizzle/ 纳入 package files 与打包验证。检查数据库迁移记录是否含当前包未知迁移，含未知记录时拒绝打开，不静默降级。

下面 SQL 是必须保留的关系约束参考，不作为另一套手写迁移源。用 pgTable、索引和 check 声明生成等价迁移；迁移记录交给 Drizzle，不另外建立 schema_migrations。

```sql
CREATE TABLE sessions (
  id text PRIMARY KEY, runtime text NOT NULL, native_session_id text NOT NULL,
  project_id text NOT NULL, cwd text NOT NULL, title text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}', archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(runtime, native_session_id)
);
CREATE TABLE runs (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), native_turn_id text,
  status text NOT NULL CHECK(status IN ('starting','running','waiting_approval','cancelling','succeeded','failed','cancelled','interrupted')),
  error jsonb, created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  last_sequence integer NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
  events_cleared boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_active_run ON runs(session_id)
  WHERE status IN ('starting','running','waiting_approval','cancelling');
CREATE INDEX session_runs ON runs(session_id, created_at DESC, id DESC);
CREATE TABLE events (
  run_id text NOT NULL REFERENCES runs(id), sequence integer NOT NULL CHECK(sequence > 0),
  event jsonb NOT NULL, PRIMARY KEY(run_id, sequence)
);
CREATE TABLE approvals (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES runs(id), native_request_id jsonb NOT NULL,
  kind text NOT NULL CHECK(kind IN ('command','file-change')), detail jsonb NOT NULL,
  allowed_decisions jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','responding','resolved','expired')),
  decision text CHECK(decision IN ('approve','deny')), UNIQUE(run_id, native_request_id)
);
```

- [ ] Drizzle 配置使用以下内容；运行 `pnpm exec drizzle-kit generate --config packages/runtime/drizzle.config.ts` 并提交 schema、SQL 与元数据。运行时只 migrate，不调用 Kit，不使用 push 自动修改用户数据库。

```ts
import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/runtime/src/schema.ts',
  out: './packages/runtime/drizzle',
})
```

```ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as schema from './schema.js'
const client = await PGlite.create(pgdata, { relaxedDurability: false })
const db = drizzle({ client, schema })
await migrate(db, { migrationsFolder })
```

pgdata 是 dataDir/pgdata；migrationsFolder 是从 dist/store.js 所在包解析出的 ../drizzle。Store 保留 client 用于生命周期关闭，业务查询都使用 db/tx。

- [ ] 再加跨进程竞争锁、符号链接路径别名、重复 close、迁移失败释放锁、重开已迁移数据库用例。GREEN 执行目标测试和 check:type。提交 `feat(runtime): own a persistent PGlite store`。

## Task 3: 可查询与归档的统一会话索引

**Files:** Modify store.ts、store.test.ts；Create store-sessions.test.ts。

**Interfaces:** Store produces `insertSession(input: Omit<Session,'createdAt'|'updatedAt'|'archived'|'activeRunId'>): Promise<Session>`、`getSession(id): Promise<Session>`、`listSessions(filter?: SessionFilter): Promise<Page<Session>>`、`setArchived(id, archived): Promise<void>`。id 参数均为 string。

- [ ] 写 RED 用例：创建后关闭重开，核对原生映射和 options；独立用例验证分页、默认不列归档及归档后仍可 get。

```ts
test('preserves the native mapping after reopening', async () => {
  let store = await SessionStore.open(dir)
  await store.insertSession({ id: 's1', runtime: 'codex', nativeSessionId: 'native-1',
    projectId: 'p1', cwd: dir, title: 'first', options: { model: 'test-model' } })
  await store.close()
  store = await SessionStore.open(dir)
  try {
    expect(await store.getSession('s1')).toMatchObject({
      id: 's1', nativeSessionId: 'native-1', options: { model: 'test-model' }, activeRunId: null,
    })
  } finally { await store.close() }
})
```

dir 由每个测试 beforeEach/mkdtemp 创建，afterEach/rm；不要让测试依赖其他测试写入。

- [ ] Run `pnpm exec vitest run packages/runtime/src/store-sessions.test.ts`，预期缺少 Store 方法导致 FAIL。
- [ ] 通过 Drizzle insert/select/update 与 db.transaction 实现 CRUD；返回 ISO 时间字符串。list 按 created_at DESC,id DESC 排序，默认 limit=50，范围 1–200。cursor 为 base64url 编码的 JSON {createdAt,id}，解码并校验后使用 tuple keyset，不拼接进 SQL。activeRunId 从 runs 非终态子查询得出，不另维护重复字段。

```ts
const rows = await db.select().from(sessions).where(and(
  filter.projectId === undefined ? undefined : eq(sessions.projectId, filter.projectId),
  filter.runtime === undefined ? undefined : eq(sessions.runtime, filter.runtime),
  eq(sessions.archived, filter.archived ?? false),
  cursor === undefined ? undefined : sql`(${sessions.createdAt}, ${sessions.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id})`,
)).orderBy(desc(sessions.createdAt), desc(sessions.id)).limit(limit + 1)
```

and/eq/desc/sql 从 drizzle-orm 导入，sessions 从 schema.js 导入；cursor 为 Valibot 校验后的对象。

- [ ] 在 validation.ts 定义公共输入 schema，以 v.InferOutput 推导对应类型；原生消息用宽松 object 只消费声明字段，公共 options 用 strictObject 拒绝未知字段。不要为数据库内部每次读写重复 parse；有外部数据入口时使用 drizzle-orm/valibot 生成行 schema，并为 JSONB 字段补具体校验。

```ts
import * as v from 'valibot'
export const PageInputSchema = v.strictObject({
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)), 50),
  cursor: v.optional(v.string()),
})
export const CursorSchema = v.strictObject({
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  id: v.pipe(v.string(), v.minLength(1)),
})
export type PageInput = v.InferOutput<typeof PageInputSchema>
```

safeParse 失败映射 INVALID_INPUT，不将含原始输入的完整 issues 写入日志。新增用例：负数/fractional limit、未知 options 字段、非 ISO cursor、畸形 Codex frame；AG-UI parseEvent 仍调用官方 EventSchemas，不复制官方 schema。

- [ ] limit+1 读取计算 nextCursor；未知 ID 返回 SESSION_NOT_FOUND，非法分页返回 INVALID_INPUT。setArchived 使用事务检查不存在活动运行；与 beginRun 的事务串行通过 SessionStore 同一 PGlite connection 保证。
- [ ] GREEN：重开、过滤、同时间分页、未知 ID、归档 idempotence、非法 cursor 用例全部通过，提交 `feat(runtime): persist and query managed sessions`。

## Task 4: 持久化运行与无丢失的事件订阅

**Files:** Modify store.ts；Create subscription.ts、subscription.test.ts、store-runs.test.ts。

**Interfaces:** Store produces `beginRun(sessionId, runId): Promise<Run>`、`getRun(id): Promise<Run>`、`listRuns(sessionId, page?): Promise<Page<Run>>`、`setNativeTurn(runId, nativeTurnId): Promise<void>`、`appendEvent(runId, event): Promise<EventEnvelope>`、`finishRun(runId, outcome): Promise<void>`、`readEventPage(runId, afterSequence, limit=128): Promise<EventEnvelope[]>`、`clearRunEvents(runId): Promise<void>`、`onRunChange(runId, listener): () => void`、`subscribe(runId, options?): AsyncIterable<EventEnvelope>`。finishRun outcome 使用 Task 1 terminalEvent 的类型。

- [ ] 写 RED 用例：beginRun 写 RUN_STARTED 为序号 1；订阅读取第一条后退出，追加事件并完成，再从 1 订阅。

```ts
test('replays events produced without a subscriber', async () => {
  await store.beginRun('s1', 'r1')
  const first = store.subscribe('r1')[Symbol.asyncIterator]()
  expect((await first.next()).value?.sequence).toBe(1)
  await first.return?.()
  await store.appendEvent('r1', { type: EventType.CUSTOM, name: 'test.progress', value: 1 })
  await store.finishRun('r1', { status: 'succeeded' })
  const replay: EventEnvelope[] = []
  for await (const e of store.subscribe('r1', { afterSequence: 1 })) replay.push(e)
  expect(replay.map(e => e.sequence)).toEqual([2, 3])
  expect(replay[1]?.event.type).toBe(EventType.RUN_FINISHED)
})
```

beforeEach 建真实 Store，并用 Task 3 insertSession 创建 s1；finally 关闭数据库。

- [ ] RED run：`pnpm exec vitest run packages/runtime/src/subscription.test.ts packages/runtime/src/store-runs.test.ts`。
- [ ] beginRun 事务检查归档、写 starting 行、追加 RUN_STARTED；唯一索引冲突翻译 SESSION_BUSY。appendEvent 使用 Drizzle db.transaction，在 tx.update(runs) 中用 sql`${runs.lastSequence} + 1` 并 returning，再 tx.insert(events)，同一事务提交才发 onRunChange。finishRun CAS 只允许非终态转终态，先 expire 审批并追加 resolved，再追加唯一终态；所有更新同一事务。终态后拒绝新业务事件。
- [ ] readEventPage 在同一 transaction 读取清理标记、最高序号、事件页和必要状态，避免清理竞争伪装为空结果。底层允许内部游标落后，公开订阅初始校验整数 0..lastSequence；clear 标记优先于回放。清理不把 lastSequence 归零。
- [ ] subscription 用下面的唤醒模式，绝不切换成另一套内存事件缓存：

```ts
let revision = 0
let wake: (() => void) | undefined
const unlisten = store.onRunChange(runId, () => { revision++; wake?.() })
// 每轮先记 revision，再查数据库和终态；查空且非终态时：
const observed = revision
// 查询发生于此；消费者读取每条数据后再更新本地 sequence。
if (revision === observed) {
  await new Promise<void>(resolve => {
    wake = resolve
    if (revision !== observed || signal?.aborted) resolve()
  })
}
// finally 中 unlisten，移除 abort listener，清理 wake；断订阅不触发 cancel。
```

该片段只说明 lost-wakeup 防护；完整迭代器必须在监听注册后查询，并在终态前耗尽已提交页。abort 回调调用 wake；已 aborted 时立即结束。iterator.return 必须主动唤醒待处理 next，使用显式 AsyncIterator 包装内部 generator.return，不能让 return 排队在永不结束的 next 后面。

- [ ] 增加确定性 barrier 用例覆盖“最后一页查空→准备等待”期间追加、两订阅者不同速度、清理与回放竞争、取消 signal、pending next 时 return、重放终态、非法游标。对存储边界用 barrier 控制，不靠任意 sleep。
- [ ] GREEN 目标测试和 check:type，提交 `feat(runtime): persist runs and resume event subscriptions`。

## Task 5: 有界 Codex JSON-RPC 客户端

**Files:** Create runtime-codex/src/client.ts、protocol.ts、client.test.ts、test/fake-app-server.mjs、src/schemas/；Modify package.json 的 gen:schema 脚本及 README 协议版本说明。

**Interfaces:** `JsonRpcClient({ command, args, env?, requestTimeoutMs?, shutdownTimeoutMs? })`；`request(method, params): Promise<unknown>`、`reply(id: string|number, result: Json): Promise<void>`、`replyError(id, code, message): Promise<void>`、`onFrame(listener): () => void`、`onExit(listener): () => void`、`close(): Promise<void>`。Frame 由 protocol.ts 定义 response/notification/server-request 三类，保留请求 ID 的 string/number 类型。

- [ ] 用 `codex app-server generate-ts --out /tmp/agent-runtime-protocol-0.153.4` 生成 0.153.4 非 experimental 类型。将 initialize、thread/start/resume、turn/start/interrupt、item/started/completed、文本增量、命令/文件审批和 serverRequest/resolved 所需类型及递归 import 依赖复制进 schemas；保留生成头。Valibot schema 通过 satisfies/类型测试与生成类型的已消费字段保持一致，不使用断言掩盖不匹配。脚本记录版本，不在普通 build 中调用 Codex。protocol.ts 用 Valibot schema 从 unknown 校验并提取已消费字段，不能将 JSON.parse 结果直接 as any。
- [ ] 写 RED transport 测试，使用真实 Node 子进程对端。测试先用 node:net 在 127.0.0.1 的随机端口建立控制 server；通过 fake 的 --control-port 参数传端口。对端连接并发送 ready 后，测试通过控制 socket 指定下一条请求的 response/notification/exit；业务 stdout 仍仅 NDJSON，stderr 独立测试，不调用模型。生产 transport 不添加 IPC 或测试专用接口。

```ts
test('rejects pending requests when the process exits', async () => {
  const client = new JsonRpcClient({ command: process.execPath,
    args: [fakePath, '--exit-on-request'], requestTimeoutMs: 1000 })
  try {
    await expect(client.request('initialize', {})).rejects.toMatchObject({ code: 'PROCESS_EXITED' })
  } finally { await client.close() }
})
```

fakePath = fileURLToPath(new URL('../test/fake-app-server.mjs', import.meta.url))；--exit-on-request 在读取第一个请求后 process.exit(7)，不是启动前退出。

- [ ] Run `pnpm exec vitest run packages/runtime-codex/src/client.test.ts`，确认 FAIL。
- [ ] spawn 使用 argv 数组、shell:false，stdin/stdout/stderr pipe。读取增量 Buffer 并按换行组帧，使用 StringDecoder 保留 UTF-8 边界；单帧上限 8 MiB。区分响应、通知与服务端请求，id=0 有效；无关联的响应不误投递。畸形帧返回 PROTOCOL_ERROR 并关闭不可信 transport。
- [ ] 实现 pending map、单调请求 ID、默认 RPC 超时 15s；超时只拒绝请求，不重发。stdin.write(false) 等待 drain；close 清理计时器并 reject 所有 pending。上限 8 MiB 的入站待处理数据，超限终止 transport 并报告 STREAM_OVERFLOW，说明此时全部共享会话都会受影响。
- [ ] close 先关闭 stdin，等待 2s，SIGTERM 后再等 2s，最后 SIGKILL；等待实际 exit 才报告资源释放。stderr 保留最多 16 KiB 内部尾部，不直接写公共日志/错误；只输出退出码与脱敏摘要。常规日志仅方法名、ID、状态和计时。
- [ ] GREEN 补齐乱序响应、服务端请求与客户端同号、拆分 UTF-8、畸形 JSON、未知响应、超时、stdin 错误、close 幂等和有界溢出测试。提交 `feat(codex): add a bounded app-server transport`。

## Task 6: Codex 会话与 AG-UI 投影

**Files:** Create runtime-codex/src/runtime.ts、events.ts、events.test.ts、runtime.test.ts；Replace src/index.ts 示例为公开导出；Modify runtime-codex/package.json，依赖 runtime workspace。

**Interfaces:** `CodexRuntime implements RuntimeAdapter`，kind='codex'。构造 options：`{ executable?: { command: string; args?: string[] }; codexHome?: string; model: string; requestTimeoutMs?: number; shutdownTimeoutMs?: number }`。executable 默认 {command:'codex'}；args 为前置参数，最终追加 app-server，测试可传 process.execPath 与 fakePath。会话 options 只接受 model、approvalPolicy('on-request'|'never')、sandbox('read-only'|'workspace-write')；默认 on-request/workspace-write，不支持任意 config 或 credentials。

内部 `CodexEventMapper(sessionId, runId).accept(method, params): AdapterNotice[]`，按 itemId 保存文本/工具流状态；`finish(outcome): AdapterNotice[]` 只收尾开放的文本，不制造工具成功。输入边界先由 protocol.ts 校验。

- [ ] RED：mapper 原始 item 事件与重复完成态不重复输出全文；用 Task 5 对端测试构造无 spawn、首次操作一次握手。

```ts
test('does not duplicate final text after a delta', () => {
  const mapper = new CodexEventMapper('s1', 'r1')
  const notices = [
    ...mapper.accept('item/started', { threadId: 'n1', turnId: 't1',
      item: { type: 'agentMessage', id: 'm1', text: '', phase: null } }),
    ...mapper.accept('item/agentMessage/delta', { threadId: 'n1', turnId: 't1', itemId: 'm1', delta: 'hello' }),
    ...mapper.accept('item/completed', { threadId: 'n1', turnId: 't1',
      item: { type: 'agentMessage', id: 'm1', text: 'hello', phase: null } }),
  ]
  const deltas = notices.filter(n => n.kind === 'event' && n.event.type === EventType.TEXT_MESSAGE_CONTENT)
  expect(deltas).toHaveLength(1)
})
```

- [ ] Run `pnpm exec vitest run packages/runtime-codex/src/events.test.ts packages/runtime-codex/src/runtime.test.ts`，确认缺失实现导致 FAIL。
- [ ] start memoize 初始化 Promise；等待 initialize 成功后发 initialized，之后才能 thread/start。用固定 clientInfo 名 agent-runtime 和当前包版本；不启用 experimentalApi。传 approvalsReviewer:'user'，避免继承用户的自动审批路由。模型由构造参数提供；cwd realpath 后为目录，所有 options 在边界校验。

```ts
const turnParams = {
  threadId: session.nativeSessionId,
  input: [{ type: 'text' as const, text: input.text, text_elements: [] }],
}
// thread/start 设置 ephemeral:false，thread/resume 仅按保存的 threadId。
// model、sandbox、approvalPolicy 及 approvalsReviewer 均在 start/resume 重新明确传入。
```

- [ ] execute 在 turn/start 前注册会话通知路由，预先关联公共 runId；处理 turn/started 或早到通知时记录 nativeTurnId，随后与 response 核对。不能等 response 后才开始监听。按 threadId+turnId 隔离多会话；原生终态解析为 AdapterOutcome。
- [ ] 顺序 await emit，维护有界通知队列；默认上限 1024 通知或 8 MiB（先到者），溢出中断该运行并报告 STREAM_OVERFLOW。无法完成安全中断时关闭 transport，所有受影响运行明确失败，绝不静默丢帧。此资源故障不同于用户取消超时。
- [ ] 文本按标准事件转换。MCP 工具参数已知时发送 TOOL_CALL_START/ARGS/END，执行完成后 RESULT。命令/文件更改缺少完整输入时用 codex.command/codex.file-change CUSTOM 表达真实内容，不伪造 args；进度用 codex.progress。无增量的文本完成项补发全文一次；已有增量只补明确的后缀，内容冲突报投影错误，不直接拼接重复全文。
- [ ] cancel 在尚未取得 turnId 时记录请求，取得后仅发一次 turn/interrupt；收到终态才结束 execute。终态竞争遵循原生结果。close 或 exit 清理 loaded-thread 缓存，下次显式操作重新启动；dispose 后永久拒绝新操作。
- [ ] 本任务的 respondApproval 尚无已支持的 pending 请求时返回 APPROVAL_NOT_FOUND；服务端审批先按协议拒绝，Task 8 将其接入可恢复交互。这样 RuntimeAdapter 完整可编译且不会在中间提交默认放行。
- [ ] GREEN：每种投影均用 parseEvent 校验；覆盖启动失败、恢复失败不重建会话、跨会话通知、终态重复、部分输出后失败、文本-only completion、未知通知和取消竞争。提交 `feat(codex): adapt sessions and streaming execution`。

## Task 7: Manager 组合会话与后台执行

**Files:** Create runtime/src/manager.ts、manager.test.ts；Modify index.ts；Create runtime/test/manual-adapter.ts（仅测试使用）。

**Interfaces:** Produces 固定契约中的 open、create/get/list/resume/archive/unarchive、run/getRun/listRuns、subscribe/clearRunEvents。内部 Store 与 Adapter 仍通过任务定义的接口组合。

- [ ] 测试 ManualAdapter 实现 RuntimeAdapter：createSession 产生计数 native ID；execute 保存 runId/emit 与一个 deferred outcome；测试调用 `push(runId, notice): Promise<void>` 及 `finish(runId, outcome): void` 显式推进。`waitStarted(runId): Promise<void>` 通过 barrier 等待 execute 安装，避免时序 sleep；cancel 记录对应运行并结束为 cancelled；dispose 结束剩余运行。
- [ ] 写 RED 验证不订阅也执行、同会话忙、不同会话并行，真实 PGlite 不替换。

```ts
test('keeps a run executing without subscribers', async () => {
  const adapter = new ManualAdapter()
  const manager = await RuntimeManager.open({ dataDir: dir, runtimes: [adapter] })
  try {
    const session = await manager.createSession({ runtime: adapter.kind, projectId: 'p', cwd: dir })
    const { runId } = await manager.run(session.id, { text: 'hello' })
    await adapter.waitStarted(runId)
    await expect(manager.run(session.id, { text: 'second' })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    adapter.finish(runId, { status: 'succeeded' })
    const events: EventEnvelope[] = []
    for await (const event of manager.subscribe(runId)) events.push(event)
    expect(events.at(-1)?.event.type).toBe(EventType.RUN_FINISHED)
    expect((await manager.getRun(runId)).status).toBe('succeeded')
  } finally { await manager.dispose() }
})
```

- [ ] Run `pnpm exec vitest run packages/runtime/src/manager.test.ts`，确认 FAIL。
- [ ] open 校验重复 kind、dataDir，本任务打开 Store 后对正常关闭的数据库工作；Task 9 在 open 返回前加入 recoverInterrupted，不在此处调用尚未实现的函数。配置缺少旧会话 adapter 时查询仍可用，执行返回 RUNTIME_UNAVAILABLE。未知公共 ID 不回退原生 ID。
- [ ] createSession 校验项目非空、cwd 存在及目录、title 长度≤256；title 默认 projectId。适配器返回 canonical cwd 和已校验 options 再写入 Store。成功写入前不返回公共 ID；写入失败不删除可能已有副作用的原生会话。
- [ ] run 校验非空 text（允许换行，保留原文），事务 beginRun 后立即安排后台 drive 并返回 ID。drive 的所有 rejection 必须转换成 finishRun 或 Task 9 存储故障路径，不能出现 unhandled rejection。接收 started→setNativeTurn，event→appendEvent，approval→Task 8 事务。resumeSession 成功返回原 Session；run 自行确保 resume，调用方无需重复操作。

```ts
const runId = randomUUID()
await store.beginRun(sessionId, runId)
const completion = drive(session, runId, input)
// active map 保存 completion；drive 内完整捕获错误；finally 删除自身。
return { runId, sessionId }
```

- [ ] 实现正常路径 dispose：标记 closing，调用所有 adapter.dispose，等待后台 drive 收敛后 store.close；重复调用复用同一个 Promise。Task 9 增加超时、故障聚合和控制操作竞争处理。本任务测试不可引用尚不存在的关闭方法。
- [ ] GREEN 覆盖跨会话并行、归档禁止执行、缺少适配器仍能查询、未管理 native ID 被拒绝、native 创建成功而索引失败、没有订阅时执行失败可查。提交 `feat(runtime): coordinate managed background runs`。

## Task 8: 可恢复审批与精确取消

**Files:** Modify manager.ts、store.ts、runtime-codex/src/runtime.ts、events.ts；Create runtime/src/approval.test.ts、runtime-codex/src/approval.test.ts。

**Interfaces:** Store adds `requestApproval(runId, request): Promise<Approval>`、`claimApproval(runId, approvalId, decision): Promise<Approval>`、`resolveApproval(runId, nativeRequestId): Promise<void>`、`listPendingApprovals(runId): Promise<Approval[]>`、`markCancelling(runId): Promise<Run>`。request 使用 AdapterNotice 的 approval.request 类型。Manager 与 adapter 补全固定 respondApproval/cancel 方法。

- [ ] RED：审批出现后断开订阅，再查询 pending 并响应；第二次响应返回 APPROVAL_NOT_PENDING；不同 runId 返回 APPROVAL_NOT_FOUND，未发送原生响应。

```ts
test('allows an approval after the original subscription disconnected', async () => {
  await adapter.waitStarted(runId)
  await adapter.push(runId, { kind: 'approval', request: {
    nativeRequestId: 0, kind: 'command', detail: { command: 'echo safe' },
    allowedDecisions: ['approve', 'deny'],
  } })
  const [approval] = await manager.listPendingApprovals(runId)
  expect(approval?.status).toBe('pending')
  await manager.respondApproval(runId, approval!.id, 'deny')
  await expect(manager.respondApproval(runId, approval!.id, 'deny'))
    .rejects.toMatchObject({ code: 'APPROVAL_NOT_PENDING' })
})
```

测试用 beforeEach 打开 manager、创建 session/run；ManualAdapter.respondApproval 通过 emit approval-resolved 进行确认，记录决定供行为断言；finally dispose。

- [ ] Run `pnpm exec vitest run packages/runtime/src/approval.test.ts packages/runtime-codex/src/approval.test.ts`，预期 FAIL。
- [ ] requestApproval 事务创建 UUID、将 running 改 waiting_approval（cancelling 不回退）、追加 CUSTOM runtime.approval.requested，value 为公共 Approval 对象去除 nativeRequestId。保存原生 number/string ID，不通过 String(id) 合并不同 ID。
- [ ] claimApproval 事务 CAS pending→responding，并写 decision；再发送原生回复 {decision:'accept'|'decline'}。以 serverRequest/resolved 确认，resolveApproval 事务标 resolved 并发 runtime.approval.resolved {approvalId,status,decision}；没有 pending/responding 审批后才恢复 running，cancelling 不回退。
- [ ] 原生自行清理请求时将未响应审批 expired，而不是 falsely approved。发送错误或确认超时返回 APPROVAL_RESPONSE_UNCERTAIN 并保持不可重复响应；后续原生 resolved 或运行终止收敛。同一运行可以同时有多个审批。
- [ ] 未支持的 requestUserInput 回复合法空 answers；MCP elicitation 回复 decline/content:null；permissions 请求回复空 granted permissions（按生成类型校验）；未知方法返回 JSON-RPC -32601 并使相关运行失败。无法关联运行的未知 server request 关闭不可信 transport，不能默认批准。协议允许决定中没有 accept 时不得暴露 approve。
- [ ] cancel 原子标 cancelling，复用一个在途中断 promise；若 Manager 已接受 run 但 execute 尚未安装原生路由，先记录取消意图并在 drive 的启动关口处理，不能报未知运行或丢弃取消。RPC 成功只表示请求已发出，最终状态由 execute 完成更新。已终态 cancel 为 no-op；请求超时返回 CANCEL_TIMEOUT，仍占用会话，不关闭其他会话进程。审批等待期间取消使 pending 项在终态过期。
- [ ] GREEN：同号请求、并发响应只发送一次、刷新恢复、超时不重发、多审批、原生失效、取消等待审批、取消成功竞态及其他会话不受影响。提交 `feat(runtime): resume approvals and cancel individual runs`。

## Task 9: 恢复、存储故障及有界关闭

**Files:** Modify manager.ts、store.ts、subscription.ts、runtime-codex/src/runtime.ts；Create runtime/src/recovery.test.ts；扩展 client/runtime tests。

**Interfaces:** Store adds `recoverInterrupted(): Promise<void>`；Manager 完成 `dispose(): Promise<void>`，内部 fatal 状态为 RuntimeError|null。Store 内部可保存 failure 并唤醒全部订阅，供订阅 next 抛出 STORAGE_ERROR，不新增公共事件存储后端接口。

- [ ] RED：直接 Store 创建非终态 run，正常 close 不篡改状态，再由 Manager.open 执行恢复；用于模拟上次未记录终态，不需要真的杀测试 runner。

```ts
test('records one interrupted terminal when reopening an unfinished run', async () => {
  await store.beginRun('s1', 'r1')
  await store.close()
  const manager = await RuntimeManager.open({ dataDir: dir, runtimes: [new ManualAdapter()] })
  try {
    expect((await manager.getRun('r1')).status).toBe('interrupted')
    const events: EventEnvelope[] = []
    for await (const event of manager.subscribe('r1')) events.push(event)
    expect(events.filter(e => e.event.type === EventType.RUN_ERROR)).toHaveLength(1)
  } finally { await manager.dispose() }
})
```

- [ ] Run `pnpm exec vitest run packages/runtime/src/recovery.test.ts`，确认恢复断言 FAIL。
- [ ] recoverInterrupted 按运行调用事务终结逻辑，append INTERRUPTED 错误、expire 审批、保持既有事件；重复打开不能再次追加。先完成恢复再允许新操作，不能根据原生 thread 是否存在自动重放 prompt。
- [ ] 持久化失败的正常路径：Manager 进入 fatal，拒绝新 run/approval/clear；使全部订阅抛出 STORAGE_ERROR；尽力 cancel 活动运行，不再假装已写终态；保留原始 cause 给宿主。测试通过 Drizzle/PGlite transaction 边界注入一次写失败，避免 mock Manager 内部流程。
- [ ] dispose memoize Promise，停止接收新操作；等待所有被接受的 create/resume/start 控制操作结束或超时，防止关闭后产生新进程。对活动运行发送 cancel，最多等 5s；随后 adapter.dispose 有界回收，活动 drive 收敛为 PROCESS_EXITED 或 CANCELLED。await 所有数据库写入链，关闭订阅，再 Store.close/释放锁。失败用 AggregateError 汇总，不能让一个 adapter 的失败阻止其他资源清理。数据库未确认关闭时保留目录锁，不能允许新 Manager 同时打开。
- [ ] 子进程 generation 递增，旧 generation 的迟到消息不可落到重新启动的新运行；原生进程死亡清空 loaded sessions，新显式 run 重新初始化/续接，旧运行保持 failed。
- [ ] GREEN 验证重复 reopen 终态唯一、待审批恢复为 expired、存储失败下没有成功终态、start/dispose 竞争、timeout 后强制回收、两会话进程退出都失败、退出后显式新运行成功。提交 `fix(runtime): recover interrupted runs and close owned resources`。

## Task 10: 完整集成、SDK 示例与交付检查

**Files:** Create runtime-codex/test/integration.test.ts、examples/sdk/main.ts、examples/sdk/smoke.ts、examples/sdk/package.json；Modify 根 README.md、runtime/README.md、runtime-codex/README.md、.github/workflows/ci.yml、pnpm-workspace.yaml、package.json、cspell.yaml、knip.json。

**Interfaces:** 消费所有已固定公共接口；example 使用 workspace 包公开 exports，不从 src 私有模块导入。examples/sdk 注册为 private workspace package，脚本先 build 再由 Node 24 strip-types 运行 .ts，使用 .js 包入口，不引入 tsx。

- [ ] RED 集成测试连接真实 Manager + PGlite + CodexRuntime + fake-app-server，不使用 ManualAdapter。依次覆盖 create/run、断订阅继续生成、游标重订阅、审批与取消、两会话隔离、dispose 后按公共 ID 重开。对端输出脚本与独立控制 socket 检查实际请求 payload，包括 text_elements:[]、ephemeral:false、审批拒绝。

```ts
test('a fresh manager resumes a persisted public session', async () => {
  const first = await RuntimeManager.open({ dataDir: dir, runtimes: [makeCodex()] })
  const session = await first.createSession({ runtime: 'codex', projectId: 'demo', cwd: dir })
  await first.dispose()
  const second = await RuntimeManager.open({ dataDir: dir, runtimes: [makeCodex()] })
  try {
    const resumed = await second.resumeSession(session.id)
    expect(resumed.nativeSessionId).toBe(session.nativeSessionId)
    expect(resumed.id).toBe(session.id)
  } finally { await second.dispose() }
})
```

makeCodex 返回 new CodexRuntime({model:'test-model',executable:{command:process.execPath,args:[fakePath]}})。fake 通过保存 thread ID 到测试专属目录来验证 resume，不无条件接受任意 ID。

- [ ] Run `pnpm exec vitest run packages/runtime-codex/test/integration.test.ts`，先保留一个明确失败的完整链路断言，再修真实集成缺口。
- [ ] 写可直接运行的最小 example：

```ts
import { RuntimeManager } from '@qingshaner/runtime'
import { CodexRuntime } from '@qingshaner/runtime-codex'
const model = process.env.CODEX_MODEL
if (!model) throw new Error('Set CODEX_MODEL before running this example')
const manager = await RuntimeManager.open({
  dataDir: './.agent-runtime', runtimes: [new CodexRuntime({ model })],
})
try {
  const session = process.env.SESSION_ID
    ? await manager.resumeSession(process.env.SESSION_ID)
    : await manager.createSession({ runtime: 'codex', projectId: 'demo', cwd: process.cwd() })
  console.log({ sessionId: session.id })
  const { runId } = await manager.run(session.id, { text: 'Briefly describe this directory.' })
  for await (const envelope of manager.subscribe(runId)) {
    console.log(JSON.stringify(envelope))
    if (envelope.event.type === 'CUSTOM' && envelope.event.name === 'runtime.approval.requested') {
      const pending = await manager.listPendingApprovals(runId)
      for (const approval of pending) await manager.respondApproval(runId, approval.id, 'deny')
    }
  }
} finally { await manager.dispose() }
```

- [ ] smoke.ts 仅在 RUN_CODEX_SMOKE=1 且 CODEX_MODEL 存在时执行，否则输出“SKIPPED: real Codex smoke not run”并不宣称验证通过。使用独立临时 cwd、应用数据目录，保持同一 codexHome 以便续接；不更改用户全局配置。文本 smoke 自动断订阅重连并比对序号、续接公共 ID；审批用 read-only 沙箱请求写入临时文件，通过 readline 提示人工 approve/deny；取消用显式输入触发。未触发目标审批/取消时报告该场景未验证，不能视为 pass。
- [ ] README 说明“刷新保活要求宿主仍存活”、公共 ID 与 native ID、订阅返回不取消、取消 RPC 不等于终态、永久事件占用和 clearRunEvents、遗留锁的人工恢复、固定 Codex 版本与升级验证、模型/鉴权要求、数据敏感性。补充 dataDir 到 gitignore，不写真实凭据。
- [ ] CI 在 Node 24 跑冻结 lockfile安装、只读检查、build、typecheck、Vitest/coverage；不调用真实 Codex 登录，不将需要凭据的 smoke 放入默认 CI。删除默认 CI 自动修复步骤，使只读 lint 与 spec 一致。使用 cspell 项目词表处理协议术语，不全局禁用拼写检查。
- [ ] GREEN：目标集成测试，然后一次完整 `pnpm build`、`pnpm check:type`、`pnpm test`、`pnpm exec biome check .`、`pnpm check:cspell`、`pnpm check:knip`。全量验证发现问题时修复后只重跑相关项和被改动影响的集成项。
- [ ] 对 runtime 与 runtime-codex 各运行 pnpm pack 到临时目录，在 repo 外部消费者安装 tarball 并 import，验证 dts、PGlite 外置资源、Drizzle 迁移资源从任意 cwd 可读取、内部 shared 不泄漏；包导入不启动 Codex。保留 pack 测试结果，不发布 npm。
- [ ] 提交 `test(runtime): verify the Codex SDK delivery`。报告自动测试结果与真实 smoke 实际覆盖；不自动合并、发布或进入子项目二。

## Spec 覆盖与最终交接

| Spec 要求 | 对应任务 |
| --- | --- |
| 模块边界、ESM/workspace、最小契约 | 1、6、7 |
| PGlite 所有权、Drizzle schema/迁移/参数化查询 | 2、3 |
| Valibot 公共输入、游标、原生消息校验 | 1、3、5、6 |
| 仅 SDK 会话、统一查询/归档/重启映射 | 3、7、10 |
| 每会话单运行、后台执行、多会话 | 4、6、7 |
| 持久化事件、游标恢复、清理及 lost-wakeup | 4、10 |
| 真实原生协议、AG-UI 映射、无导入副作用 | 5、6 |
| 审批恢复、响应不确定性、取消不伤及其他会话 | 8 |
| 中断恢复、存储失败、进程退出及 dispose | 9 |
| 示例、打包、自动验证和显式真实 smoke | 10 |

每项完成时记录目标命令与结果，完成所有任务才称首个子项目交付。若实际 Codex 0.153.4 协议不能满足已确认语义，记录精确差异并回到 spec 讨论，不用静默降级替代验收。

参考：[Drizzle PGlite](https://orm.drizzle.team/docs/connect-pglite)、[Drizzle Valibot](https://orm.drizzle.team/docs/valibot)、[Codex app-server](https://developers.openai.com/codex/app-server/)、[PGlite API](https://pglite.dev/docs/api)、[AG-UI JS events](https://docs.ag-ui.com/sdk/js/core/events)。本计划中的协议输入还以本机 0.153.4 生成类型核对，包括 text_elements 和 approvalsReviewer。
