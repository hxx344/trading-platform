# Monitor 模块：实施方案 v1.0

2026-11-13 用户决定：工作台原有的各模块都要在本仓库里具备（不在工作台上替换）。Monitor（行情监控）按下面的批次接入，只在 `config.json` 配置了 `monitor` 时启用；未配置时服务行为不变。

对照的工作台代码：`modules/monitor`（工作台提交 `7745181` 时的内容）。工作台 Monitor 的功能编号 M01–M14 沿用。

## 当前状态（v0.25.0）

- 已发布：M-1（Anthropic 价差）随 v0.12.0；v0.15.0 起在设置页「从工作台导入」里启用。M-2a（原油价差）随 v0.20.0。M-2b（海力士溢价）随 v0.21.0。M-2c（多交易所对比）随 v0.23.0。M-2d（已结算资金费历史与多空资金费图）随 v0.24.0。M-2e（技术指标）随 v0.25.0。
- 进行中：M-2（原油价差与海力士行情），剩对比表各交易所的结算历史（M-2d-3），方案见下文《M-2》。
- 未开始：M-3 至 M-6（见下表）。
- M-1 没做：成交标记、股数从交易中心同步、概览卡片与告警（均线 / 布林带 / Z-score 随 M-2e 补上）。

## 批次

| 批次 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| M-1 | Anthropic 价差（M03）：Binance、Hyperliquid（xyz:ANT、io:ANTH）、Lighter RH 四条腿的报价与 15 分钟 K 线，每股口径溢价；只读公开接口，无凭据、无告警 | R2 | 完成（Linux CI 通过），随 v0.12.0 发布 |
| M-2 | 原油价差与海力士行情（M01、M02），分 M-2a–M-2e 五小批（见下文），Var 腿先降级为“未接入” | R2 | M-2a 已发布（v0.20.0），M-2b 已发布（v0.21.0），M-2c 已发布（v0.23.0），M-2d 已发布（v0.24.0），M-2e 已发布（v0.25.0），M-2d-3 未开始 |
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
| M-2d | 资金费：原油 Binance 已结算资金费（4 小时）与海力士 Hyperliquid 小时资金费历史、多空资金费图 | 已发布（v0.24.0）；对比表各交易所结算历史另成 M-2d-3 |
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
