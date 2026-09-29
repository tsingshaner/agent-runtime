# Web 工作台

React、Vite、TanStack Router/Query、Base UI 与 Tailwind CSS 构建的中文入口。
`src/routes/` 使用 TanStack 文件路由，Vite 插件自动生成 `src/routeTree.gen.ts`；生成文件随代码提交，不手工编辑。
浏览器使用 Better Auth React client；业务 API 使用共享 oRPC 契约。
当前入口提供登录、受保护工作台和退出；项目、聊天与资源页面由后续任务实现。

## 构建与启动

在仓库根目录执行：

```sh
pnpm install
pnpm build
pnpm --filter @internal/server build
NITRO_RUNTIME_DATA_DIR=/absolute/path/to/runtime-data NITRO_HOST=127.0.0.1 NITRO_PORT=4310 \
  node apps/server/.output/server/index.mjs
```

打开 `http://127.0.0.1:4310`。服务启动时初始化，访问令牌写入数据目录中的
`http-token`（权限 0600）。在终端读取该文件，将令牌填入登录页；不要放进 URL、日志或 localStorage。
`RUNTIME_DATA_DIR` 是兼容的数据目录覆盖变量；未配置目录时使用服务工作目录中的 `.agent-runtime`。

Better Auth 会话有效期固定为 7 天，不自动续期；Cookie 为 HttpOnly、SameSite=Strict，
HTTPS 下附加 Secure。退出撤销当前会话，服务重启轮换访问令牌并清空所有浏览器会话。
这不是 Codex 身份配置；后续使用模型时仍需在服务器预先配置 Codex。

## 开发

先构建 workspace，然后分两个终端运行：

```sh
RUNTIME_PUBLIC_ORIGIN=http://127.0.0.1:5173 pnpm --filter @internal/server start
pnpm --filter @internal/web dev
```

打开 `http://127.0.0.1:5173`。Vite 将认证和健康检查请求转发到本机 4310，保留浏览器的 Host/Origin。
后续业务页面需要在开发代理中增加对应 API 前缀。不要将开发服务器公开到公网。

## 同源 HTTPS

生产部署由 Nitro 同时提供构建后的页面、静态资源和 API。将
`RUNTIME_PUBLIC_ORIGIN=https://agent.example.com` 传给服务进程，反向代理终止 HTTPS，
再转发到 `127.0.0.1:4310`。例如已有 TLS 配置的 Nginx 站点内：

```nginx
location / {
    proxy_pass http://127.0.0.1:4310;
    proxy_set_header Host $http_host;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

公开地址必须是纯 HTTP/HTTPS origin，不含凭据、路径或尾部斜杠。
服务校验真正收到的 Host 与 Origin，不使用 X-Forwarded-Host 放宽校验。
代理必须保留原始 Origin，不应把外站请求的 Origin 改成可信地址。
业务 REST/SSE 的 Cookie 写请求必须来自工作台同源；原 Bearer 客户端继续可用。

## 验证

```sh
pnpm exec vitest run apps/server/src/auth.test.ts apps/server/src/server.test.ts
pnpm --filter @internal/web check:type
pnpm --filter @internal/server smoke:nitro
```

HTTP 测试覆盖登录兑换、退出撤销、过期、重启、HTTPS Cookie、Origin/Host 与 Bearer 兼容。
Nitro smoke 使用真实构建产物验证页面深链接、静态资源、认证及持久服务重启，不调用模型。
浏览器手工检查：直接打开工作台跳转登录 → 错误令牌提示 → 正确登录 → 受保护服务连接 →
刷新仍登录 → 退出 → 后退或直接打开工作台仍需登录；在 390px 宽度检查布局与键盘操作。
