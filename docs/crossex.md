# Gate CrossEx 跨所模块：实施方案 v1.0

2026-11-13 用户决定工作台原有各模块都要在本仓库具备（见 [plan.md](plan.md)）。执行线（原油 O1–O4）完成后，下一个接入的是工作台“CrossEx”（`modules/crossex`）：在一个 Gate CrossEx 账户里，同时持有不同交易所的同币种永续合约，组成两腿对冲（资金费或价差套利）。本文是接入方案，按第 5 节分批实施；用户已决定先跳过实盘测试，待实测项记在第 6 节。

方案对照的工作台代码：`project-aggregation` main `7745181` 的 `modules/crossex`（来源 `hxx344/gate-crossex-arbitrage@804d284`，另合入 `640df2f` 资金费机会补丁）。

## 当前状态（v0.28.0）

- 方案 v1.0，未开始实现。
- 计划：C1 只读 → C2 两腿开平仓 → C3 持仓操作与下单终端 → C4 资金费与持仓分析；C5 机会列表等行情监控 M-4 完成后另定。

## 1 范围

| 本方案（C1–C4） | 后置或不做 |
| --- | --- |
| Gate CrossEx 私有接口客户端：签名、逐字段校验的解析、超时与响应体上限 | 机会列表（对冲页“价差 / 资金费机会”、持仓页“资金费机会”）：工作台靠 Monitor 的 `opportunities-v2`，本仓库行情监控还没有全市场报价（M-4 未开始），列为 C5 |
| 账户、持仓、挂单、杠杆与风险限额、ADL 排名、手续费率读取；合约目录（约 2 MB，gzip） | 页面填写 API 密钥：本仓库密钥只在 `secrets.json`，由导入或手写配置（同原油、期权） |
| 两腿开仓、平仓（最多 16 腿）、撤单：预览 → 确认，请求编号幂等，逐腿发送，结果未知不重发 | 工作台多实例互斥（`live_owner` 租约）与账户写者（`account-writer`）：改用本仓库的进程锁 |
| 持仓操作：加仓、两腿配平（减少 / 增加 / 指定数量） | 工作台维护接口、总览摘要（`/api/hub/summary`）、跳转 Monitor 按钮 |
| 下单终端：单合约盘口与公开 WS（最多 12 个合约） | 工作台已停用的模拟交易（`engine`、`execution`、`analytics`、`funding.mjs`、`ProfitChart`）不搬 |
| 持仓资金费（各交易所公开接口直读）、持有情景、盈亏拆分、仓位走势 | 导入工作台本地的执行记录与成交缓存：历史订单与成交本就从 Gate 接口读 |
| 飞书：执行确认、完成、结果未知、待人工各一条 | 划转、改杠杆、改保证金模式：工作台也不做，本仓库同样不做 |
| 页面 `#/crossex`：持仓、交易、对冲、订单、设置五栏，照工作台排版 | |
| 从工作台导入 CrossEx 账户（命令行 `--crossex` 与页面勾选） | |

## 2 业务规则（与工作台一致，差异单列）

### 2.1 账户与合约

- 一个 Gate 账户，API 密钥须开 CrossEx 读写权限。账户身份是 Gate UID（`/account/detail`），持仓、挂单里的 `user_id` 须与它一致，不一致整次读取作废。
- 合约 `<交易所>_FUTURE_<币>_USDT`，交易所限 `BINANCE`、`OKX`、`GATE`、`BYBIT`、`KRAKEN`、`HYPERLIQUID`、`DERIBIT`、`LIGHTER`；只用 `business_type=FUTURE`、`state=live`、`delist_time=0` 的合约。币种口径同工作台 `crossexBase`（Kraken 用规范币名，其余用原生币名），跨交易所比较按规范币名（工作台经验 L020、L027）。
- 写操作只有 `POST /crossex/orders` 与 `DELETE /crossex/orders/{id}`。杠杆与风险限额只读，用于开仓前容量检查。

### 2.2 开仓、平仓与撤单

- 预览：强制读一次账户（结果不超过 15 s），开仓最多 2 腿，平仓最多 16 腿；两腿开仓用 IOC 保护限价（盘口价按 `slippageBps` 外推、按价格步长取整）。预览 30 s 有效，记下连接版本、UID、账户状态与设置的指纹。
- 确认：请求编号幂等；重新核对指纹、冲突、上限与杠杆；在一个事务里把执行记为 `PREPARED`。总时限 20 s。
- 逐腿发送：第一腿全部成交才发第二腿，否则第二腿记 `UNSENT`；IOC 成交每 250 ms 查一次，最长 15 s。
- 结果未知（`UNKNOWN`）的订单永不重发，只按订单 `text` 或订单编号对账。
- 撤单：先持久化 `CANCEL_PENDING` 再发。
- 重启恢复：`PREPARED` 改 `UNSENT`，`SENDING` 改 `UNKNOWN`，之后走对账。
- 上限：`notionalPerLeg`、`maxOpen`（对冲组数，按腿数 ×2 计）、`maxTotalNotional`、`cooldownSeconds`、`slippageBps`；`entryPaused` 只停新开仓，平仓与撤单照常。
- 冲突拒绝：有结果未知或进行中的订单；开仓时同合约有挂单或持仓；已成交但持仓还没反映出来（工作台经验 L054）。
- 读取失败：保留上次结果并标“待同步”，在下一次成功读取之前拒绝预览与确认。

### 2.3 与工作台的差异

- 唯一写者：工作台与本服务不协调。切换后须在工作台 CrossEx 设置页断开账户（第 4 节）。本服务用进程锁 `pa-executor-live/gate-crossex/<UID>` 防同机多开，不搬 `live_owner` 租约与账户写者。
- 硬上限：`config.json` 的 `crossex.limits`（`notionalPerLeg`、`maxOpen`、`maxTotalNotional`）页面与接口不能改，同原油的 `notionalLimits`。页面设置（`entryPaused`、`slippageBps`、`cooldownSeconds`、每腿默认金额、费率、`minNetBps`）存在 `crossex.sqlite`，保存时不得超过硬上限。
- 数值：工作台用 decimal.js，本仓库没有运行依赖，改用 `src/decimal.ts`（bigint），缺的除法与取整在该文件补，并补单元测试。
- 图表：不引入 recharts，沿用本仓库现有的 SVG 图表组件。

## 3 架构

- 代码：
  - `src/crossex/client.ts`：Gate 签名（预签名串 `方法\n/api/v4路径\n查询串\nSHA512(请求体)\n时间戳`，HMAC-SHA512 十六进制，头 `KEY`、`Timestamp`、`SIGN`）与逐字段解析，解析规则照搬 `live-client.mjs`，未知枚举、缺字段、UID 不一致一律报错。
  - `src/crossex/runtime.ts`：第 2.2 节的状态机，照搬 `live-runtime.mjs`，测试一并移植。
  - `src/crossex/store.ts`：`<数据目录>/crossex.sqlite`（WAL、`synchronous=FULL`），表同工作台的 `live_cache`、`live_previews`、`live_executions`、`live_orders`、`live_requests`、`live_supplemental`、`live_trades`、`live_account_book` 与 `settings`；不存密钥，没有 `live_connection` 与 `live_owner`。
  - `src/crossex/market.ts`、`terminal.ts`、`funding.ts`：合约目录、下单终端盘口、持仓资金费。
  - 服务接线 `src/service/crossex*.ts`；共享文件（`config.ts`、`main.ts`、`http.ts`、`import-workbench.ts`、`App.tsx`、`route-parse.ts`）只追加接线。
- 外部调用（工作台现值）：
  - 单次请求 8 s，单次调用 12 s，响应体上限 8 MB，拒绝重定向；写请求不重试；读请求失败保留缓存并暂停交易，不在本轮重试。
  - 账户轮询链式调度，每轮间隔 5 s 减去本轮耗时（工作台经验 L049）；补充读取（手续费率、杠杆、风险限额、ADL、流水）不早于 30 s 一次；合约目录 300 s 后才重读，按 gzip 取（L068）。
  - 持仓资金费：各交易所公开接口直读，30 s 轮换、最多 4 个并发，遇 418 / 429 冷却 60 s（L023、L077）。
  - 下单终端公开 WS `wss://api.gateio.ws/ws/crossex/public`：最多 12 个合约，25 s 心跳，只在页面打开终端时连接。
- 配置 `config.json` 新增可选 `crossex`：`{ accountUid, credentialVersion, limits: { notionalPerLeg, maxOpen, maxTotalNotional } }`。没有 `crossex` 时服务与现在完全相同（不建客户端、不开循环、页面不显示）。
- 密钥 `secrets.json` 新增可选 `gate`：`{ apiKey, apiSecret }`，同样 600、64 KiB 上限、报错不回显内容。
- 启动：配置了 `crossex` 时取进程锁，再做启动检查（30 s 上限）：读 UID 须等于 `accountUid`，读一次账户、持仓与挂单须解析通过；失败拒绝启动（安装时自动回退旧版本）。交易权限无法不下单就验证，沿用工作台做法：首次写请求被 403 拒绝时记为“无交易权限”，页面提示。
- 接口（须登录、同源校验，未配置 `crossex` 时 404）：`GET /api/crossex/state`、`GET /api/crossex/instruments`、`GET /api/crossex/market`、`POST /api/crossex/refresh`、`POST /api/crossex/preview`、`POST /api/crossex/open-capacity`、`POST /api/crossex/confirm`、`POST /api/crossex/cancel`、`GET /api/crossex/requests/<编号>`、`PUT /api/crossex/settings`。请求与应答字段同工作台对应接口，只去掉连接管理。
- 飞书：执行确认、完成、结果未知、待人工、读取失败超过 5 分钟各一条，同一执行同一状态只发一次，沿用原油的事件表 → 发件箱与 `once` 去重；定时摘要加一行 CrossEx 持仓组数、总名义金额与待处理订单数。
- 页面：顶部“CrossEx”标签（`#/crossex`）只在 `GET /api/crossex/state` 有应答时出现。五栏照工作台：持仓（账户概览、持仓组合、资金费、平仓）、交易（下单终端）、对冲（两腿手动对冲）、订单（挂单与历史、撤单）、设置（只显示账户与硬上限，可改页面设置，不填密钥）。样式从工作台复制，规则见 [frontend.md](frontend.md)《页面开发规则》；读取走 use-live-resource（页面隐藏时暂停、失败保留上次结果并标注、401 提示重新登录）。
- 导入：`install.sh --import-workbench --crossex` 与页面导入面板的“导入 CrossEx 账户”勾选框。
  - 只读工作台 `<数据目录>/modules/crossex/crossex.sqlite` 的 `live_connection`，用同目录 `credentials.key`（32 字节）以 AES-256-GCM 解密；以库属主身份在子进程里读，拒绝符号链接与非普通文件，WAL / `-shm` 规则同原油导入。任何失败只报固定原因，不回显密钥、密文或字段内容。
  - 拒绝并说明：未连接或已断开、记录格式错误、无法解密、没有 UID（“须在工作台重新验证”）、有未结束的执行（不是已完成或已取消）、有结果未知、发送中或撤单中的订单。
  - 映射：`accountUid` = 记录的 `accountUid`，`credentialVersion` = `version`，密钥写入 `secrets.json` 的 `gate`；工作台设置写入 `crossex.sqlite` 的 `settings`。
  - `limits` 只在首次创建 `crossex` 时写入，取工作台当前的 `notionalPerLeg`、`maxOpen`、`maxTotalNotional`（使切换前后行为相同），之后由用户在 `config.json` 调整后 `sudo bash install.sh`。已有 `crossex` 时不覆盖；`secrets.json` 已有 `gate` 而没有 `crossex` 时也不覆盖。
  - 工作台模块仍在运行（租约未过期）不拦截，预览提示“导入后在工作台 CrossEx 设置页断开账户”。

## 4 切换与回退

切换：

1. 工作台 CrossEx 页确认没有进行中的执行与待处理订单。
2. 本服务页面导入 CrossEx 账户（或手写配置）→ 服务重启并通过启动检查。
3. 工作台 CrossEx 设置页“断开账户”，此后只在本服务交易。
4. 先只看持仓与订单是否与工作台一致；实盘开平仓待用户当次授权（第 6 节）。

回退：`sudo bash install.sh --version <接入前的版本>`。回退前在页面确认没有进行中的执行与待处理订单；旧版本拒绝未知配置键，须先从 `config.json` 删掉 `crossex`、从 `secrets.json` 删掉 `gate`。`crossex.sqlite` 不删，旧版本不读它。要回到工作台交易，在工作台设置页重新填密钥连接。

## 5 实施批次

| 批 | 内容 | 风险 | 验证 |
| --- | --- | --- | --- |
| C1 | 只读：客户端（签名、解析、超时）、配置 / 密钥 / 启动检查 / 进程锁、账户轮询与缓存、补充读取、合约目录；三个读接口；页面持仓（只读）、订单（只读）、设置；工作台导入 | R2 | 解析与签名单元测试（移植 `live-client` 用例）；替身 Gate 接口端到端：轮询、读取失败保留缓存、UID 不一致、无 `crossex` 时行为不变；导入器单元测试；浏览器在替身上看三栏与手机宽度 |
| C2 | 交易：预览 → 确认 → 逐腿发送、撤单、上限与冲突、重启恢复、结果未知对账；对冲页、持仓页平仓、订单页撤单；飞书 | R3 | 移植 `live-runtime` 用例（含重启恢复、`UNKNOWN` 不重发、第二腿 `UNSENT`、指纹失效）；替身上浏览器走完开仓、平仓、撤单、结果未知；两路独立审查 |
| C3 | 持仓操作（加仓、配平）、开仓容量面板、下单终端与公开 WS | R3 | 移植 `position-actions`、`open-capacity`、`terminal-market` 用例；独立审查 |
| C4 | 持仓资金费、持有情景、盈亏拆分、仓位走势、账户流水 | R2 | 移植 `position-funding`、`holding-scenario`、`position-metrics` 用例；浏览器看持仓页 |
| C5 | 机会列表：待行情监控 M-4（全市场报价）完成后另写方案 | 待定 | — |

每批单独发布；C2、C3 修完两路审查的 P0/P1 后才发布。

## 6 尚待实测

用户已决定先跳过实盘测试。下列各项只在替身接口上验证过，实盘须用户当次授权：

- 启动检查在真实账户上读 UID、账户、持仓与挂单。
- 最小金额两腿开仓、平仓各一次：IOC 保护价、逐腿成交、持仓回读。
- 撤单与 403（无交易权限）提示。
- 持仓资金费各交易所公开接口的真实返回。

## 7 相关经验（工作台 `LESSONS.md`）

L020（资产身份）、L023 / L077（持仓资金费）、L024（ADL 映射）、L025（流水聚合）、L027（计价币）、L049（链式轮询）、L054（成交已反映到持仓）、L059 / L098（资金费口径）、L068（gzip）。工作台维护接口相关的 L008、L072 本仓库不适用。
