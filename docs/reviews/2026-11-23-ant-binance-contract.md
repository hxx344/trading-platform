# 2026-11-23 ANT 价差：默认股数与 Binance 腿改读 ANTUSDT

- 范围：基于 v0.80.2 的一次提交，29 个文件（含本记录）。
  - 默认股数由 12.7 / 16.7 改为 13.116 / 17.68（十亿股）。
  - Binance 腿由已结算的 `ANTHROPICUSDT` 改读按股报价的 `ANTUSDT`：`src/vendor/anthropic-market.mjs`（附 `.d.mts`）、`src/monitor/anthropic.ts`（历史换算、合约标记、混合版本保护）、页面文字与外链、关联持仓与每日持仓归类、只读观察合约名、模拟执行器合约名。
  - 方案、影响面与回滚写在 `docs/monitor.md`「Binance 腿改读 ANTUSDT（v0.80.3）」。
- 等级：按 R3 处理（改写 `monitor.sqlite` 已有行；这些行是可从交易所重新回补的行情缓存，不涉及资金、凭据、下单与主库）。审查方式：作者自审，加一轮独立只读审查子代理（审 `git diff HEAD`，未给作者结论）。
- 回滚版本：v0.80.2（不需要改配置；回滚期间 Binance 腿的历史价差不正确，见文档）。

## 结论

P0、P1 为 0。P2 三条：两条已修，一条按文档登记。P3 五条全部登记在文档「没做」。

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 自测 | — | 口径变化后 7 条断言失败（每股换算、基础名匹配、旧三腿快照兼容） | 按新口径改写；旧三腿快照改为断言被拒绝 |
| 自测 | — | 首次用公开接口查询 `ANTUSDT` 得到空应答，误判合约不存在 | 用 `exchangeInfo` 重新核实：`ANTUSDT` 交易中，`ANTHROPICUSDT` 已结算 |
| 1 | P2 | 升级用例的时钟早于切换时刻，进度回退、切换后清空重读、整表重写没有集成测试覆盖 | 已修：新增「切换之后才升级」用例（时钟 2026-11-23，库里是旧口径加冻结结算价） |
| 1 | P2 | 混合版本保护只有一个方向：新行情服务 + 旧采集端时，旧采集端把每股价再除以流通股数并写库 | 不改代码（旧版本无法补救）；升级后切换时刻之后的行清空重读，自行恢复。文档已写明表现与恢复方式 |
| 1 | P2 | 基础名 `ANT` 对所有非 Hyperliquid 交易所生效，把此前有意排除的同名合约归入 ANT | 已修：`VENUE_ONLY_BASES` 把 `ANT` 限定在 Binance，资产账本与页面两处同表，测试覆盖 OKX / Bybit / Lighter RH 不归入 |
| 1 | P3 | 2026-11-17 09:00–10:30 UTC 的 Binance 空档每小时被缺口修复重问一次 | 登记，请求量可忽略 |
| 1 | P3 | 切换前旧历史里的 Binance 缺口此后补不回来 | 登记 |
| 1 | P3 | 启动摘要与导入面板仍显示“流通股”，该数已不参与换算 | 登记，文字未改 |
| 1 | P3 | 照旧示例写了 `shares: { 12.7, 16.7 }` 的部署不会拿到新默认值 | 登记，并写进更新说明 |
| 1 | P3 | 旧行情服务 + 新执行服务的几秒里 ANT 只读观察被拒 | 登记 |

已核实（独立审查）：
- 换算幂等：旧口径最低 1221，最高 2228 ÷ 13.116 ≈ 170，都在阈值 400 的正确一侧。首次升级、写库失败后重启、回滚到旧版本再升级、空库、有状态无行，结果都正确。
- 整表重写不丢行：内存来自 `store.candles()` 全量，保留期裁剪与写库 `cutoff` 相同，删除、写入、标记在同一个事务里。
- 覆盖进度回退后走尾部读取，约 600 根一页读完，不卡住，其余三条腿的进度不受影响。
- `binanceSymbol` 从 `fetchAnthropicQuote` / `fetchAnthropicCandleBatch` 经行情服务 IPC 到采集端不会被丢，两端都升级后 Binance 腿不会一直被拒。
- 浏览器 K 线缓存：旧合约名的缓存校验不过即删除并重新读取。
- `src`、`web`、`scripts`、`deploy` 里没有残留的 `ANTHROPICUSDT` 引用或“÷ 流通股数”的计算；服务端没有用 Anthropic 溢价的告警或概览。
- `VENUE_EXECUTION_SYMBOLS` 未动，ANT 仍不可下单。

未证实（审查子代理无法访问 Binance；作者 2026-11-23 用公开接口核实了前两项）：
- `ANTUSDT` 成交 K 线从 2026-11-17 10:30 UTC 起，旧合约 09:00 UTC 之后只重复冻结收盘价（作者已核实）。
- `ANTUSDT` 的 `exchangeInfo` 是否满足 `src/live/binance.ts` 的合约校验：未在真实账户上验证，解析失败只影响这一个只读合约。

## 已运行

- `pnpm check`、`pnpm build:web`：通过。
- 本机（Windows）按文件运行相关测试：`test/monitor.test.ts`、`monitor-anthropic`、`monitor-related`、`monitor-oil`、`monitor-web`、`import-form`、`asset-daily-changes`、`asset-positions-store`、`control`、`executor`、`http`、`import-modules`、`live-bybit`、`market-monitor`、`monitor-candle-cache`、`monitor-control`、`monitor-exchanges`、`monitor-funding`、`monitor-funding-history`、`monitor-goldoil`、`monitor-hynix`、`monitor-indicators`、`monitor-perpetual`、`monitor-shared-reads`。失败的只有 3 条本机限制用例（`monitor.test.ts` 两个「服务进程」用例与 `import-modules.test.ts` 的「资产账本写入」用例，数据目录 `fsync` 报 EPERM）。
- 浏览器：替身后端 `scripts/dev-monitor.ts`，1280 与 390 宽度下 Anthropic 页签：Binance 腿显示 `ANTUSDT` 与每股价，「如何比较」为 1 股 / 单位，无横向溢出，控制台只有替身后端未配置接口的 404。
- 独立审查子代理的临时探针：时钟 2026-11-23、库里是旧口径加冻结结算价时，直接升级与“先遇到旧行情服务再重启”两种情形都恢复正确。

## 未运行

- 全量 `pnpm test`、安装测试、真实 systemd 验收：本机是 Windows，由主线 CI 把关。
- 真实服务器上的升级：`monitor.sqlite` 的实际换算结果需升级后在页面与日志（“按 ANTUSDT 口径换算”一行）上确认。
