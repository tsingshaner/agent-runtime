# Web 工作台

React、Vite、TanStack Router/Query、Base UI 与 Tailwind CSS 构建的中文入口。
`src/routes/` 使用 TanStack 文件路由，Vite 插件自动生成 `src/routeTree.gen.ts`；生成文件随代码提交，不手工编辑。
浏览器使用 Better Auth React client；业务 API 使用共享 oRPC 契约。
当前入口提供登录、项目与会话导航、Codex 流式聊天、历史和归档、工具审批、补充输入及取消。
已提供 Skill 导入、内容读取、MCP 配置、Knowledge 文档管理和项目绑定；Memory 页面由后续任务实现。

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

打开 `http://127.0.0.1:5173`。Vite 将认证、健康检查、项目、会话、运行、技能和 MCP 请求转发到本机 4310，保留浏览器的 Host/Origin。不要将开发服务器公开到公网。

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

## 项目与聊天

创建项目时填写的是服务端已有目录，服务会校验并规范化路径；项目归属不是文件沙箱。
项目和会话 ID 保存在 `/workspace?project=…&session=…`，刷新或直接访问恢复对应上下文。
列表支持分页；会话侧栏可切换已归档列表，空闲会话可以归档和恢复。

服务端 `CODEX_MODEL` 设置网页的默认模型，通过受保护的 `/health` 仅返回模型名称；
未配置时网页要求手动填写。新会话固定 Codex、项目、模型及选定工作目录。
模型认证仍使用服务端预先配置的 Codex 身份，不通过网页上传凭据。

发送前将原 Request ID 和消息暂存于当前标签页的 sessionStorage，收到成功响应后清除。
响应不确定时只允许“确认原请求”，使用相同标识与输入；刷新后仍保留这份确认上下文。
会话忙时不排队，新会话可以独立运行。运行查询返回 `requestText` 用于历史恢复；
旧数据未保留的输入显示为空，不猜测用户消息。

事件订阅使用 OpenAPILink 和 TanStack StreamProcessor，断线按持久序号续订并去重，
最多自动重试五次，仍失败时可手动重新连接。切换页面只关闭订阅，不取消运行。
审批和补充输入从服务端查询；授权发送尝试会在当前标签页记住，响应不确定时不重发。
批次逐项选择后由服务端收齐执行。取消请求成功后仍等待服务端的实际终态。
Markdown 不执行原始 HTML，不渲染外部图片，链接经过安全转换；代码块支持复制。

## 浏览器回归与真实冒烟

```sh
pnpm build
pnpm --filter @internal/web exec playwright install chromium
pnpm exec vitest run apps/web/test/workbench.test.ts
```

测试启动构建后的网页和真实 Fetch 服务、真实 PGlite，模型侧复用 ManualAdapter，
覆盖目录校验、项目/会话隔离、刷新、手机导航、归档、请求响应丢失、断流重连、
工具结果、混合审批批次、输入续接、取消确认和迟到回答。不调用外部模型。
可使用 `PLAYWRIGHT_CHANNEL=chrome` 改用本机 Chrome。
CI 使用 `playwright install --with-deps chromium` 安装浏览器和系统依赖。

真实模型需显式启用（会消耗已配置的 Codex 额度）：

```sh
pnpm --filter @internal/server build
RUN_REAL_CODEX=1 CODEX_MODEL=your-model pnpm --filter @internal/web smoke
```

真实冒烟从网页登录、创建项目/会话、发送文本并刷新验证历史。未启用时输出 UNVERIFIED；
工具、审批与资源的真实模型行为仍按实际触发情况单独记录，受控测试不能替代该验证。

## OpenUI 只读回复

可以直接请求“用卡片总结”或“用表格比较”。助手回复中的 `openui` 围栏块支持
`Card(title, body)` 和 `Table(caption, columns, rows)`；其余回复继续使用 Markdown。
每块只包含一个 root 赋值，参数直接使用 JSON 文本和数组，不使用变量引用。
卡片和表格随文本事件更新，刷新与断网恢复复用已有 Run 事件，不重复执行。
只读内容不提供动作、表单、网络查询或工具调用；用户消息和工具结果不会被解释为 UI。

组件定义同时生成服务端展示指令。Web 的 build/dev 命令会更新已提交的
`apps/server/src/openui-prompt.json`；修改组件定义后需重新构建并重启服务，前后端一起部署。
服务对运行输入添加展示指令，持久化的用户原文、请求去重和 Memory 写入仍使用原始输入。
直接使用 SDK 时，只有显式设置 `RuntimeManager.open` 的 `instructions` 才会注入宿主指令。

未知组件、错误属性、丢弃的内容、结束后未闭合的围栏或表达式会局部回退到原文。
每块最多 64,000 字符，表格最多 200 行、30 列；超限保留原文，不截断数据。
表格列与行长度需一致，宽表格可聚焦后使用键盘滚动。原始 HTML 和脚本均作为文字显示。

浏览器回归覆盖混排、分片、错误回退、终态中断、重连和交互控制。
真实 Codex smoke 额外请求卡片与表格，验证生成和刷新恢复；未启用仍报告 UNVERIFIED。

## 技能管理

选择项目后打开「技能管理」，页面地址保留 `view=skills`，刷新或登录后可恢复。
「共享技能库」展示所有已导入的受管理副本，「当前项目绑定」独立展示本项目的启停状态。
从服务端目录导入会保留原文件及脚本、参考资料；点击「查看内容」读取 SKILL.md，
也可按相对路径读取附属文件。文件仅作为文本展示，不执行 HTML 或脚本，不提供在线编辑。

绑定、启停和解除绑定会等待服务端确认；有活动 Run 时显示等待提示，可以切回会话处理审批或取消。
解除绑定不删除共享副本。绑定失败保留服务端状态并提供错误提示，不提前显示为已生效。

浏览器测试使用真实临时目录和服务，覆盖导入失败、文件越界、安全展示、项目隔离、刷新、键盘和窄屏。
HTTP 资源测试验证活动 Run 期间等待更新且取消仍可用；这些测试不调用真实 Codex。

## MCP 管理

选择项目后打开「MCP 管理」，页面地址保留 `view=mcp`。共享配置支持 stdio 和
Streamable HTTP；参数使用 JSON 数组，环境变量或请求头映射使用 JSON 对象。
映射值只能填写服务端环境变量名称，实际凭据由服务端解析；不要把密钥写入启动参数。
HTTP URL 不允许包含凭据、查询参数或片段。

「检测连接」临时连接服务、发现工具并释放连接，分别提示缺少凭据、超时及连接失败。
修改共享配置会影响所有绑定项目，修改后需重新检测。项目绑定、启停和解除绑定独立管理，
有活动 Run 时等待服务端确认，仍可切回会话处理审批或取消；失败时保留输入，不提前显示成功。

浏览器回归使用受控 stdio/HTTP MCP 服务，覆盖创建、编辑、发现工具、连接释放、凭据引用、
失败状态、项目隔离、键盘和窄屏。HTTP 资源测试验证活动 Run 期间的更新等待与取消。
这些测试不调用真实 Codex，也不验证外部 MCP 服务的可用性。

## 知识管理

选择项目后打开「知识管理」，地址保留 `view=knowledge`。先绑定服务端已有的 Markdown
目录；无效路径会失败，不自动创建目录，也不会移动原文档。绑定更新有活动 Run 时等待，
期间文档写入暂不可用，仍可预览或切回会话处理审批、输入或取消。

绑定后支持文档列表、新建、读取、编辑、关键词搜索和实时预览。路径相对绑定目录且须以
`.md` 结尾；保存沿用服务端原子写入与路径、符号链接校验，失败保留编辑内容。
删除需确认，会删除服务端文件并同步列表与预览。切换文档或离开页面前请先保存草稿。
Markdown 不执行 HTML、不加载图片；搜索摘要作为纯文本展示。不会导入非 Markdown 文件、
抓取网页或创建向量库。目录若被多个项目显式绑定，文件修改会被这些项目共同看到。

浏览器测试使用真实服务与临时目录，验证增删改查、落盘、目录和项目边界、搜索安全、
失败保留草稿、手机及键盘操作，并验证活动 Run 期间绑定等待和取消；模型侧使用受控 adapter。
