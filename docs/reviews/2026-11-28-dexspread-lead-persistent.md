# DEX 价差：多参考源领先测速常驻化与离线分析（v0.117.0）审查

2026-11-28，R2。基线 `326b173`（v0.116.1，自 `4551e11` v0.115.0 分支开发并变基合入），回滚版本 `v0.116.1`。范围为 `#/varlighter/lead` 常驻多参考源改造与独立只读离线分析架构：后端核心（`src/varlighter/{views,lead,lead-store,lead-worker,lead-streams,engine}.ts`、`src/dex/host.ts`）、前端页签与只读白名单（`web/src/varlighter/{VarLighterLead.tsx,varlighter-lead-form.ts,varlighter.css}`、`web/src/api.ts`）、预览替身（`scripts/dev-varlighter.ts`）与测试（`test/dex-lead.test.ts`、`web/test/varlighter-form.test.mjs`、`web/test/api.test.mjs`）。不修改 `varlighter.sqlite`、`src/dex/protocol.ts`、`src/dex/ipc.ts`、`src/http.ts`、`src/read-token.ts` 与执行面代码，设计见 [dexspread.md](../dexspread.md) 第 22 节与 [frontend.md](../frontend.md)。

两轮独立只读 R2 审查与修复闭环：

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 首轮·独立审查 | P1 | 冷启动空库 `addWatcher()` 同时触发 `live.refresh()` 与 `runAnalyze()`，与 `initialAnalyzeRan` `useEffect` 并发抢占单一 Worker 返回 `429 lead_analyze_busy` 并丢弃首次结果 | 已修：`runAnalyze` 与 `addWatcher` 成功回调同步置 `initialAnalyzeRan.current = true`，二轮再补 `useEffect` `write.busy === 'add'` 在途防并发守卫 |
| 首轮·独立审查 | P1 | `startRun`/`endRun` 写库报错误写入 `storageError` 被 30s 只读 `summary()` 清零掩盖，且 `startRun` 失败时 `tickMaintenance` 无退避每秒刷错误日志 | 已修：拆分 `lastWriteError` 与每标的 `startRunCooldown`（30s 退避 + 60s 日志节流），`endRun`/`pruneBatch` 不覆写前置写错，`view()` 提示写库退避原因 |
| 首轮·独立审查 | P2 | `LeadTracker` 30s 心跳锚点落在 60s 时，Worker 再按 `MAX_STALE_SLOTS=600`（60s）向外填值，静默流总外推可达 120s | 已修：`LeadTracker` 最后锚点限至 `30s`、Worker `MAX_STALE_SLOTS` 收窄为 `300`（`30s`），确保静默总外推严格 `<= 60s` 并补测试 |
| 首轮·独立审查 | P2 | 停服 `close()` 后未置 `leadStore=null` 与拦截后续请求导致访问已关句柄/漏出新 Worker；`openLeadStore` 与 `ensureLeadStore` 的 `prepare`/`listWatchers()` 异常存在句柄泄漏窗口 | 已修：`openLeadStore` 整体并入 `try/catch { db.close(); }`，`ensureLeadStore` 失败闭合临时实例；`close()` 置 `leadStore=null`，全接口在停服态统一抛出 `503 unavailable` |
| 首轮·独立审查 | P2 | `lead_events` 与 `lead_grid` 缺少 `run_id` 索引，7 天数据清理时 `stmtPruneRuns` 执行全表扫描 | 已修：补充 `lead_events_run` 与 `lead_grid_run` 索引并纳入测试校验 |
| 首轮·独立审查 | P2 | DEX 挂牌 `PEPE` 与 Binance `1000PEPEUSDT`（及跨 DEX 分别挂 `1000PEPE` 与 `PEPE`）时 `buildLeadCandidates` 产出重复候选 | 已修：以 `dexMarkets` 为锚去重、`canonicalBase` 归并 `1000` 前缀，并兼顾 `classifyLeadAsset` 类别识别 |
| 首轮·独立审查 | P2 | `POST /api/varlighter/lead/analyze` 未纳入 `web/src/api.ts` `query` 只读白名单；文档未更新至 v0.117.0；缺 `analyzeTimeoutMs` 超时与多边界单测 | 已修：纳入 `web/src/api.ts` `query` 白名单，补充 `504 analyze_timeout`、`503 unavailable`、60s 上限、写错退避与候选去重单测，并更新文档与本记录 |
| 首轮·独立审查 | P3 | 移除当前分析且无历史数据的标的时 `selectedSymbol` 未回落；`removeWatcher` 先停流再删库在 409 冲突时误停在连流 | 已修：`removeWatcher` 与 `useEffect` 联动同步回落 `selectedSymbol`，服务端改为先校验 `updatedAt` 并原子 `deleteWatcher` 再 `stopRuntime` |
| 二轮·独立复审 | P0/P1 | 核查首轮全部 8 项主路径、句柄清理与停服 503 契约均已闭环，无 P0/P1 阻断问题 | 全部闭环（0 P0 / 0 P1） |
| 二轮·独立复审 | P2/P3 | ① 冷启动 `addWatcher` 在途期间 2s 轮询并发窗；② 双 DEX 分别挂 `1000PEPE`/`PEPE` 归并；③ `stopRuntime`/`pruneBatch` 清错作用域、日志时间戳初值 `null`、409 `remove` 保留流回归用例 | 已在复审后全部一并收口：补全上述 5 处微调与单测并重跑全部本地检查通过 |

- **已运行**：最终代码通过 `pnpm check`、`pnpm build:web`、`node deploy/component-digests.mjs .`（组件摘要零泄漏并已清理 `.control-sha256` 等临时摘要）、8 组定向回归测试（`test/dex-lead.test.ts`、`web/test/varlighter-form.test.mjs`、`web/test/api.test.mjs`、`test/varlighter.test.ts`、`test/dex-service.test.ts`、`test/lighter-book-top.test.ts`、`test/workspace-nav.test.ts`、`test/web-css.test.ts`，共 120 项全通过）、两轮独立只读 R2 审查与修复，以及本地替身 `node scripts/dev-varlighter.ts --port 4746` 双视口（`1280×900` 与 `390×844`）浏览器验收。
- **未运行**：真实公网 7 个参考源/交易所生产行情在线联调，以及全仓测试与 Ubuntu Linux CI（交由 GitHub Actions CI 执行与验证）。
