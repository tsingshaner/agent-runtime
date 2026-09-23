# 使用 oRPC 契约迁移本地服务接口

本地 server 采用 Nitro 与 oRPC OpenAPIHandler，以 Valibot 契约描述 REST 接口并复用现有 RuntimeManager；本次范围为已有服务接口迁移、契约及验证，不包含新增 runtime 或 A2A 接入。接口格式优先遵循 oRPC 约定，允许调整旧 HTTP 格式并同步迁移仓库内调用方，避免为了保留手写协议而长期维护额外兼容层；既有运行生命周期、鉴权与资源所有权约束仍然有效。

契约放入独立 workspace 包，由服务端与客户端共同引用，且不依赖服务端进程、数据库或 runtime 实现。由契约生成 OpenAPI JSON，并通过受现有鉴权保护的端点提供；本次不增加交互式 API 文档页面。

事件流使用单一 oRPC 异步迭代端点，保留 AG-UI 事件及持久序号；客户端以 OpenAPILink 解码后交给 TanStack StreamProcessor。只重连订阅，不重提运行；传输错误与 Run 终态保持独立，断开订阅不取消运行。
