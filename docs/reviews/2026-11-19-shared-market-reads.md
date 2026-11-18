# 公开行情重复读取合并审查

2026-11-19，R2（公开行情读取的合并与短时缓存；不改下单、预览复核和发送前检查的读取方式）。范围是 v0.67.1 之后的 main（`7784230`）之上的一批改动。回退版本为 v0.67.1，配置和数据不用改。

| 部分 | 文件 | 改动 |
| --- | --- | --- |
| 执行器 Binance 合约规则 | `src/live/binance.ts` | 一次 `exchangeInfo` 应答写入全部可读合约的规则（有效期仍为 60 秒），同时到达的读取合并为一次 |
| 资产账本 | `src/asset/sources/shared-reads.ts`（新）、`src/asset/{sync,store}.ts`、`src/asset/sources/{quotes,gate,hyperliquid,variational}.ts` | 一轮同步内 CoinGecko、Coinbase 汇率、Bybit 现货价同一地址只读一次，最多保留 30 秒；三个数据源改用同一个 CoinGecko 地址 |
| 行情服务 | `src/monitor/shared-reads.ts`（新）、`src/monitor/{market-readers,exchanges}.ts`、`src/market/monitor-data.ts` | 原油卡片与交易所对比共用 Binance 资金费周期表和 xyz 合约上下文；采集器有同一次推送的标记价与资金费时不再读 `premiumIndex` |
| CrossEx | `src/crossex/display-depth.ts`（新）、`src/vendor/crossex/{market.mjs,clients.d.mts}`、`src/service/crossex.ts` | 开仓容量面板与下单终端共用深度读取，最多复用 1 秒 |

测试：`test/live-binance.test.ts`、`test/asset-shared-reads.test.ts`、`test/monitor-shared-reads.test.ts`、`test/crossex-display-depth.test.ts`，以及三个资产数据源测试里更新后的地址。文档：`docs/{monitor,oil,asset,crossex,executor}.md`。

## 有意没有合并的读取

- Ondo：奖励采集每分钟只开 10 秒订阅是有意的流量控制，挂单引擎的最优价订阅有意独立；市场目录引擎 60 秒、奖励 15 分钟各读一次。合并的收益很小，风险在实盘挂单路径上，不做。
- 交易所对比的 Bybit、OKX、Bitget、Gate、Lighter 行：解析依赖各所合约元数据，采集器推送不带这些字段。
- 采集器发现合约时的 `fundingInfo` 与 `exchangeInfo`、海力士结算资金费历史、合约指标读取器、Lighter 与 Gate 合约目录：各有自己的缓存与失败处理，重复频率是分钟级。
- Anthropic 卡片不改用采集器数据：是否有等价的指数价和两腿同步上下文没有核实。
- 资产账本持仓读取的 Binance 合约目录、Aster `exchangeInfo` 不与执行器共用：不同进程、不同解析和有效期。
- 原油、海力士自动开平仓的盘口读取（已经共用采集器推送，预览复核与发送前检查按 L100 自读）不动。

## 独立审查

两位独立只读审查者各看一半差异（执行器与资产账本；行情服务与 CrossEx），只给差异范围、[审查标准](../code-review.md) 和核查重点。两份结论都是没有 P0、P1、P2。

已核实的要点：签名请求和带凭据的请求不会进入资产账本的共用层（三条地址规则都锚定首尾，只接受不带请求体、除 `Accept` 外没有请求头的 GET）；Binance 规则缓存按合约名存取，规则不完整的合约不缓存，有效期不比原来长；采集器的标记价、资金费率、下次结算时刻与 `premiumIndex` 字段单位和含义相同，两条腿不会一条用推送一条用 REST；监控共用读取的结果只到卡片、对比表和告警，不进入下单；`createMarket` 里只有 `openCapacityContext` 使用共用的深度读取器，预览、复核、平仓各自读取；共用的盘口保留真实来源时间，不会被调用方就地修改。

| 问题 | 处理 |
| --- | --- |
| P3，资产账本的余额同步改用包装后的读取函数后，Hyperliquid 的市场与币名缓存不再和持仓读取共用 | 已修：`createAssetStore` 只建一个共用层，余额同步和持仓服务都经过它（持仓的请求不在共用清单内，照原样发出） |
| P3，Binance 合约目录被限流时，等同一次读取的调用方会一个接一个重读 | 已修：只有发起方被自己的取消信号中止时，其余调用方才自己重读；交易所拒绝直接返回给所有等待者。补了测试 |
| P3，Anthropic 卡片的 xyz 读取改走共用后不再响应调用方自己的取消 | 已修：调用方的取消只结束它自己的等待 |
| P3，`prepareCrossex` 推导容量读取器的默认值与 `createMarket` 不完全一致（显式注入 `loadDepth` 时不同，现有调用方没有这样用） | 已修：照搬同一条规则 |
| P3，资产共用读取的 12 秒超时从第一个调用方开始计时，后加入的调用方可能提前超时 | 不改：后果是提前走各数据源已有的 Coinbase 回退 |
| P3，共用层在应答超过 2 MB 时报的错，调用方显示为“连接超时”而不是“超过上限” | 不改：只影响诊断文案，这三类应答远小于 2 MB |
| P3，Coinbase 回退价的“获取时间”最多比实际晚 30 秒 | 不改：只是时间标签，新鲜度阈值是 15 分钟 |
| P3，测试缺口：`prepareCrossex` 接线、行情服务停止时在途共用读取的中止、Hyperliquid 参与资产共用、超过 2 MB | 登记：接线由只在 Linux 运行的 `test/crossex-service.test.ts` 间接覆盖，其余没有补 |

四处修复之后没有再做独立审查，只重跑了定向测试和类型检查。

## 验证范围

已运行（Windows 原生）：后端与页面类型检查；修复后的定向测试 `test/live-binance.test.ts`、`test/asset-shared-reads.test.ts`、`test/asset-sources-*.test.ts`、`test/monitor-shared-reads.test.ts`、`test/market-monitor.test.ts`、`test/monitor-exchanges.test.ts`、`test/crossex-display-depth.test.ts`、`test/venue-feeds.test.ts`、`test/crossex/{open-capacity,terminal-market,live-market}.test.mjs` 共 175 项，174 通过、1 项按平台跳过、0 失败。

未运行：全套 `pnpm test`（在 Windows 上运行 40 分钟后停在某个用例没有进展，已中止；由发布门禁的 Linux CI 运行）；浏览器验收（没有改页面）；真实 Binance、Hyperliquid、CoinGecko、Coinbase、Bybit 和 Gate CrossEx 接口，以上检查都用替身；`test/crossex-service.test.ts` 的实盘模式用例和 `test/asset-sync.test.ts` 在 Windows 上不能运行，由发布门禁的 Linux CI 覆盖。

待确认：服务器上开启合约监控后，原油卡片和海力士对比行实际改用推送的比例（取决于 Binance 标记价推送是否每次都带齐资金费）。
