# 沿用 PGlite 与持久化事件契约

多 runtime 扩展沿用现有 PGlite 存储，不采用初始计划中的 SQLite；现有审批持久化、事件回放和唯一终态契约继续有效。这样可复用已实现的状态管理与恢复能力，避免仅因扩展适配器而引入数据库迁移；详细契约仍以 [Spec #10](https://github.com/tsingshaner/agent-runtime/issues/10) 为准。

SDK 保持嵌入式执行能力，HTTP 服务内部使用同一个 Manager；同一数据目录只允许一个宿主拥有，其他进程通过 HTTP 访问，避免出现多个执行与恢复主体。
