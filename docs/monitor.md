# Monitor 模块：实施方案 v1.0

2026-11-13 用户决定：工作台原有的各模块都要在本仓库里具备（不在工作台上替换）。Monitor（行情监控）按下面的批次接入，只在 `config.json` 配置了 `monitor` 时启用；未配置时服务行为不变。

对照的工作台代码：`modules/monitor`（工作台提交 `7745181` 时的内容）。工作台 Monitor 的功能编号 M01–M14 沿用。

## 当前状态（v0.38.0）

- 已发布：M-1（Anthropic 价差）随 v0.12.0；v0.15.0 起在设置页「从工作台导入」里启用。M-2a（原油价差）随 v0.20.0。M-2b（海力士溢价）随 v0.21.0。M-2c（多交易所对比）随 v0.23.0。M-2d（已结算资金费历史与多空资金费图）随 v0.24.0。M-2e（技术指标）随 v0.25.0。M-2d-3（对比表各交易所的结算历史）随 v0.27.0，M-2 完成。
- M-3a（原油与海力士阈值告警、飞书出站队列、页面告警面板与测试消息）随 v0.29.0；替身后端与替身机器人验证，未接真实飞书。
- M-3b（从工作台导入告警档位与行情告警机器人 `feishuMonitor`）随 v0.30.0；替身文件与替身机器人验证，未接真实工作台与飞书。
- M-3c（各市场的监控开关：关闭后停采集、停告警，保留配置与历史）随 v0.31.0；替身行情验证。
- M-3d-1（Var 行：公开行情与预测资金费、页面保存的会话 token 与认证标记价）随 v0.33.0；替身 Variational 验证，未接真实账户。
- M-3d-2（从工作台导入 Var token）随 v0.34.0；替身文件验证，未接真实工作台。M-3 完成。
- M-4a（合约价差采集器：11 家交易所永续合约公开盘口，SSE 增量，只在内存）随 v0.36.0；替身交易所验证，并在开发机上对真实交易所做过 20 秒冒烟（见 M-4a 实施记录）。页面与导入见下一条。
- M-4b（合约价差页面；从工作台导入时一并启用）随 v0.37.0；替身合约行情上浏览器走查（见 M-4b 实施记录）。
- M-5a（展开组合详情：按金额校验盘口、平仓收益测算；跨计价币排名；手动配对）随 v0.38.0；替身交易所验证（见 M-5a 实施记录）。
- M-5b1（市场指标：成交额与持仓量列；所需资本与 ROC；列选择；表头排序）随 v0.39.0；替身交易所验证（见 M-5b1 实施记录）。
- 未开始：M-5b2–M-5f、M-6（见下表与「M-5」节）。
- M-1 没做：成交标记、股数从交易中心同步、概览卡片与告警（均线 / 布林带 / Z-score 随 M-2e 补上）。

## 批次

| 批次 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| M-1 | Anthropic 价差（M03）：Binance、Hyperliquid（xyz:ANT、io:ANTH）、Lighter RH 四条腿的报价与 15 分钟 K 线，每股口径溢价；只读公开接口，无凭据、无告警 | R2 | 完成（Linux CI 通过），随 v0.12.0 发布 |
| M-2 | 原油价差与海力士行情（M01、M02），分 M-2a–M-2e 五小批（见下文），Var 腿先降级为“未接入” | R2 | M-2a 已发布（v0.20.0），M-2b 已发布（v0.21.0），M-2c 已发布（v0.23.0），M-2d 已发布（v0.24.0），M-2e 已发布（v0.25.0），M-2d-3 已发布（v0.27.0） |
| M-3 | 告警规则、飞书通知、监控开关、Var 会话 token（M09–M12），分 M-3a–M-3d 四小批（见下文） | R3 | M-3a 完成（v0.29.0），M-3b 完成（v0.30.0），M-3c 完成（v0.31.0），M-3d-1 完成（v0.33.0），M-3d-2 完成（v0.34.0） |
| M-4 | 永续全市场报价（M04：11 家交易所公共 WS、SSE 增量），分 M-4a（采集器与接口）、M-4b（页面与导入） | R2 | 完成（M-4a v0.36.0，M-4b v0.37.0） |
| M-5 | 依赖 M04 的页面（M05–M08），分 M-5a–M-5f 小批（M-5b 再拆 b1、b2，见「M-5」节） | R2 | M-5a（v0.38.0）、M-5b1（v0.39.0）完成，其余未开始 |
| M-6 | 其余（M13、M14；M14 原靠 iframe 桥接宿主，需重新设计） | 待定 | 未开始 |

## M-1：Anthropic 价差

**配置**

```json
"monitor": { "anthropic": {} }
```

- `monitor.anthropic` 可带 `shares: { "outstanding": 12.7, "diluted": 16.7 }`（十亿股）；不写用这两个默认值。校验与工作台一致：`1 ≤ outstanding ≤ diluted ≤ 100`。
- 配置了 `monitor`（或 `oil`、`asset`）时 `pairs` 可以省略。
- 不需要任何密钥。
- 启用方式：在设置页「从工作台导入」里点「读取工作台」，勾选「启用行情监控」后导入（命令行：`sudo bash install.sh --import-workbench --monitor`），写入的就是上面这一段（默认股数），已启用时保留现有设置；方案见 [module-import.md](module-import.md)。手写 `config.json` 后执行 `sudo bash install.sh` 仍可用，作为备选；改股数仍在 `shares` 里改。

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
- 样式：`web/src/monitor.css` 复制自工作台 `modules/monitor/app/globals.css`（`77f3cf2`）里这个页面用到的规则，每条选择器前加 `.monitor-desk ` 限定范围（具体取法见下面的实施记录）。

**测试**

- 工作台 `modules/monitor/tests/anthropic-market.test.mjs` 里只依赖行情模块的用例原样搬到 `test/monitor-anthropic.test.ts`（每股换算、腿失败、分页、限流冷却、响应大小、旧快照兼容）。
- 新增：存储的写入、读回与保留期；采集循环的快照标记；配置解析；三个接口的鉴权、404、503 与参数校验；页面换算函数与 vendor 文件结果一致。

**回滚**：`sudo bash install.sh --version v0.11.0`，回退前先删掉 `config.json` 里的 `monitor`（旧版本不认识这个键，配置检查会不通过）。主库不变；`monitor.sqlite` 留在数据目录里，旧版本不读它，删掉只丢 K 线历史（可从交易所重新回补最近约 50 天）。

### M-1 实施记录（与上文不同或补充的地方）

- **K 线的新鲜度**：除报价外，K 线接口的 `status` 也会标 `snapshot`：启动时从库里读回、最近一轮 K 线整轮失败，或最近一次成功的 K 线轮距今超过 615 秒（工作台已存 K 线的时限，约十轮）。
- **库打不开**：`monitor.sqlite` 打不开时服务照常启动，stderr 记一行原因，不注册行情监控的读取，三个接口与没配置时一样 404，页面不显示入口；运行状态接口多一个 `monitor` 段（`available`、`error`、`anthropic` 的最近取数时刻与错误）。`--check-config` 的输出列出 monitor 配置摘要。
- **`days` 参数**：只认 `1–400` 的十进制整数（上限即保留期 `ANTHROPIC_RETENTION_DAYS`），其余 400 `invalid_days`。
- **导入**：`src/service/import-workbench.ts` 写配置时，“有别的模块就可以不写 `pairs`”改为按 `MODULE_KEYS`（`oil`、`options`、`monitor`、`asset`）判断，导入不会删掉已有的 `monitor` 段。
- **页面读取**：报价每 10 秒、K 线每 60 秒，都走 `useLiveResource`；K 线按所选范围加 21 天读（`days=28`、`days=51`，“全部”不带 `days`），与工作台相同；切换范围时，已读到且覆盖新范围的数据先留在图上。尚无数据的 503 按“正在获取”显示，不当作失败。读取超时：报价 10 秒，K 线 30 秒（完整 400 天约几 MB）。
- **页面外观**：照工作台 Hub 里嵌入显示的 Anthropic 详情，所以不渲染工作台的顶栏（工作台 `.hub-content .topbar { display: none }`），外层用本服务的顶栏与标签；工作台的 `<main>` 换成 `.monitor-main`（页面本身在服务的 `<main>` 里）。图表切换、范围、对比合约、来源展开都用页面内状态，不存浏览器偏好（工作台存在 localStorage）。
- **样式**：`web/src/monitor.css` 是按规则编号从工作台 `globals.css` 取出、加前缀生成的（规则顺序、数值不改）：`body` 规则作用在 `.monitor-desk` 本身；`.hub-content`、`.monitor-detail` 祖先去掉；本页不渲染的部分（顶栏、资金费、告警、交易所对比等）不取；`@keyframes spin` 与 `styles.css` 里的完全相同，不重复。另加三处：`design-tokens.css`（`9ca6f68`）的令牌放在 `.monitor-desk` 上；工作台页面靠 Tailwind preflight 的几条（清零外边距、按钮透明背景、标题继承字号）；本页在 ASTER 外壳（`.aster-desk .focused-desk`）里，`aster.css` 的 `.page-heading` 规则和 `styles.css` 的 `.svg-plot` 颜色、提示框边框也会命中，文件末尾按工作台的值复位。
- **示例配置**：`deploy/config.example.json` 加了 `monitor` 段；`deploy/test-install.sh` 里只用示例 ASTER 部分的那一步同时去掉 `monitor`，免得安装测试去读交易所行情。
- **本地预览**：`scripts/dev-monitor.ts`（`pnpm build:web; node scripts/dev-monitor.ts [--port 4731]`）用替身行情（`test/monitor-fake.ts`）、模拟执行器和临时数据目录跑页面，不走 `startService`（不加账户锁、不写环境标记），Windows 上也能跑；不联网。
- **测试**：`test/monitor-anthropic.test.ts`（vendor 行为，14 个）、`test/monitor.test.ts`（存储、采集、配置、导入、HTTP 层与两个整服务用例，9 个）、`test/monitor-web.test.ts`（页面数据规则，6 个）、`test/web.test.ts` 补 `#/monitor` 路由。两个整服务用例（`startService`）与仓库原有服务进程用例一样，在 Windows 上因数据目录 fsync 报 EPERM 跑不了，需在 Linux（CI）上验证。

**本批没做**：成交标记、均线 / 布林带 / Z-score、股数从交易中心同步、概览卡片与告警（M-3）。

## M-2：原油价差与海力士行情

对照的工作台代码：`modules/monitor`（工作台 `31242e0` 时的内容，各文件的最后提交号写在对应小批里）。工作台把原油与海力士做成 Hub 里的两张卡片和各自的详情页；本服务在「行情监控」页顶部加市场切换（只列出配置了的市场），每个市场一个详情，外观照工作台详情页。

| 小批 | 内容 | 状态 |
| --- | --- | --- |
| M-2a | 原油价差：Binance BZUSDT / CLUSDT 标记价报价与 15 分钟 K 线、详情页（价差 / 价格对比） | 已发布（v0.20.0） |
| M-2b | 海力士溢价：Hyperliquid xyz:SKHY（ADR）/ xyz:SKHX（普通股）报价与 1 小时 K 线、详情页（溢价率 / 美元价差 / 价格对比） | 已发布（v0.21.0） |
| M-2c | 多交易所对比：原油（Hyperliquid、Bybit、Binance、Lighter、OKX、Bitget；Variational 显示“未接入”）与海力士（Hyperliquid、Bybit、Binance、OKX、Bitget、Gate）的同所两腿价差与资金费年化 | 已发布（v0.23.0） |
| M-2d | 资金费：原油 Binance 已结算资金费（4 小时）与海力士 Hyperliquid 小时资金费历史、多空资金费图 | 已发布（v0.24.0）；对比表各交易所结算历史另成 M-2d-3，已发布（v0.27.0） |
| M-2e | 技术指标：7 日均线、20 日布林带、Z-score（Anthropic、原油、海力士三个市场一起补） | 已发布（v0.25.0） |

不做：工作台的四腿资金费对冲模拟、成交标记与相关持仓（依赖资产账本的成交，随 Asset 后续批次）、告警（M-3）、工作台的原油日线任务与旧的 Hyperliquid 原油行情。

**配置**：`monitor` 下每个市场一个键，`{}` 表示启用，至少一个：`"monitor": { "anthropic": {}, "oil": {}, "hynix": {} }`。`anthropic` 从 M-2 起可以不写（只看原油也行）；`oil`、`hynix` 不带任何字段。

**从工作台导入**：勾选「启用行情监控」时写入当时已有的全部市场；已启用时保留现有各市场的设置（Anthropic 股数等），只补上缺少的市场，补了就算“已加入”，一个都不缺才“跳过”。

**接口**：`GET /api/monitor/<市场>/quote`、`GET /api/monitor/<市场>/candles?days=<1–400>`，含义与 M-1 相同；没配置这个市场时 404；`/api/monitor/state` 的 `markets` 列出配置了的市场。

**存储**：同一个 `monitor.sqlite`，每个市场一张 K 线表（`oil_candles(time, brent, wti)`、`hynix_candles(time, adr, ordinary)`），最近一轮的状态仍在 `monitor_state`（键 `oil.quote`、`oil.candles` 等）。只加表，不改 M-1 的表。

**回滚**：回到 v0.20.0 前删掉 `monitor.hynix`，回到 v0.19.0 前再删掉 `monitor.oil`（旧版本的配置检查不认识）；只剩 `monitor: {}` 时连同 `monitor` 一起删。新表留在 `monitor.sqlite` 里，旧版本不读。

### M-2a：原油价差

对照：`modules/oil/binance.mjs`（`8470785`）、`spread.mjs`（`568a20d`）、`intraday.mjs`（`89f26e5`）、`lib/oil-history.ts`、`lib/oil-chart-config.ts`（`89f26e5`）、`lib/exchange-service.ts` 的 `parseBinanceQuote`（`c4c7910`）、`app/oil-panel.tsx`（`9c652bc`）、`app/spread-chart.tsx`（`4be9aa4`）。

**代码**

- `src/vendor/oil-market.mjs`（附 `.d.mts`）：复制上面三个 `.mjs` 里报价校验、价差、15 分钟 K 线配对 / 回补 / 窗口与图表行的部分，不改逻辑；日线快照、`marketFromExchangeQuote`（工作台交易所对比的接口形状）不带。
- `src/monitor/oil.ts`：采集与读取，结构同 `anthropic.ts`（启动读回、两条循环、快照标记、日志去重）。报价读法照工作台 `parseBinanceQuote`：两个合约的 `premiumIndex` 与 `fundingInfo`，两腿的源时刻相差超过 15 秒或不在本机时间前 120 秒到后 60 秒内拒收；资金费周期或下次结算时刻缺一项时两腿资金费都置空（价格照用）。工作台每次读全市场的 `premiumIndex` 和合约目录 `exchangeInfo`（共享给交易所对比），这里只读两个合约（`?symbol=`），不读合约目录。
- `src/monitor/store.ts` 加 `oil_candles` 表和对应的读写（同一事务写行、保留期裁剪与轮次状态）。

**采集规则**

| 项 | 间隔 | 单次请求超时 | 失败行为 |
| --- | --- | --- | --- |
| 报价 | 10 秒一轮：两个 `premiumIndex` 与一个 `fundingInfo` 并发 | 10 秒 | 任一价格请求失败本轮作废，保留上次报价（超过 35 秒标为快照）并记原因；`fundingInfo` 失败只让资金费为空；不在轮内重试 |
| K 线 | 60 秒一轮，从最后一根已存 K 线往前 96 根（1 天）处续读；更早的缺口每小时补读一次（启动后第一轮也补读）；首次从 2026-04-01 09:00 UTC 回补（每腿约 15 页，每页 1500 根） | 15 秒 | 任一腿失败本轮作废，保留已存的 K 线并记原因 |

- 限流：与 Anthropic 共用同一个 Binance 冷却（429 后 60 秒、418 后 120 秒内两边都不发 Binance 请求）。原油报价每分钟 18 个请求（权重各 1）、K 线每分钟 2 个（首次回补约 30 个、权重各 10），与 Anthropic 合计仍远低于每分钟 2400 权重。
- 保留 400 天（同 Anthropic），超出的行每轮写入时删除；响应大小上限同 M-1（8 MiB）。
- 新鲜度：报价超过 35 秒或启动时读回标 `snapshot`；K 线启动读回、最近一轮失败或超过 615 秒没有成功的一轮标 `snapshot`。

**页面**：照工作台原油详情：状态行、四格读数（当前价差、布伦特、WTI 标记价、区间平均价差）、走势图（价差 / 价格对比两个标签，1 周 / 1 月 / 全部）、近期观察（每日最后一根共同 K 线，6 天）、如何比较、数据来源与覆盖范围。价差 = 布伦特 − WTI（USDT / 桶），按十进制精确相减（`spread.mjs`）。图表与 Anthropic 共用一个组件（从 `MonitorPage.tsx` 移到 `MonitorChart.tsx`，标签由各市场的图表配置给出）。不做：多空资金费图（M-2d）、指标（M-2e）、成交标记。

**测试**：vendor 文件的报价校验、价差精度、K 线配对与分页校验；采集的快照标记、限流共用、读回与写入失败；配置解析与导入补市场；接口 404 / 503 / 400；页面数据规则。

### M-2a 实施记录（与上文不同或补充的地方）

- **配置**：`monitor` 改为按市场分段，`{ "anthropic": {…}, "oil": {} }` 任配其一或都配；`oil` 不带设置（写别的键或非对象时配置检查报“monitor.oil 无效（不带设置，写 {}）”），一个市场都不写时报“monitor 须至少配置一个市场”。M-1 的 `{ "anthropic": {} }` 照常可用。
- **接口**：`/api/monitor/state` 返回 `{ markets, anthropic }`（只配原油时 `anthropic` 为 `null`）；`/api/monitor/oil/quote`、`/api/monitor/oil/candles?days=` 规则同 Anthropic（未配置 404 “本服务没有配置原油行情监控”，先于参数检查；尚无数据 503；`days` 只认 1–400）。报价应答比工作台多 `status`、`staleAfterMs`、`lastAttemptAt`、`lastError`；K 线应答多 `lastAttemptAt`、`lastError`，窗口读取带 `windowDays` 与完整历史的 `coverage`。运行状态的 `monitor` 段多一个 `oil`（报价与 K 线的最近时刻、行数与错误），没配的市场为 `null`。
- **报价时刻**：`fetchedAt` 用两腿源时刻中较早的一个（工作台用读取完成的本机时刻），新鲜度按它算，页面状态行显示的也是它。
- **限流共用**：`openMonitor` 建一个 Binance 冷却交给两个采集器；`createAnthropicMonitor` 多一个可选的 `gate` 参数，不传时照旧自建。
- **旧缺口每小时补读一次**：工作台的读取每轮都从最早的缺口读起，交易所始终不给的 K 线（维护停摆等）会让每轮从那里翻页到现在（一年后每腿约 26 页、权重各 10）。这里除启动后第一轮和每满一小时的一轮外，只把最后一天的行交给读取函数，更早的行原样接回（`OIL_GAP_RETRY_MS`）。
- **K 线写入**：只写与内存相比新增或变化的行；读回失败（行在、轮次记录缺失或校验不过）时下一轮成功后整表重写。保留期裁剪在内存里同样做，内存与库保持一致；写入失败时内存不前进，下一轮重读重写。
- **导入**：「启用行情监控」现在写入所有市场 `{ "anthropic": {}, "oil": {} }`；已启用的配置缺市场时补上缺的（已有市场的设置原样保留，预览写“补上 原油价差，已有的…保留现有设置”），都齐了才显示“已启用，保留现有设置”；现有 `monitor` 段无效时不改动并在预览里说明。导入面板该行列出写入后的市场。
- **页面**：配置了两个以上市场时，页面顶部显示市场标签（照工作台 Hub 的 `hub-market-nav`），只挂载当前市场的面板（切换时新面板立即读取，范围与图表标签回到默认）；选中的市场记在浏览器 `localStorage`（`monitor:market:v1`，读写失败时只是不记），其余页面状态仍不存偏好。原油面板的报价快照提示与 K 线快照提示附带服务最近一次失败的原因。走势图与 Anthropic 共用 `web/src/MonitorChart.tsx`，图表配置多一个 `modes`（Anthropic 三个标签，原油只有价差 / 价格对比），没有溢价率标签的市场提示框也不显示溢价率。K 线同样按所选范围加 21 天读，为 M-2e 的指标预热留好窗口。
- **样式**：市场标签的规则取自工作台 `globals.css`（`77f3cf2`）的 Hub 标签部分，追加在 `monitor.css` 末尾；原油面板其余部分与 Anthropic 用同一组规则，没有新增。
- **本地预览**：`scripts/dev-monitor.ts` 同时启用两个市场；替身行情（`test/monitor-fake.ts`）新增 BZUSDT / CLUSDT 的 `premiumIndex`、`fundingInfo` 与 15 分钟 K 线（上市 30 天，价差在 2.5–5.5 之间缓慢摆动），可让单腿、资金费或整体返回 429 / 500。
- **测试**：新增 `test/monitor-oil.test.ts`（10 个：vendor 价差精度、K 线配对 / 分页 / 续读补缺口 / 窗口，报价解析，采集的快照标记、续读起点、失败与恢复、Binance 冷却与 Anthropic 共用，读回失败整表重写与写入失败下一轮补写，永久缺口每小时补读，配置与接口）；`test/monitor-web.test.ts` 加 3 个原油页面数据规则；`test/import-modules.test.ts` 改写行情监控导入用例（全新、补市场、已齐、只有原油、无效配置、超出大小）。

**本批没做**：海力士（M-2b）、多交易所对比（M-2c）、多空资金费（M-2d）、指标（M-2e）、成交标记、概览卡片与告警（M-3）。`deploy/config.example.json` 仍只带 `anthropic`。

**回滚**：`sudo bash install.sh --version v0.19.0`，回退前从 `config.json` 删掉 `monitor.oil`（只配了原油时删掉整个 `monitor`）；`monitor.sqlite` 里的 `oil_candles` 表旧版本不读。

### M-2b：海力士溢价

对照：`modules/monitor` 的 `lib/market.ts`、`lib/quote-service.ts`、`lib/market-service.ts`（`8470785`）、`lib/market-validation.ts`（`c534894`）、`app/dashboard.tsx`（`9c652bc`）、`app/spread-chart.tsx`（`4be9aa4`）。

**代码**

- `src/vendor/hynix-market.mjs`（附 `.d.mts`）：复制上面几个文件里 xyz dex `allMids` 报价解析、1 小时 K 线请求 / 校验 / 配对 / 续读起点、价格换算校验，页面与服务共用。与原文件不同的地方写在文件头：只存两腿收盘价（`time, adr, ordinary`），正股 ÷ 10、价差、溢价率读取时算；请求函数接收 fetcher / 超时 / 本机时刻；工作台随包的 `archive.json` 基线不带，首次从上市首个整点（2026-07-10 14:00 UTC）回补，起点不早于 Hyperliquid 保留的最近 5000 根；续读起点多一个 `full` 开关；资金费（`metaAndAssetCtxs`）不读，随 M-2d。
- `src/monitor/hynix.ts`：采集与读取，结构同 `oil.ts`（启动读回、两条循环、快照标记、日志去重、写入失败内存不前进、读回失败整表重写、旧缺口每小时补读）。不经过 Binance 冷却。
- `src/monitor/store.ts` 加 `hynix_candles` 表和对应的读写。

**采集规则**

| 项 | 间隔 | 单次请求超时 | 失败行为 |
| --- | --- | --- | --- |
| 报价 | 10 秒一轮：一个 `{type:'allMids', dex:'xyz'}` | 5 秒（同工作台） | 失败本轮作废，保留上次报价（超过 35 秒标为快照）并记原因；不在轮内重试 |
| K 线 | 60 秒一轮：两腿 `candleSnapshot` 1h 并发，从最后一小时往前 48 小时续读；更早的缺口每小时补读一次（启动后第一轮也补读）；首次从上市首个整点回补（一次请求，最多 5000 根） | 10 秒（同工作台） | 任一腿失败本轮作废，保留已存的 K 线并记原因 |

- 报价时刻：`allMids` 不带源时刻，`fetchedAt` 用收到应答的本机时刻（同工作台），新鲜度按它算。
- 限流：Hyperliquid 公开接口每分钟约 8 个请求（报价 6 个、K 线 2 个），429 记为“接口限流（HTTP 429）”，不另设冷却。
- 保留 400 天，实际受 Hyperliquid 只给最近 5000 小时（约 208 天）限制：更早的小时一旦存下就保留到 400 天，缺口补读不早于最近 5000 根。
- 新鲜度规则同原油（报价 35 秒、K 线 615 秒，启动读回为快照）。

**页面**：照工作台海力士详情：状态行、四格读数（当前溢价率、ADR、正股 ÷ 10、区间平均溢价率）、走势图（溢价率 / 美元价差 / 价格对比，1 周 / 1 月 / 全部，默认全部）、近期观察（每日最后共同小时，6 天）、如何比较（1 股正股 = 10 份 ADR）、数据来源与覆盖范围。不做：多空资金费图（M-2d）、指标（M-2e）、成交标记。

### M-2b 实施记录（与上文不同或补充的地方）

- **配置**：`monitor.hynix` 不带设置（写别的键或非对象时报“monitor.hynix 无效（不带设置，写 {}）”），可单独配置。运行状态的 `monitor` 段多一个 `hynix`（报价与 K 线的最近时刻、行数与错误）。
- **接口**：`/api/monitor/hynix/quote`、`/api/monitor/hynix/candles?days=` 规则同原油（未配置 404 “本服务没有配置海力士行情监控”，先于参数检查；尚无数据 503；`days` 只认 1–400）；应答多出的字段同原油。
- **K 线**：只收两腿同一已收盘整点都有的小时（工作台 `alignCandles`），读回时再校验整点、递增、不晚于轮次时刻与价格为正。替身行情缺某小时（任一腿没有成交）时该小时不存，页面按缺口断开。
- **缺口补读**：只在 Hyperliquid 仍保留的最近 5000 根里找缺口（更早的读不回来，不让每小时一轮白读 5000 根）；补读那一轮写入成功才算补过，写入失败下一轮照样补读（原油同样改为写入成功后才推迟下一次补读）。
- **日志**：K 线读取失败的日志不再重复“K 线读取失败”字样（Anthropic、原油一起改）。
- **导入**：「启用行情监控」写入 `{ "anthropic": {}, "oil": {}, "hynix": {} }`；已启用的配置缺海力士时补上，规则同 M-2a。
- **页面**：市场标签多一个“海力士”，默认范围“全部”、默认标签“溢价率”（同工作台）；快照提示附带服务最近一次失败的原因；K 线按所选范围加 21 天读（为 M-2e 预热）。来源说明按本服务改写：不提资金费，写明 Hyperliquid 只给最近 5000 小时、本服务存在 `monitor.sqlite` 保留 400 天。
- **本地预览**：`scripts/dev-monitor.ts` 同时启用三个市场；替身行情新增 xyz dex 的 `allMids` 与 SKHY / SKHX 1 小时 K 线（上市 30 天，溢价在 2–8% 之间缓慢摆动），可让单腿或整体返回 429 / 500，可指定缺失的小时。
- **测试**：新增 `test/monitor-hynix.test.ts`（9 个：报价换算与拒收、K 线配对 / 续读起点 / 5000 根下限 / 行校验，采集的快照标记与续读，失败与恢复、429，读回与写入失败，永久缺口每小时补读、补读轮写入失败下一轮照样补读，配置与接口，页面数据规则）；`test/import-modules.test.ts` 行情监控导入用例补海力士。

**本批没做**：多交易所对比（M-2c）、资金费（M-2d）、指标（M-2e）、成交标记、概览卡片与告警（M-3）。`deploy/config.example.json` 仍只带 `anthropic`。

**回滚**：`sudo bash install.sh --version v0.20.0`，回退前从 `config.json` 删掉 `monitor.hynix`（只配了海力士时删掉整个 `monitor`）；`hynix_candles` 表旧版本不读。

### M-2c：多交易所对比

对照：`modules/monitor` 的 `lib/exchange-service.ts`（`c4c7910`）、`lib/exchange-quotes.ts`（`568a20d`）、`lib/oil-cex.ts`（`1fdb6e8`）、`lib/oil-dex.ts`（`8470785`）、`modules/oil/hyperliquid.mjs`（`c534894`）、`app/exchange-comparison.tsx`（`568a20d`）、`hooks/use-exchange-quotes.ts`（`8470785`）。工作台的原油与海力士都有这张表（海力士的对比交易所带 Gate、不带 Lighter），这一批两个市场一起做；批次表原写的“原油含 Gate”按工作台更正为 Gate 只在海力士。

**做法：按需读取，不后台轮询**（同工作台）。页面打开对比表时每个交易所各自每 15 秒请求一次服务；服务收到请求才去读那一家，结果 5 秒内各页面共用，同一结果同时只有一个请求在途。没人看页面时不发任何请求。

**接口**：`GET /api/monitor/<oil|hynix>/exchanges/<交易所>`，返回该交易所一行（两腿价格、币种、口径、资金费率与周期、下次结算、时间口径）；未配置该市场或该市场不支持这家时 404，读取失败 503（`code: exchange_unavailable`，`message` 是固定中文原因，不带上游内容）。

**各交易所来源**

| 交易所 | 原油 | 海力士 | 请求（每次读取） |
| --- | --- | --- | --- |
| Hyperliquid | xyz:BRENTOIL / xyz:CL 的 `metaAndAssetCtxs`（xyz） | 采集器的 `allMids` 报价 + `metaAndAssetCtxs` 资金费（只接实时报价） | 1 个（两个市场共用 5 秒） |
| Binance | 采集器的报价（不额外请求） | SKHYUSDT / SKHYNIXUSDT `premiumIndex` + `fundingInfo`（15 秒） | 0 / 2–3 个 |
| Bybit | BZUSDT / CLUSDT | SKHYUSDT / SKHYNIXUSDT | 合约信息 2 个（60 秒） + `tickers` 2 个 |
| OKX | BZ / CL-USDT-SWAP | SKHY / SKHYNIX-USDT-SWAP | 合约 2（60 秒）+ 标记价 2 + 资金费 2（15 秒） |
| Bitget | BZUSDT / CLUSDT | SKHYUSDT / SKHYNIXUSDT | 合约 2（60 秒）+ 行情 2 + 资金费 2（15 秒） |
| Lighter | `orderBookDetails` 目录（60 秒）+ 只读 WebSocket `market_stats` 快照 | — | 目录 0–1 个 + 1 个连接（最长 9 秒） |
| Gate | — | `contracts/<合约>` 2 个 | 2 个 |
| Variational | “未接入”（需要登录会话） | — | 不请求 |

**超时、重试与失败**：每个 HTTP 请求 10 秒超时，不重试；失败的结果不缓存，下一次请求重新读。合约目录与资金费的应答先核对信封与合约行（HTTP 200 带错误码也算失败），核对过才缓存。合约目录 60 秒有效，过期后重读失败时 10 分钟内沿用旧目录。资金费读不到时只缺资金费（年化显示“—”并标“资金费缺失”），价格照常。Binance 与采集器共用同一个 429/418 冷却（60 / 120 秒），冷却内不发请求。应答大于 8 MiB 时放弃。服务停止时在途请求与 Lighter 连接立即中止。

**页面**：原油与海力士详情页图表下方各一张“交易所实时对比”表，布局照工作台；时间按 UTC 显示。

### M-2c 实施记录（与上文不同或补充的地方）

- **代码**：`src/vendor/exchange-comparison.mjs`（附 `.d.mts`）复制上面各文件的合约表、各所解析与校验、价差与资金费年化、Lighter 快照订阅，页面与服务共用，与原文件的差别写在文件头；`src/monitor/exchanges.ts` 是读取与缓存；`src/service/monitor.ts` 在配置了原油或海力士时建读取器，与采集器共用 Binance 冷却，停止时一起停。
- **与工作台的差别**：按合约逐个请求，不拉整个市场的列表（工作台读 Bybit、OKX、Bitget 全市场，单次几百 KB），Bybit 两次 `tickers` 应答的时间差超过 15 秒视为不同步；Binance 海力士不读 `exchangeInfo`（合约状态以 `premiumIndex` 能否返回为准）；Hyperliquid 两个市场用同一个校验，下次结算按下一个整点推算并标“推算”；原油 Hyperliquid 行情没有源时刻，用收到应答的时刻（页面标“采集时间”）。
- **日志**：每个交易所的失败按原因去重记一次，恢复记一次；JSON 解析失败只记错误类型，不记应答片段；采集器还没有报价（“尚未取得…报价，后台正在采集”）不记失败。
- **页面**：年化是纯文本，不能点开结算历史（随 M-2d）；四腿对冲模拟和 Hub 摘要不做；Variational 行固定“未接入”。
- **本地预览**：替身行情新增 Bybit、OKX、Bitget、Gate、Lighter（含 WebSocket 替身，可设为无应答或拒绝）的应答，各交易所价格在同一走势上加小幅偏移；xyz `metaAndAssetCtxs` 带原油与海力士合约。
- **测试**：新增 `test/monitor-exchanges.test.ts`（12 个：各交易所解析与页面校验、年化公式手算核对（海力士 10 份、两腿周期不同、资金费名义价不同、缺腿为空）、5 秒缓存与并发去重、失败不缓存与日志去重、合约目录沿用与 10 分钟上限、HTTP 200 错误码应答不进缓存、Binance 冷却与资金费缺失、采集器来源与未就绪、Hyperliquid 资金费缺失与快照、Lighter 拒绝 / 超时 / 停止、停止中止在途请求、原因文本不带上游内容、接口 401 / 404 / 503 / 200）。

**本批没做**：资金费历史与多空资金费图（M-2d）、指标（M-2e）、Variational、告警（M-3）。真实交易所未验证（本机访问部分交易所受地区限制）。

**回滚**：`sudo bash install.sh --version v0.22.0`，不用改配置（没有新配置字段、没有新表）。

### M-2d：已结算资金费

对照：`modules/oil/binance-funding-history.mjs`（`8470785`），`modules/monitor` 的、`lib/hynix-funding-history.ts`（`8470785`）、`lib/hynix-funding-analysis.ts`（`8bc3bee`）、`app/settled-funding-panel.tsx`（`8bc3bee`）、`app/oil-funding-panel.tsx` 与 `app/hynix-funding-panel.tsx` 的面板配置。工作台的原油与海力士详情页都有这块“多空价差资金费”，这一批两个市场一起做。

**做法：后台采集，存进 `monitor.sqlite`**（同 K 线）。每个市场的采集器多一个循环，每 5 分钟一轮：

| 市场 | 来源 | 结算周期 | 每轮请求 |
| --- | --- | --- | --- |
| 原油 | Binance `GET /fapi/v1/fundingRate`（BZUSDT、CLUSDT 各一路，每页 1000 条，最多 500 页） | 4 小时（结算时刻须落在 4 小时格点后 60 秒内，`rateType` 只收 `Regular`） | 每腿 1 个起 |
| 海力士 | Hyperliquid `POST /info` `{type:'fundingHistory'}`（xyz:SKHY、xyz:SKHX，每次最多 500 条，翻到空页为止，最多 100 页） | 1 小时（时刻取整点） | 每腿 1 个起 |

**续读**：首次从第一次结算读起（原油 2026-04-01 12:00 UTC，海力士 2026-07-10 15:00 UTC），但不早于 400 天前；之后每轮从最后一次结算往前 48 小时读起；每小时一轮（以及启动后第一轮）从最近 7 天内最早的缺口或单边结算读起，补读交易所晚到的记录（更早的缺口视为永久缺口，不再补读）。新读到的单腿为空时保留已存的值。缺口保留为断点，不补 0。

**分段回补**：一轮最多读一段时间范围：海力士 60 天（Hyperliquid `fundingHistory` 每次权重 20、每 20 条另加 1，每 IP 每分钟 1200；60 天两腿约 300），原油不分段（Binance 每页 1000 条约 167 天，400 天只要几个请求）。没读到当前时刻时接口标 `complete: false`，下一轮从这一段的终点续读（这一段没有结算也照样往前走），页面显示“正在分段回补，已到 …”，区间终点取已有的最后一次结算。海力士从首个结算回补到现在约需 3 轮（15 分钟），满 400 天约 7 轮。

**计算**（同工作台）：做空价差的净费率 = (A 腿 − B 腿) ÷ 2（两腿等名义金额），小时费率 = 净费率 ÷ 周期小时数；区间累计 = 各结算之和；累计年化 = 累计 ÷（共同结算次数 × 周期小时数）× 8760。只计两腿都有费率的结算，覆盖不全时页面标出缺少多少次。

**超时、重试与失败**：原油每个请求 15 秒、海力士 10 秒超时，不在本轮重试，下一轮（5 分钟后）再读；原油走与报价、K 线共用的 Binance 429/418 冷却。读取失败或写库失败时保留已有数据，页面标“快照”并给原因，日志按原因去重记一次、恢复记一次。

**接口**：`GET /api/monitor/<oil|hynix>/funding`，返回全部已存结算（原油 `{time, brent, wti}`、海力士 `{time, adr, ordinary}`，费率为小数）、`fetchedAt`、`status`（`live` / `snapshot`）、`complete`、周期小时数、覆盖范围与最近一次失败原因；还没有任何结算时 503：首轮还在进行为 `code: not_ready`，上一轮失败为 `code: funding_unavailable`（`message` 带失败原因，原因是固定中文短句，不带上游内容）；未配置该市场时 404。

**存储**：`monitor.sqlite` 新增 `oil_funding(time, brent, wti)`、`hynix_funding(time, adr, ordinary)` 两张表，保留 400 天；轮次时间存 `monitor_state`（键 `oil.funding`、`hynix.funding`）。只加表。

**页面**：原油与海力士详情页在交易所对比表下方加“多空价差资金费”面板：区间累计年化与累计资金费读数、小时费率 / 累计资金费 / 累计年化三种曲线、覆盖说明、刷新按钮、计算口径与数据来源；时间范围与上方价差图共用。原油面板另有“当前预估”（按报价里两腿的当前资金费率，等数量 / 等名义两种口径）。

### M-2d 实施记录（与上文不同或补充的地方）

- **代码**：`src/vendor/settled-funding.mjs`（附 `.d.mts`）复制上面各文件的读取、配对、校验与区间分析，服务与页面共用，与原文件的差别写在文件头；`src/monitor/funding.ts` 是两个市场共用的采集、续读、写库与快照；`oil.ts`、`hynix.ts` 各加第三个循环。
- **与工作台的差别**：工作台把结算写成归档 JSON 并带元数据快照，这里只存行（`monitor.sqlite`）；工作台每次请求都按需读，这里后台每 5 分钟读、页面只读服务；工作台的 `analyzeFundingWindow` 与 `retainFundingRows` 没复制（页面直接用区间分析，保留由写库时按 400 天裁剪）。
- **启动**：库里的结算读回时按同一规则校验，读不回（缺轮次记录或校验不过）时记一行日志，下一轮成功后整表重写。
- **页面**：每 5 分钟读一次接口（超时 30 秒）；首轮还在进行（503 `not_ready`）时显示“正在载入”，首轮失败（503 `funding_unavailable`）显示服务给的原因；接口失败与校验失败的文字分开；刷新按钮只在请求进行中禁用；“全部”区间从首个结算起，超过 400 天保留期后从保留的最早结算起（不把裁掉的部分算成缺失）；原油“当前预估”的口径选择存浏览器本地（读写失败不影响显示）。
- **本地预览**：替身行情新增 Binance `fundingRate`（4 小时）与 Hyperliquid `fundingHistory`（每次最多 500 条）应答，可设某腿某时刻缺失或整体无应答；`scripts/dev-monitor.ts` 把海力士上市时间设为真实的 2026-07-10，打开后前 10 分钟能看到分段回补。
- **测试**：新增 `test/monitor-funding.test.ts`（8 个：配对规则、续读起点与合并、区间分析手算核对、采集 / 存储 / 快照 / 重启续读（原油每腿 1 个请求；海力士 3 段，空段 1 个、其余 3 + 2 个请求）、80 小时前的缺口只在每小时整轮补读、分段回补（空段照样前进、未完成标记）与 7 天缺口范围、失败处理（500 去重与恢复、429 冷却、写库失败后重写、读回失败整表重写）、接口 404 / 401 / 503 两种 / 200 与页面校验、区间起止）。
- **审查**：记录见 [docs/reviews/2026-11-14-monitor-m2d.md](reviews/2026-11-14-monitor-m2d.md)；首轮失败页面一直“载入中”、海力士整轮回补的请求权重随历史增长两条 P2 已修。

**登记（P3）**：Binance 出现 `Special` 结算或原油结算周期改变时整轮读取失败（同工作台的严格校验，页面显示快照或首轮失败原因）；接口每次返回全部结算（海力士 400 天约 9600 行，页面每 5 分钟读一次）；重启时若库里还没有结算，分段回补从头再走一遍（空段各 1 个请求）；真实交易所未验证（本机访问 Binance 受地区限制）。

**本批没做**：对比表各交易所的结算历史（M-2d-3）、指标（M-2e）、四腿资金费对冲模拟、告警（M-3）。

**回滚**：`sudo bash install.sh --version v0.23.0`，不用改配置（没有新配置字段；新表旧版本不读）。

### M-2e：技术指标

对照：`lib/indicators.ts`（`8bc3bee`）、`app/spread-chart.tsx`（`4be9aa4`）的指标部分、`lib/anthropic-history.ts` 与 `lib/oil-chart-config.ts`（`35ebb94`）的指标窗口、`app/globals.css`（`77f3cf2`）的指标样式。工作台三个市场的走势图都有这三项，这一批一起补。

**做法：只改页面**，服务与接口不变。K 线本来就按所选范围多读 21 天（M-1、M-2a、M-2b 已留好），指标先在读到的全部 K 线上算，再按所选范围截取，所以“1 周”的第一根也有完整的 20 日窗口；“全部”读的是完整历史，开头 20 天没有布林带与 Z-score。

**指标**（同工作台）：

| 指标 | 窗口 | 规则 |
| --- | --- | --- |
| 7 日均线 | 7 个自然日的 K 线：原油、Anthropic 672 根 15 分钟，海力士 168 小时 | 含当前已收盘的一根 |
| 20 日布林带 | 20 个自然日：原油、Anthropic 1920 根，海力士 480 小时 | 中轨 = 窗口均值，上下轨 = 均值 ± 2 倍总体标准差 |
| 20 日 Z-score | 同布林带 | （当前值 − 中轨）÷ 标准差；标准差为 0 时留空 |

窗口必须连续：遇到缺口或无效值时两个窗口都从头累计，不足一个窗口时留空。切换溢价率 / 价差标签时按该标签的口径重新计算；价格标签不显示指标。

**页面**：价差走势图在标签下方加“技术指标”开关（7 日均线、布林带 · 20 日、Z-score · 20 日，默认全开）、最新读数（Z-score 带“高于 +2σ / 低于 −2σ / 位于 ±2σ 内 / 等待 N 根 / 窗口无波动”状态）；主图叠加布林带区域、上下轨、中轨与均线；Z-score 打开时图下方另有 Z-score 小图（±2σ 区域与参考线，与主图同步悬停）；最后是“指标怎么看”说明。开关按市场存在浏览器本地（`monitor:chart:<anthropic|oil|hynix>:v1`，Anthropic 各对比腿共用；读写失败时按默认全开）。

**同时修**（M-2b 登记的 P3）：海力士“历史行情存在 N 处缺口”与原油“缺少 N 根共同 15 分钟 K 线”改为只数所选范围内显示的 K 线，不再把范围之前多读的 21 天算进去。

### M-2e 实施记录（与上文不同或补充的地方）

- **代码**：`src/vendor/indicators.mjs`（附 `.d.mts`）复制 `calculateIndicators`，只去掉类型、改为接收任意带 `time` / `premium` / `spread` 的行；`web/src/MonitorChart.tsx` 照工作台加开关、读数、图层、Z-score 小图与说明；三个市场的图表配置多 `periods`、`bars`、`preferenceKey`；`monitor-history.ts` 新增 `rangeGaps`（范围内缺口数与缺少的根数）与 `savedToggles`。
- **与工作台的差别**：工作台把图表标签与开关一起存偏好，这里标签仍是页面状态（与资金费面板共用范围，不共用标签），只存开关；说明文字的“先使用完整历史计算”在 1 周 / 1 月下改为“连同所选范围之前多读的 21 天一起计算”（本服务按范围读），“全部”下写“使用完整历史计算，开头不足一个窗口的部分留空”；成交标记与成交面板不做。
- **测试**：新增 `test/monitor-indicators.test.ts`（6 个：手算均线 / 布林带 / Z-score 与零波动、缺口与无效值重置窗口、各市场窗口根数与 15 分钟序列遇小时步长重置、按范围加 21 天读与完整历史在范围内结果一致、缺口只数显示范围、开关读取的缺省与损坏处理）；`test/monitor-hynix.test.ts` 的提示用例改为按显示范围。
- **审查**：记录见 [docs/reviews/2026-11-14-monitor-m2e.md](reviews/2026-11-14-monitor-m2e.md)。

**本批没做**：成交标记、对比表各交易所的结算历史（M-2d-3）、告警（M-3）。

**回滚**：`sudo bash install.sh --version v0.24.0`，不用改配置（只改页面）。

### M-2d-3：对比表各交易所的结算历史

对照：`lib/exchange-funding-history.ts`（`1fdb6e8`）、`lib/exchange-funding-analysis.ts`（`8470785`）、`lib/exchange-funding-cex.ts`（`ee3942c`）、`lib/exchange-funding-service.ts`（`1fdb6e8`）、`app/exchange-funding-history.tsx`（`7896143`）、`app/globals.css`（`77f3cf2`）第 7–10 行。工作台在对比表里点某一家的年化，展开这一家两腿最近 60 天的实际结算；这一批照做。

**做法：按需读取，不后台轮询、不入库**（同工作台）。页面展开某一家时每 5 分钟请求一次服务；服务收到请求才读这一家的两腿历史，结果 5 分钟内各页面共用，同一家同时只有一个读取在途。之后再读时每条腿从上次覆盖终点前 1 天读起（交易所偶尔改写最近的结算），与旧记录合并，60 天窗口之外的记录剪掉。

**接口**：`GET /api/monitor/<oil|hynix>/exchanges/<交易所>/funding-history`，返回 `{exchange, monitorId, currency, fetchedAt, status, reason, left, right, rows}`：`left` / `right` 是两腿的合约、采集时间、错误与实际查询覆盖（`coverage`，读不到时为 `null`），`rows` 是两腿各自的结算（`time, leftRate, rightRate`，同一时刻只有一腿时另一腿为 `null`，不按时间桶配对）。未配置该市场、该市场不支持这家（Variational、海力士的 Lighter、原油的 Gate）时 404；两腿都读不到且没有上次结果时 503（`code: funding_history_unavailable`，`message` 是固定中文原因）。

**各交易所来源**（全部公开接口，不需要密钥）

| 交易所 | 接口 | 翻页 |
| --- | --- | --- |
| Binance | `/fapi/v1/fundingRate`（原油同样直接读，不复用采集器的库） | `startTime` 往后，每页 1000 |
| Bybit | `/v5/market/funding/history` | `endTime` 往前，每页 200 |
| OKX | `/api/v5/public/funding-rate-history`（取 `realizedRate`） | `after` 往前，每页 400 |
| Bitget | `/api/v2/mix/market/history-fund-rate` | `pageNo`，每页 100 |
| Hyperliquid | `info` 的 `fundingHistory` | `startTime` 往后，每页 500，最多 10 页 |
| Lighter | `/api/v1/fundings`（目录与对比表共用，费率是百分点并带付款方向） | 按 25 天一段 |
| Gate | `/api/v4/futures/usdt/funding_rate` | `to`（秒）往前，每页 100，最多 32 页 |

CEX 最多 32 页。

**超时、重试与失败**（L039、L093：“查无”必须排除读取不完整）：每个请求 10 秒超时、不重试，整次读取 60 秒截止，服务停止时立即中止。任何一页失败、页数到上限、某页不前进或超出所查范围，这条腿整条算失败，不声明覆盖；交易所返回空页才算“查过，没有结算”。一腿失败时保留这条腿上次的记录与覆盖（覆盖随 60 天窗口收缩），并在这条腿上标错误；两腿都失败时有上次结果就返回它（`status: snapshot`，原因“历史结算费率暂时更新失败，保留上次成功记录。”，15 秒后再试），没有就 503，这个失败同样保留 15 秒（页面每 30 秒重试，不会每次都重读 60 天）。Binance 与采集器共用 429/418 冷却。失败按原因去重记日志，恢复记一次。

**页面**：对比表的做空 / 做多年化变成按钮，点开在表下方显示这一家按该方向的结算历史（再点同一个按钮或点“收起”关闭，焦点回到原按钮）：快捷区间（最近 7 / 30 / 60 天）与自定义开始、结束（UTC，含开始不含结束，最长 60 天）、每条腿的原始费率累计、本方向收付累计与结算次数、覆盖说明（已查询 / 部分覆盖 / 未知）、结算明细表（每页 200 条，翻页）。

### M-2d-3 实施记录（与上文不同或补充的地方）

- **代码**：`src/vendor/exchange-funding-history.mjs`（附 `.d.mts`）复制上面各文件的解析、校验、翻页、合并与区间统计，页面与服务共用；`src/monitor/exchanges.ts` 加 `fundingHistory`（缓存、截止、失败快照与日志）；`src/http.ts` 加接口；`web/src/MonitorFundingHistory.tsx` 是面板，`web/src/MonitorExchanges.tsx` 把年化改成按钮。
- **与工作台的差别**：不接 Variational（没有 `availability` 字段）、Aster 与 Bitget USDC；时间按 UTC 显示与输入（工作台是北京时间）；合并逻辑抽成 `mergeFundingHistory`；Lighter 目录由读取器注入（与对比表共用 60 秒缓存）；Bitget 的 `productType` 固定 `USDT-FUTURES`；没有进度回调。页面首次读取可能要十几秒（海力士小时结算回补 60 天要翻十几页），所以客户端等 75 秒，没数据且出错时每 30 秒重试。
- **本地预览**：替身行情为 Binance（海力士）、Bybit、OKX、Bitget、Gate、Lighter、Hyperliquid（原油）加历史结算接口，按各所周期（Hyperliquid、Lighter 1 小时，Binance 4 小时，其余 8 小时）生成，费率按交易所与合约各自一条曲线，可按 `交易所:合约` 设为失败（`historyDown`）。
- **测试**：新增 `test/monitor-funding-history.test.ts`（11 个：整理超过 200 条不截断与上限 / 冲突 / 非法值、各所解析与信封（OKX 实际费率、Binance Special、Lighter 方向、秒级时间）、快照校验与页面只认本服务支持的交易所、区间统计（UTC 输入、含头不含尾、覆盖说明）、两腿合并（一腿失败保留、窗口收缩、增量起点）、翻页（空历史、超大页、不前进、页数上限、单页失败）、替身上各交易所两腿 60 天、5 分钟缓存与并发去重与增量、一腿 / 两腿失败与快照与恢复日志、停止中止与 Binance 冷却、接口 401 / 404 / 503 / 200）。整次读取 60 秒截止与停止走同一个中止信号，测试只覆盖停止，没有实际等 60 秒。
- **审查**：记录见 [docs/reviews/2026-11-14-monitor-m2d3.md](reviews/2026-11-14-monitor-m2d3.md)。

**本批没做**：Variational、四腿资金费对冲模拟、告警（M-3）。真实交易所未验证（本机访问 Binance 返回 451）。

**回滚**：`sudo bash install.sh --version v0.26.0`，不用改配置（没有新配置字段、没有新表）。

## M-3：告警与飞书（分批）

工作台的 M09–M12 分四小批接入，顺序与风险：

| 小批 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| M-3a | 原油（价差、布伦特、WTI）与海力士（ADR 溢价率）阈值告警，经本服务已有的飞书出站队列发送；页面告警面板；测试消息 | R3 | 完成（v0.29.0） |
| M-3b | 从工作台导入告警规则与行情监控的飞书机器人（设置页「从工作台导入」与 `--monitor-alerts`） | R3 | 完成（v0.30.0） |
| M-3c | 各市场的监控开关（停采集、停告警，保留数据） | R2 | 完成（v0.31.0） |
| M-3d | Variational 会话 token 与 Var 腿（对比表里原是“未接入”），分两小批：M-3d-1 公开行情、预测资金费、页面保存 token 与认证标记价；M-3d-2 从工作台导入 token | R3 | M-3d-1 完成（v0.33.0），M-3d-2 完成（v0.34.0） |

## M-3a：原油与海力士阈值告警

对照工作台：`modules/monitor/server/oil/config.mjs`、`server/oil/monitor.mjs`（原油）、`server/alert-engine.mjs`、`server/alert-service.mjs`、`server/feishu.mjs`（海力士）、`app/alert-settings.tsx`、`lib/monitor-alerts.ts`、`lib/alert-grid.ts`（页面），工作台提交 `31242e0`。

**规则**（两个市场共用一套，同工作台原油的做法；工作台海力士的规则在 M-3b 导入时换算成这一套）：

- 一档 = 名称、指标、方向（向上 ≥、向下 ≤、双向穿越）、阈值、冷却（分钟）、回差、开关；另有市场级的总开关。
- 原油指标：价差（布伦特 − WTI，USDT/桶，可为负）、布伦特价格、WTI 价格（须大于 0）；最多 50 档，名称 60 字，冷却 0–10080 分钟，回差 0–100 万。默认三档“价差 3 / 4 / 5 USDT”向上、冷却 30 分钟、回差 0.1，总开关关闭。
- 海力士指标：ADR 溢价率（%，−100 至 10000）；最多 20 档，名称 40 字，冷却 0–1440 分钟，回差 0–100 个百分点。默认没有档位，总开关关闭。
- 同一指标、方向、阈值不能重复；编号、名称（不含换行）、数值都在服务端校验。
- 判定：满足阈值时一次越线只提醒一次；越线后须先离开阈值超过回差才算结束，再次越线且距上次提醒超过冷却才再提醒。双向穿越每侧各算各的越线、共用冷却；保存后每侧都按“已提醒过”起算，不会因为当前已在某一侧而立即提醒。数值比较带浮点容差（同工作台）。
- 改档：指标、方向、阈值、回差、开关都没变的档保留越线状态，其余从头算。总开关关闭或没有机器人时照样跟踪越线，但不发送（打开后若仍在越线中且未提醒过，下一轮发送）。

**取数**：每 10 秒读一次采集器的最新报价，只用实时报价：状态 `live`，原油报价时刻在 90 秒内、海力士获取时刻在 30 秒内（同工作台），也不能超前 5 秒以上。原油采集器的报价超过 35 秒没更新就已标为快照（`QUOTE_STALE_MS`），所以原油实际按 35 秒停判，90 秒只是兜底。报价过期或无效时本轮不判断，面板显示原因。原油用 Binance 标记价，价差按十进制相减（同页面）。

**发送：写进飞书出站队列**（`notify.sqlite`，ASTER 告警用的同一个队列与机器人 `secrets.json` 的 `feishu`）。触发的档合成一条消息入队，入队成功就记为“已提醒”（开始算冷却），之后由队列负责送达：失败按 5 秒起翻倍、最长 5 分钟退避重试，消息保留 7 天；队列每次最多把 10 条消息合成一帖。与工作台的区别：工作台发送失败时不记为已提醒，60 秒后若仍满足条件再发；这里入队后一定会重试到送达，所以飞书长时间不可用时，恢复后会收到迟到的提醒，消息里带报价时刻。入队失败（`notify.sqlite` 写不进）时不记为已提醒，60 秒后再试；越线在此期间结束则不再补发，提示随之清除。

**消息**：

```
【原油阈值告警】价差 4（向上穿越）：价差 4.0123 ≥ 4 USDT/桶；…
布伦特 66.1234 · WTI 62.1111 · 价差 4.0123 USDT/桶（Binance BZUSDT / CLUSDT 标记价，报价时刻 2026-11-14T08:00:00.000Z）
```

海力士同样两行：第一行各档的溢价率与阈值，第二行 ADR、正股 ÷ 10、每份价差与获取时刻（Hyperliquid xyz:SKHY / xyz:SKHX）。队列每条消息只保留 1500 字：同一轮触发的档太多时，第一行放不下的档合成“另有 N 档”，报价行始终完整；面板记录里保留全部档位。

**测试消息**：面板“发送测试消息”直接发一帖到同一个机器人（不经队列，10 秒超时），立刻显示成功或失败原因；两个市场合计每分钟最多一次。没有机器人时提示到 `secrets.json` 填写 `feishu`（M-3b 起优先用 `feishuMonitor`，可从工作台导入）。

**存储**：`monitor.sqlite` 已有的 `monitor_state` 表，键 `alerts.oil`、`alerts.hynix`，值是 `{version, revision, config, states, events}`（`events` 最近 100 条：触发时刻、各档数值与阈值、队列消息编号；测试消息记成功或失败）。**不加表、不改表**。写库失败时暂停判断和新提醒（内存里已有的“已提醒”保留，不会因此重复提醒），面板显示原因，日志每次故障只记一次；之后每轮先重试写入，写成功即恢复。故障期间开始又结束的越线不补报。

**重启时是“至少一次”**：入队（`notify.sqlite`）与记为已提醒（`monitor.sqlite`）是两个库，不在一个事务里。入队后、写库前进程退出，或写库一直失败期间重启，重启后同一次越线会再提醒一次；不会漏报。

**已保存的值读不出来**（文件损坏，或回滚后遇到新版本写的格式）：按默认配置（总开关关闭）启动，面板提示；后台检查和测试消息都不写库，原值留在文件里，直到页面保存一次才覆盖。

**接口**（写操作同其它页面写操作，须带页面请求标记）：

- `GET /api/monitor/<oil|hynix>/alerts`：`revision`、`config`、机器人是否已配置、最近检查与最近有效报价时刻、当前数值、原因、最近 100 条记录（告警的送达状态从队列读：已排队 / 已发送 / 重试中（带原因）/ 已超出保留期）。
- `POST /api/monitor/<oil|hynix>/alerts`：`{revision, config}`，版本不符 409（`stale_revision`），校验失败 400，写库失败 503；返回同上。
- `POST /api/monitor/<oil|hynix>/alerts/test`：`{}`；一分钟内再发 429，没有机器人 400，发送失败 503（带飞书返回的错误码）。
- 未配置该市场时 404，没有配置行情监控时 404。

**页面**：原油、海力士详情页在“近期观察”上方加“飞书告警梯度”折叠面板，照工作台 `alert-settings.tsx`：冷却 / 回差说明、按范围批量生成档位、逐档编辑、总开关、保存 / 放弃修改并重载、发送测试消息、最近检查与服务器当前数值、最近发送记录。面板每 10 秒刷新，编辑中不覆盖草稿，保存会让之前发出的读取失效（L089）。时间按北京时间显示（同工作台）。

**影响面（R3）**：

- 飞书：新增的消息走 ASTER 告警同一个机器人与队列；告警多时与 ASTER 事件合帖发送。不改队列的重试、合帖与保留规则；`feishu.ts` 只追加两处：`notify` 返回入队的消息编号（未配置机器人时为 `null`），新增按编号读送达状态。
- 凭据：只读 `secrets.json` 已有的 `feishu`，不写、不在接口或日志里返回地址与签名密钥。
- 数据库：只用 `monitor.sqlite` 已有的键值表；不碰主库、执行器、划转、ADL、原油执行。
- 进程：多一个每 10 秒的同步检查（读内存报价、写一行 SQLite），不发网络请求；测试消息才发一次网络请求。

**回滚**：装回上一版（`sudo bash install.sh --version <上一版>`），不用改配置。旧版不读 `alerts.*` 键，留在库里无害；已入队未送达的告警消息旧版照样会发出（队列表结构不变）。

**超时与失败**：测试消息 10 秒超时、不重试；队列沿用原有规则。检查本身不发请求，异常记日志（按原因去重），下一轮继续。

## M-3b：从工作台导入告警档位与机器人

对照工作台：`modules/monitor/server/oil/config.mjs`（原油档位与旧百分比档的换算）、`server/alert-engine.mjs`（海力士 `alerts.json`）、`server/notification-store.mjs`（统一的行情告警机器人 `notifications.json`），工作台提交 `31242e0`。

**来源**（`<工作台数据目录>/modules/monitor/` 下三个文件，以该目录属主身份、不带环境变量的子进程读取；只读普通文件，符号链接不跟随，每个最多 1 MiB）：

- `oil/monitor.json`：档位格式与本服务相同，照搬。旧的百分比价差档（`spreadPercent`）照工作台读取时的做法改为同数值的绝对价差档、关闭，名称加「（原百分比）」；换算后与已有档条件相同的不导入。
- `hynix/alerts.json`：方向 above / below / both 对应 gte / lte / both；各档没有单独设置冷却与回差时带上面板统一的值；冷却由秒换算为分钟；方向与阈值都相同的后一档不导入（本服务不允许重复）。
- `notifications.json`：工作台行情监控唯一的飞书机器人。地址为空且有两个待选机器人（原油、海力士各一个）时说明“尚未在工作台选定”，不导入。

转换后按页面保存的同一套校验检查，不通过时该市场不导入并给出原因；文件缺失、不是 JSON、不是普通文件各给原因，不带文件内容。

**写入**：

- 档位不直接改 `alerts.<市场>`（运行中的服务每 10 秒会写回自己的值），而是由 `src/monitor/import-writer.ts` 以数据目录属主身份写入 `monitor.sqlite` 的待应用键 `alerts.<市场>.import`。行情监控启动时和每轮检查开始时应用：整体替换档位与总开关（版本加一，越线状态从头算：单向档导入时已在越线中会提醒一次，双向档按“已提醒过”起算），历史里记一条“已导入”；新值与删除待应用键在同一事务里，所以只应用一次。待应用的值无效，或写入超过 10 分钟仍未应用（配置改动失败、或当时该市场没在运行）时丢弃并记日志，不会在以后启用该市场时盖掉届时的档位；写库失败时面板显示原因，每轮重试。只给本服务配置里有的市场写档位，没有的市场标明原因、不写。
- 机器人写入 `secrets.json` 的新字段 `feishuMonitor`（格式同 `feishu`）。有它时行情告警发往这个机器人，入单独的出站队列 `notify-monitor.sqlite`（重试、合帖与保留规则同 `notify.sqlite`）；没有时仍发 `feishu`（同 M-3a）。之前入 `feishu` 队列的告警，送达状态仍从原队列读。ASTER 告警与定时摘要不变。
- 顺序：账本（若选了）→ 档位 → 配置与密钥。档位写入失败时配置不变、整次请求失败（已写入的账本保留）；只换档位（机器人相同或没有）时配置不变、不重启，行情监控 10 秒内换上新档位；机器人有变化时照常写配置、检查、重启，失败时恢复配置，已写入的档位保留并在消息里说明。

**入口**：

- 设置页「从工作台导入」：预览在行情监控下列出两个市场的档位数、启用数、总开关、说明与机器人；勾选「同时导入告警档位与机器人」（行情监控已启用且这次不改它时可勾；这次会启用行情监控或补上市场时，须同时勾选那一项，因为请求会带上 `monitor` 并重启服务）。工作台没有 Monitor 模块时显示“工作台没有 Monitor 模块”，不报错。页面请求新增 `monitorAlerts: true`，须和 `monitor: true` 一起发。
- 命令行：`sudo bash install.sh --import-workbench --monitor-alerts`（隐含 `--monitor`，安装脚本传入数据目录）。旧版本包报“不支持 --monitor-alerts”。

**页面**：告警面板说明用的是 `feishuMonitor` 还是 `feishu`；发送记录里导入显示为“已导入 · 从工作台导入 N 档（总开关开 / 关），替换了原有档位”。

**影响面（R3）**：

- 凭据：`secrets.json` 新增可选字段 `feishuMonitor`；地址与签名密钥不进接口、结果文件、日志与命令行输出（只有市场、档数与原因）。
- 数据库：`monitor.sqlite` 只多两个待应用键与一种历史记录；新增 `notify-monitor.sqlite`（只在有 `feishuMonitor` 或文件已存在时打开）。主库、执行器、划转、ADL、原油执行不变。
- 导入流程：`import-helper.ts` 与命令行在账本之后、配置之前多写一步档位；配对、原油、期权、资产账本的导入不变。
- 工作台的行情告警不受影响：导入后两边都会发，确认后在工作台关掉总开关。

**回滚**：先从 `secrets.json` 删掉 `feishuMonitor`（v0.29.x 按白名单读密钥，多出字段会拒绝启动），再 `sudo bash install.sh --version v0.29.2`。v0.29.x 忽略待应用键与“已导入”记录；发往 `feishuMonitor` 的那些发送记录，旧版会拿编号去 `notify.sqlite` 查，面板上的送达状态可能对不上（只影响显示）；`notify-monitor.sqlite` 留在数据目录，其中未送达的告警不再发送。在本版里只删掉 `feishuMonitor` 时，告警改回 `feishu`，`notify-monitor.sqlite` 里残留的消息 7 天后清除，7 天内再加回会补发。

**超时与失败**：读取子进程与写入子进程各 30 秒超时，不重试，失败给原因；应用失败每 10 秒随检查重试。

**本批没做**：状态页不显示 `notify-monitor.sqlite` 的队列状态；导入的档位在工作台运行期间不自动同步（再导一次即替换）。

## M-3c：监控开关

对照工作台 `modules/monitor/server/monitor-control.mjs`（M11）与 `app/monitor-hub.tsx` 的「运行监控」开关。

**开关**：每个配置了的市场（Anthropic、原油、海力士）一个开关，存在 `monitor.sqlite` 的 `monitor_state`（键 `control.<市场>`，值 `{ version: 1, enabled, revision }`），重启后保留；没有记录时按开启。`config.json` 的 `monitor` 仍决定有哪些市场，开关只决定已配置的市场是否运行。

- `POST /api/monitor/<市场>/control`，请求体 `{ enabled, revision }`（须带页面请求标记）。`revision` 是页面上次读到的版本号，不一致时 409 `control_conflict`；已经是目标状态时原样返回（丢失应答后的重试无害）；先写入再生效，写入失败 503 `control_unsaved`，开关不变。字段不对 400 `invalid_control`，未配置的市场 404。
- `GET /api/monitor/state` 多一项 `controls`（各市场 `{ market, enabled, revision, error }`），状态页的 `monitor` 也带同一份。
- 保存值无法读取时按开启运行，`error` 给出原因（页面显示）；在页面点一次开关会保存为关闭并覆盖坏记录，需要运行时再点一次开启。

**关闭后**：该市场的采集循环在当前一轮结束后不再进入下一轮（每秒检查一次是否重新开启）；服务启动时已关闭的市场不跑首轮。原油、海力士的自动告警检查跳过（不判断阈值、不发飞书）。该市场 `/api/monitor/<市场>/…` 下的所有接口（报价、K 线、资金费、多交易所对比与结算历史、告警读取与保存、测试消息）回 423 `monitor_disabled`，所以关闭期间也不会按需去交易所读对比数据。历史 K 线、资金费记录、告警档位与发送记录都保留；重新开启后采集从断点继续补齐（K 线按各采集器原有的回补规则）。关闭期间从工作台导入的告警档位照常在 10 秒内换上（只换档位，不判断阈值）。重新开启后，告警按最近一笔未过期的报价恢复判断（关闭较久时要等采集器取得新报价），各档位按关闭前保存的越线状态比较（关闭期间导入过档位则从头判断，同页面保存），关闭期间越过的档位可能立即告警一次（仍受冷却时间限制）。关闭的市场下不存在的路径也回 423（不区分 404）。

**页面**：市场标签行右侧「运行监控」开关（`role="switch"`，文字 已开启 / 已关闭 / 保存中… / 重试切换），只有一个市场时标签行只显示开关。关闭时面板换成提示“××监控已关闭，行情采集、自动告警已暂停。配置和历史数据已保留，可通过上方开关重新开启。”（Anthropic 没有自动告警，只写“行情采集已暂停”），告警设置随面板一起隐藏。切换成功后立即显示服务返回的开关；被其他页面改过（409）或结果未知（超时、断网）时重新读取状态并提示核对。旧服务不返回 `controls` 时页面不显示开关。另一页面关闭时，本页最长 60 秒（状态读取间隔）后才换成提示，期间面板读取显示 423 的原因。

**影响面**：只涉及行情监控的采集、告警与读取接口；不碰交易、划转与 `notify.sqlite`。

**回滚**：`sudo bash install.sh --version v0.30.0`，不用改配置。v0.30.0 不认识 `control.*` 记录，所有已配置的市场照常运行；记录留在 `monitor.sqlite`，再升级回来时恢复各开关。

**本批没做**：开关不进飞书定时摘要；不支持定时开关。

## M-3d：Variational 腿与会话 token

对照工作台 `modules/monitor`（提交 `8470785`）：`lib/variational-api.ts`（token 到期解析、固定只读接口、拒绝与拦截的区分）、`lib/variational-market.ts`（认证标记价与公开预测资金费的解析）、`lib/oil-dex.ts` 的 `parseVariationalOilQuote` 与 `createOilDexReader` 里的 Var 部分（公开行情与认证行情的取舍、token 轮换）、`server/variational-session.mjs`（token 文件与更新）、`server/variational-transport.mjs` 与 `server/variational-request.py`（经 Python 标准库发请求）、`app/variational-session.tsx`（表单）、`app/exchange-comparison.tsx` 的 Var 行。

### M-3d-1：公开行情、预测资金费与页面保存的 token

**用户可见的变化**：原油「交易所实时对比」里 Variational 不再是“未接入”。

- 不填 token 也有价格：公开接口 `omni-client-api…/metadata/stats` 的 BZ / CL 标记价（没有行情时间，标“采集时间”）；预测资金费来自公开接口 `omni.variational.io/api/funding/v2`（年化小数，按 `资金费周期 ÷ 一年秒数` 换成每期费率，下次结算时间来自接口）。两者都不带 token。
- 填了有效 token：价格改用认证接口 `/api/quotes/indicative`（`qty = 1` 的标记价，带源时间，两腿时间相差超过 15 秒作废）。认证失败（只有 HTTP 401 且 `x-omni-auth: r` 才算 token 被拒）时本行退回公开价格，表单显示“会话已失效”；被 Cloudflare 拦截或网络失败不算 token 失效，显示“认证行情暂不可用”，同样退回公开价格。
- Var 行的身份格下多一个「更新 Var token」按钮，展开表单（照工作台 `variational-session.tsx`）：状态（尚未配置 / 已配置 / 已过期 / 会话已失效 / 认证行情暂不可用）、token 声明的到期时间与最近保存时间（UTC，同本页）、密码框、保存、刷新配置。token 只在密码框里，不进页面状态与浏览器存储；保存成功后清空输入框。
- Var 的年化不能点开结算历史（工作台同样没有：公开接口没有可核实的历史实际结算费率），格内是纯文本，说明里写明原因。海力士没有 Var 行，不变。

**接口**（都在登录检查之后，原油监控关闭时同其它原油接口回 423）：

- `GET /api/monitor/oil/exchanges/variational`：同其它交易所的一行。
- `GET /api/monitor/oil/exchanges/variational/session`：`{ available, configured, revision, expiresAt, updatedAt, status, error }`，不含 token。
- `POST /api/monitor/oil/exchanges/variational/session`（须带页面请求标记；工作台是 PUT，本服务的写接口统一用 POST）：请求体只能是 `{ token, revision }`。`revision` 与当前不一致 409（`session_conflict`）；token 格式不对、已过期或 30 秒内到期 400；距上次验证不足 3 秒 429；先用新 token 读一次 `/api/me`，Variational 确认有效（应答里带未过期的 token）才保存，否则 400 / 502 并说明“原配置未修改”；写文件失败 503，原配置保留。保存后下一次读取（页面每 15 秒）即用新 token，不用重启。

**存放**：数据目录 `monitor-variational-session.json`（`{ version: 1, revision, token, updatedAt }`，服务账户 600，先写临时文件再改名）。启动时文件过大、权限不是 600、内容无效时不读它（日志说明，状态显示“尚未配置”并带原因），Var 行照常用公开价格；页面保存一次即覆盖。与工作台相同不加密（资产账本的 vr-token 加密存放在库里，防的是库文件单独外泄；这里是单独的 600 文件）。资产账本里保存的 vr-token 与这里互不相干，各存各的（同工作台）。

**请求**：`omni.variational.io` 的三个接口经 `python3 -I -B scripts/variational-request.py` 发出（照工作台：标准库 HTTP 客户端，token 只经标准输入传入，不跟随重定向，只回传状态、三个应答头与 2 MB 以内的正文，出错只给退出码），`metadata/stats` 走本服务原有的 Node 请求。每个请求 10 秒超时、不重试；结果 5 秒内各页面共用（同其它交易所），认证行情按 token 版本分开缓存；没人看页面时不发请求。本机没有 `python3` 时认证行情与预测资金费不可用（公开价格照常），原因显示在本行。

**token 轮换与在途读取**（L089）：读取开始时记下 token 版本，读完发现版本已变（页面刚保存了新 token）就丢掉这次结果重读，最多两次，之后用公开价格；旧版本的读取结果不会把新 token 标成“已失效”。

**日志**：token、Cookie 与应答正文不进日志、接口错误与页面；失败按原因去重记一次，恢复记一次（同其它交易所）。保存 token 记一行“已更新 Var token（版本 N，声明到期 …）”。

**影响面（R3）**：

- 凭据：新增页面写入的会话凭据文件；token 只发往 `omni.variational.io` 的 `/api/me` 与 `/api/quotes/indicative`（固定路径、固定请求体，传输脚本再核对一遍），公开接口不带 token。vr-token 是网页会话凭据，本服务只发只读请求。
- 新增 `python3` 子进程（资产账本的 Var 余额已在用同样的做法），一次读取通常四个（两腿认证标记价、两腿预测资金费），token 轮换重读时认证读取最多四轮（有上限），各 10 秒内结束。子进程只拿到 `PATH`（同资产账本），服务环境里的代理设置不用于 Var 请求。
- 读取接口、缓存与日志沿用 M-2c；不碰交易、划转、通知队列、`monitor.sqlite` 与配置格式。

**失败与回滚**：读取失败只影响 Var 这一行。回滚 `sudo bash install.sh --version v0.32.0`，不用改配置；旧版本不读 `monitor-variational-session.json`，Var 行回到“未接入”，文件留在数据目录（不再需要时手动删除）。

**本批不做（登记）**：从工作台导入 token（M-3d-2）；token 到期前的飞书提醒；Var 进原油价差主图与告警（工作台也只在对比表里用）。

**测试计划**：解析（公开行情、认证标记价、预测资金费的手算核对、过期与不同步）；token 文件（权限、坏文件、原子写、版本冲突、过期、3 秒限频、`/api/me` 不确认时不保存）；传输脚本（白名单外的路径与请求头被拒、token 不出现在输出与错误里、超时与中止）；读取器（无 token 走公开、认证成功、401 被拒退回公开并标“已失效”、拦截不标失效、轮换中途丢弃旧结果）；接口（登录、请求标记、409 / 400 / 429 / 423）；页面（表单状态、保存清空输入、Var 年化不可点）。

**实施记录（v0.33.0）**：

- 数据规则 `src/vendor/variational-market.mjs`（复制工作台 `lib/variational-market.ts` 与 `lib/variational-api.ts`，差别写在文件头）；`exchange-comparison.mjs` 的原油对比加入 Var，`exchange-funding-history.mjs` 把 Var 排除在结算历史外（`supportsFundingHistory`）。
- 传输 `src/monitor/variational-transport.ts` 与 `scripts/variational-request.py`（逐字复制工作台脚本，只改说明），`deploy/package.sh` 把脚本打进发布包。
- token 文件 `src/monitor/variational-session.ts`；读取器 `src/monitor/exchanges.ts` 的 `readVariational`（认证价与公开资金费并行，资金费失败只空出年化）；接口在 `src/http.ts`。
- 页面：`web/src/MonitorExchanges.tsx` 的 Var 行与 `web/src/MonitorVariationalSession.tsx` 表单，见 [frontend.md](frontend.md)《行情监控页：Var 行与 token 表单》。
- 测试 `test/monitor-variational.test.ts`（解析、token、认证请求、读取器含轮换、token 文件、传输与真实 `python3` 脚本的拒绝路径、接口、页面数据规则）；`scripts/dev-monitor.ts` 接上替身 Variational。
- 与计划的差别：无。

### M-3d-2：从工作台导入 Var token

**用户可见的变化**：设置页「从工作台导入」的预览多一行“Var token”：工作台有没有 token、它声明的到期时间（UTC）、本服务现有 token 的到期时间、能否导入及原因；行情监控一节多一个勾选项“同时导入 Var token”。命令行 `sudo bash install.sh --import-workbench --monitor-variational`（可与 `--monitor-alerts` 同用）。只导入 token 时不重启，行情监控下一次读取（页面每 15 秒）即用导入的 token；同时启用或补全行情监控时照常改配置并重启。

**来源**：工作台 `<工作台数据目录>/modules/monitor/variational-session.json`（`server/variational-session.mjs` 写入，`monitor-services.mjs` 传入的目录即 `modules/monitor`，与 M-3b 读的告警文件同一目录）。照 M-3b：由以该目录属主身份、空环境运行的子进程读取，只读普通文件（符号链接不跟随），另加工作台自己的两条拒读规则：超过 16 KiB、权限不是 600。内容须是 `{ version: 1, token }` 且 token 能解析出到期时间；已过期或 30 秒内到期不导入。不联网验证（导入时 Variational 可能拦截服务器；读取器下一次用它时自然会标出“会话已失效”）。

**取舍**（导入替换本服务现有 token 的规则）：本服务没有 token、现有 token 文件无效（不包括只在内存里被 Variational 拒绝的判定，写入方看不到）或已过期 → 导入；与工作台的是同一个 token → 跳过（“已是同一个 token”）；本服务的 token 有效且声明到期不早于工作台的 → 跳过（“本服务的 token 更新”，页面保存过新的就不被旧的盖掉）；否则导入并替换。预览按导入前读到的状态给出结论，只比较到期时间（token 本身只有写入子进程同时看到两边），到期相同时写“多半是同一个 token”；写入时由写入子进程按当时文件再判断一次，结果与提示以写入子进程的实际判断为准。

**写入**：token 经标准输入交给以数据目录属主身份、空环境运行的 `src/monitor/variational-import-writer.ts write`（同 M-3b 的 `import-writer.ts`），它复核 token、按上面的规则判断，写 `monitor-variational-session.json`（600，先写临时文件再改名，`revision` 取现有文件的版本 + 1）。现有文件是符号链接、不是普通文件或不归服务账户时拒绝写入；判断之后、改名之前文件被别人换过（页面刚保存）时放弃写入并提示重试。顺序：账本 → 档位 → token → 配置；token 写失败时前面已写的保留、配置不改。token 不进导入结果、日志与命令行输出，结果里只有到期时间与原因。

**运行中的服务换上 token**：`variational-session.ts` 原只在启动时读文件；改为每次取用 token（读取器）和读状态（页面）时比较文件的设备号、inode、修改时间与大小，变了就重读一次，内容有效且与内存中的不同才换上（无效或被删掉时保留内存中的，日志记一次）。换上的 token 版本号若不大于内存中的，取内存版本 + 1：读取器按版本号共享结果，不同 token 不能共用一个号（导入在文件被删后写的是 1）。页面保存前先重读一次，等 Variational 期间落地的导入被这次保存以更大的版本号盖过；保存记下的是自己写的文件（取自写入句柄），之后别人换上的文件照样会被重读。页面自己保存时不触发重读。导入只写 token 文件、不改配置时不重启服务。

**页面请求**：`POST /api/import` 新增 `monitorVariational: true`，须和 `monitor: true` 一起发（同 `monitorAlerts`）；本服务配置没有原油监控（`monitor.oil`）时跳过并说明。

**影响面（R3：凭据）**：root 导入助手与安装脚本多读一个工作台凭据文件并写本服务一个凭据文件，读写各在降权子进程里完成，token 只经管道在内存中传递；`variational-session.ts` 多了按文件变化重读。不碰交易、划转、`monitor.sqlite`、配置格式与读取器的请求。

**失败与回滚**：读不到或不合格时只跳过 Var token，其它所选内容照常导入。回滚 `sudo bash install.sh --version v0.33.0`：旧版本不认 `monitorVariational` 与 `--monitor-variational`，已导入的 token 文件格式不变，旧版本启动时照常读取。

**测试计划**：来源读取（缺失、权限不是 600、过大、符号链接、坏 JSON、过期）；取舍规则（无 token、同一个、本服务更新、本服务过期）；写入子进程（复核、拒写符号链接与他人文件、版本 + 1、600）；会话按文件变化重读（导入后换上、无效文件不换、页面保存不重读）；导入助手与命令行的接线、请求校验；`deploy/test-install.sh` 的参数检查；页面勾选与请求体。

**实施记录（v0.34.0）**：照上文实现。页面：导入面板行情监控一节下加 Var token 表（`#importVariationalTable`）与勾选项（`#importVariationalPick`），版式照同一面板的告警档位表，时间按 UTC 显示（与原因文字、对比表一致）；勾选 token 时请求体自动带上 `monitor: true`。独立审查（后端、页面两路）无 P0/P1，P2 与 P3 的处理见 `docs/reviews/2026-11-14-monitor-m3d2.md`。剩余已知限制：写入子进程的“改名前复核”与改名之间仍有微秒级窗口，没有跨进程锁；落在这个窗口里时，页面刚保存的 token 会被导入的盖掉（日志里有两次写入，重新保存即可）。

## M-4：合约价差（永续全市场报价）

对照工作台 `modules/monitor/server/perpetual-service.mjs`、`modules/monitor/modules/perpetual/`（交易所适配、采集策略）与 `app/perpetual-panel.tsx`（工作台提交 `c84ba27`）。工作台的 M04 是其后 M05–M08（质量、机会、纸面、告警等）的数据源，这里只搬报价本身，其余留给 M-5。

### M-4a：采集器与接口

**范围**：`config.json` 的 `monitor.perpetual: {}`（不带设置）启用。服务端采集器 `src/monitor/perpetual.ts` 移植 `createPerpetualService` 的核心：
- 每 5 分钟按交易所发现一次合约目录（失败 30 秒后重试，同一家的重试不叠加；失败只在首次记一行日志，恢复前不再重复，恢复时记一行）。目录签名变化时（合约身份、乘数、频道）换一代订阅：旧一代的连接与重连计时一起作废，身份变了的旧报价剔除；只有下架、费率、分类字段变化时不重订阅，只更新报价上的元数据。
- 每份订阅计划一条 WebSocket：20 秒连接超时，断线指数退避重连（5 秒起、最长 60 秒，加抖动），心跳，看门狗（45 秒没有消息或只有心跳就重连），同一主机的辅助请求共享每分钟预算（Hyperliquid 遇错误时退避），带 `snapshot` 的计划另按间隔走 REST 盘口快照（8 秒超时）。
- 解析结果按字段各自的时间合并为每合约一条报价（`mergePerpetualQuote`，资金费更新不会刷新旧盘口），每秒提交一次。
- 每秒对所有读者广播一帧增量（`createPerpetualChangedPatch`，帧带 `baseSequence`），只含变化的合约；读者积压时下一帧改发全量，积压超过 4 MB 断开。

交易所适配原样复制到 `src/vendor/`：`perpetual-exchanges.mjs`、`perpetual-kraken.mjs`、`perpetual-additional-exchanges.mjs`、`perpetual-collection-policy.mjs`、`asset-identity.mjs`，以及摘自 `perpetual-service.mjs` 的合并与增量函数 `perpetual-stream.mjs`。每个文件头注明来源提交；类型声明另写在 `.d.mts`。共 11 家：Binance、Bybit、OKX、Bitget、Gate、Kraken、Hyperliquid、Lighter、Aster、Lighter RH、Entropy。

**接口**（GET，只校验登录 cookie）：
- `/api/monitor/perpetual/quote`：整张表，同工作台 `quote`（`{ schemaVersion, monitorId: 'perpetual', streamId, sequence, status, generatedAt, staleAfterMs, exchanges, quotes, storageError: null }`）。
- `/api/monitor/perpetual/summary`：概要，同工作台 `summary`（含 `available: true`），多一个 `running`，没有 CrossEx 过滤。
- `/api/monitor/perpetual/stream`：SSE。首帧为 `retry: 5000` 加全量（已有读者时取共享基线），之后每秒一帧 `{ type: 'patch', baseSequence, patches, removed, … }`；请求头带 `Accept-Encoding: gzip` 时整条流 gzip（同步刷新）。帧格式与工作台相同，M-4b 的页面照搬工作台的 `lib/perpetual-feed.ts` 消费。

未配置时 404。M-3c 开关同样适用：`POST /api/monitor/perpetual/control`；关闭后上面三个接口返回 423，提示“合约价差监控已关闭，行情采集已暂停；开启后重新采集”。状态页 `monitor.perpetual` 给出运行状态、报价数、读者数、连接数、各交易所状态与重连次数，并附 `summary`。

**开关与生命周期**：采集器不按“轮”跑，而是由自己的计时器和连接驱动。`monitorLoops` 为它起一个循环，每秒看一次开关：开启时 `start()`，关闭时 `stop()`。`stop()` 结束所有读者的流、关闭连接、清空报价，并换新的流编号，再次开启时从空表开始采集，不显示几小时前的价格。服务停止时同样 `stop()`。

**与工作台的差异**：
- 不持久化。工作台把报价存进 `market.sqlite`，重启后先显示旧报价；本服务只放在内存里，重启或关闭开关后从空表开始。因此不建库、不改库结构，`storageError` 恒为 null。
- 不搬：质量采样、资金费与价格历史、市场指标、扫描器数据、机会列表（v1/v2）、CrossEx 过滤、合约告警、纸面交易、深度与平仓估算、汇率、诊断指标。这些属于 M05–M08，留给 M-5。
- WebSocket 用 Node 自带的（支持自定义请求头，例如 Gate 的 `X-Gate-Size-Decimal`），不用 `ws` 包。它与 `fetch` 共用全局 dispatcher：服务环境设了 `NODE_USE_ENV_PROXY=1` 加 `HTTPS_PROXY` 时，REST 与 WebSocket 一起走代理（开发机上比对过连接去向：直连 443 的连接减少、代理端口的连接相应增加）；没设时直连。工作台用的是 `ws` 加 `https-proxy-agent`。
- 日志写标准错误（进 journal），只记合约列表失败与恢复：每家首次失败记一行，恢复前不重复记（旧一代连接照常出报价时也不重复），恢复记一行。连接断开、协议错误与重连次数不进日志（重连频繁，会刷屏），看状态页 `monitor.perpetual` 各交易所的 `error`、`lastProtocolError` 与重连次数。
- `perpetual-exchanges.mjs` 有两处修正：OKX 改连 443 端口；OKX 推送的 `notice` 消息（例如“8443 端口即将停用”）不再当作订阅失败。工作台 c84ba27 会因此不断重建 OKX 连接，始终拿不到 OKX 行情。

**影响面（R2）**：新增只读的公开行情采集，以及 `/api/monitor/perpetual/*` 接口。启用后常驻约 20 条 WebSocket，有持续的网络流量和 CPU 占用。没有凭据，不碰交易、划转、告警、`monitor.sqlite` 的结构与配置里的其他字段。未配置 `monitor.perpetual` 时什么都不启动。

**回滚**：`sudo bash install.sh --version v0.35.0`。如果配置里写了 `monitor.perpetual`，回滚前要先删掉这一项（只配了合约价差时删掉整个 `monitor`），否则 v0.35.0 会因为不认识这个键而拒绝 `monitor` 配置。开关记录 `control.perpetual` 留在 `monitor.sqlite`，旧版本会忽略它。

**测试计划**：替身交易所加替身 WebSocket（`test/monitor-perpetual.test.ts`），覆盖：发现与订阅；合并为每合约一条；控制消息回复；请求头与二进制类型；在线状态与概要；断线退避重连；消息无效时重连；合约列表失败；目录换代时剔除旧报价并重新订阅；停止后清空、不再重连、换流编号，再启动；停止时还在进行的合约发现在重启后才返回时丢弃（两种返回顺序）；旧一代断线后挂着的重连计时作废；合约列表失败只记首次与恢复；接口方面覆盖整表、概要、SSE 首帧与增量（序号连续，带 gzip 与不带；先到的与中途加入的读者按工作台 feed 规则拼回的表与服务端一致，含目录换代后的 `removed`；积压读者跳过增量、可写后发全量，超过 4 MB 断开；未运行时流立即结束；`Accept-Encoding` 的 `q=0`），未配置 404，关闭后 423 并结束读者的流，重新开启；配置解析与 `--check-config` 摘要；导入不补上 perpetual。交易所适配本身的解析正确性沿用工作台的测试，不在本仓库重复。

**本批没做**：页面（M-4b）；从工作台导入时启用（M-4b，随页面一起，避免导入后有采集却看不到）；持久化；M05–M08。只配了 `monitor.perpetual` 时，行情页现有的提示把它当作“没有配置行情监控”，M-4b 加标签后已能看到页面。

### M-4a 实施记录（v0.36.0）

照上文实现。启用方式暂时只能手写配置：在 `config.json` 的 `monitor` 里加 `"perpetual": {}`，然后执行 `sudo bash install.sh`。M-4b（v0.37.0）起「从工作台导入」一并启用。

在开发机上对真实交易所做过 20 秒冒烟。OKX、Gate、Bitget、Kraken、Aster、Hyperliquid、Lighter RH、Entropy 都能实时采集，每家报价数基本等于合约数（Hyperliquid 179 个合约中取到 81 条）。Binance（HTTP 451）、Bybit（403）、Lighter WebSocket（400，restricted jurisdiction）被开发机出口所在地区封锁，部署机能否连通取决于所在地区。


### M-4b：合约价差页面与导入

**对照**：工作台 `modules/monitor/app/perpetual-panel.tsx`、`perpetual-scanner-parts.tsx`、`hooks/use-perpetual-feed.ts`、`lib/perpetual-{types,feed,display,spreads,fees,fx,scanner}.ts`、`app/perpetual.css`、`app/perpetual-scanner.css`（提交 `c84ba27`）。

**范围**：
- 行情页加「合约价差」标签（名称同工作台 `lib/monitors.ts`），排在海力士之后；开关同其它市场。只配了 `monitor.perpetual` 时也能看到页面。
- 面板照工作台「发现机会」工作区的排版：标题“合约价差套利”与刷新按钮；工具栏（价格套利 / 资金费套利 / 全部报价三个视图、交易所多选、币种搜索、RWA / 加密 / 类别）；状态行（连接状态、组合或报价数、在线平台数、更新时间）；排名表与分页（每页 30 条）；全部报价表；“更多筛选与排序设置”里的价差排序、报价口径、平台组合。
- 排名表只保留单靠报价能算出来的列：类型、组合、资金费率、资金费差、年化、报价、开仓价差（毛价差，附按公开 taker 费率估算的净价差）、报价时间。
- 数据：照搬工作台的 feed（SSE 增量 + 断线时 20 秒快照轮询、序号校验、源时间时钟、每 20 秒刷新一次显示）与排名函数，原样复制，文件头注明来源；只有读取的 hook 改写：地址改为 `/api/monitor/perpetual/stream|quote`，快照读取走 `api.ts`（401 转登录、423 显示服务给的原因），页面隐藏时轮询放慢到 30 秒（同工作台独立打开时的行为）。
- 筛选与类别存浏览器 `localStorage`（键名同工作台 `market-monitor:perpetual:v1` 与 `market-monitor:perpetual-scanner:v1`，格式兼容）；视图与页码不存。写回全部筛选字段（`{ version: 2, ...filters }`），本页不用的（自选、屏蔽、跨计价币）读进来后按关闭处理、原样写回。
- 从工作台导入：行情监控补上 `monitor.perpetual`（与其它市场一样不需要密钥），预览写明“11 家交易所永续合约公开盘口，常驻约 20 条 WebSocket，报价只在内存”。已有配置没有它时同样补上；不想要可在行情页用开关关闭，或从 `config.json` 删掉。

**不搬**（属于 M05–M08，留给 M-5）：成交额、持仓量、所需资本、ROC、已结算资金费历史、质量列与质量依据、组合展开详情、价差图表与持仓跟踪工作区、自选与屏蔽、范围筛选、列选择与表头排序、跨计价币（汇率）、CrossEx 导入与屏蔽名单、报价健康、机会提醒、手动组合、推送开关。

**影响面（R2）**：只加页面与导入的一个市场；后端接口沿用 M-4a。导入后部署机多出常驻采集（见 M-4a 影响面）。

**回滚**：`sudo bash install.sh --version v0.36.0`，不用改配置（M-4a 已认识 `monitor.perpetual`；导入补上的这一项 v0.36.0 照常运行，只是没有页面）。

**测试计划**：导入补上 perpetual 的预览与结果文字、已有时保留；feed 与排名是原样复制，沿用工作台的测试，不在本仓库重复。浏览器在 `scripts/dev-monitor.ts`（加替身合约行情）上 1280 与 390 宽度走一遍：三个视图切换、交易所多选、搜索、翻页、价差排序与报价口径切换、关闭再开启开关、刷新后记住所选；无横向溢出（表格在自己的框内滚动）、无 CSP 报错。

#### M-4b 实施记录（v0.37.0）

按上面的计划实现，差别与补充：

- 页面 `web/src/MonitorPerpetual.tsx`、样式 `web/src/perpetual.css`、零件 `web/src/perpetual-scanner-parts.tsx`、读取 hook `web/src/use-perpetual-feed.ts`；排版、样式过滤方式与浏览器验证见 [frontend.md](frontend.md) 的「行情监控页：合约价差」。
- 开关刚打开的那一秒采集器还没启动，服务立即关掉 SSE；照搬的 feed 要 20 秒（快照）/ 30 秒（流）后才重试。hook 在服务回答 `unavailable` 期间每 3 秒重连并立即显示，开关重开后约 6–8 秒出数据。
- 导入：`planMonitor` 不再跳过 `perpetual`，预览写“合约价差（11 家交易所永续合约的公开盘口，常驻约 20 条 WebSocket，报价只在内存，不写数据库）”。已有 `anthropic`、`oil`、`hynix` 的配置再导入时补上 `perpetual: {}`，其余保留；测试 `test/import-modules.test.ts`、`test/monitor-perpetual.test.ts`（配置与导入）与相关导入测试的“已完整”配置随之加上 `perpetual`。
- 替身：`test/perpetual-fake.ts` 供 `scripts/dev-monitor.ts` 用；费率元数据放在合约目录里（同真实交易所模块：`takerFee*` 随目录进入报价，不随行情更新）。
- 跨计价币默认关闭（同工作台），CEX 用 USDT、DEX 用 USDC 计价时 CEX↔DEX 组合为空；跨计价币需要汇率，属 M-5。

## M-5：合约价差的其余功能（M05–M08）

对照工作台 `modules/monitor` 的 `server/perpetual-*.mjs`、`app/perpetual-*.tsx` 与 `lib/perpetual-*.ts`（提交 `c84ba27`）。按依赖与存储拆成六小批，每批都只在配置了 `monitor.perpetual` 时生效：

| 小批 | 内容（工作台对应） | 新增存储 | 依赖 |
| --- | --- | --- | --- |
| M-5a | 采集器内的按需盘口服务：成交校验（depth）、平仓测算（exit）、现货汇率（fx）；页面的组合展开详情、跨计价币、手动配对（M07） | 无 | M-4 |
| M-5b1 | 市场指标（market-metrics、metrics-reader）：成交额、持仓量列；所需资本与 ROC（含设置）；列选择；表头排序（只开放报价能算的列） | `perpetual-cache.sqlite` 的 `contract_metrics_cache` | M-4 |
| M-5b2 | 资金费历史与汇总（funding-history、funding-reader、scanner-data）：24h / 7天 / 30天实际资金费列与展开详情的已结算资金费；范围筛选；成交额、持仓量与历史列的全量排序 | 同一文件的 `funding_history_cache` | M-5b1 |
| M-5c | 价格历史与价差图（price-history、price-reader、图表工作区；资金费稳定度读 M-5b2 的资金费历史） | 同一文件的 `price_history_cache` | M-5b2 |
| M-5d | 质量采样与质量依据（quality：含 CoinGecko 与多空比请求）、手续费与滑点预算设置 | 同一文件的 `quality_samples` | M-5b1（缓存库、列与排序框架） |
| M-5e | 模拟与手工持仓跟踪（paper）：展开详情「平仓与跟踪」的登记、持仓跟踪工作区 | `monitor_state` 的一个键 | M-5a |
| M-5f | 机会列表 v1/v2、现货划转证据、CrossEx 设置（opportunities、spot-transfer、crossex-settings） | 待定 | M-5a（汇率） |

CrossEx 的机会来源（C5）与导入预填属 M13，按 R3 单独做（见 [crossex.md](crossex.md)）。

### M-5a：按需盘口、跨计价币与手动配对

**对照**：工作台 `server/perpetual-depth.mjs`、`lib/perpetual-{execution,exit,fx,fees,types,manual-pairs}.ts`、`hooks/use-perpetual-fx.ts`、`app/perpetual-{execution,exit,manual-pairs}.tsx` 与其 css、`app/perpetual-panel.tsx` 的行展开部分（提交 `c84ba27`）。

**范围**：
- 服务：把工作台的按需盘口服务（`createPerpetualExecutionService`）放进合约价差采集器，报价与合约目录直接取采集器内存。接口 `POST /api/monitor/perpetual/depth`（两腿按金额读公开盘口，估算成交均价与价差）、`POST /api/monitor/perpetual/exit`（按登记的开仓数量与价格估算现在平仓的净收益）、`GET /api/monitor/perpetual/fx`（USDC、USD1、USDG 对 USDT 取 Gate 现货一档，USD 取 Kraken USDTUSD）。须登录，POST 带页面请求标记；关闭开关时 423，采集器未运行时 503，参数无效 400，合约身份已变 409，上游限流 429，其它上游失败 502；拒绝都带服务的原因。
- 页面：排名行末加展开按钮。展开时冻结当前快照、排名与页码并停掉行情连接（时钟照走，报价按时过期），页签「成交与持有」（按金额校验盘口）、「平仓与跟踪」（只有测算）、「各平台报价」（同币种各平台报价）；两腿有下架安排时显示下架提示。筛选、翻页、切换视图或「收起并恢复」都会收起。
- 跨计价币：「更多筛选与排序设置」加「计价币范围」（仅相同计价币 / 跨计价币 · 按现货汇率校正），选跨计价币时每 60 秒读一次汇率，排名按汇率换算，状态行下方显示汇率时间与每条汇率的来源时间与买卖价。
- 手动配对：「监控工具与设置」里加手动配对（自选两个合约与换算倍数，独立算双向价差），只存浏览器 `localStorage`（键 `market-monitor:perpetual-manual-pairs:v1`，同工作台）。

**不搬**（留给后续小批）：质量依据页签与质量列（M-5d）、持有情景与价差趋势（M-5b/M-5d）、价差图表按钮（M-5c）、平仓页签里的登记与持仓跟踪工作区（M-5e）、CrossEx 导入与屏蔽、提醒、手续费设置。

**影响面（R2）**：服务端新增三个只读接口，都按需访问交易所公开接口：盘口查询全站最多同时缓存 10 个市场、请求有全局速率预算（工作台原值），汇率结果缓存 60 秒；不写数据库、不碰账户与凭据。Lighter / RH Lighter / Kraken 的盘口经 WebSocket 读取（Node 自带 WebSocket，随 `NODE_USE_ENV_PROXY` 走代理）；这三家的真实 WebSocket 盘口路径只在替身上走过（替身拒绝连接），登记为待实测（[plan.md](plan.md) 第 6 节）。页面只在展开详情时多一次手动查询。

**回滚**：`sudo bash install.sh --version v0.37.0`，不用改配置（没有新增配置与存储）。

**测试计划**：工作台 `tests/perpetual-execution.test.mjs`（从 `server/perpetual-depth.mjs` 导入）、`perpetual-exit.test.mjs`、`perpetual-manual-pairs.test.mjs` 移植为 `test/perpetual/{execution,exit}.test.mjs`、`web/test/perpetual/manual-pairs.test.mjs`（只改导入路径）；本仓库补采集器与接口测试（未运行 503、参数 400、身份变化 409、POST/GET 方法、未配置 404、关闭后 423、停止后再启动换新的查询服务）、Node WebSocket 适配器、页面与服务端两份 lib 的一致性。浏览器在替身后端（`test/perpetual-fake.ts` 加替身盘口与汇率）上 1280 与 390 宽度走一遍展开、校验、平仓测算、各平台报价、收起恢复、跨计价币与汇率详情、手动配对增删。

#### M-5a 实施记录（v0.38.0）

按上面的计划实现，差别与补充：

- 工作台 `lib/perpetual-{types,fx,fees,execution,exit}.ts` 原样复制到 `src/vendor/`（发布包不含 `web/src`，服务端要用就得放在 `src`）；`server/perpetual-depth.mjs` 复制为 `src/vendor/perpetual-depth.mjs`，只改导入路径，并把默认的 `ws` 库换成 `NodeWebSocket`：继承本仓库已有的 ws 兼容适配 `src/vendor/crossex/node-ws.mjs`（`binaryType = 'arraybuffer'`，文本帧与二进制帧都以 `Buffer` 交付，原文件的 `String(raw)` 照常解码），选项取工作台 `PerpetualWebSocket` 的 `maxPayload` 8 MB 与握手 20 秒。页面的 `web/src/perpetual-{types,fx,fees}.ts` 与 `src/vendor` 的副本由测试比对一致；页面新文件直接从 `src/vendor` 引入 execution 与 exit。
- 汇率按需读取：工作台在服务端每 60 秒常驻刷新一次汇率（供机会列表的 `peekFx`）；本批只有页面要汇率，改为请求时读、缓存 60 秒，常驻刷新留到 M-5f 需要 `peekFx` 时再加。
- 页面：`web/src/PerpetualExecution.tsx`、`PerpetualExit.tsx`、`PerpetualManualPairs.tsx`、`use-perpetual-fx.ts`；请求走 `api()`（带页面请求标记，401 转登录，失败显示服务给的原因）。平仓测算的输入字段与默认值同工作台模拟仓位（展开时快照的多腿卖一、空腿买一，1000 USDT），去掉登记方式切换与登记按钮。
- 样式：三份组件 css 原样复制；`perpetual.css` 按新增的类重新过滤（展开列、详情行、页签、汇率提示），末列恢复为展开按钮后，M-4b 删去的 `th:last-child` 规则也照工作台保留。补了一段：工作台的监控模块在 iframe 里，详情按 `100vw` 限宽；本服务左侧有导航栏，改为按表格容器宽度（容器查询 `100cqw`），否则 1280 宽度下详情右侧被裁掉。
- 手续费与滑点预算用工作台默认值（`defaultQualityBudget`：公开 taker 费率、0.10% 滑点），可调的设置面板属 M-5d。

### M-5b1：市场指标、所需资本与 ROC、列选择与表头排序

**拆分**：工作台的资金费历史、市场指标与汇总接口合计约 3,000 行（服务端约 1,450、页面约 1,700），一次搬完不利于审查与验收，按功能拆成 b1（指标、资本、列与排序框架）与 b2（资金费历史、汇总接口与范围筛选、依赖汇总数据的全量排序）。b1 不需要汇总接口：成交额与持仓量只读当前页 30 个组合，排序只开放报价能算的列。

**对照**：工作台 `server/perpetual-{market-metrics,metrics-reader,store}.mjs`、`lib/perpetual-{market-metrics,market-metrics-feed,contract-data-feed,capital,scanner-sort,scanner-filters,funding-history}.ts`、`lib/read-activity.ts`、`hooks/use-perpetual-market-metrics.ts`、`server/capital-metrics.mjs`（project-aggregation 仓库根）、`app/perpetual-scanner-parts.tsx` 的指标单元格、`app/perpetual-panel.tsx` 的列菜单、表头排序、资本与 ROC 部分（提交 `c84ba27`）。

**范围**：
- 服务：采集器内建一个市场指标服务（工作台 `createPerpetualMarketMetricsService` 与读取器原样复制），跨开关启停复用：开关打开时启动、关闭时停止（中止在途请求并写回缓存），页面读过的合约每 30 秒刷新 24h 成交额与持仓金额，各交易所限速、限流退避与失败退避同工作台。接口 `POST /api/monitor/perpetual/metrics`（至多 30 个组合，返回各腿的成交额、持仓金额、来源与时间）：须登录、带页面请求标记；关闭开关 423，采集器未运行 503，组合无效 400。
- 缓存：数据目录新增 `perpetual-cache.sqlite`（工作台的 `publicCache` 写法：`contract_metrics_cache(id, updated_at, payload)`，gzip JSON，至多 5000 行，WAL、`busy_timeout=100`），只有服务进程写；与 `monitor.sqlite` 分开，指标写入不和告警、开关、导入争锁。打不开时只用内存，接口带 `storageError`。b2、M-5c、M-5d 在同一文件加表。
- 页面：「显示列」菜单与「恢复默认列」（列偏好沿用 `market-monitor:perpetual-scanner:v1` 的 `columns`，b1 只列出已实现的列，没实现的列保留在存储里）；成交额、持仓量两列（多空两腿，点按钮弹出来源与时间，过期标灰）；所需资本、ROC 两列与详情行的资本说明；「监控工具与设置」加 ROC 杠杆、保证金缓冲、持有小时（键 `market-monitor:perpetual-capital-assumptions:v1`）；表头排序（键 `market-monitor:perpetual-scanner-sort:v1`），b1 可排资金费差、年化、报价（分多空腿，跨计价币按汇率）、开仓价差、所需资本、ROC；存储里是 b2 才有的排序列时按默认排序显示、不改存储。报价时间列照工作台默认隐藏，可在「显示列」打开。

**不搬**（b2 及以后）：资金费历史三列与展开详情的已结算资金费、范围筛选面板、成交额与持仓量与历史列的排序（要对全部候选组合读指标，靠汇总接口）、质量列（M-5d）。

**影响面（R2）**：新增一个只读接口与常驻的按需采集：只采页面读过的合约（缓存至多 500 个，按最近访问淘汰），每家交易所串行、间隔 350 ms，每秒至多 30 次读取，多数交易所走批量行情接口；新增一个可丢弃的缓存库文件。不碰凭据、交易、划转与 `monitor.sqlite`。

**回滚**：`sudo bash install.sh --version v0.38.0`，不用改配置；旧版本不读 `perpetual-cache.sqlite`，留在数据目录无害，可手动删除。

**测试计划**：移植工作台 `tests/perpetual-{market-metrics,metrics-reader,market-metrics-feed,scanner-sort,cache-store}.test.mjs` 与 `tests/capital-metrics.test.mjs`（只改导入；缓存库测试改测本仓库的缓存模块）；本仓库补采集器与接口测试（未运行 503、组合无效 400、未配置 404、关闭 423、开关重开后继续用同一缓存、停止时写回）、缓存库打不开时退化为内存。浏览器在替身后端（替身指标接口）1280 与 390 宽度走一遍列菜单、指标列与悬停、资本与 ROC 设置、表头排序与刷新后记住。

#### M-5b1 实施记录（v0.39.0）

按上面的计划实现，差别与补充：

- 工作台 `server/perpetual-market-metrics.mjs`（指标服务）复制为 `src/vendor/perpetual-market-metrics-service.mjs`（同目录已有 `lib/perpetual-market-metrics.ts` 的复制，改名避免同名）；`metrics-reader.mjs`、`capital-metrics.mjs`、`lib/perpetual-{market-metrics,funding-history}.ts` 原样复制到 `src/vendor/`，`.mjs` 配 `.d.mts` 类型声明。
- 缓存库：`src/monitor/perpetual-cache.ts`，表与写法同工作台 `publicCache`；本批只建 `contract_metrics_cache`。打不开（如路径被目录占用、磁盘只读、文件损坏）时服务照常启动，指标只存内存，日志写明原因，指标接口的每个回复带 `storageError`（页面在表格上方提示）；文件损坏不会自动重建，停服务后删掉该文件即可（只丢缓存的公开数值）。
- 接口：`POST /api/monitor/perpetual/metrics`（带页面请求标记），请求体 `{ pairs }` 至多 30 组；采集未运行返回 503「合约价差采集未运行，开启后再读取市场指标」，请求格式错误 400，其它错误 500。页面把服务给的原因放在提示里。
- 停止：关闭开关时中止在途请求并写回缓存；服务进程退出时 `settleMonitor` 至多等 2 秒让写回完成，再关闭数据库。
- 页面：`web/src/use-perpetual-market-metrics.ts`（请求走 `api()`，401 转登录）；`read-activity.ts` 为独立页版本（页面隐藏时读取间隔至少 30 秒、离线停读，不接宿主的读取活动）；`lib/perpetual-{capital,scanner-sort,scanner-filters,contract-data-feed,market-metrics-feed}.ts` 复制到 `web/src/`，只改导入路径（服务端也用的文件从 `src/vendor/` 引入）。
- 排序：表头排序只开放报价能算的六列（资金费差、年化、报价、价差、所需资本、ROC）；存储里若是成交额、持仓量或历史列（工作台写入的），本批按默认排序显示、不改存储，b2 开放后自动生效。排序需要汇率时按需读取汇率并提示缺失。
- 替身：`test/perpetual-fake.ts` 加指标接口（Binance、Bybit、Hyperliquid 给数值，OKX 与 Lighter 抛错以展示“更新失败”）。
- 测试：工作台缓存库测试不移植（测的是工作台的 store），改由 `test/monitor-perpetual-metrics.test.ts` 测本仓库缓存模块，同文件覆盖采集器启停与重开读缓存、服务层缓存打不开时只存内存、接口的 401/403/503/400/404/423。
- 常驻采集：页面读过的合约登记后不会因页面关闭或闲置而过期，重启后从缓存库读回最近的 500 个继续采；只有关闭合约价差开关才停。频率有上限：批量行情接口每 30 秒一轮，Binance 持仓与 OKX K 线按 5 分钟分桶缓存，每家交易所串行、间隔 350 ms。
- 下架组合：服务端对含已到下架时间的腿的批次整批返回 400（工作台规则，原样保留）；页面不为这类行请求指标（下架时间提前 5 秒算，抵消页面时钟与服务端到达时刻的差；单元格显示“已下架”），避免整页指标失败。目录变化导致报价被删、页面快照还没更新的短暂窗口里仍可能整批失败一轮，60 秒后重试恢复；展开详情冻结期间行不更新，这种失败会持续到收起。
- 401：指标读取在登录失效后仍按 60 秒间隔重试（面板在登录提示后面不卸载），重新登录后自动恢复；与汇率读取（401 后停）不同，是有意的。
- 停机：`settleMonitor` 排在告警的最终写入之后，最坏 20 + 5 + 2 秒，仍在 systemd 默认 30 秒停止时限内；通常关闭开关时写回已开始，这里立即返回。
- Lighter 与 Aster 的持仓金额口径工作台标为待核实，显示“暂无数据”，同工作台。
