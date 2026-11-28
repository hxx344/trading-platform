# DEX 价差：Binance 领先测速子模块审查

2026-11-28，R2。基线 `89e4388`（v0.114.0），回滚版本 `v0.114.0`。范围为 DEX 价差服务内新增只读子模块「Binance 领先测速」（`src/varlighter/{lead,lead-streams,engine,views}.ts`、`src/dex/host.ts`）、前端页签（`web/src/varlighter/{VarLighterLead.tsx,varlighter-lead-form.ts,parts.tsx,varlighter-form.ts,varlighter.css,VarLighterPage.tsx}`、`web/src/route-parse.ts`）、预览替身（`scripts/dev-varlighter.ts`）与测试（`test/dex-lead.test.ts`、`web/test/varlighter-form.test.mjs`）。不触碰执行面、实盘下单/凭据、`src/http.ts`、`src/dex/protocol.ts`、`src/read-token.ts` 与 SQLite 表结构，设计见 [dexspread.md](../dexspread.md) 第 21 节与 [frontend.md](../frontend.md)。

两轮独立只读审查与最终 P3 收尾：

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 首轮·独立审查 | P1 | `evaluateBinanceImpulse` 在 `bestBase.monoMs > preFloor` 且跨过 `preFloor` 时直接 `break`，未把容差带内的平稳报价延续至 `preFloor`，窗口前缀微调点差会丢掉更早的 DEX 抢跑 | 已修：`preStartMono` 跨界平稳报价延续至 `preFloor`；选各场所基准时检查 `(preStartMono, bestBase.monoMs]` 是否有同向抢跑（无则取起爆前稳态点，有则保留 `preStartMono` 前基准）；已补 `-300ms` 回归测试 |
| 首轮·独立审查 | P1 | `POST lead/catalog` 的 fetch 超时（`15 s`）长于执行面 IPC 读超时（`DEX_READ_TIMEOUT_MS = 10 s`），慢网络时会引发 `DexOutcomeUnknown` 并强断浏览器连接 | 已修：将 `CATALOG_TIMEOUT_MS` 降至 `7_500 ms`（严格小于 `10 s`），并补充 `CATALOG_TIMEOUT_MS < 10_000`、`8 MB` 限长与 `anySignal` 超时测试 |
| 首轮·独立审查 | P2 | WS 在连状态收到错误帧/解析异常时 `setConnected` 将 `lastError` 覆写为 `null`，页面误显正常等待首档 | 已修：`setConnected` 保留在连 `lastError` 至下一条有效行情清除；前端同步在 Binance 指标卡与 DEX 表格双路径显示 `lastError` |
| 首轮·独立审查 | P2 | `EntropyBboStream` 仅在建连发一次 `l2Book`，安静市场超过 60s 无价变时会触发 `LEAD_BASE_STALE_MS` 断线并使事件判 `no_data` | 已修：增加 `ENTROPY_CONFIRM_MS = 45_000` 定期 `l2Book` 确认并新增 `LeadTracker.confirmAlive` 延续新鲜度与网格，不虚增 `ticks`/`ticksPerSec` |
| 首轮·独立审查 | P2 | 30 分钟长跑时每次 `GET /lead`（2s 轮询）重复遍历 `Map` 计算互相关 | 已修：改用定长 `Float64Array` 线性扫描并用 `gridRevision` 按网格变更缓存结果 |
| 首轮·独立审查 | P2 | 页面冷启动目录尚未返回前即锁死 `initialized` 停止预填；目录刷新失败呈现绿色 `Callout` | 已修：仅在拿到非空候选、会话已存在、`catalog.loading` 结束或用户编辑后锁定；`useWrite` 支持 `WriteMessage`，目录错误渲染红色提示 |
| 首轮·独立审查 | P2/P3 | 缺目录限流/`anySignal`/重连超时/裁盘重订/表单辅助单测与文档回填；`XcorrChart` 0ms 参考线缺域检查与 `height=220` 与 `.vl-chart.small` 200px 不一致 | 已修：补全前后端边界单测、SVG 域检查与 `height=200` 对齐，并过滤损坏 `lead_history` 条目；文档见 [dexspread.md](../dexspread.md) 第 21 节与 [frontend.md](../frontend.md) |
| 二轮·独立复审 | P0/P1/P2 | 逐项核查首轮全部 7 项均已严格闭环，无新增 P0/P1/P2 问题 | 全部闭环 |
| 二轮·独立复审 | P3 | ① 无效/倒挂 `bbo` 不应推迟 `EntropyBboStream.lastTopAt`；② `lead_history` 应校检 `startedAt`/`elapsedMs`/`venues` 元素类型；可补跨断线 `segId` 互相关单测 | 已修：`emitTop` 返回 `boolean` 仅有效价更新 `lastTopAt`；收紧 `lead_history` 字段校验；已补无效倒挂 `bbo` 定时器及跨断线 `segId` 互相关单测 |

- **已运行**：最终源码 `pnpm check`、静态构建 `pnpm build:web`、组件隔离校验 `node deploy/component-digests.mjs .`（执行面/控制面/行情面零导入，已清理临时摘要文件）、定向测试（`test/dex-lead.test.ts`、`web/test/varlighter-form.test.mjs`、`test/varlighter.test.ts`、`test/dex-service.test.ts`、`test/lighter-book-top.test.ts`、`test/workspace-nav.test.ts`、`test/web-css.test.ts` 全通过，0 失败）、两轮独立只读审查及替身预览 `node scripts/dev-varlighter.ts --port 4745` 双端（`1280×900` 与 `390×844`）浏览器验收。
- **未运行**：真实公网 Binance / Lighter / Entropy WS/REST 联调（本机环境不直连外部交易所生产端点）、全仓与 Linux CI 交由 GitHub Actions Ubuntu CI 执行。
