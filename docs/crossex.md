# Gate CrossEx 跨所模块：实施方案 v1.0

2026-11-13 用户决定工作台原有各模块都要在本仓库具备（见 [plan.md](plan.md)）。执行线（原油 O1–O4）完成后，下一个接入的是工作台“CrossEx”（`modules/crossex`）：在一个 Gate CrossEx 账户里，同时持有不同交易所的同币种永续合约，组成两腿对冲（资金费或价差套利）。本文是接入方案，按第 5 节分批实施；用户已决定先跳过实盘测试，待实测项记在第 6 节。

方案对照的工作台代码：`project-aggregation` main `7745181` 的 `modules/crossex`（来源 `hxx344/gate-crossex-arbitrage@804d284`，另合入 `640df2f` 资金费机会补丁）。

### v0.65.0 公开行情与交易执行（R3）

行情服务收集终端公开推送、各交易所原生深度（含 Kraken、Lighter 的临时 WebSocket）、公开 K 线和资金费。终端最多订阅 12 个不同合约，共用一条 Gate 公开连接。历史 K 线使用固定周期和 240 根目标窗口，历史资金费限制查询区间及向交易所请求的页数。公开协议只传合约身份和对应查询参数，保留来源时间。

取消公开查询会中止本次 REST 读取或关闭临时 WebSocket。多个查询同时等同一份原生合约元数据、资金费区间或 Binance 资金费周期表时，最后一个读者退出才中止共享读取。

执行服务持有 Gate 密钥、账户锁及 `crossex.sqlite`，负责原生合约身份、目录、汇率、账户读取、额度判断与签名发送。当前确认绑定各腿复核盘口的来源时间和行情连接代次；检查账户风险后、发送每一腿前都会再次核实有效性。行情连接断开后，终端清除实时盘口，每笔已受理订单继续按原标识查询或撤销。恢复后的新确认须取得新连接的有效快照。首次切换和回退目标 v0.64.0 见 [行情监控文档](monitor.md)。

## 当前状态（v0.35.0）

- 已实现 C1–C4（服务端 + 页面），在 v0.35.0 合并为一次发布（见第 5 节），未实盘；C5 机会列表等行情监控 M-4 完成后另定。
- 实现与第 2.3 / 3 节原方案的出入已在对应条目注明（“实现：”）。

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

- 唯一写者：工作台与本服务不协调。切换后须在工作台 CrossEx 设置页断开账户（第 4 节）。本服务用进程锁 `pa-executor-live/gate-crossex/<UID>` 防同机多开，不搬账户写者（`account-writer`）。
  - 实现：运行时整体照搬，`live_owner` 租约表保留（运行时自己建表、续约）；进程锁已保证同账户只有一个进程，所以启动时先删掉上次进程留下的租约，免得等满 60 秒租约过期。
- 硬上限：`config.json` 的 `crossex.limits`（`notionalPerLeg`、`maxOpen`、`maxTotalNotional`）页面与接口不能改。页面设置（`entryPaused`、`slippageBps`、`cooldownSeconds`、每腿默认金额、费率、`minNetBps`）存在 `crossex.sqlite`，保存时不得超过硬上限。
- 数值：工作台用 decimal.js。
  - 实现：没有改写成 `src/decimal.ts`，而是把 decimal.js 10.6.0（工作台锁定版本，MIT）原样放进 `src/vendor/decimal.mjs`，不增加 npm 依赖；运行时的数值逻辑因此与工作台逐位相同。
- 图表：不引入 recharts，沿用本仓库现有的 SVG 图表组件。
- 持有情景：工作台由行情监控的资金费机会算出，本服务未接行情监控，对冲栏不显示持有情景，与机会列表一起等 C5（行情监控 M-4）。

## 3 架构

- 代码（实现：没有按下面的拆分改写成 TypeScript，而是把工作台 `modules/crossex/server` 的 `live-client.mjs`、`live-runtime.mjs`、`market.mjs`、`terminal-market.mjs`、`clients.mjs`、资金费与金额等文件原样放进 `src/vendor/crossex/`，每个文件头注明来源提交与改动（只改 import 路径、ws 换成本仓 `node-ws.mjs`、`loadFeed` 固定报“行情监控未接入”）；TypeScript 侧用 `.d.mts` 声明。下面各条是原方案，规则仍适用）：
  - `src/crossex/client.ts`：Gate 签名（预签名串 `方法\n/api/v4路径\n查询串\nSHA512(请求体)\n时间戳`，HMAC-SHA512 十六进制，头 `KEY`、`Timestamp`、`SIGN`）与逐字段解析，解析规则照搬 `live-client.mjs`，未知枚举、缺字段、UID 不一致一律报错。
  - `src/crossex/runtime.ts`：第 2.2 节的状态机，照搬 `live-runtime.mjs`，测试一并移植。
  - `src/crossex/store.ts`：`<数据目录>/crossex.sqlite`（WAL、`synchronous=FULL`），表同工作台的 `live_cache`、`live_previews`、`live_executions`、`live_orders`、`live_requests`、`live_supplemental`、`live_trades`、`live_account_book` 与 `settings`；不存密钥。
    - 实现：`live_connection` 与 `live_owner` 也在（运行时自己建）。`live_connection` 的 `apiKey` / `apiSecret` 只存标记 `secrets:gate.apiKey` / `secrets:gate.apiSecret`，读回时从 `secrets.json` 取；`encrypt` 遇到其他值（如 Monitor 密码）直接报错。`config()` 返回的 `notionalPerLeg`、`maxOpen`、`maxTotalNotional` 取 min(页面设置, `crossex.limits`)。没有工作台的模拟盘表与 `credentials.key`。
  - `src/crossex/market.ts`、`terminal.ts`、`funding.ts`：合约目录、下单终端盘口、持仓资金费。
  - 服务接线 `src/service/crossex*.ts`；共享文件（`config.ts`、`main.ts`、`http.ts`、`import-workbench.ts`、`App.tsx`、`route-parse.ts`）只追加接线。
- 外部调用（工作台现值）：
  - 单次请求 8 s，单次调用 12 s，响应体上限 8 MB，拒绝重定向；写请求不重试；读请求失败保留缓存并暂停交易，不在本轮重试。
  - 账户轮询链式调度，每轮间隔 5 s 减去本轮耗时（工作台经验 L049）；补充读取（手续费率、杠杆、风险限额、ADL、流水）不早于 30 s 一次；合约目录 300 s 后才重读，按 gzip 取（L068）。
  - 持仓资金费：各交易所公开接口直读，30 s 轮换、最多 4 个并发，遇 418 / 429 冷却 60 s（L023、L077）。
  - 下单终端公开 WS `wss://api.gateio.ws/ws/crossex/public`：最多 12 个合约，25 s 心跳，只在页面打开终端时连接。
- 配置 `config.json` 新增可选 `crossex`：`{ accountUid, credentialVersion, limits: { notionalPerLeg, maxOpen, maxTotalNotional } }`。没有 `crossex` 时服务与现在完全相同（不建客户端、不开循环、页面不显示）。
- 密钥 `secrets.json` 新增可选 `gate`：`{ apiKey, apiSecret }`，同样 600、64 KiB 上限、报错不回显内容。
- 启动：配置了 `crossex` 时取进程锁，再做启动检查（30 s 上限）：读 UID 须等于 `accountUid`，读一次账户、持仓与挂单须解析通过。
  - 实现：启动检查失败（连不上 Gate 或 30 s 内无应答、密钥 UID 不符、密钥已更换而 Gate 有挂单或本地有结果未知的订单、账户被另一进程占用、数据库打不开）只停用 CrossEx，ASTER、原油、期权等照常启动；日志与飞书各说明一次原因（同一原因每次进程启动只发一条飞书，日志只在原因变化时再记），之后每 60 s 后台重试，通过后飞书“CrossEx 已启动”。未启动期间页面仍显示 CrossEx 标签，`/api/crossex/*` 返回 503“CrossEx 未启动：<原因>（每 60 秒重试）”，确认与撤单带 `requestStatus: 'not_submitted'`（没有发出任何请求）；定时摘要与启动通知写明未启动。`config.json` / `secrets.json` 格式错误仍拒绝启动。服务停止时正在进行的启动检查立即放弃。交易权限无法不下单就验证，沿用工作台做法：首次写请求被 403 拒绝时记为“无交易权限”，页面提示。
- 接口（须登录、同源校验，未配置 `crossex` 时 404）：`GET /api/crossex/state`、`GET /api/crossex/instruments`、`GET /api/crossex/market`、`POST /api/crossex/refresh`、`POST /api/crossex/preview`、`POST /api/crossex/open-capacity`、`POST /api/crossex/confirm`、`POST /api/crossex/cancel`、`GET /api/crossex/requests/<编号>`、`PUT /api/crossex/settings`。请求与应答字段同工作台对应接口，只去掉连接管理。
  - 实现：另有 `GET /api/crossex/bootstrap`（`{ now, config, connection, limits }`），`settings` 同时接受 `PUT` 与 `POST`；`state`、`bootstrap`、`settings`、`refresh` 的应答多一个 `limits`（`config.json` 的硬上限）。`state` 的查询参数 `opportunities=0` 不算机会、`funding=1` 带资金费机会。设置超过硬上限返回 400 “…不能超过服务配置的上限 … （config.json crossex.limits）”；带 `monitorPassword` / `clearMonitorPassword` 返回 400（行情监控未接入）。应答不含 csrfToken、`apiKey`、`apiSecret` 与标记，连接视图保留密钥末四位 `keySuffix`（页面显示用）。没有模拟盘、hub 与健康检查接口。运行时的 `AppError` 原样带状态码，`requestStatus: 'not_submitted'` 时 `code` 为 `not_submitted`；其他错误 500 “操作未完成，请检查服务状态”。
- 飞书：执行确认、完成、结果未知、待人工、读取失败超过 5 分钟各一条，同一执行同一状态只发一次，沿用原油的事件表 → 发件箱与 `once` 去重（`once` 记录保留 7 天）；定时摘要加一行 CrossEx 持仓组数、总名义金额与待处理订单数。
  - 实现：去重键 `crossex:<执行编号>:confirmed|unknown|attention|finished` 与 `crossex:read-failure:<开始时刻>`，经通知器新增的 `notifyOnce`；只提 24 小时内有变化的执行，避免 `once` 表 7 天清理后重发已结束的执行。结果未知的订单在核对期间一直更新变化时间，所以若 7 天后仍未核对完，会再提醒一次（约每周一次）。摘要行在定时摘要卡片的固定行之后。
- 页面：顶部“CrossEx”标签（`#/crossex`）只在 `GET /api/crossex/state` 有应答时出现。五栏照工作台：持仓（账户概览、持仓组合、资金费、平仓）、交易（下单终端）、对冲（两腿手动对冲）、订单（挂单与历史、撤单）、设置（只显示账户与硬上限，可改页面设置，不填密钥）。样式从工作台复制，规则见 [frontend.md](frontend.md)《页面开发规则》；读取走 use-live-resource（页面隐藏时暂停、失败保留上次结果并标注、401 提示重新登录）。
- 导入：`install.sh --import-workbench --crossex` 与页面导入面板的“导入 CrossEx 账户”勾选框。
  - 只读工作台 `<数据目录>/modules/crossex/crossex.sqlite` 的 `live_connection`，用同目录 `credentials.key`（32 字节）以 AES-256-GCM 解密；以库属主身份在子进程里读，拒绝符号链接与非普通文件，WAL / `-shm` 规则同原油导入。任何失败只报固定原因，不回显密钥、密文或字段内容。
  - 拒绝并说明：未连接或已断开、记录格式错误、无法解密、没有 UID（“须在工作台重新验证”）、有未结束的执行（不是已完成或已取消）、有结果未知、发送中或撤单中的订单。
    - 实现：执行“未结束”= 该执行有不在 `FILLED`、`CANCELLED`、`FAIL`、`REJECT`、`UNSENT` 之内的订单，或没有任何订单；订单同此口径。另外拒绝：`live_cache` 里有挂单（同工作台断开账户的检查）、记录的 `accountReference` 与解密出的密钥不符、工作台额度本服务不接受。实现文件 `src/service/import-crossex.ts`、`src/crossex/import-writer.ts`，字段与顺序见 [module-import.md](module-import.md) §9。
  - 映射：`accountUid` = 记录的 `accountUid`，`credentialVersion` = `version`，密钥写入 `secrets.json` 的 `gate`；工作台设置写入 `crossex.sqlite` 的 `settings`。
  - `limits` 只在首次创建 `crossex` 时写入，取工作台当前的 `notionalPerLeg`、`maxOpen`、`maxTotalNotional`（使切换前后行为相同），之后由用户在 `config.json` 调整后 `sudo bash install.sh`。已有 `crossex` 时不覆盖；`secrets.json` 已有 `gate` 而没有 `crossex` 时也不覆盖。
  - 工作台模块仍在运行（租约未过期）不拦截，预览提示“导入后在工作台 CrossEx 设置页断开账户”。

## 4 切换与回退

切换：

1. 工作台 CrossEx 页确认没有进行中的执行与待处理订单。
2. 本服务页面导入 CrossEx 账户（或手写配置）→ 服务重启并通过启动检查。
3. 工作台 CrossEx 设置页“断开账户”，此后只在本服务交易。
4. 先只看持仓与订单是否与工作台一致；实盘开平仓待用户当次授权（第 6 节）。

更换密钥：在 `secrets.json` 换 `gate` 密钥时，若 Gate 上仍有挂单或本地有结果未知的订单，运行时拒绝换用新密钥，CrossEx 保持未启动（其他模块照常）。库里只存密钥标记，读取用的总是 `secrets.json` 当前的密钥（同一 UID），所以每次重试都会用新密钥核对本地订单、读 Gate 挂单。恢复：在 Gate 网页撤掉挂单，等结果未知的订单核对完，下一次重试自动启动；也可换回原密钥并 `sudo systemctl restart trading-platform`，在页面撤单后再换。新密钥读取账户、持仓或挂单未完成时另报“暂不能确认可以换用”，核对它的 CrossEx 读取权限与网络。

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

实现：运行时整体照搬后 C1–C4 无法拆开验证与发布，合并为一次发布（R3），合并前须有覆盖 C2/C3 交易路径的独立审查。已移植的工作台用例见 `test/crossex/`（只改 import 路径与夹具，每个文件头注明）；`live-runtime`、`open-capacity`、`position-actions-runtime` 也已移植，用 `test/crossex/workbench-store.mjs`（工作台存储的测试用副本）；只依赖工作台账户写者的 23 个 `live-runtime` 用例与 1 个工作台 HTTP 夹具用例跳过。本服务自己的存储、上限截断、租约清理、启动失败降级、写请求标记与导入由 `test/crossex-service.test.ts` 覆盖。

## 6 尚待实测

用户已决定先跳过实盘测试。下列各项只在替身接口上验证过，实盘须用户当次授权：

- 启动检查在真实账户上读 UID、账户、持仓与挂单。
- 最小金额两腿开仓、平仓各一次：IOC 保护价、逐腿成交、持仓回读。
- 撤单与 403（无交易权限）提示。
- 持仓资金费各交易所公开接口的真实返回。

## 7 相关经验（工作台 `LESSONS.md`）

L020（资产身份）、L023 / L077（持仓资金费）、L024（ADL 映射）、L025（流水聚合）、L027（计价币）、L049（链式轮询）、L054（成交已反映到持仓）、L059 / L098（资金费口径）、L068（gzip）。工作台维护接口相关的 L008、L072 本仓库不适用。
