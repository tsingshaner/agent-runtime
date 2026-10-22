# Web 工作台完整验收

日期：2026-10-22（Asia/Shanghai）。对应 GitHub #51，父规格 #41。

## 环境与证据边界

- macOS，本机 Node 24.14.0、pnpm 12.4.1、Playwright 1.63.0、Codex CLI 0.163.0。
- 使用构建后的 Nitro 服务和 Web 静态产物，临时数据目录；未修改既有服务数据。
- HTTPS 由回环地址代理终止 TLS，使用一天有效的临时自签证书。浏览器只在测试上下文忽略该证书信任错误，系统信任不变。
- 真实 Codex 使用本机已登录的 ChatGPT 身份和 `gpt-6-astra`，未记录令牌或密钥。
- 公网域名、正式 CA 证书、外部客户端访问和远端 CI 未验证；本记录不等同于公网生产发布。

## 已执行路径

| 验证层 | 结果与覆盖 |
| --- | --- |
| 构建后同源 HTTPS | 登录、Secure/HttpOnly/SameSite=Strict Cookie、错误 Origin 拒绝、未登录 API/事件流拒绝、默认模型、直接路由刷新、退出撤销 Cookie、Bearer 兼容 |
| HTTPS 资源入口 | Skill 导入与绑定、MCP 创建/检测/绑定、Knowledge 创建保存、Memory 未配置指引；手机宽度和键盘退出 |
| 连贯工作流（真实服务、受控 adapter） | 活动 Run 中更新资源，拒绝新 Run（RESOURCES_UPDATING），切回审批和补充输入，退出不取消 Run，重新登录取消，下一轮收到新技能绑定，归档和恢复 |
| 真实 Codex、构建后 HTTPS 网页 | 文本回复 WEB_SMOKE_OK、刷新恢复、OpenUI 卡片/表格生成和刷新恢复通过 |
| 真实工具、审批、资源执行 | 未触发，未验证；受控 adapter/MCP 测试不替代该证据 |
| 既有功能回归 | 保留登录、历史、审批、输入、取消、Skill/MCP/Knowledge/Memory 的安全、错误、保存失败、项目隔离与手机测试 |

真实 Codex smoke 输出：`PASS: built Nitro over local HTTPS, real Codex text, OpenUI card/table generation and browser history recovery.`

## 重跑

先使用 Node 24+ 和 pnpm 12+，配置本机 Codex 登录身份；HTTPS fixture 需要 OpenSSL。

```sh
pnpm build
pnpm --filter @internal/server build
pnpm --filter @internal/web exec playwright install chromium
pnpm --filter @internal/web smoke:https
RUN_REAL_CODEX=1 CODEX_MODEL=gpt-6-astra pnpm --filter @internal/web smoke
node apps/server/nitro-smoke.ts
pnpm test
pnpm check:type
pnpm check
pnpm check:cspell
pnpm check:knip
pnpm peers check
```

真实模型命令会消耗所配置身份的额度；模型应替换为部署者有权限的型号。
本机启动、取令牌、公开地址、默认模型和反向代理配置见 [Web README](../../apps/web/README.md)。
退出清除浏览器查询缓存并撤销登录，不取消服务端 Run；重新登录可恢复控制。

## 检查结果

全仓 347 项测试通过、3 项跳过（49 个测试文件通过、1 个跳过），无类型错误。
类型检查、只读 Biome、cspell、knip、peer 检查及 workspace/Nitro/Web 构建通过；
现有非阻塞 lint 提示保留。Review 未发现阻塞问题。
