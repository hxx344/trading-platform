# Asset 模块：实施方案 v1.0

2026-11-13 用户决定：工作台原有的各模块都要在本仓库里具备（不在工作台上替换）。Asset（资产账本）按下面的批次接入，只在 `config.json` 配置了 `asset` 时启用；未配置时服务行为不变。

对照的工作台代码：`modules/asset`（最后修改提交 `0014655`）。工作台 Asset 的功能编号 A01–A15 沿用。

## 批次

| 批次 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| A-1 | 只读账本与计算口径：库结构、每日快照、账本读取、资产走势（A10）、日变化归因（A12）、出金与现金流的只读展示；从工作台导入历史数据的命令 | R2 | 完成（Linux CI 通过），随 v0.12.0 发布 |
| A-2 | 本地写入：手工资产（A06）、汇率（A07）、出金（A09）、现金流（A11）、同步锁 | R3 | 实施中（方案见下文 A-2） |
| A-3 | 凭据与中心化交易所余额同步（A01、A02：Binance、Bybit、OKX、Gate）、行情与汇率自动更新 | R3 | 方案见下文 A-3/A-4，A-2 发布后实施 |
| A-4 | 其余数据源（Aster 多账户 A03、Hyperliquid、Lighter RH、Variational A15） | R3 | 与 A-3 同批 |
| A-5 | 持仓与成交（A04、A05） | R2 | 未开始 |
| A-6 | 交易凭据导出（A14）、原表导入（A08） | R3 | 未开始 |

## A-1：只读账本与计算口径

**配置**

```json
"asset": {}
```

- 本批没有选项，也不需要密钥；`asset` 只接受空对象，写了别的字段配置检查报错。配置了 `asset`（或 `oil`、`monitor`）时 `pairs` 可以省略。解析在 `src/service/asset-config.ts`，`--check-config` 的输出末尾加“资产账本已启用”。

**数据**

- 独立库文件 `asset.sqlite`（数据目录内，导入命令建表并开 WAL），不给主库加迁移。
- 表与工作台 `ledger.sqlite` 同形，去掉 `owner` 一列（本服务只有一个使用者）：`assets(id, data)`、`settings(key, value)`、`snapshots(date, data)`（每个北京时间日期一行；工作台导入前的示例记录以 `archive-…` 为键，也在这张表里）。工作台的 `connections`（加密凭据）、`sync_locks`、`auth_attempts`、`fill_cache` 本批不建。
- 本批服务只读这个库（只读方式打开，第一次读取时才打开；文件不存在或导入还没提交时按“未导入”应答），不写；库里的数据全部来自导入。

**从工作台导入历史数据**

推荐在设置页「从工作台导入」里点「读取工作台」，勾选「导入资产账本」并选择工作台用户后导入：一次完成启用 `asset` 与导入账本，不用手改 `config.json`，也不用处理文件权限；命令行为 `sudo bash install.sh --import-workbench --asset [--asset-owner <用户>]`。方案（读取与写入身份、顺序与失败行为）见 [module-import.md](module-import.md)。两种方式都按下面的导入规则执行。

备选：手工运行导入命令（工作台账本在 `<工作台数据目录>/modules/asset/ledger.sqlite`）：

```
sudo -u trading-platform node /opt/trading-platform/current/src/asset/import.ts --from <工作台数据目录>/modules/asset/ledger.sqlite --owner <工作台用户名> --data-dir /var/lib/trading-platform
```

- 以只读方式打开工作台的库，把指定用户的 `assets`、`snapshots` 和页面用到的 `settings` 复制进 `asset.sqlite`，一个事务内整体替换（三张表先清空再写入，别的用户、源库里已删掉的设置都不会残留）。复制的设置按白名单：`source-ledger`（原表数据：起始快照与原表各期次，账本、历史与日变化都以它为基准，**缺了就拒绝导入**）、`initialized`、`fx`、`fx-status`、`withdrawals`、`cash-flow-audit-v1`、`aster-accounts`、各交易所的 `-status`、`last-attempt`。凭据（`connections`）不读也不导入。
- 账户标识不导入：`aster-accounts` 只留 `id`、`name`、`value`、`details`、`updatedAt`、`includeSpot`、`configured`、`lastSync`、`error`、`scope`（去掉钱包地址 `walletAddress` 与密钥尾号 `label`）；各交易所 `-status` 只留 `configured`、`lastSync`、`error`、`scope`（去掉 `label`）。
- 写入前先把要导入的内容全部读出并校验：JSON 能解析、资产与快照的基本字段、`fx` 为正数、`cash-flow-audit-v1` 按工作台的审计规则校验、`source-ledger` 有起始快照；资产、快照与设置里任何一层出现凭据类字段名（`apiKey`、`apiSecret`、`secret`、`privateKey`、`passphrase`、`vrToken`、`walletAddress`、`encrypted`、`credential(s)`、`signer`、`apiSecretKey`、`secretKey`、`password`、`mnemonic`、`seedPhrase`、`accessToken`、`authToken`，不分大小写，也不管中间的下划线与连字符）就拒绝导入，报错只写字段名、不带内容。各交易所状态与 Aster 账号的报错原文（`error`）里的钱包地址与 64 位十六进制串导入时隐去。资产行、快照、出金备注与资金流记录里的文字（包括自己填的“账户标识”）原样导入，页面显示的内容与工作台相同。任何一项不通过都不动已有的 `asset.sqlite`，命令输出“导入失败，未改动已有数据：<原因>”并以 1 退出。
- `--data-dir` 须是绝对路径，按服务同样的规则拒绝工作台数据目录；`--from` 不能是本服务自己的 `asset.sqlite`。
- 重复执行以最新一次为准；导入时刻、源文件名、用户与条数记在 `settings` 的 `import-info`。成功时输出资产、快照与设置的条数。
- 服务运行中也可以执行（WAL），页面下次读取就是新数据，不用重启。
- 手工运行命令时，需要运行命令的账号（`trading-platform`）能读到工作台的库文件（经设置页或 `install.sh` 导入时由 root 导入器以库的属主身份读取，不受此限）；读不到时由 root 把 `ledger.sqlite`（连同同目录的 `ledger.sqlite-wal`，有的话）复制到该账号能读的位置再导入。
- 留在快照里的 `positions`（持仓记录）不去掉：其中 `scopes[].generation` 是工作台对凭据密文算的单向摘要（只用来判断凭据是否换过，不能还原凭据），`account` 是工作台给账户起的编号，`accountName` 是页面上显示的账户名，都不是凭据；日变化的持仓影响要用到它们。

**计算口径**

- 从工作台 `modules/asset/lib`（`0014655`）复制到 `src/asset/`，文件头注明来源路径、提交号与改动：
  - 原样：`types.ts`、`asset-values.ts`、`performance-metrics.ts`、`cash-flows.ts`、`daily-positions.ts`、`positions-decimal.ts`。
  - 计算不改，只去掉 `owner` 与工作台的库封装（改用 `query.ts` 的最小接口）：`withdrawals.ts`、`snapshot-history.ts`、`daily-changes.ts`。
  - 只取用到的部分，留下的函数不改：`positions-cycle.ts`（只留 `cash-flows.ts` 用到的十进制运算）、`positions-types.ts`（只留复制文件用到的类型）、`seed.ts`（只留 `seedLedger`，原表数据一律来自导入的 `source-ledger`，没有示例数据兜底）、`source-ledger.ts`（项目名规则与示例标记；不引入 zod，`SourceLedger` 类型手写）、`aster-accounts.ts`（只留 `readAsterAccounts`）。
  - 工作台 `store.ts` 的 `readLedger`、`cash-flow-store.ts` 的 `loadCashFlows`、`app/api/history/route.ts` 的期次明细改写在 `src/asset/store.ts`：没有 `owner`，不做初始化；本服务不存凭据，各交易所连接与 Aster 账号一律显示“未配置”。页面上原来在浏览器里算的合计、分交易所合计、走势、月度与年化指标，用同样的工作台函数在 `src/asset/views.ts` 里算好随接口返回。
- 工作台 `modules/asset/tests` 里覆盖这些文件的用例搬到 `test/asset-*.test.ts`（`asset-values`、`performance-metrics`、`withdrawals`、`cash-flows`、`snapshot-history`、`daily-changes` 六个文件，66 个用例），期望值不改，作为口径没变的证据。为适配去掉 `owner` 改写或去掉的部分：
  - `snapshot-history`：去掉“不同用户的快照互不可见”一例（本库没有 `owner`）；建表与插入语句去掉 `owner` 列。
  - `daily-changes`：两个用户改成两个库；去掉其中“别的用户 / 缺少用户”的断言。
  - `cash-flows`：工作台的 `saveCashFlow`（带同步锁与 `owner`）本批没有，第一个用例改为同样的“解析 → `amendCashFlows` → 写设置”三步，去掉别的用户的检查。
  - `withdrawals`：出金登记表单的 zod 校验（`withdrawalSchema`）属于 A-2，没搬；该例只保留北京时间午夜的日期检查。
  - `positions-decimal.test.ts` 依赖工作台服务端的持仓读取，没搬。

**接口**（都要登录，只读）

- `GET /api/asset/state`：是否已导入、导入时刻与来源（文件名、用户）、资产条数、日快照的条数与日期范围、导入前记录条数；没配置 `asset` 时 404（页面据此不显示入口）。
- `GET /api/asset/ledger`：资产列表（按估值从高到低，已登记的新增出金并入出金行，同工作台）、汇率、合计、交易所 / 积分 / 出金小计与分交易所合计（对照工作台 `app/api/ledger/route.ts` 的只读部分与 `dashboard.tsx` 里的计算）。
- `GET /api/asset/history`：原表期次与每日快照、走势、月度表现与年化指标（对照 `app/api/history/route.ts` 与 `asset-trend.tsx`）。
- `GET /api/asset/period?id=<期次编号>`：一份记录的资产明细（对照 `app/api/history/route.ts` 带 `id` 的读取）；编号格式不对 400，没有这份记录 404。
- `GET /api/asset/daily-changes`：近 90 天的日变化归因（对照 `app/api/daily-changes/route.ts`）。
- `GET /api/asset/withdrawals`、`GET /api/asset/cash-flows`：只读列表（资金流含有效记录、全部审计版本与作废记录）。
- 还没导入时这些接口返回 200 与空数据并标明 `imported: false`，不报错。库读取出错时返回 500 `asset_unreadable` 并带原因（库内数据格式无效时只说明需要重新导入，不带内容）；这时“资产”标签照常显示。审查记录见 [reviews/2026-11-13-asset-a1.md](reviews/2026-11-13-asset-a1.md)。

**页面**

- 地址 `#/asset`，标签“资产”，只在 `/api/asset/state` 有应答时显示；页面在 `.aster-module` 之外，自带 `.asset-desk` 外壳。
- 对照工作台 `modules/asset/app/dashboard.tsx`、`asset-trend.tsx`、`daily-changes.tsx`、`withdrawals-panel.tsx`、`cash-flows-panel.tsx`（`0014655`）：三个子页“资产总览”（六格汇总、资产变化走势与年化 / 上月指标、每月表现、每日波动与资金流标注、资产明细表（全部 / 自动更新 / 手动维护筛选，交易所行可展开分项）、分交易所合计）、“历史记录”、“出金记录”。
- 与工作台不同的地方：历史记录的“查看明细”在表格上方原位展开一个面板（工作台是弹窗）；每日波动在展开时才读取；资金流只列记录与审计历史，没有登记表单。
- 页面顶部固定提示：本批只读，数据停留在导入时刻（写明时刻与工作台用户），同步与编辑尚未接入。所有写入入口（同步、添加资产、改汇率、记出金、登记资金流、连接交易所）本批不显示。没导入时显示空状态和导入命令。
- 走势图用本仓库的 `svg-plot.tsx`。样式：`web/src/asset.css` 复制自工作台 `modules/asset/app/globals.css` 里这些页面用到的规则，每条选择器前加 `.asset-desk ` 限定范围（详见 [frontend.md](frontend.md)《资产页》）。

**测试**

- 搬来的口径用例（见上）。新增：`asset-import`（只取指定用户、白名单与去掉标识、整体替换与换用户、校验失败不改动且报错不带内容、凭据字段检查、命令行退出码）、`asset-store`（未导入的空应答、导入后各接口的内容、服务先启动后导入与再次导入、导入记录损坏、`asset` 配置解析）、`asset-http`（未登录 401、没配置 404、未导入与导入后的应答、期次 400 / 404、读取失败 500；服务进程装配一例只在 Linux 上运行）、`asset-format`（页面文案规则），`web.test.ts` 补 `#/asset` 路由。测试用的工作台库由 `test/asset-fixture.ts` 生成（假数据）。
- 本地看页面：`pnpm build:web` 后执行 `node scripts/asset-demo.ts --data-dir <空目录的绝对路径> [--port 4730]`，它用同一份假数据生成工作台库、导入，再以模拟交易所起服务；登录链接在 `<数据目录>/access-url`，打开 `http://127.0.0.1:4730/#/asset`。

**回滚**：`sudo bash install.sh --version v0.11.0`，回退前先删掉 `config.json` 里的 `asset`（旧版本不认识这个字段，配置检查会失败）。主库不变；`asset.sqlite` 留在数据目录里，旧版本不读它。工作台的库只被只读打开，不受影响。

## A-2：本地写入（编辑、汇率、出金、资金流）

2026-11-13 用户要求：资产页做到与工作台一样的交易所同步、行情与汇率更新、编辑与出金登记。分两次发布：A-2（本节，本地写入）先发，A-3/A-4（下一节，凭据与同步）随后。

- 等级 R3（账本写入、并发锁、与导入的竞争）。回滚版本 v0.15.0：本批不改 `config.json` 格式；`asset.sqlite` 只新增 `sync_locks` 表与新的设置值，v0.15.0 只读 `assets`、`settings`、`snapshots`，回退后照常读取（回退后页面看到的是本批写入后的数据，不会回到导入时刻）。
- 影响面：`src/asset/`（库打开方式、新增写入与锁）、`src/http.ts`（资产写接口）、`src/service/main.ts`（装配）、资产页与其样式、文档与测试。划转、ADL、原油、期权、行情监控不变。

**对照的工作台代码**（`modules/asset`，`0014655`）：`lib/store.ts` 的 `withLock`、`snapshot`、`editAsset`、`editFx`、`saveWithdrawal`、`deleteWithdrawal`；`lib/sync-lock.ts`；`lib/cash-flow-store.ts` 的 `saveCashFlow`；`lib/validation.ts` 的 `editSchema`、`fxSchema`、`withdrawalSchema`、`withdrawalIdSchema`、`editValue`；`app/api/ledger|withdrawals|cash-flows/route.ts`；页面 `app/dashboard.tsx` 的编辑与汇率弹窗、`withdrawals-panel.tsx`、`cash-flows-panel.tsx` 的登记表单。

**库与锁**

- 服务改为读写打开 `asset.sqlite`（仍是首次用到且文件存在时才打开；文件不存在 = 未导入，写接口回 409“尚未导入资产账本”）。打开时 `CREATE TABLE IF NOT EXISTS sync_locks(id INTEGER PRIMARY KEY CHECK(id = 1), expires INTEGER NOT NULL, token TEXT NOT NULL)`（单用户，去掉 `owner` 列，固定一行）。库文件或其 `-wal`/`-shm` 不归服务账户、打不开写时，读接口照常（退回只读打开），写接口回 409 并说明“资产库不可写（属主不是服务账户），请重新导入”。
- 同步锁照搬工作台 `sync-lock.ts`：每次取锁一个随机令牌，TTL 120 s、每 30 s 续期、最长持有 600 s；忙时报“资产正在更新，请稍后重试”（409）；每次写入在一个 `BEGIN IMMEDIATE` 事务里先核对令牌未过期才写，否则报“资产更新超时或已被其他操作接替，本次结果未保存”。随机数用 `node:crypto`。
- **与导入的竞争**（工作台没有这一情形）：取锁时记下 `settings.import-info` 的原值，每次写入事务里同时核对它没变；导入在锁持有期间整体替换了账本时，本次写入作废并报“资产账本刚被重新导入，本次修改未保存，请刷新后重试”。导入本身不取锁（导入写入是单个事务，替换后旧锁令牌照常过期）。
- 每次写入后照工作台 `snapshot()` 写当天（北京时间）的日快照 `snapshots(date='YYYY-MM-DD')`，口径用已复制的 `snapshotValues`、`configuredExchanges`、`embeddedWithdrawals`；本服务没有持仓缓存（A-5），快照不带 `positions`。

**写接口**（都要登录；沿用现有 POST 的页面请求标记与 JSON 检查；本服务只有 POST，删除与修改也用 POST；输入严格校验、拒绝未知字段，规则与工作台 zod 规则逐条相同，不引入 zod；成功都返回新的 `/api/asset/ledger` 应答）：

| 接口 | 工作台对照 | 输入 |
| --- | --- | --- |
| `POST /api/asset/assets/edit` | `PATCH /api/ledger`（编辑资产） | `{id:'row-<n>', quantity:0–1e15, price:0–1e9 或 null}`；交易所行拒绝（“交易所资产由只读接口维护”）；`market` 行只改数量；数量大于 0 时须有单价 |
| `POST /api/asset/fx` | `PATCH /api/ledger`（汇率） | `{fx: 0 < fx ≤ 1000}`，状态记为手动 |
| `POST /api/asset/withdrawals/add`、`/edit` | `POST`/`PATCH /api/withdrawals` | `{id:UUID, date:'YYYY-MM-DD', amount: >0、≤1e12、最多两位小数, note: ≤200 字}`；日期不早于原表基准日、不晚于北京时间今天；重复提交同一编号同内容视为成功；上限 2000 条 |
| `POST /api/asset/withdrawals/delete` | `DELETE /api/withdrawals` | `{id:UUID}` |
| `POST /api/asset/cash-flows` | `POST /api/cash-flows` | 工作台 `parseCashFlow` 的输入（已复制在 `cash-flows.ts`），返回资金流列表 |

- 报错照工作台 `api.ts` 的 `failure`：校验错误 400“输入格式不正确，请检查数值和连接信息”；业务错误原文 400；锁忙 / 被接替 / 被导入替换 409；库错误 503“服务暂时不可用，已保留上次数据，请稍后重试”，不回显 SQL。
- 写入成功后 `GET` 读接口立刻反映（同一连接）。

**页面**（照 `dashboard.tsx`、`withdrawals-panel.tsx`、`cash-flows-panel.tsx` 排版，样式从工作台 `globals.css` 复制，规则同 [frontend.md](frontend.md)）

- 去掉“只读”提示；手动维护与 `market` 行的“编辑”按钮、汇率格的“修改”入口、出金子页的“记一笔出金”表单与每行编辑 / 删除、资金流面板的登记表单，均照工作台。工作台是弹窗，本页用原位展开面板（同 A-1 的做法）。写入时按钮禁用、成功提示“已保存”、失败原位显示原因。
- 交易所行在本批仍显示导入时的估值（同步属 A-3），提示文案相应调整。

**测试**：校验规则逐条（边界与未知字段）、锁（忙、过期接替后写入作废、续期、释放只删自己的锁）、导入替换后写入作废、各写接口的成功与失败（含 CSRF 标记缺失 403、未导入 409、库只读 409）、日快照内容、页面请求编号与表单文案。工作台 `tests` 里覆盖这些函数的用例搬过来，期望值不改。

## A-3/A-4：凭据、交易所同步、行情与汇率（方案）

- 等级 R3（凭据存放、外部调用、导入凭据）。回滚版本：A-2 发布的版本；新增的 `connections` 表与密钥文件旧版本不读。
- **数据源**（全部只读，照工作台 `lib/exchanges.ts`、`okx.ts`、`gate.ts`、`hyperliquid.ts`、`rh-lighter.ts`、`variational*.ts`、`fx.ts`）：Binance、Bybit、OKX、Gate、Aster（最多 10 个 API Pro 钱包账号，可选含现货）、Hyperliquid 与 Lighter RH（只填钱包地址）、Variational（vr-token，经 `python3 -I` 标准库脚本读取，本机没有 python3 时该源报“客户端不可用”）；行情 CoinGecko（VIRTUAL/USDT/USDC，失败退 Coinbase），人民币汇率 Coinbase（失败退 Frankfurter ECB，7 天内）。每次请求 12 s 超时、不重试（下一分钟再读）；失败只标该行“同步失败 · 保留旧值”。签名复用 `src/vendor` 的 Binance、Bybit 传输层，补拷工作台 `server/exchange-transport` 的 OKX、Gate；Aster 签名用本仓库 `src/aster/eip712.ts`，不引入 ethers 运行时依赖。
- **同步**：`POST /api/asset/sync` 照 `refresh()`：30 s 内重复请求直接返回当前账本；取锁后各源并行，凭据在读取期间被换掉的源不写结果；最后写日快照。页面打开且可见时每 60 s 触发一次（照 `refresh-loop.ts`），另有“同步”按钮；服务端不定时同步（与工作台一致，页面不开就不读外部接口）。
- **凭据存放**：AES-256-GCM 加密存在 `asset.sqlite` 的 `connections(exchange, encrypted, updated_at)`，附加数据为连接名（如 `binance`、`aster:<账号编号>`）；密钥是数据目录里的 `asset-credential.key`（64 位十六进制，600，服务账户），服务第一次保存连接或导入连接时生成。与工作台相同，密钥与库在同一台机器的同一账户下，防的是库文件单独外泄；接口与日志只给出连接名与密钥尾号，不回显凭据。
- **连接管理**：`POST /api/asset/connections`（连接 / 更新，先实测读取成功才保存，失败什么都不改）、`/connections/delete`（断开，保留旧值）、`/aster-accounts/add|edit|delete`，规则照工作台 `connect`、`disconnect`、`connectAsterAccount`、`deleteAsterAccount`。
- **从工作台导入连接**：导入资产账本时，读取子进程（以工作台库属主身份）同时读工作台 `<DATA_DIR>/modules/asset/config.json` 的 `credentialKey` 与该用户的 `connections`，解密后经管道交给写入子进程，以本服务的密钥重新加密写入；预览只列有连接的交易所名。工作台密钥缺失或解密失败时只导入账本、不导入连接，并在结果里写明。重新导入时连接以工作台为准整体替换。
- 未纳入：Variational 连接诊断（`/api/connections/variational-test`）、持仓与成交（A-5）、交易凭据导出与原表导入（A-6）。
