# DEX 价差账号去重并入资产总计代码审查记录（2026-11-27）

## 批次与定级

- **范围**（相对于 `origin/main` `7276b6d` / `v0.109.0`）：
  - **DEX 只读 IPC 与引擎暴露**：`src/varlighter/engine.ts`、`src/dex/protocol.ts`、`src/dex/server.ts`、`src/dex/main.ts`、`src/dex/ipc.ts`、`src/service/main.ts`（新增 `GET /dex/v1/accounts` 只读套接字端点，返回 `{ accounts: { lighter?, rh?, entropy? }, problem }`；与 `accountSource()` 同源，`live-keys.json` 优先于 `keys.env`，绝不返回私钥或 `apiKeyIndex`；执行面仅通过 `dex.client.accounts()` 读取，仍不导入 `src/varlighter/**`）。
  - **单账户只读与跨所去重聚合**：`src/asset/sources/rh-lighter.ts`、`src/asset/sources/lighter-account.ts`、`src/asset/dex-spread.ts`、`src/asset/types.ts`、`src/asset/views.ts`、`src/asset/sync.ts`、`src/asset/store.ts`、`src/asset/source-import.ts`（`Asset['mode']` 新增 `'dex-spread'`；Lighter 主网按 `total_asset_value` + 共享 USDC/USD 汇率及独立 60 秒冷却计价；Entropy 对 `hyperliquid` 去重；Lighter RH 通过 `indexHashes` 与 `l1Address` 双重去重并共享 `rhLighterCooldown` 60 秒冷却；`sync.connect` 同事务原子剔除与 `sync.refresh` 写前密文复核防双算；`settings['dex-spread-accounts']` 与 `settings['dex-dedup-identities']` 仅存域前缀 SHA-256 指纹，全链路零明文持久化；`importPlan` 保留 `syncedDex`）。
  - **前端展示、演示、测试与文档**：`web/src/asset-connection-form.ts`（排除 `'dex-spread'`）、`web/src/asset-format.ts`、`web/src/asset.css`、`scripts/asset-demo.ts`（`--with-dex-spread`）、`test/asset-dex-spread.test.ts`、`test/asset-sources-lighter-account.test.ts`、`test/dex-service.test.ts`、`test/asset-format.test.ts`、`web/test/asset-connection-form.test.mjs`、`docs/asset.md`、`docs/dexspread.md`（第 11.2、16 节）、`docs/frontend.md`、`docs/live-results.md`。
- **风险定级**：**R2**
  - 不修改 SQLite 表结构、`config.json`、`install.sh` 或部署单元；不将 DEX 价差纳入「交易所连接」卡片、持仓页 `/api/asset/positions` 或成交页 `/api/asset/fills`；不经执行面接触 DEX 实盘私钥；涉及资产总计计算、跨场所去重校验及 DEX 服务只读 IPC，按 R2 完成独立审查。
- **回滚基线**：`v0.109.0`（`7276b6d`，库结构与配置格式未变，回退旧版本只需停服务换版，旧版忽略新增 `settings` 键）。

## 独立审查摘要

由独立只读审查子代理（`research`）依 [docs/code-review.md](../code-review.md) 与 [LESSONS.md](../../LESSONS.md) 按 D1–D5 完成全量 diff 及上下文审查：

- **总体结论**：**P0 = 0，P1 = 0**，**P2 = 2**，**P3 = 2**。
- **已核查无问题路径（Verified clean）**：
  - 执行面隔离与只读 IPC（`deploy/component-digests.mjs` 打包边界、拒绝未知字段/`apiKeyIndex`/私钥）；
  - 去重完整性、断开保留旧值期间防双算、更换钱包后旧 `indexHashes` 失效、`sync.connect` 同事务原子剔除与密文损坏保守拒绝；
  - SQLite / 明细 / 错误信息 / 日志 / HTTP 接口全链路零明文地址与账号编号残留；
  - `rhLighterCooldown` 与 `rhRoundPromise` 并发及超时/限流边界、`lighter-account.ts` 字节上限与手动重定向拦截。
- **审查发现与整改处置（全部已闭环）**：
  1. `[P2] D4`：补充 `test/asset-sources-lighter-account.test.ts` 覆盖 Lighter 主网独立 60 秒冷却与恢复（HTTP 429 / `code === 23000`，且不影响 RH 冷却）、CoinGecko + Coinbase 双汇率源失败、以及 HTTP 400 非 `21100`/非 JSON 回退测试；补充 `test/asset-dex-spread.test.ts` 覆盖 `rh-lighter` 断开保留旧值去重、`rh-lighter` 密文损坏保守拒绝，以及刷新拉取期间连接密文并发变动放弃陈旧写入的竞态测试。
  2. `[P2] D5`：修正 `docs/asset.md` 与 `docs/live-results.md` 对 Lighter 主网仅读取 `accounts[0].total_asset_value`（不回退读取实盘保证金字段 `collateral`）的表述，并在 `docs/asset.md` 补全新账号首次同步失败或密文损坏触发的「部分账号估值缺失」状态说明。
  3. `[P3] D5/D7`：将 `src/asset/dex-spread.ts` 头部注释 `salted SHA-256` 改为准确的 `domain-tagged SHA-256`。
  4. `[P3] D2`：放宽 `src/asset/sync.ts` 中 `safeProblem` 正则对 `0x` 长十六进制串的词边界限制。

## 验证汇总

- **已运行（变基至 `7276b6d` 并完成全部修改后）**：
  - `pnpm check`（`tsc -p tsconfig.json && tsc -p web/tsconfig.json`）：通过（0 错误）。
  - `node deploy/component-digests.mjs .`：通过（校验后已清理生成的 `.control-sha256`/`.executor-sha256`/`.market-sha256`/`.dex-sha256`）。
  - `node --test --test-reporter=dot test/asset-dex-spread.test.ts test/asset-sources-lighter-account.test.ts test/dex-service.test.ts test/dex-livekeys.test.ts test/varlighter.test.ts test/varlighter-paper-commit.test.ts`：全部通过（其中 `dex-service.test.ts` 3 条 Linux/Unix 专项用例及 `asset-dex-spread.test.ts` 的 `apply: true` 备份路径在 Windows 上按预期跳过）。
- **已复用（基于未冲突且 `02c1ed8..7276b6d` 零触及的资产/前端代码）**：
  - `pnpm build:web`、`test/dex-keys.test.ts`、`test/dex-accounts.test.ts`、`test/asset-sync.test.ts`、`test/asset-store.test.ts`、`test/asset-values.test.ts`、`test/asset-format.test.ts`、`test/asset-http.test.ts`、`test/asset-sources-rh-lighter.test.ts`、`test/asset-sources-hyperliquid.test.ts`、`test/asset-daily-changes.test.ts`、`test/boundaries.test.ts`、`web/test/asset-connection-form.test.mjs` 于 `02c1ed8` 变基后全部通过。
  - 浏览器双宽度复验：`scripts/asset-demo.ts --with-dex-spread` 在 `v0.107.0+` 新版暗色壳层、1280×800 与 390×844 双宽度验证通过，见 [docs/frontend.md](../frontend.md)。
- **未运行 / 平台与环境说明**：
  - Windows 本机未运行全仓 `pnpm test`（其中原表备份 `fsyncPath(directory, 'r')` 及 POSIX 文件权限相关用例依赖 Linux），完整全仓与部署测试由推送后的 GitHub Actions `ci.yml` 执行。
  - 真实 Lighter 主网、Lighter RH 与 Entropy 账户接口未在本机实连，待实测确认项见 [docs/live-results.md](../live-results.md)。
