# Monitor 模块：实施方案 v1.0

2026-11-13 用户决定：工作台原有的各模块都要在本仓库里具备（不在工作台上替换）。Monitor（行情监控）按下面的批次接入，只在 `config.json` 配置了 `monitor` 时启用；未配置时服务行为不变。

对照的工作台代码：`modules/monitor`（工作台提交 `7745181` 时的内容）。工作台 Monitor 的功能编号 M01–M14 沿用。

## 批次

| 批次 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| M-1 | Anthropic 价差（M03）：Binance、Hyperliquid（xyz:ANT、io:ANTH）、Lighter RH 四条腿的报价与 15 分钟 K 线，每股口径溢价；只读公开接口，无凭据、无告警 | R2 | 进行中 |
| M-2 | 原油价差与海力士行情（M01、M02），Var 腿先降级为“未接入” | R2 | 未开始 |
| M-3 | 告警规则、飞书通知、监控开关、Var 会话 token（M09–M12） | R3 | 未开始 |
| M-4 | 永续全市场报价（M04：11 家交易所公共 WS、SSE 增量） | R2 | 未开始 |
| M-5 | 依赖 M04 的页面（M05–M08） | R2 | 未开始 |
| M-6 | 其余（M13、M14；M14 原靠 iframe 桥接宿主，需重新设计） | 待定 | 未开始 |

## M-1：Anthropic 价差

**配置**

```json
"monitor": { "anthropic": {} }
```

- `monitor.anthropic` 可带 `shares: { "outstanding": 12.7, "diluted": 16.7 }`（十亿股）；不写用这两个默认值。校验与工作台一致：`1 ≤ outstanding ≤ diluted ≤ 100`。
- 配置了 `monitor`（或 `oil`、`asset`）时 `pairs` 可以省略。
- 不需要任何密钥。

**代码**

- `src/vendor/anthropic-market.mjs`（附 `.d.mts`）：复制自工作台 `modules/monitor/modules/anthropic/market.mjs`（提交 `35ebb94`），两个请求函数 `requestBinance`、`requestInfo` 从 `modules/monitor/modules/oil/binance.mjs`（`8470785`）、`hyperliquid.mjs`（`c534894`）内联进来，其余不改。每股换算、合约发现、分页、限流冷却都在这个文件里。
- `src/monitor/store.ts`：独立库文件 `monitor.sqlite`（数据目录内，自带建表、WAL），不给主库加迁移。表：`anthropic_candles(time, binance, xyz, io, rh)` 每个 15 分钟时段一行；`monitor_state(key, json, updated_at)` 存最近一次成功的报价、K 线轮的取数时刻与各腿错误。
- `src/monitor/anthropic.ts`：采集与读取。启动时从库里读回 K 线与上次报价（标为快照）；之后两条循环各自跑。
- `src/service/monitor.ts`、`src/service/monitor-config.ts`：配置解析、接线（同 `oil.ts` 的做法）。

**采集规则**（与工作台相同，数值写在 vendor 文件里）

| 项 | 间隔 | 单次请求超时 | 失败行为 |
| --- | --- | --- | --- |
| 报价 | 10 秒一轮，四条腿并发，每腿一个请求 | 10 秒 | 失败的腿记原因，其余腿照常；四腿全失败时本轮作废，保留上次报价并标为快照；不在轮内重试，下一轮再读 |
| K 线 | 60 秒一轮，每条腿从自己最后一个已保存收盘价往前 1 天处续读 | 15 秒 | 失败的腿保留已保存的收盘价并记原因；四腿全失败时本轮作废 |

- 限流：Binance 返回 429 后 60 秒、418 后 120 秒内不再发 Binance 请求（报价与 K 线共用）；Lighter RH 返回 429、405 或代码 23000 后 60 秒内不发请求，K 线每轮最多 4 页（每页 500 根）。Binance 行情请求每分钟约 6 次报价加 1–2 次 K 线，占公共行情额度很小，与 ASTER 的请求预算无关（不同交易所）；与原油模块共用同一出口 IP 的 Binance 额度，原油读盘口每 3 秒 4 个请求，合计远低于每分钟 2400 权重。
- 同一循环的两轮不重叠：上一轮结束后才计时下一轮。
- 首次采集从 50 天前开始（Hyperliquid 只给最近约 5000 根）；保存最多 400 天，超出的行在每轮写入时删除。
- 响应大小：Lighter RH 单个响应超过 2 MiB 拒绝读取。

**数据时效**

- 报价带 `fetchedAt`（本机成功取到的时刻）。公开接口不给标记价的来源时间，所以新鲜度只按本机接收时刻判断：最近一次成功的报价距今超过 35 秒，或是启动时从库里读回的，接口标 `status: "snapshot"`，页面按陈旧显示并写明时刻；否则 `live`。
- K 线只存已收盘的时段，缺失的腿为空，页面断线不补。

**接口**（都要登录，只读）

- `GET /api/monitor/state`：`{ markets: ["anthropic"], anthropic: { shares } }`；没配置 `monitor` 时 404（页面据此不显示入口）。
- `GET /api/monitor/anthropic/quote`：工作台同名接口的内容（四条腿的标记价、资金费、各腿错误、`fetchedAt`）加 `status`、`staleAfterMs`、`lastAttemptAt`、`lastError`；还没有任何报价时 503 `not_ready`。
- `GET /api/monitor/anthropic/candles?days=<1–400>`：最近若干天的 K 线快照，带完整历史的覆盖范围（`coverage`）；不带 `days` 返回全部；参数非法 400；还没有数据时 503 `not_ready`。

**页面**

- 地址 `#/monitor`，标签“行情监控”，只在 `/api/monitor/state` 有应答时显示。
- 对照工作台 `modules/monitor/app/anthropic-panel.tsx`（`35ebb94`）与 `spread-chart.tsx`（`4be9aa4`）：对比合约切换（xyz:ANT / io:ANTH / Lighter RH）、状态行、股数说明、四格读数（当前溢价、两边每股价、区间平均）、走势图（溢价率 / 每股价差 / 每股价格三个标签与时间范围）、近期观察表、如何比较、数据来源与覆盖范围。文案沿用工作台。
- 走势图用本仓库的 `svg-plot.tsx` 画。本批不做：成交标记（依赖资产账本的成交，随 Asset 后续批次补）；股数从交易中心同步（本服务用配置里的股数）。
- 样式：`web/src/monitor.css` 复制自工作台 `modules/monitor/app/globals.css`（`77f3cf2`）里这个页面用到的规则，每条选择器前加 `.monitor-desk ` 限定范围。

**测试**

- 工作台 `modules/monitor/tests/anthropic-market.test.mjs` 里只依赖行情模块的用例原样搬到 `test/monitor-anthropic.test.ts`（每股换算、腿失败、分页、限流冷却、响应大小、旧快照兼容）。
- 新增：存储的写入、读回与保留期；采集循环的快照标记；配置解析；三个接口的鉴权、404、503 与参数校验；页面换算函数与 vendor 文件结果一致。

**回滚**：`sudo bash install.sh --version v0.10.0`，回退前先删掉 `config.json` 里的 `monitor`（旧版本不认识这个键，配置检查会不通过）。主库不变；`monitor.sqlite` 留在数据目录里，旧版本不读它，删掉只丢 K 线历史（可从交易所重新回补最近约 50 天）。
