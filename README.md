# Agent Runtime

Node.js 24、ESM 的多 runtime SDK：通过同一个 Manager 使用 Codex、DeepSeek Harness 和 Deep Agents，以 PGlite 保存统一会话、运行状态和 AG-UI 事件。提供本地 HTTP 服务、TanStack AI 与 A2A 接入，以及项目 Knowledge、Skill、MCP 和共享 Memory。

- [@qingshaner/runtime](packages/runtime/README.md)：公共会话管理和本地持久化。
- [@qingshaner/runtime-codex](packages/runtime-codex/README.md)：Codex app-server 适配器。
- [@qingshaner/runtime-dsh](packages/runtime-dsh/README.md)：每会话独立 Harness 进程。
- [@qingshaner/runtime-deepagents](packages/runtime-deepagents/README.md)：持久化原生图与人工交互。
- [SDK 示例与验收](examples/sdk/README.md)、[本地服务](apps/server/README.md)、[TanStack AI](examples/tanstack/README.md)、[A2A](examples/a2a/README.md)。
- [验收矩阵与验证边界](docs/runtime-acceptance.md)。

## 本地运行

需要 Node.js 24、pnpm 12、已经完成鉴权的 Codex CLI，以及调用方可使用的模型。
协议类型和自动化对端测试基线为 **codex-cli 0.153.4**；未运行真实模型冒烟时，不能声称真实环境兼容验证通过。

```sh
pnpm install --frozen-lockfile
pnpm build
CODEX_MODEL=your-model pnpm example:sdk
# 使用上次输出的公共 sessionId 续接
CODEX_MODEL=your-model SESSION_ID=public-session-id pnpm example:sdk
```

示例保存数据到当前工作目录下 `.agent-runtime`，打印公共 ID 与完整事件；终端中逐项询问审批，无终端时拒绝审批。通过 `RUNTIME` 和 `RUNTIME_MODEL` 选择 runtime 与模型，配置方式见 SDK 示例。
通过 workspace 包的公开 exports 运行；Node 24 原生运行 TypeScript，不需要额外脚本运行器。
使用 workspace 脚本时工作目录为 `examples/sdk`。需要其他工作目录时，build 后从目标目录运行示例的绝对路径。

## 宿主与数据生命周期

- **刷新保活要求宿主仍存活**：应用刷新、断开或退出订阅不会取消运行；SDK 所在 Node 进程必须持续运行。宿主退出后不能继续生成，重开时未完成运行标记为 `interrupted`，不会自动重试输入。
- 公共 `session.id`、`runId` 与 Codex 原生 thread/turn ID 不同。调用管理器接口时使用公共 ID；会话固定绑定 runtime。
- 只管理 SDK 创建并成功保存的会话，不扫描或导入 Codex CLI 历史。
- 一个数据目录只允许一个活跃 Manager；仅支持本地文件系统，不支持共享网络目录或多进程写入。
- Codex 按项目懒启动共享 app-server，DSH 每会话独立进程，Deep Agents 使用原生持久 checkpoint；同一会话只允许一个非终态运行。
- 事件先写入数据库再发布，序号从 1 连续增长。`subscribe(runId, { afterSequence })` 从已消费游标之后重放。退出订阅、调用迭代器 return 或中止订阅不等于取消运行。
- `cancel()` 的 RPC 成功只表示取消请求已被接受；仍须订阅终态或查询 `getRun()`。普通取消不终止共享进程。
- 事件永久保存并持续占用磁盘。终态运行可调用 `clearRunEvents(runId)` 清理事件；状态和元数据保留，后续订阅抛出 `EVENTS_CLEARED`。
- 数据包含提示词、输出、工作目录和审批细节，可能涉及敏感信息。使用受控目录、备份与访问权限；不要提交数据库或凭据。SDK 只保存经过白名单验证的会话配置，不将鉴权内容作为 session options。

### 遗留锁恢复

`DATA_DIR_BUSY` 表示存在 `.manager.lock`。先确认锁中记录的主机和 PID 对应的进程已结束、没有任何活跃 Manager 或未完成数据库关闭；备份数据后，人工删除数据目录中的 `.manager.lock`，再重开。
不能仅凭 PID 不存在自动抢锁；不确定时不要移除。关闭超时会保留所有权以防止第二个写入者进入。

## 检查与冒烟

```sh
pnpm build
pnpm check:type
pnpm test
pnpm check
pnpm check:cspell
pnpm check:knip
pnpm test:cov
pnpm smoke:codex
```

默认 smoke 输出 `SKIPPED: real Codex smoke not run`，不登录、不调用模型。
真实冒烟必须显式设置 `RUN_CODEX_SMOKE=1` 和 `CODEX_MODEL`，使用现有鉴权，会产生模型用量：

```sh
RUN_CODEX_SMOKE=1 CODEX_MODEL=your-model pnpm smoke:codex
```

冒烟使用独立临时 workspace 与应用数据库，前后使用相同 `CODEX_HOME`（或默认 Codex home）以验证续接，不改写全局配置。
验证文本流游标重连、公共 ID 续接；交互终端中请求 read-only 沙箱写入临时文件，由用户 approve/deny，再输入 `cancel` 验证取消终态。
未产生审批、未及时输入取消或无交互终端时，对应场景明确输出 `UNVERIFIED`，不能当作通过。
临时应用数据结束后删除；原生 smoke thread 仍可能保存在 Codex home。升级 CLI 后需重新执行这些场景才能扩展兼容声明。
CI 在 Node 24 使用冻结依赖、只读检查和串行测试文件，避免同时启动多个 PGlite 实例产生资源竞争；不调用真实 Codex 或凭据。
