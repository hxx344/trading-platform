# 2026-11-27 DEX 价差：Entropy 默认交易成本 0.2 bps 与返佣实测对账采集（v0.111.0）

- 范围：相对基线 `63d07d4`（`v0.110.1`，已合入 `v0.107.0` 全站视觉升级、`v0.108.0` 账户资产页签、`v0.108.1` 统一账户余额读取、`v0.109.0` Lighter 300ms 延迟模拟、`v0.110.0`/`v0.110.1` DEX 账号去重并入资产总计）的 17 个修改文件、2 个新增文件（`src/varlighter/entropy-cost.ts`、`test/dex-entropy-cost.test.ts`）及本审查记录。
- 等级：R3（`varlighter.sqlite` 新增三张表、`DEFAULT_GLOBAL.entropyFeeBps` 默认值与老库一次性迁移、`live.ts` 实盘发单/成交关联采集）。
- 审查方式：作者自审 + 四次独立只读 R3 审查子代理（含变基前后）：
  1. 首轮独立审查（`bd6a5cef`）：0 P0、2 P1、3 P2、6 P3，全部修复。
  2. 二轮独立复审（`90b4c226`）：发现 1 项增量重叠窗跨轮活锁 `[P1]`、1 项手动超时/停服竞争 `[P2]` 与 2 项 `[P3]`，全部修复并补充回归单测，同时把测试样本地址替换为占位地址 `0x2222...2222`。
  3. 三轮独立终审（`2c4e7d12`）：确认无剩余 P0/P1/P2 问题，记录 1 项不阻塞合并的 `[P3]` JSON 校验加固建议。
  4. 变基至 `7276b6d`（`v0.109.0`）后独立合并复核（`ce0c375f`）：确认两批变更无遗漏/覆盖/遮蔽冲突，无剩余 P0/P1/P2 问题；随后顺延变基至 `63d07d4`（`v0.110.1`），代码文件零冲突自动合入。
- 回滚版本：`v0.110.1`。新增表（`entropy_fills`、`entropy_fee_snapshots`、`entropy_order_links`）与状态键（`entropy_fee_default_02`、`entropy_cost_sync`）增量兼容，直接回退即可；如需恢复按目录原始费率，在页面清空「Entropy 手续费（基点）」保存。

## 改动

1. **策略默认成本与总览含费口径**（`strategy.ts`、`engine.ts`、`views.ts`、`VarLighterPage.tsx`、`VarLighterDetail.tsx`）：`DEFAULT_GLOBAL.entropyFeeBps` 默认改为 `0.2`；老库仅在尚未记录 `entropy_fee_default_02` 且当前值为 `null` 时一次性升为 `0.2`。总览 `StateRow` 新增两腿往返手续费 `feeCost` 与含费总成本 `totalCost`，明确区分 `含费 x` / `缺盘口` / `手续费未知`；策略与分时段统计维持纯盘口口径，不重复扣费。
2. **Entropy 真实成交与 HYPE 价格采集**（`model.ts`、`store.ts`、`entropy-cost.ts`、`live.ts`、`engine.ts`、`host.ts`）：通过 Hyperliquid 公开 `info` 接口（`userFillsByTime`、`userFees`、`allMids`、`candleSnapshot` 1h `HYPE`）按地址小写 SHA-256 前 16 位 `account_hash` 隔离落库 `io:*` 真实成交，关联平台实盘 `cloid`；通过 `pendingQueue` 与前缀边界跨轮推进满页二分（L093），通过 `manualWaitMs = 7_000` 避开 10 秒 IPC 超时断链（L204），停服等待 `entropyCost.idle()`。
3. **实盘准备页对账与反算工具**（`VarLighterLive.tsx`、`varlighter-form.ts`）：新增「Entropy 实际成本与返佣核对」面板（`14 天 / 30 天 / 全部`、立即同步、导出 JSON、实扣与假设缺口汇总、`rebateAudit` 同口径 `usdcNotionalUsd` 反算器、隐藏全部 40 位钱包地址）。

## 审查结论

四轮审查均已闭环，合并后最终结论：**0 个 P0，0 个 P1，0 个 P2**。

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 首轮 | P1 | `POST entropy-cost/sync` 可能撞到 `DEX_READ_TIMEOUT_MS = 10_000` 触发 `DexOutcomeUnknown` 断链 | 已修：不改动执行器/IPC 文件，`sync(true)` 设 `manualWaitMs = 7_000` 超时先返回 `pending: true` 并后台完成，`engine.ts` 停服等 `entropyCost.idle()` |
| 首轮 | P1 | 满页二分 `MAX_FILL_REQUESTS = 5` 未持久化未完前缀窗口 | 已修（二轮继续闭环见下） |
| 二轮 | P1 | `cursorMs > 0` 跨 60s 重叠窗多轮拆分丢弃 `probeStartMs`/`probeEndMs` 导致活锁 | 已修：在 `entropy_cost_sync` 持久化有界二分队列 `pendingQueue`（含尾部折叠与异常/坏行 `queue.unshift`）与 `probeStartMs`/`probeEndMs`；已补 `cursorMs > 0` 多轮重叠窗单测 |
| 首轮 | P2 | `userFees` 单路失败与 `allMids` 成功同轮覆盖旧费率快照为 `null` | 已修：仅单路失败时沿用 `prevSnap` 有效费率字段与 HYPE 价 |
| 首轮 | P2 | 「领币时 HYPE 单价」受控 `useEffect` 在用户清空后立即回填 | 已修：加 `priceTouched` ref 保护 |
| 首轮 | P2 | `assumedFeeBps` 为空时外部成交按 0 记账，且返佣分母混入非 USDC 成交 | 已修：回退 `fill.catalogFeeBps`，新增 `EntropyCostSummary.usdcNotionalUsd` |
| 二轮 | P2 | `sync(true)` 返回 `pending` 后后台抛错未捕获拒绝，且 `stopSignal.aborted` 期间仍可新建 `runSync` | 已修：在 `sync()` 入口拦截 `stopSignal.aborted` 并给 `task` 挂接 `.catch(...)` 脱敏收尾 |
| 首轮/二轮 | P3 | 重叠窗补写 `hype_price_usd`、`cloid` 小写、`userAddRate` 负费率、`candleSnapshot` 守卫、总览缺盘口文案、测试 `fees-fail` / `pending` 文案与 `ApiError` | 已修，全数补充回归单测 |
| 三轮 | P3 | `readSync` 过滤损坏 `pendingQueue` 元组可更严格（仅外部篡改 JSON 时触发） | 登记未改，不阻塞 |
| 变基复核 | P3 | `engine.ts:99` JSDoc 注释版本号写为 `v0.107.0`；迁移写入与状态标记分两步 | 登记未改，不阻塞 |

## 已运行

- `npx tsc -p tsconfig.json && npx tsc -p web/tsconfig.json`：通过。
- `npx vite build --config web/vite.config.ts`：通过（791ms）。
- 定向单元测试（`node --test --test-reporter=dot test/dex-entropy-cost.test.ts test/dex-accounts.test.ts test/dex-keys.test.ts test/varlighter.test.ts test/varlighter-paper-commit.test.ts test/dex-live.test.ts test/dex-orders.test.ts test/dex-service.test.ts test/asset-dex-spread.test.ts web/test/varlighter-form.test.mjs web/test/app-dialog.test.mjs`）：177 项全部通过。
- 执行服务组件摘要校验（`node deploy/component-digests.mjs` 对比 `de5334e` / `63d07d4`）：`.executor-sha256` 均为 `242315e9b9592fa0755298385860db13d3b67a5e7cfb3483022b7c88b48b82a6`（完全一致）。
- 浏览器走查（`scripts/dev-varlighter.ts --port 4733`，1280×800 与 390×844）：核对合并后总览（5 页签、`含费 0.4` / `缺盘口（含费 0.4）`）、账户资产页（`#/varlighter/accounts`）、实盘准备页「Entropy 实际成本与返佣核对」（清空 HYPE 单价保持空值、实时计算、立即同步 HTTP 200），0 控制台报错、0 横向溢出、0 暴露 40 位以太坊地址。
- 四轮独立只读 R3 审查通过。

## 未运行

- 本地未跑完其余非 DEX 测试与 Windows 跳过的 POSIX/systemd 安装验收（由推送后的 Ubuntu CI 完整分片与 systemd 套件验证）。
- 尚未在真实账户下单或等待下次真实双周 HYPE 返佣发放时做线上对账实测。
