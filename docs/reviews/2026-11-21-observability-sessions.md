# 2026-11-21 可观测性、页面会话与顶栏状态（v0.75.0）

- 范围：v0.74.0（`ff43d6f`）之后的本批提交。文件：`src/crash-guard.ts`、`src/service/health-watch.ts`、`src/service/feishu.ts`、`src/host-status.ts`、`src/sessions.ts`、`src/http.ts`、`src/login-password.ts`、`src/data-dir.ts`、`src/runtime.ts`、`src/service/main.ts`、`src/market/main.ts`、`src/control/main.ts`、`src/store.ts`、`src/executor.ts`；页面 `web/src/HostStatusBadge.tsx`、`ConnectionStatus.tsx`、`host-status.ts`、`topbar-status.css`、`App.tsx`、`SettingsPage.tsx`；对应测试与文档。
- 等级：R3（鉴权：页面会话与登录限速；资金风控：累计名义金额缓存；数据库：读索引）。审查方式：作者自审 + 独立只读审查子代理一轮。
- 回滚版本：v0.74.0。浏览器需重新登录；读索引留着无影响。

## 结论

P0、P1 为 0。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2 | 退出、注销全部或过期时会话文件写入失败，重启后被注销的会话重新有效 | 已修：结束会话的写入失败时删除文件（重启后全部需重新登录），删不掉则日志提示手动删除；补测试 |
| P3 | 控制面探测经控制面转回本服务，本服务卡住时会报成控制面不可用 | 告警文案与文档写明 |
| P3 | 崩溃告警时间依赖服务器时区 | 改为北京时间 |
| P3 | 累计名义金额缓存缺回归测试 | 已补：别的连接提交、本连接回滚与提交 |
| P3 | 按地址节流可被大量地址挤掉，全局层在持续猜测时每次让本人等最多 1 分钟 | 登记；文档写明，可用 access-url 登录 |
| P3 | 已打开的永续行情推送流不随注销断开 | 登记；只读行情，断线后需重新登录 |
| P3 | 新测试文件没有分片耗时数据 | 登记；按默认值估算，分片明显不均时按 AGENTS.md 更新 |

已核实：会话无法伪造或绕过，`/api/session*` 均在鉴权与 CSRF 检查之后，只读令牌访问不到 `/api/host` 与 `/api/session`；换密码后 epoch 不同，旧会话全部作废；缓存在事务内总是重算、提交的写入必使其失效；崩溃兜底与 Node 默认退出语义一致；巡检探测有超时、不重叠、告警不刷屏；回退 v0.74.0 安全。

## 已运行

- `pnpm check`、`pnpm build:web`。
- 全量 `pnpm test`：除两条回滚测试外通过；这两条因读索引在回滚后保留而失败，改为不计 `read_*` 后单独重跑通过。审查修复后重跑 `test/sessions`、`test/notional`、`test/login`、`test/http`、`test/observability`。
- 浏览器：替身后端上 1280 与 390 宽度，展开负载与连线详情、设置页登录会话；无横向溢出、无 CSP 报错。

## 未运行

- `deploy/test-install.sh`、真实 systemd 验收（本次未改安装脚本与单元）。
- 真实账户上的告警发送。
