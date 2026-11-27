# DEX 价差模块账户资产、持仓、成交与盈亏代码审查记录（2026-11-27）

## 批次与定级

- **范围**（相对于 `origin/main` `c1ed586` / `v0.107.0`）：
  - **后端采集与存储**：`src/varlighter/accounts.ts`、`src/varlighter/engine.ts`、`src/varlighter/store.ts`、`src/varlighter/views.ts`、`src/dex/host.ts`（扩展 Lighter 主网 / Lighter RH / Entropy HIP-3 `io` 盘账户权益、保证金、可用余额、现货资产、持仓详情、近 30 天成交、资金费与交易所盈亏曲线；`varlighter.sqlite` 只加不改的新表 `account_snapshots`；`GET /api/varlighter/accounts` 与 `POST /api/varlighter/accounts/refresh` 会话接口）。
  - **前端页签与格式化**：`web/src/route-parse.ts`、`web/src/varlighter/VarLighterAccounts.tsx`、`web/src/varlighter/VarLighterPage.tsx`、`web/src/varlighter/VarLighterLive.tsx`、`web/src/varlighter/parts.tsx`、`web/src/varlighter/varlighter-form.ts`、`web/src/varlighter/varlighter.css`（新增第五页签 `#/varlighter/accounts`、SVG 权益/盈亏曲线、30 天汇总与策略实盘对照、活跃持仓、成交/资金费/策略实盘三页签）。
  - **预览、测试与文档**：`scripts/dev-varlighter.ts`、`test/dex-accounts.test.ts`、`test/dex-keys.test.ts`、`web/test/varlighter-form.test.mjs`、`docs/dexspread.md`（第 14 节）、`docs/frontend.md`、`docs/live-results.md`。
- **风险定级**：**R2**
  - 不改变实盘下单与对账状态机（`src/varlighter/live.ts`、`orders.ts`）、HTTP/IPC 超时边框（`src/http.ts`、`src/dex/ipc.ts`）、只读令牌白名单（`src/read-token.ts`）或 `deploy/` 打包与组件指纹脚本；涉及新增交易所只读/签名鉴权接口解析、`varlighter.sqlite` 增量表及前端交易资产汇总视图，按 R2 完成独立审查。
- **回滚基线**：`v0.107.0`（`c1ed586`，`varlighter.sqlite` 仅新增 `account_snapshots` 表，回退旧版本无需迁移数据）。

## 两轮独立审查摘要

1. **首轮 R2 独立只读审查（`Independent R2 Code Reviewer`）**：
   - **已核实边界**：执行面与部署边界零改动；`USDC`/`USDG` 币种区分及 `1 USDG = 1 USD` 提示准确；Entropy `io:` 严格过滤与有界翻页/截断（L093）正常；Lighter 账户归属、`401/403` 强刷、无 API 私钥零鉴权请求及非零 `fee` 保守置空正常；脱敏与 CSP（无内联样式、无账户号/地址/密钥/令牌泄露、不进只读令牌）通过。
   - **提出问题（P0 = 0，P1 = 2，P2 = 3，P3 = 2）**：
     - `[P1]` 工作区存在未提交修复，`HEAD` 自身未纳入该修复；
     - `[P1]` 后台轮询与手动刷新并发缺少每场所序号与发起时刻保护，且 `loop()` `finally` 会覆盖平仓/改密钥期间刚触发的立即重刷；
     - `[P2]` `EquityLineChart` 纵轴刻度固定美元 `$` 而未匹配 `USDC`/`USDG`；
     - `[P2]` 第 4 张汇总卡未反映单场 `tradesError` 与多场部分汇总范围；
     - `[P2]` Entropy `pnlCurve` 未下采样，且 `AccountsView.livePositions` 冗余未消费；
     - `[P3]` `.vl-acc-facts dd` CSS 选择器优先级盖过 `.vl-up` / `.vl-down`；
     - `[P3]` `removeLiveKeys` 未重置账户重刷调度，且 `dropVenueCaches` 全局递增会影响其它无关场所。
   - **处置**：已全部修复并补充并发竞争、L049 发起时刻、`pnlCurve` 下采样与前端汇总脚注单测，经 `1280×800` 预览浏览器实测复验三项界面修复通过后纳入功能提交。

2. **第二轮独立只读复核（`R2 Fix Verifier`）**：
   - **核实结果**：确认首轮全部 7 项问题（2 P1 / 3 P2 / 2 P3）均已彻底关闭，干净工作区直接通过 `pnpm check`、12 个 DEX/VarLighter 测试文件与 `pnpm build:web`，**P0 = 0，P1 = 0**。
   - **增量新发现（P2 = 1，P3 = 1）与会后顺手闭环**：
     - `[P2]` `web/src/varlighter/varlighter-form.ts` 与 `VarLighterAccounts.tsx`：首次历史尚未回包时（`historyAt === null && tradesError === null`），单场所汇总脚注与汇总表前两列会短暂显示 `0 笔 / $0`。**已修复**：单场所分支增加 `venue.historyAt === null` 判断返回 `'成交未拉取'`，汇总表对应两列同步显示 `'—'`，并补充 `historyAt: null` 单测。
     - `[P3]` `web/src/varlighter/parts.tsx`：`EQUITY_MARGIN.right = 86` 在四五位数带 1 位小数与 `USDG` 标签时可能贴边。**已修复**：放宽至 `EQUITY_MARGIN.right = 104`。
   - **修复后验证**：上述 P2/P3 修改完成后已重跑 `pnpm check`、全部 12 个相关测试文件与 `pnpm build:web`，均全部通过。

## 验证汇总

- **已运行（最终源码稳定后）**：
  - `pnpm check`：通过（0 错误）。
  - `node --test --test-reporter=dot test/dex-accounts.test.ts test/dex-hyperliquid.test.ts test/dex-keys.test.ts test/dex-lighter-signer.test.ts test/dex-live.test.ts test/dex-livekeys.test.ts test/dex-orders.test.ts test/dex-service.test.ts test/varlighter-local.test.ts test/varlighter-paper-commit.test.ts test/varlighter.test.ts web/test/varlighter-form.test.mjs`：12 个测试文件全部通过（其中 `dex-service.test.ts` 中 3 条 Linux/Unix 专项用例在 Windows 上按预期跳过）。
  - `pnpm build:web`：通过（600ms，无告警）。
- **已运行（前序阶段）**：
  - 浏览器验收（`scripts/dev-varlighter.ts` 替身后端，`1280×800` 与 `390×844`）：分别在 `v0.107.0` 变基后以及第 1 轮前端修复后完成两轮实看，确认 `<h1>` 新壳层与 390px 零横向溢出、`USD`/`USDG`/`USDC` 纵轴刻度无裁切、卡片盈亏着色、未授权状态文案及零 JS/CSP 报错（最终 P2 `historyAt === null` 空态与 `right: 104` 边距由单测与 TypeScript/Vite 构建覆盖，未再单开浏览器截图）。
- **未运行 / 平台与环境说明**：
  - Windows 本机未跑全仓其余模块 `pnpm test`；另有 `test/any-signal.test.ts`（L152 Windows 反斜杠路径格式）与 `test/read-token.test.ts`（L247 Windows 文件权限位 `0666` vs `0600`）受本机 Windows 基线限制无法直接作为 Linux 断言通过依据（本分支均未改动对应实现），完整 Linux 测试与分片由推送后的 `ci.yml` 执行。
  - 真实 Lighter 主网 / RH / Entropy 历史接口未在本地实连（本机无真实资金凭据）；待实测项（`taker_fee`/`maker_fee` 非零单位、`/api/v1/pnl` 时间戳与当日口径、`/api/v1/positionFunding` 正负号、60 次/分限流余量及高频 `io:` 截断表现）已完整登记在 [docs/live-results.md](../live-results.md)。
