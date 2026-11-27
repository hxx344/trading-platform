# Entropy 统一账户余额读取代码审查记录（2026-11-27）

## 批次与定级

- **范围**：提交 `9045126`、`53177fb`、`120493d`（相对 `origin/main` `d533f6d` / `v0.108.0`）。
- **涉及文件**：`src/varlighter/accounts.ts`、`test/dex-keys.test.ts`、`test/dex-accounts.test.ts`、`scripts/dev-varlighter.ts`、`docs/dexspread.md`（第 12.13、15 节）、`docs/live-results.md`。
- **风险等级**：**R3**（`src/varlighter/accounts.ts` 直接供给实盘开仓前余额校验 `src/varlighter/live.ts:blocker()`、订单结果不明时现读账户核对 `readAccount()`，以及实盘准备页与账户资产页/快照落库）。
- **审查方式**：作者自审，加两轮上下文隔离的独立只读审查子代理（第 1 轮审 `d533f6d..9045126`，第 2 轮开新只读子代理复审修复增量 `9045126..53177fb`）。
- **回滚版本**：`v0.108.0`（`d533f6d`）。库结构、配置格式、凭据文件、前端组件与部署安装脚本均未改动，直接回退即可。

## 首轮独立 R3 审查结论（`d533f6d..9045126`）

- **结论统计**：**P0 = 0，P1 = 0，P2 = 3，P3 = 1，待核实 = 1**。
- **已核实无问题的边界**：
  - **D1**：`default` / `disabled` 模式沿用 `parseEntropyAccount(state)` 与 `v0.108.0` 一致；`unifiedAccount` 模式下 `collateral`、`equity`、`available` 取自 `spotClearinghouseState` 的 `USDC`（`token === 0`），不与 `io` 盘 `accountValue` 叠加导致重复计算；`total < 0 || hold < 0` 拒绝，`available` 经 `Math.max(0, total - hold)` 钳制不为负；`token === 0` 在 200 条资产截断前校验。
  - **D2**：`fetchAccount` 每次现查 `userAbstraction`，不缓存模式；`engine.ts:refreshAccounts` 保留 L049 发起时刻与每场所序号/L089 失效保护。
  - **D3**：`fetchAccount` 对三条请求透传同一调用方 `signal`（不使用 `AbortSignal.any`，符合 L206）；`portfolioMargin`、`dexAbstraction`、未知或非字符串模式默认拒绝，不回落返回 `0.00`。
  - **D4**：钱包地址仅放 POST 请求体，不进 URL；`parseEntropyMode` 报错仅允许 `[a-zA-Z0-9_-]{1,32}`，不带出地址；测试与文档使用合成地址或脱敏描述，无凭据/地址泄露。
  - **D5**：检索全仓确认 `src/asset/sources/hyperliquid.ts` 已自行处理 `userAbstraction`，`engine.ts` 是 `fetchAccount` 唯一调用方，`scripts/dev-varlighter.ts` 同步更新为 `unifiedAccount` 替身；`docs/dexspread.md` 第 15 节写明 R3 四要素与回滚版本 `v0.108.0`。
- **问题与处置**：

| 级别 | 位置 | 问题 | 处理 |
| --- | --- | --- | --- |
| 待核实 | `src/varlighter/accounts.ts`、`src/varlighter/live.ts` | `unifiedAccount` 在存在 `io` 盘活跃持仓（尤其逐仓或明显浮盈亏）时，`spotClearinghouseState` 的 `total`、`total - hold`、`tokenToAvailableAfterMaintenance` 与 `io` 盘 `accountValue`/`unrealizedPnl` 的真实对账口径尚未经真实开仓实测 | 保留在 `docs/live-results.md`「待实测」与 `docs/dexspread.md` 第 15 节；在主网实盘持仓核对后再决定是否调整 |
| P2 | `docs/dexspread.md`、`docs/live-results.md` | 审查记录文件尚未入库；`docs/live-results.md` 将 `unifiedAccount` 整项标为已修复而未保留有持仓口径待实测 | 已补齐本审查记录文件；已在 `53177fb` 更新 `docs/live-results.md` 与 `docs/dexspread.md` 第 15 节保留持仓口径待实测 |
| P2 | `src/varlighter/accounts.ts`、`VarLighterAccounts.tsx` | `parseEntropyUnifiedBalance` 未拦截 `token !== 0` 却名为 `USDC` 的条目（可造成现货列表与余额矛盾或前端 `key={asset.symbol}` 冲突），且非 USDC 资产未拦截负值 | 已在 `53177fb` 修复：拦截所有非 `token === 0` 且 `symbol === 'USDC'` 条目，拦截非 USDC 资产负 `total`/`hold`，并在 `test/dex-keys.test.ts` 补齐单测 |
| P2 | `test/dex-keys.test.ts` | 未验证 `init.signal` 透传到全部三次请求，也未覆盖 `spotClearinghouseState` 挂起时 `abort()` 中止路径 | 已在 `53177fb` 与 `120493d` 补充信号透传引用校验与 `abort()` 中止单测 |
| P3 | `src/varlighter/accounts.ts` | `fetchAccount` 先解析 `clearinghouseState` 后判 `userAbstraction` 模式，若非支持模式下 `clearinghouseState` 结构不同会掩盖明确的模式拒绝提示 | 已在 `53177fb` 调整为先 `parseEntropyMode(mode)` 再 `parseEntropyAccount(state)`，并在 `test/dex-keys.test.ts` 补齐回归用例 |

## 第二轮独立只读复核结论（`9045126..53177fb`）

- **核实结果**：第一轮指出的全部 P2（代码/测试/文档待实测部分）与 P3 项均已完整修复，未发现放宽的测试断言或新增逻辑回退；**新增 P0 = 0，P1 = 0，P2 = 0**。
- **增量 P3 提示与收口**：
  - `[P3]` `test/dex-keys.test.ts` 原 `assert.deepEqual(signalsSeen, [signal, signal, signal])` 在 `node:assert/strict` 下只比较结构而不校验 `AbortSignal` 引用相等。已在 `120493d` 改为 `assert.equal(signalsSeen.length, 3); assert.ok(signalsSeen.every(seen => seen === signal))`，并重跑 `pnpm check` 与 `test/dex-keys.test.ts` 通过。

## 已运行

- 源码定型后（`53177fb`）：
  - `pnpm check`（`tsc -p tsconfig.json && tsc -p web/tsconfig.json`）：通过（0 错误）。
  - `pnpm build:web`：通过（`vite build`，560ms，0 错误）。
  - `node --test --test-reporter=dot test/dex-keys.test.ts test/dex-accounts.test.ts test/dex-live.test.ts test/varlighter.test.ts`：115 条全部通过（Windows 本机替身测试，含首轮审查者独立复跑与第二轮复核复跑）。
- 收口测试断言后（`120493d`，只改 `test/dex-keys.test.ts`）：
  - `pnpm check`：通过。
  - `node --test --test-reporter=dot test/dex-keys.test.ts`：10 条全部通过。
- 公开只读核实：主网 `api.hyperliquid.xyz/info` 实查无持仓 `unifiedAccount` 账户与多组带 `io` 盘持仓账户，确认无持仓时 `clearinghouseState(dex: 'io')` 返回 `0.0`，闲置与可用 USDC 位于 `spotClearinghouseState`（`token: 0`）；`meta(dex: 'io')` 返回 `collateralToken: 0`（USDC）。

## 未运行

- Windows 本机未运行全仓 `pnpm test` 及 `deploy/test-install.sh` / `deploy/test-platform-systemd.sh`；完整 Linux 测试分片与真实 systemd 验收由随后推送的 GitHub Actions 分支 CI（`ci.yml`）执行。
- 真实账户在 `unifiedAccount` 模式下带 `io` 盘活跃持仓与明显浮盈亏时的实盘余额核对与对账（无本机实盘凭据，已记入 `docs/live-results.md` 待实测）。
