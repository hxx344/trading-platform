# 原油双腿模块：实施方案 v1.0

2026-11-13 用户决定：原油双腿作为本仓库第二个正式模块接入，第一批直接做到实盘下单（R3，两路独立审查；实盘首次运行须用户当次授权）。与前端 F3 并行开发。

## 1 范围

工作台日常主用法是**同一交易所内 BZ−CL 两腿**（等桶、方向相反，下单面板默认预设）；本仓库执行器目前只支持“同一合约、Binance 与 Bybit 跨所”。第一批：

| 必须 | 后置 |
| --- | --- |
| 执行器支持同所 BZ/CL 两腿，保留跨所 | 价差自动规则（先 observe 再 live） |
| 按桶数下单，服务端换算各腿原生数量 | Binance 本地追价、追价界限、分批 |
| 服务接线：Binance/Bybit 账户、密钥、启动检查、进程锁、名义金额上限、两腿任务循环 | 四腿、OKX |
| 页面“原油”页：价差与盘口、持仓、下单（预览 → 确认实盘）、任务进度与人工处理、额度 | 盈亏、资金费、已实现盈亏账本与走势 |
| 飞书：原油任务告警 | 价格/价差提醒（monitor 那套） |
| 从工作台导入 Binance/Bybit 执行账户 | |

## 2 业务规则

- 合约：`CLUSDT`（WTI）、`BZUSDT`（Brent）；交易所 Binance（统一账户或标准账户，`PERPETUAL`/`TRADIFI_PERPETUAL`）、Bybit（统一账户，LinearPerpetual），沿用 `src/live/` 现有连接器与启动检查。
- 预设：
  - `same-exchange`：同一交易所，一腿 BZ、一腿 CL，方向相反。“做多价差”= 多 BZ 空 CL，“做空价差”= 空 BZ 多 CL。
  - `cross-exchange`：现有语义不变（同一合约，两个交易所方向相反）。
- 数量：页面输入每腿桶数，服务端按各腿合约乘数换算原生数量，须是该合约下单步长的整数倍，否则拒绝并给出最近的两个可用桶数；两腿桶数必须相等（现有校验保留）。
  - 意图里每腿填 `quantity`（原生数量，原写法）或 `barrels`（桶数）其一，两腿须同一种；用桶数时两腿桶数须相等（`unbalanced`）。
  - 换算在预览里读到各腿合约规则之后做：桶数 ÷（步长 × 合约乘数）须为整数，否则返回 `barrels_step`，消息给出两腿都能用的两个最近桶数（各腿“每步桶数”的最小公倍数网格上、不低于各腿最小数量，取请求值以下一个与以上一个）。任务记录仍只存原生数量，预览多一个 `barrels` 字段。
- 下单方式：首腿市价或 Bybit 原生追价（现有限制不变）；对冲腿市价。首腿是意图 `legs` 的第一项；同所预设下首腿默认 CL（流动性更好），由页面排在第一项，可换。
- 价差口径：同所 BZ−CL 可成交价差，单位 USDT/桶：卖出价差 = BZ 买一 − CL 卖一，买入价差 = BZ 卖一 − CL 买一；跨所为同一合约两所买卖一之差。价格本身按每桶报（名义金额 = 数量 × 合约乘数 × 价格），两价直接相减；两所连接器目前都按合约乘数 1 列出原油合约。
- 名义金额上限（`config.json` 的 `oil.notionalLimits`，页面与接口不能改）：
  - `perJob`：单个任务（取较贵一腿按价格保护界限计）；开仓、平仓都受限。
  - `openPer24h`：最近 24 小时内已确认的开仓任务名义金额合计（计法同现有 `openNotionalUsed`，加确认时刻窗口）；平仓不受限，保证随时能平。确认满 24 小时即移出窗口；超限返回 `notional_24h_cap`。与 `totalOpen` 二选一，两个都写或都不写拒绝启动。
  - 金丝雀（`src/live/canary.ts`）保持原有终身累计语义 `totalOpen`，不受影响。
- 唯一写者：工作台和本服务不协调。切换前须在工作台停用原油自动规则、不再用这两个执行账户下单；本服务把非本服务的挂单当外部挂单，预览直接拒绝（现有逻辑）。

## 3 架构

- 意图（`POST /api/preview`）：`same-exchange` 不写顶层 `symbol`，每腿带 `{ venue, symbol, side, orderType, quantity | barrels, limitPrice? }`，两腿同一交易所、合约不同、方向相反；`cross-exchange` 写法不变（顶层 `symbol`，腿上不写 `symbol`），也可用 `barrels`。规划之后执行器各环节本就按腿上的合约工作，状态机未改。
- 同一进程、同一库 `executor-live.sqlite`、同一执行器实例：两腿任务、划转、ADL 是同一实例下的三条循环（原型 `src/main.ts` 已这样跑），租约天然互斥。
- 配置 `config.json` 新增可选 `oil`：`{ notionalLimits: { perJob, openPer24h }, accounts: [{ venue, accountId, accountMode, credentialVersion }] }`，Binance、Bybit 各至多一个；没有 `oil` 时服务与现在完全相同（不建连接器、不开任务循环、页面不显示原油页）。`pairs` 与 `oil` 可以只有其一。
- 密钥 `secrets.json` 新增可选 `binance`、`bybit`：`{ apiKey, apiSecret }`；同样 600、64 KiB 上限、报错不回显内容。
- 启动：配置了 `oil` 时按账户取进程锁（与金丝雀同名 `pa-executor-live/<交易所>/<账户>`，二者不能同时操作同一账户），逐个账户 `preflightLive`（30 s 上限），失败拒绝启动（安装时自动回退旧版本）；`registerAccount`；`passes` 加 `jobs`。
- 行情：服务端每 3 s 读一次已配置交易所的 BZ、CL 盘口（单次 3 s 超时、失败保留上次结果并标注时刻，不重试），只供页面显示；预览与执行照旧自己读盘口。
- 新增接口（须登录，未配置 `oil` 时 404）：`GET /api/oil/market`（`books` 各所各合约买一卖一与读取/失败时刻，`sameExchange` 各所 `sell`/`buy` 价差，`crossExchange` 各合约 `binanceOverBybit`/`bybitOverBinance`）；`GET /api/oil/state`（`accounts`、`positions`（每 15 s 读一次各账户 BZ/CL 多空持仓与挂单数，单次 10 s 超时、不重试，失败保留上次结果）、`jobs`（最近 20 个，含 `preset` 与每腿计划/成交桶数、成交均价、预览盘口）、`notionalLimits`（`perJob`、`openPer24h`、`openUsed`、`windowMs`、`nextReleaseAt`））；预览、确认、任务操作沿用现有 `/api/preview`、`/api/confirm`、`/api/jobs/<编号>/…`。
- 飞书：任务确认发出、完成、转人工（不平衡/结果未知）、失败、停止各一条，带交易所、合约、方向、桶数、成交均价与价差；同一任务同一状态只发一次。沿用事件表 → 发件箱：`job-accepted` / `job-finished` 事件转成消息，`notify.sqlite` 新表 `once` 按“任务 + 状态”去重（随发件箱保留期清理）；确认时给预览可成交价差，结束时给成交均价差。
- 页面：顶部加“原油”页（`#/oil`，配置了 `oil` 才显示）：价差与盘口卡片；两交易所 BZ/CL 持仓表；下单表单（预设、交易所、开/平、做多/做空价差、桶数、首腿合约与下单方式、超时、价格保护）→ 预览（各腿数量、价格保护、名义金额与额度、提示）→ “确认执行（实盘）”；任务列表与详情（进度、各腿成交、停止、核对、认领、确认未创建、强制释放，沿用执行器现有语义与确认文案）；额度条。
- 导入：`install.sh --import-workbench` 与页面导入增加“原油执行账户”：只读工作台 `hub.sqlite` 的 `execution_accounts`（用同目录 `credentials.key` 解密，沿用 `server/contract-probes/lib/workbench-accounts.ts` 的规则：有未完成回滚日志或未合并 WAL 时拒绝、`purpose==='execution'`、只接受 Binance standard/portfolio-margin 与 Bybit unified），以库属主身份在子进程里读（同现有导入）。导入时读 `execution_auto_rules`，有 live 模式启用中的原油规则就拒绝导入并说明。`notionalLimits` 不从工作台导入，首次导入写入保守默认值 `perJob: 200`、`openPer24h: 1000`，由用户在 `config.json` 调整后 `sudo bash install.sh`。

## 4 切换与回退

切换：

1. 工作台停用所有原油自动规则；确认两执行账户在 BZ/CL 上没有工作台挂单。
2. 本服务页面导入原油执行账户（或手写配置）→ 服务重启并通过启动检查。
3. 先用最小桶数做一次同所开仓与平仓，看两腿成交、持仓回读与飞书消息；之后在 `config.json` 调额度。
4. 工作台此后不再用这两个账户交易（可以断开执行账户）。

回退：`sudo bash install.sh --version v0.7.0`（或更早）。回退前在页面确认没有未结束的原油任务。主库不迁移；旧版本不认识 `oil` 配置字段，回退前须从 `config.json` 删掉 `oil`、从 `secrets.json` 删掉 `binance`/`bybit`。旧版本打开含新格式（同所）已结束任务的库须能正常启动（测试覆盖）。

## 5 实施批次

| 批 | 内容 | 验证 |
| --- | --- | --- |
| O1a | 执行器同所预设与桶数换算、`openPer24h`；服务配置/密钥/启动检查/锁/任务循环；行情读取；两个新接口；飞书任务告警 | 单元与替身交易所端到端：同所开平、跨所回归、桶数换算拒绝、额度窗口、启动检查失败、无 `oil` 时行为不变、旧版本读新库（`test/oil.test.ts`；旧版本读新库为一次性脚本核对：未改代码的执行器打开新代码写入的含同所已结束任务与同所预览的库，正常启动并列出任务） |
| O1b | 页面原油页；工作台账户导入（命令行与页面） | 浏览器在替身交易所上走完预览 → 确认 → 完成、停止与转人工的显示、手机宽度；导入器单元测试（解密、拒绝条件、自动规则拦截） |
| O1c | 两路独立审查，修完 P0/P1 后发布 | 审查记录 `docs/reviews/` |
| O1d | 实盘：用户当次授权后最小桶数同所开平一次 | 结果回填本文件第 6 节 |

## 6 尚待实测

- Binance `BZUSDT` 的真实合约乘数、步长与 `TRADIFI_PERPETUAL` 下单（金丝雀只跑过 CLUSDT）。
- 同一账户同时下 BZ、CL 两单时的持仓回读与成交回报顺序。
- Bybit `BZUSDT` 是否上架及统一账户下的规则。
