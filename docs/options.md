# 期权 Greeks 模块：实施方案 v1.1

2026-11-13 用户决定：工作台“期权 Greeks”（`modules/greeks`，Bybit BTC 期权铁鹰 / 卖出宽跨）作为本仓库第三个模块接入，第一批直接做到实盘下单（R3，两路独立审查；实盘首次运行须用户当次在页面上操作）。

同日用户决定跳过 G1d 实盘测试，继续做第二批 G2，分三次发布：G2a 周五定时开仓与 IOC 兜底，G2b “收益”页盈亏台账与采样，G2c 组合询价 RFQ。

## 1 范围

| 第一批 G1（v0.11.0） | 第二批 G2 |
| --- | --- |
| Bybit 期权客户端（行情、下单 / 改单 / 撤单、订单与成交、持仓、平仓历史、账户与组合保证金） | 组合询价 RFQ（G2c） |
| 期权链行情：10 s 刷新报价、1 h 刷新合约、30 s 过期 | “收益”页的盈亏台账与采样（G2b） |
| 策略：最近周日到期，卖腿 delta 0.45，铁鹰护翼 delta 0.10；最大亏损 / 保证金预算 | 周五定时自动开仓（G2a，v0.13.0） |
| 计划（30 s 有效）→ 确认任务（请求编号幂等）→ 各腿跟随盘口限价单、停止、净价与风险预留、重启恢复、15 s 对账 | IOC 兜底（G2a，v0.13.0，默认关闭） |
| 跟踪策略：按成交累计各腿数量，平仓只平跟踪数量；只有交易所平仓历史证明已平才退役 | 不做：旧版无订单跟踪策略的成交回溯恢复（导入已拒绝有跟踪策略的状态） |
| 账户保证金健康度（含组合保证金明细与开仓前基线）、持仓与持仓 Greeks、近期成交 | 不做：演示模式（本服务只有实盘） |
| 飞书：任务确认、结束（完成 / 部分 / 停止 / 失败）、转人工 | |
| 页面 `#/options`：执行台、持仓、组合执行三栏，照工作台排版 | |
| 从工作台导入期权密钥与参数（命令行 `--options` 与页面勾选） | |

## 2 业务规则（与工作台 `modules/greeks/app` 提交 160e932 一致，下单顺序除外）

- 合约：Bybit `category=option`、`baseCoin=BTC`；BTC 指数取 `linear` `BTCUSDT` 的 `indexPrice`。
- 选腿：只看未来最近的周日（UTC）到期；卖出 Call、卖出 Put 各取 |delta| 最接近 0.45 的行权价，须卖 Put 行权价 < 卖 Call 行权价；铁鹰再买入行权价在卖腿外侧、|delta| 最接近 0.10 的 Call / Put。四腿（宽跨两腿）数量相同。
- 实盘开仓只允许周五（UTC），且到期日须是本周日。
- 风险：铁鹰最大亏损 = 最宽一翼 × 数量 − 按执行价算的权利金，须 ≤ `maxRiskUsd`，保证金估算也须 ≤ `maxRiskUsd`；卖出宽跨亏损无上限，按 Bybit 官方期权下单初始保证金公式算的卖腿保证金（含缓冲）须 ≤ `maxMarginUsd`。执行中按见过的最差价格持续预留，超出即停止该任务后续下单与改价。
- 净价：开仓计划默认“最低净收入” = 按被动价（买腿买一、卖腿卖一）估算的净权利金扣手续费；平仓默认“最高净支出”。确认时可改。手续费估算 = min(费率 × 指数, 封顶比例 × 价格) × 数量。执行中按各腿最差价格预留，突破即停止后续下单与改价。
- 下单：每腿一张 GTC 限价单（买腿挂买一、卖腿挂卖一，按最小价格步长四舍五入），盘口变化就改价，每 1 s 看一次；`orderTimeoutSeconds`（默认 600）后撤单并核对（最多 5 次、间隔 1 s）。订单编号 `tpo-<任务>-<序号>`，平仓 `tpo-close-<任务>-<序号>`，平仓单 reduceOnly。订单状态同时查实时与历史两处，两处都查不到算“未知”，不当作已撤。
- 下单顺序（与工作台不同，2026-11-13 用户决定）：先买后卖。开仓先下两条买翼，全部成交后才下卖腿；平仓先买回卖腿，全部成交后才卖出买翼。买入腿没有全部成交（停止、净价或风险超限、行情过期、超时、结果未知）时卖出腿不下单，任务按已成交情况记为部分成交、已停止或失败（买入腿结果未知时为待核对），铁鹰任何时候都不会留下无保护的卖出，最坏是多出已付权利金的买翼。两轮各有 `orderTimeoutSeconds`，总执行时间最长约为两倍；卖腿不再检查开仓日期，周五临近午夜确认时卖腿可能在周六挂出（到期日仍是本周日）。卖出宽跨开仓只有卖腿、平仓只有买腿，各一轮。工作台四腿同时挂单。
- 定时开仓（G2a，同工作台 `scheduler.py`）：开关打开时每 5 s 检查一次；在周五（UTC）`openHourUtc:openMinuteUtc` 起 `openWindowSeconds` 秒的窗口内、本 ISO 周还没开过，就按当前设置（策略、每腿数量、上限）生成开仓计划并以请求编号 `scheduled-<ISO 周>` 提交，最低净收入用计划默认值。受理时再查一次窗口，下第一单前再查一次，过了窗口不下单。每周最多受理一次（受理即记入本周，结果是部分成交或失败也不再补开）。窗口内被拒（有未结束任务或订单、跟踪中的策略、行情过期、超出上限等）每 5 s 重试，同一原因只记一次日志；窗口结束仍未开出时发一条飞书“本周定时开仓未执行”。开关默认取 `config.json` 的 `options.autoOpen`（缺省关）；页面上切换后存进 `options.sqlite`，此后以页面为准，改 `config.json` 不再起作用：紧急关闭在页面上操作，页面打不开时从 `config.json` 删掉整个 `options` 停用期权模块。关闭定时不会停止已受理的定时任务（在“组合执行”里停止）。在窗口内打开开关，下一次检查（约 5 s）就会开仓，确认框会提示。打开前页面弹出确认，列出时间、策略、数量、上限与 IOC 设置。
- IOC 兜底（G2a，同工作台 `orders.py` market=True，`options.marketFallback`，缺省关）：只用于没停止的开仓任务，某腿超时撤单后结果是部分成交或未成交、且任务没有因净价或风险超限停止时，等 0.8 s 不撤单再读一次原单，剩余数量符合交易所最小 / 最大数量与步长，就发一张 IOC 限价单：买入挂卖一向下取整到价格步长、卖出挂买一向上取整。下单前按这个价格做净价与风险预留，超出就不发。只发一次，不重发；发出后读回，仍未结束则撤单再读。订单编号 `tpo-ioc-<任务>-<序号>`。与“先买后卖”的关系：IOC 在各腿所在的那一轮里执行，买入腿含 IOC 全部成交才下卖腿。注意：默认的最低净收入是按被动价估算的，对手价 IOC 通常会突破它而被拦下；要让 IOC 真正生效，需在手动确认时调低最低净收入。定时开仓用的是默认值，所以定时任务的 IOC 一般不会发出（与工作台相同）。
- 交易所拒绝码按接口白名单判定（同工作台 `bybit.py`）；其他错误码、超时、5xx 都算“结果未知”，只能靠核对订单解决，不重发。
- 任务状态：进行中 accepted / running / stopping / recovering / recovery_needed；结束 completed / partial / stopped / failed。有未结束的订单或任务时不接受新计划。重启时进行中的任务改为 recovering 并请求停止，由对账循环撤单核对后结束。
- 跟踪策略：开仓成交累加到 `symbol|side` 数量，平仓成交扣减；平仓计划只平跟踪数量（不超过交易所持仓）。持仓里看不到某腿时，查交易所平仓历史（每次 7 天窗口，最多回溯 180 天），数量够了且再次读持仓仍看不到，才把该腿退役；全部退役则策略结束。
- 唯一写者：工作台与本服务不协调。切换前须在工作台关闭自动开仓、处理完所有订单 / 任务 / RFQ 并平掉或接受跟踪策略后再导入（导入时检查）。本服务和原油模块可以使用同一个 Bybit 账户（期权与 USDT 永续互不影响），但工作台期权模块此后不能再用该账户下期权单。

## 3 架构

- 代码：`src/options/`（`client.ts` 期权客户端，`market.ts` 期权链，`strategy.ts` 选腿、预算与风险，`account.ts` 持仓 / Greeks / 账户健康，`orders.ts` 跟价下单与核对，`engine.ts` 计划 / 任务 / 对账 / 跟踪策略，`store.ts` 状态库），服务接线 `src/service/options.ts`、`options-config.ts`。
- 状态：单独的 `options.sqlite`，一行 JSON 状态文档（版本 1，带账户 UID；G2a 加 `schedule`：页面开关、本周已开、最近一次被拒原因与飞书提醒周，旧文档读入时补默认值），每次变更整体写入（WAL + synchronous=FULL），对应工作台原子写的 `engine_state.json`。主库不迁移，回退时不受影响。状态文档损坏或 UID 不符时拒绝启动。
- 配置 `config.json` 新增可选 `options`：`{ accountId, limits: { maxRiskUsd, maxMarginUsd }, legQty?, strategyMode?, marginMode?, orderTimeoutSeconds?, feeRate?, marginBufferPct?, autoOpen?, openHourUtc?, openMinuteUtc?, openWindowSeconds?, marketFallback? }`（缺省同工作台：1、iron_condor、REGULAR_MARGIN、600、0.0003、0.10、false、21、0、60、false；`openWindowSeconds` 1–300）；密钥 `secrets.json` 新增 `bybitOptions: { apiKey, apiSecret }`。`pairs`、`oil`、`options` 至少有一个。
- 启动：配置了 `options` 时取进程锁 `pa-options/bybit/<UID>`，读 `query-api` 检查密钥（读写、绑定 IP、只开合约交易 / 期权交易 / 统一账户衍生品，钱包、现货等都关闭）、统一账户、UID 与配置一致（30 s 上限），失败拒绝启动（安装时自动回退旧版本）。
- 循环：期权链每 10 s（单次 10 s 超时、失败保留上次结果并记日志）；定时开仓每 5 s（G2a）；对账每 15 s（核对未结束订单 → 结束已恢复的任务 → 同步持仓与退役）；账户健康每 15 s。
- 外部调用：每个 HTTP 请求 10 s 超时；只读请求不重试（下一轮再读），签名写请求只在时间戳被拒（10002，证明未执行）时同步时钟后重发一次。
- 结果未知的订单：对账撤单后读实时与历史订单。下单应答丢失、从未拿到订单号，发出已超过 2 分钟（Bybit 接收窗口 5 s）且不到 6 天（历史订单默认只查最近 7 天）、每次读取都明确查无此单时，按未下单（成交 0）结算；有订单号的始终保持未知、转人工。订单编号前缀为 `tpo-`（工作台为 `ic-`），回退后工作台不会把本服务的成交认成自己的。
- 接口（须登录，未配置 `options` 时 404）：`GET /api/options/market?expiry=`（期权链、到期日列表、指数、新鲜度）、`GET /api/options/preview?quantity=&mode=`（策略预览）、`GET /api/options/state`（任务、订单、跟踪策略、持仓与 Greeks、账户健康、对账状态、近期成交、参数）、`POST /api/options/plans`、`POST /api/options/tasks`、`POST /api/options/tasks/<任务>/stop`、`POST /api/options/auto-open`（`{ enabled: boolean }`，G2a；状态里的 `schedule` 给出开关、来源、时间、下次时间、窗口状态与本周未执行原因）。
- 飞书：任务确认、结束、转人工各一条（同一任务同一状态只发一次，经 `notify.sqlite` 发件箱）；定时任务标题写“期权定时开仓任务”；本周定时开仓未执行一条（每周最多一次）。
- 页面：顶部“期权”标签只在 `GET /api/options/state` 有应答时出现。排版照工作台 `modules/greeks/app/static/index.html`：执行台（指标行、期权链、策略腿与到期收益图、Greeks 汇总、执行控制、账户保证金健康度）、持仓（持仓、近期成交）、组合执行（进行中 / 历史任务卡片）。样式复制自工作台 `modules/greeks/app/static/style.css`，加 `.options-desk ` 前缀。确认对话框：腿、金额、净价限制输入、风险说明、勾选确认后提交；请求编号沿用 RequestIds。表单到请求的转换在不依赖 DOM 的 `web/src/options-form.ts`。G2a：执行控制底部“计划开仓”一行显示定时状态与下次时间，带打开 / 关闭按钮；顶部提示条显示“定时开仓 周五 HH:MM UTC”或“只手动开仓”（打开 IOC 时加“+ IOC 兜底”），本周未执行时显示原因；委托明细里 IOC 单标“IOC”，定时任务卡片标“定时”。
- 导入：读工作台 `DATA_DIR/modules/greeks/.env`（叠加 `/etc/project-aggregation.env`，键名不分大小写）取 `BYBIT_API_KEY`、`BYBIT_API_SECRET` 与 `MAX_RISK_USD`、`MAX_MARGIN_USD`、`LEG_QTY`、`STRATEGY_MODE`、`MARGIN_MODE`、`BBO_ORDER_TIMEOUT_SECONDS`、`ESTIMATED_TAKER_FEE_RATE`、`PORTFOLIO_MARGIN_BUFFER_PCT`；读 `engine_state.json`。拒绝条件：工作台 `AUTO_OPEN` 开着（环境文件里，或运行中的模块进程环境里：以 `app.main:app` 运行、`STATE_FILE` 指向该状态文件的进程，读 `/proc/<pid>/environ`，读不到即拒绝；改了文件没重启模块同样拒绝）、不是实盘主网（`TRADING_MODE`/`LIVE_TRADING`/`BYBIT_TESTNET`）、有未结束订单、有进行中任务、有未完成 RFQ、有跟踪中的策略、状态文件无法解析。UID 导入时用密钥读一次 `query-api` 取得（与启动检查同一套权限 / IP / 统一账户检查，15 s 上限，失败即不导入）。已有 `options` 时不覆盖；`secrets.json` 已有 `bybitOptions` 而配置没有 `options` 时也不覆盖。实现：`src/service/import-options.ts`，接入 `import-workbench.ts`（命令行 `--options`）、`import-helper.ts` 与 `import-channel.ts`（页面勾选「导入期权账户」）；安装脚本 `sudo bash install.sh --import-workbench --options`。只输出打码 UID、参数与原因，不输出密钥。工作台的其余估算参数（`OPTION_*_FACTOR`、`OPTION_LIQUIDATION_FEE_RATE`、`OPTION_FEE_CAP_PCT`、`QUOTE_STALE_SECONDS`、`MAX_SPREAD_BPS`、`TARGET_DTE_DAYS`、`BBO_POLL_SECONDS`）本服务不导入、按自己的默认值，改过的会列在导入提示里。G2a 起导入 `OPEN_HOUR_UTC`、`OPEN_MINUTE_UTC`、`OPEN_WINDOW_SECONDS`（定时开仓时间）与 `ALLOW_MARKET_FALLBACK`（IOC 兜底）；定时开仓本身导入后总是关闭（工作台必须先关自动开仓才能导入），要用时在期权页打开。导入助手与命令行导入沿用 `/etc/trading-platform/environment` 的代理设置。

## 4 切换与回退

切换：

1. 工作台期权模块关闭自动开仓：在 `DATA_DIR/modules/greeks/.env`（或 `/etc/project-aggregation.env`）写 `AUTO_OPEN=false` 后在工作台重启该模块（工作台页面没有这个开关；导入会读运行中模块进程的环境核对）。等跟踪策略到期或平掉，确认没有挂单、任务和 RFQ。
2. 本服务页面导入期权（或手写配置）→ 服务重启并通过启动检查。
3. 先看行情、预览和账户健康度正常；周五用最小数量（0.01）走一次开仓，周日到期或手动平仓。

回退：`sudo bash install.sh --version v0.10.1`。回退前在页面关闭定时开仓（页面开关存在 `options.sqlite`，以后重新导入同一账户会沿用），确认没有进行中的期权任务和未结束订单；旧版本不认识 `options` 与 `bybitOptions`，回退前须从 `config.json` 删掉 `options`、从 `secrets.json` 删掉 `bybitOptions`。`options.sqlite` 留在数据目录，旧版本不读。

从 v0.13.0（G2a）回退到 v0.11.0 / v0.12.0（保留期权模块）：先在页面关闭定时开仓、确认没有进行中的任务，再从 `config.json` 的 `options` 删掉 `autoOpen`、`openHourUtc`、`openMinuteUtc`、`openWindowSeconds`、`marketFallback`（旧版本按白名单读字段，多出字段会拒绝启动；工作台设置过开仓时间或开着 IOC 兜底时，v0.13.0 的导入会写入对应字段），然后 `sudo bash install.sh --version v0.12.0`。状态文档里多出的 `schedule` 与 IOC 订单记录旧版本会忽略。回退后若要回到工作台交易，工作台的 `engine_state.json` 不含本服务期间的任务与跟踪策略，须先确认账户无期权持仓。

## 5 实施批次

| 批 | 内容 | 验证 |
| --- | --- | --- |
| G1a | 客户端、期权链、策略与风险、跟价下单、任务与对账、状态库、服务接线、接口、飞书 | 替身 Bybit 期权端到端：开仓完成、部分成交、停止、净价突破、风险突破、结果未知后核对、重启恢复、平仓与退役、启动检查失败、无 `options` 时行为不变（`test/options*.test.ts`） |
| G1b | 页面；工作台导入（命令行与页面） | 浏览器在替身后端上走完预览 → 确认 → 完成与停止，1280 / 390 宽度；导入器单元测试 |
| G1c | 两路独立审查，修完 P0/P1 后发布（v0.11.0） | 审查记录 `reviews/2026-11-13-options-g1.md` |
| G1d | 实盘：用户在周五用最小数量开仓一次 | 用户跳过（2026-11-13） |
| G2a | 周五定时开仓（开关、窗口、每周一次、未执行提醒）、IOC 兜底、导入开仓时间与 IOC 设置、页面开关与标记（v0.13.0） | 替身端到端：IOC 补齐、部分剩余、IOC 部分成交、净价拦下 IOC、IOC 结果未知转待核对后重启对账结算、兜底等待中停止、兜底前读不到原单不发 IOC、窗口内每周一次、受理后重启不再开、窗口已过 / 停服不受理、下单前窗口结束不下单、窗口外不动、页面开关覆盖配置并重启保留、被拒只记一次日志与一次飞书、窗口内没跑过检查也提醒；浏览器 1280 / 390；两路独立审查 `reviews/2026-11-13-options-g2a.md` |
| G2b | “收益”页盈亏台账与采样 | 待定 |
| G2c | 组合询价 RFQ | 待定 |

## 6 尚待实测

- 真实 Bybit 期权账户上的密钥权限清单（`Options` 字段的取值）、`get-closed-positions` 期权字段、`/v5/order/history` 对期权单的保留时长。
- 跟价改单在真实盘口下的频率与成交情况。
- 定时开仓在真实周五窗口的触发，IOC 单在真实盘口的成交（G2a 只在替身上验证过）。
