# 2026-11-25 只读接口令牌：最多 8 个，按 public、system、portfolio 分范围（v0.85.0）

- 范围：`src/read-token.ts`、`src/http.ts`（令牌分支、`/api/read-token/self`、生成与吊销、`/api/status` 投影）、`tools/mcp/readonly.ts`、`web/src/{ReadTokenSettings.tsx,read-token-form.ts,styles.css}`、`deploy/{install.sh,test-install.sh}`、`test/{read-token,read-token-form,mcp-readonly,news-feed,varlighter,varlighter-local}.test.ts`、`docs/{mcp,frontend}.md`、`README.md`。
- 等级：R3（凭据与鉴权、部署脚本）。
- 影响面：`read-token.json` 升到 version 2，v1 读入时迁移为一个名为「MCP」、三个范围全选的令牌；令牌请求在白名单之后再判断范围（403 `token_scope`）；限额改为按令牌计，另加合计并发 4；新增令牌专用 `GET /api/read-token/self`；没有 `portfolio` 的令牌读 `/api/status` 只得到顶层字段白名单，日志改归 `portfolio`；吊销全部须显式 `{ all: true }`；`--set-password` 吊销全部令牌。
- 审查方式：作者自审，加三轮独立只读审查子代理，每轮新开，不给作者结论。
- 回滚版本：v0.84.0。旧版只认 version 1，读到 v2 文件当作损坏、拒绝全部令牌，不放宽权限；回退后在面板重新生成即可。

## 第一轮（f6a9021 相对 976780d）

P1 2 条、P2 2 条、P3 4 条，全部已修（4146b23）。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1 | 文件被外部删除后只有 `check`、`flush` 核对，页面上生成或逐个吊销会把已删除的令牌连同密钥、别名写回 | 已修：`view`、`generate`、`revoke`、`check`、`lookup`、`dueReminders`、落盘入口统一核对，删除后生成按全新文件；有不经令牌请求直接生成、吊销、提醒的用例 |
| P1 | `system` 范围的 `/api/status` 带飞书消息原文（成交、告警）、`/api/logs` 带成交与持仓日志 | 已修：日志归 `portfolio`；没有 `portfolio` 的令牌读 `/api/status` 用顶层字段白名单投影；页面文案同步 |
| P2 | `self` 在限额之前返回，不受每分钟次数与并发限制，文档又写“不进统计” | 已修：`self` 走同样的限额并计入统计，文档对齐；有 30 次后 429 的用例 |
| P2 | 写文档的脚本把 frontend.md 插入点之后的四节整段删掉 | 已修：从主线恢复，只新增两段 |
| P3 | 删除后 `dueReminders` 仍会提醒 | 并入第一条 |
| P3 | 连旧版平台时 MCP 每次调用都先问一次 `self` | 已修：403 `read_only` 后 5 分钟内不再问 |
| P3 | 升级后未刷新的旧页面发空体吊销，含义变成全部吊销 | 已修：全部吊销须 `{ all: true }`，空体 400 |
| P3 | 文档写得比代码覆盖的宽 | 已对齐 |

## 第二轮（4146b23 相对 f6a9021，并复核整体鉴权）

P1 1 条、P2 1 条、P3 4 条，已修（850ad42）。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1 | 别名一致性用例的第二个令牌只有 `system`，投影后读不到地址，断言必然失败（CI 已复现） | 已修：改为全选范围 |
| P2 | 投影用例的夹具没有 `health`、`dependencies`、`monitor`，`'health' in narrow` 空过 | 已修：夹具补全，逐项 `deepEqual`，标记文字先在完整应答里出现再断言窄应答没有 |
| P3 | 核对与改名之间被删除仍会写回；删除后重新生成时旧请求把旧别名登记进新表 | 写进 mcp.md 8.4；第三轮按审查意见改为改密码时删两次 |
| P3 | 投影只按顶层挑字段，`health.loops[].lastError` 是日志原文 | 已修：去掉 `lastError`；文档写明按顶层字段 |
| P3 | mcp.md 第 1 节“泄露时读到白名单全部”、http.ts 吊销注释过时 | 已修 |
| P3 | 只有 `portfolio` 的令牌在 MCP 里读不到执行器状态 | 已修：工具可属多个范围，`platform_status` 有其一即列出 |

## 第三轮（850ad42 相对 4146b23）

没有 P0、P1。P2 1 条、P3 4 条，已修（f50371b）。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2 | 文档说改密码后的重启能消除写回时间窗，不成立：写回的文件重启后会被读回 | 已修：`--set-password` 在执行服务重启完成后（含回退成功）再删一次；文档写明手工吊销全部要先停服务 |
| P3 | 两半都不在范围内时 `platform_status` 返回“成功”但没有数据 | 已修：报工具错误；有用例 |
| P3 | `dependencies` 的告警事件会写出账户推送断开及原因 | 写进 mcp.md 8.4（账户已打码，`/api/host` 同样给出） |
| P3 | 一半遇到 401、429 时整次报错、投影的各种 `health` 形状没有用例 | 已补 |
| P3 | `loops` 里非对象的元素会让解构抛错 | 已修 |

已核实（三轮合计）：令牌分支顺序为锁定 → 拒绝 cookie → 校验 → `self`（GET、精确路径、无查询）→ 白名单 → 范围 → 限额 → 打码，非 GET、白名单外、范围外都在限额前 403；v1 迁移保留编号、到期、密钥、别名、已发提醒；v2 解析对畸形文件一律拒绝；按令牌与合计的并发释放不泄漏；`--set-password` 的第一次删除在配置检查通过之后，登录密码进入执行服务的配置摘要，改密码必然重启执行服务；页面校验与服务器一致，令牌明文只在组件状态里。

未能核实：真实服务器上经 Tailscale 用多个令牌读取（与第一批一起实测，记进 [live-results.md](../live-results.md)）；install.sh 第二次删除的时机只在安装测试的最终状态上覆盖。

## 已运行

- `pnpm check`、`pnpm build:web`：通过。
- 浏览器：内置浏览器 1280 与 390 宽度，页面生成两个令牌、范围 403、吊销后 401（[frontend.md](../frontend.md)《只读接口令牌》）。
- 分支 ci（均带 `install_full=true`）：f6a9021 两处测试夹具错误 https://github.com/hxx344/trading-platform/actions/runs/45467595239 ；4146b23 别名一致性用例失败（第二轮 P1） https://github.com/hxx344/trading-platform/actions/runs/45469184007 ；850ad42 全部通过 https://github.com/hxx344/trading-platform/actions/runs/45470390421 ；f50371b 全部通过 https://github.com/hxx344/trading-platform/actions/runs/45471322568 。
