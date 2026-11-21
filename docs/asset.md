# Asset 模块：实施方案 v1.0

2026-11-13 用户决定：工作台原有的各模块都要在本仓库里具备（不在工作台上替换）。Asset（资产账本）按下面的批次接入，只在 `config.json` 配置了 `asset` 时启用；未配置时服务行为不变。

对照的工作台代码：`modules/asset`（最后修改提交 `0014655`）。工作台 Asset 的功能编号 A01–A15 沿用。

## 当前状态（v0.19.0）

- 已发布：A-1 只读账本随 v0.12.0；v0.15.0 起在设置页「从工作台导入」里启用并导入账本；A-2 本地写入（编辑手动资产、汇率、出金、资金流）随 v0.16.0；A-3/A-4（凭据加密存放、交易所连接与同步、行情与汇率自动更新、从工作台导入连接）随 v0.19.0，尚未用真实交易所账户读取过。
- 进行中：A-5（持仓与成交，见下文 A-5）。
- 进行中：A-6 的原表导入（A08，见下文 A-6）；A14 交易凭据导出不迁移（见批次表）。
- 下文 A-1 一节是当时只读批次的记录；写入入口、去掉只读提示等以 A-2 一节为准。

## 批次

| 批次 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| A-1 | 只读账本与计算口径：库结构、每日快照、账本读取、资产走势（A10）、日变化归因（A12）、出金与现金流的只读展示；从工作台导入历史数据的命令 | R2 | 完成（Linux CI 通过），随 v0.12.0 发布 |
| A-2 | 本地写入：手工资产（A06）、汇率（A07）、出金（A09）、现金流（A11）、同步锁 | R3 | 完成，随 v0.16.0 发布（见下文 A-2） |
| A-3 | 凭据与中心化交易所余额同步（A01、A02：Binance、Bybit、OKX、Gate）、行情与汇率自动更新 | R3 | 完成，随 v0.19.0 发布（见下文 A-3/A-4） |
| A-4 | 其余数据源（Aster 多账户 A03、Hyperliquid、Lighter RH、Variational A15） | R3 | 与 A-3 同批，v0.19.0 |
| A-5 | 持仓与成交（A04、A05） | R2（`fill_cache` 新表按数据库结构归 R3，回滚见下文 A-5） | 进行中（见下文 A-5） |
| A-6 | 原表导入（A08） | R3 | 进行中（见下文 A-6） |
| — | 交易凭据导出（A14） | — | 不迁移：工作台只把只读密钥导出给交易中心的只读账本；本仓库没有这个账本，原油盈亏直接读执行账户，资产与交易同在一个进程 |

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
- 走势图用本仓库的 `svg-plot.tsx`。v0.76.0 起只在作图时抽稀（`web/src/asset-format.ts` 的 `trendPlotPoints`）：首末快照跨度超过 60 天每 3 天一点、超过 180 天每 7 天一点，区间以最新快照为终点，每段取最新的完整快照（全不完整时取最新一份），首份快照保留；点仍是真实快照，不取均值，入金等台阶不被抹平。区间变化、月度表现与年化指标照旧按全部快照计算，标题右侧注明当前粒度。
- 走势图样式：`web/src/asset.css` 复制自工作台 `modules/asset/app/globals.css` 里这些页面用到的规则，每条选择器前加 `.asset-desk ` 限定范围（详见 [frontend.md](frontend.md)《资产页》）。

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

- 服务改为读写打开 `asset.sqlite`（仍是首次用到且文件存在时才打开；文件不存在 = 未导入，写接口回 409“尚未导入资产账本”）。打开时 `CREATE TABLE IF NOT EXISTS sync_locks(id INTEGER PRIMARY KEY CHECK(id = 1), expires INTEGER NOT NULL, token TEXT NOT NULL)`（单用户，去掉 `owner` 列，固定一行）。库文件或其 `-wal`/`-shm` 不归服务账户、SQLite 报不可写（READONLY / PERM / CANTOPEN）时，读接口照常（退回只读打开），写接口回 409 并说明“资产库不可写……请把它们改回服务账户所有（chown）并可写后重试”；打开时碰上导入正在写（BUSY）同样只读打开，但写接口报“资产正在更新，请稍后重试”，下一次写入重新打开。服务连接的 `busy_timeout` 为 1 秒（node:sqlite 同步等待，会挡住同进程的 ADL 与划转），导入连接仍为 5 秒。
- 同步锁照搬工作台 `sync-lock.ts`：每次取锁一个随机令牌，TTL 120 s、每 30 s 续期、最长持有 600 s；忙时报“资产正在更新，请稍后重试”（409）；每次写入在一个 `BEGIN IMMEDIATE` 事务里先核对令牌未过期才写，否则报“资产更新超时或已被其他操作接替，本次结果未保存”。随机数用 `node:crypto`。
- **与导入的竞争**（工作台没有这一情形）：取锁时记下 `settings.import-info` 的原值，每次写入事务里同时核对它没变；导入在锁持有期间整体替换了账本时，本次写入作废并报“资产账本刚被重新导入，本次修改未保存，请刷新后重试”。导入本身不取锁（导入写入是单个事务，替换后旧锁令牌照常过期）。
- 每次写入后照工作台 `snapshot()` 写当天（北京时间）的日快照 `snapshots(date='YYYY-MM-DD')`，口径用已复制的 `snapshotValues`、`configuredExchanges`、`embeddedWithdrawals`；A-2 时本服务没有持仓缓存，快照不带 `positions`；自 A-5 起经持仓缓存的 `peek` 带 `positions`（不发起读取，见 A-5 节）。

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

- 去掉“只读”提示；非交易所行（手动维护、`market`）的“编辑”笔形按钮（“新增出金记录”行点了跳到出金子页）、USD / CNY 格的笔形按钮、出金子页的“登记出金”与每行编辑 / 删除、每日波动里资金流面板的“登记资金流”与每条“修改/作废”，均照工作台。工作台是弹窗，本页用原位展开面板（同 A-1 的做法）：编辑面板在资产明细表上方，汇率面板在汇总格下方，出金的登记与删除确认在出金表上方，资金流表单在资金流列表上方。
- 全页同一时间只发一笔写入（照工作台 `mutate()`）：写入时各写入按钮禁用；成功后面板关闭、页面顶部显示“已保存”4 秒，账本应答直接成为当前值，状态、历史、出金、每日波动与资金流随即重读；失败原位显示原因、输入保留；409 或结果未知（超时、断网、5xx）、以及成功但应答无法解析时，账本也重读一遍，让页面显示库里实际的数据；401 转登录。写入超时 20 秒（锁内写入比读取慢）。
- 出金与资金流的编号在打开表单时生成（`newRequestId()`，页面在 http 下没有 `crypto.randomUUID`），重试沿用同一编号，应答丢失后再点保存不会记两笔。
- 汇率面板说明改为“汇率自动更新尚未接入，这里设置的值会一直使用”（工作台写的是“下一次自动获取成功后会覆盖”）；按钮“使用此汇率”。
- 交易所行在本批仍显示导入时的估值（同步属 A-3），顶部提示、交易所合计与出金页脚注相应说明；提示还写明重新导入会覆盖本页做过的修改。

**测试**：校验规则逐条（边界与未知字段）、锁（忙、过期接替后写入作废、续期、释放只删自己的锁）、导入替换后写入作废、各写接口的成功与失败（含 CSRF 标记缺失 403、未导入 409、库只读 409）、日快照内容。工作台 `tests` 里覆盖这些函数的用例搬过来，期望值不改。页面表单没有单元测试（工作台对应面板也没有），靠无头浏览器走查：编辑（含“数量大于零时，请填写单价”的报错）、汇率（含越界 400）、出金登记 / 修改 / 删除、资金流登记与作废。

## A-3/A-4：凭据、交易所同步、行情与汇率（v0.19.0）

- 等级 R3（凭据存放、外部调用、导入凭据）。回滚版本：A-2 发布的版本；新增的 `connections` 表与密钥文件旧版本不读。
- **数据源**（全部只读，照工作台 `lib/exchanges.ts`、`okx.ts`、`gate.ts`、`hyperliquid.ts`、`rh-lighter.ts`、`variational*.ts`、`fx.ts`）：Binance、Bybit、OKX、Gate、Aster（最多 10 个 API Pro 钱包账号，可选含现货）、Hyperliquid 与 Lighter RH（只填钱包地址）、Variational（vr-token，经 `python3 -I` 标准库脚本读取，本机没有 python3 时该源报“客户端不可用”）；行情 CoinGecko（VIRTUAL/USDT/USDC，失败退 Coinbase），人民币汇率 Coinbase（失败退 Frankfurter ECB，7 天内）。每次请求 12 s 超时（Var 经 python3 读取为 20 s，子进程整体 23 s）、不重试（下一分钟再读）；失败只标该行“同步失败 · 保留旧值”。签名复用 `src/vendor` 的 Binance、Bybit 传输层，补拷工作台 `server/exchange-transport` 的 OKX、Gate；Aster 签名用本仓库 `src/aster/eip712.ts`，不引入 ethers 运行时依赖。
- **同步**：`POST /api/asset/sync` 照 `refresh()`：30 s 内重复请求直接返回当前账本；取锁后各源并行，凭据在读取期间被换掉的源不写结果；最后写日快照。页面打开且可见时每 60 s 触发一次（照 `refresh-loop.ts`），另有“刷新资产”按钮。页面等待同步 80 s（同工作台）；极慢的网络下服务端同步可能更久（例如 10 个 Aster 账号分 4 轮），页面先报“同步失败”，服务端随后照常写入，期间再点刷新得到 409（正在同步），下一分钟的自动同步会读到结果；服务端不定时同步（与工作台一致，页面不开就不读外部接口）。
- **凭据存放**：AES-256-GCM 加密存在 `asset.sqlite` 的 `connections(exchange, encrypted, updated_at)`，附加数据为连接名（如 `binance`、`aster:<账号编号>`）；密钥是数据目录里的 `asset-credential.key`（64 位十六进制，600，服务账户），服务第一次保存连接或导入连接时生成。与工作台相同，密钥与库在同一台机器的同一账户下，防的是库文件单独外泄；接口与日志只给出连接名与密钥尾号，不回显凭据。
- **连接管理**：`POST /api/asset/connections`（连接 / 更新，先实测读取成功才保存，失败什么都不改）、`/connections/delete`（断开，保留旧值）、`/aster-accounts/add|edit|delete`，规则照工作台 `connect`、`disconnect`、`connectAsterAccount`、`deleteAsterAccount`。
- **从工作台导入连接**：导入资产账本时，读取子进程（以工作台库属主身份）同时读工作台 `<DATA_DIR>/modules/asset/config.json` 的 `credentialKey` 与该用户的 `connections`，解密后经管道交给写入子进程，以本服务的密钥重新加密写入；预览只列有连接的交易所名。工作台密钥缺失或解密失败时只导入账本、不导入连接，并在结果里写明。重新导入时连接以工作台为准整体替换。
- **重新导入的识别**：`import-info` 带每次导入随机生成的 `importId`；同步与连接写入在租约事务里比对整段 `import-info`，读取外部接口期间账本被重新导入时，旧同步什么都不写、返回 409（`reimported`）。只比对导入时刻时，同一毫秒内的两次导入无法区分。
- **代码**：`src/asset/sync.ts`（连接、断开、Aster 账号、同步，照工作台 `store.ts`）、`src/asset/credentials.ts`（密钥文件与 AES-GCM）、`src/asset/sources/*`（数据源读取）；页面 `web/src/AssetConnections.tsx`、`web/src/asset-refresh-loop.ts`，做法见 [frontend.md](frontend.md)《资产页同步与交易所连接》。测试 `test/asset-sync.test.ts`、`test/asset-credentials.test.ts`、`test/asset-sources-*.test.ts`，外部读取全部替换，不连网。
- **回滚**：`sudo bash install.sh --version v0.18.0`，配置不用改；`connections` 表与 `asset-credential.key` 旧版本不读，回退期间资产页不同步，再升级回来连接照常可用；v0.19.0 同步时写进 `aster-accounts` 的钱包地址（不是凭据）在旧版本的账本接口里会原样返回给页面。
- 未纳入：Variational 连接诊断（`/api/connections/variational-test`）、持仓与成交（A-5）、交易凭据导出与原表导入（A-6）。
- **Gate 错误诊断（v0.29.1，与工作台不同）**：真实账户上 Gate 总资产接口返回过 HTTP 500 与本程序未收录的 `label`，页面只显示固定代号 `API_CODE_UNKNOWN`，看不出真实错误码。现在未收录的 `label` 只要是纯大写字母单词以下划线连接、3–40 个字符（密钥、签名、地址、网址与句子都不是这个形状），就原样显示在诊断里（如 `HTTP 500 · SOME_LABEL`）供反馈；其余形状仍只显示 `API_CODE_UNKNOWN`，`message` 等字段照旧不显示。补收录文档里的 `SERVER_TIMEOUT`、`FAILED_RETRIEVE_ASSETS`；5xx 的诊断加上“请稍后重试”。回滚 `sudo bash install.sh --version v0.29.0`，不用改配置。审查记录见 [reviews/2026-11-15-gate-unlisted-label.md](reviews/2026-11-15-gate-unlisted-label.md)。

### 同步内共用公开价格（v0.68.0，R2）

- 一轮同步里，多个数据源会各自读同一个公开价格地址：Gate、Hyperliquid、Variational 和行情各读一次 CoinGecko，汇率和行情回退各读一次 Coinbase，每个 Bybit 钱包按币种读现货价。`src/asset/sources/shared-reads.ts` 把这些读取合并：同一地址在一轮同步里只请求一次，同时到达的读取等同一个应答。
- 共享公开 GET 包括 CoinGecko `simple/price`、Coinbase `exchange-rates`、Bybit 现货 `tickers` 与 Frankfurter 的 USD/CNY 参考汇率。账户请求按原有权限和签名流程单独读取。
- 不同同步轮次可复用收到后 30 秒内的有效报价。有来源时间的行情同时受上游有效期约束，到期即重新获取。交易所即使返回 HTTP 200，只要正文是限流、错误或缺少报价，下一次请求也会重读。同一地址共享在途请求，单个调用方取消只结束自己的等待。最多保留 64 个地址，单份保留上限 128 KiB，应答超过 2 MiB 时读取失败。
- 有上游时间的价格使用上游时刻，Coinbase 等缺少上游时刻的报价保留首次实际获取时间。使用公开价格折美元的账户估值采用余额与所用报价中较早的时间，连接状态仍记录本轮同步时间。
- 三个数据源原来各带自己的 `ids=` 参数，现在统一用 `quotes.ts` 的 `COINGECKO_QUOTES`（VIRTUAL、USDT、USDC 三个币），各源只取自己需要的币，解析和失败回退不变。
- Binance 持仓读取用的合约目录（10 分钟缓存）和 Aster 的 `exchangeInfo` 没有与执行器共用：它们在不同进程、用不同的解析和有效期。
- 测试：`test/asset-shared-reads.test.ts`，以及 `test/asset-sources-{gate,hyperliquid,variational}.test.ts` 里更新后的地址。回退 v0.67.1 不用改配置或数据。

## A-5：持仓与成交（A04、A05）

**范围**

- 服务端持仓读取与缓存：只用资产已保存的连接，只读，保留只读权限校验；新增 `GET /api/asset/positions`，含本轮盈亏（cycle）。
- 成交读取与缓存：`asset.sqlite` 新增 `fill_cache` 表；新增 `GET /api/asset/fills?market=oil|hynix`。Anthropic（ANT）市场与归属不迁移，登记为未做。
- 页面：资产工作区新增「持仓」页（总览与资产）；行情监控原油、海力士详情的价格图加成交标记，并加「关联持仓」（含本轮盈亏）。
- 每日快照（`daily-positions.ts` 的口径）用持仓缓存的 peek 写入 `positions`，peek 不发起读取。
- 不含：A08（下一批）、A14（不迁移，见批次表）、工作台的成交诊断接口与指标。

**对照的工作台文件（`project-aggregation` 提交 `7745181`；资产库与 `0014655` 相同）**

- 后端（`modules/asset/` 下）：`lib/hub-positions.ts`、`lib/positions-readers.ts`、`lib/positions-catalog.ts`、`lib/positions-values.ts`、`lib/positions-decimal.ts`、`lib/positions-types.ts`、`lib/positions-cycle.ts`、`lib/positions-cycle-readers.ts`、`lib/positions-history.ts`、`lib/positions-evidence.ts`、`lib/hub-fills.ts`、`lib/hub-fills-readers.ts`、`lib/hub-fills-replay.ts`、`lib/hub-fills-types.ts`、`lib/daily-positions.ts`、`lib/store.ts`（断开连接清成交缓存）、`drizzle/0002_fill_cache.sql`；Variational 持仓（`lib/variational-python-client.ts`、`scripts/variational-diagnostic.py`）与 RH Lighter 持仓（`lib/rh-lighter.ts`）。
- 接口：`app/api/hub/positions`、`app/api/hub/fills` 的路由（参数校验与 400/503 文案）。
- 页面：`src/TradingPositions.tsx` 与 `src/trading-center.css`（持仓页）；`modules/monitor/app/related-positions.tsx`、`spread-chart.tsx`、`oil-panel.tsx` 及其依赖（关联持仓、成交标记）。

**改动范围**

- 新文件：`src/asset/positions-*.ts`、`src/asset/fills-*.ts`（逐个复制并在文件头注明来源与差异）。
- 修改：`src/asset/db.ts`（`fill_cache` 表）、`import.ts`（导入时清空）、`sync.ts`（断开连接清缓存、快照带持仓）、`writes.ts`（快照 peek）、`store.ts`（服务生命周期）、`src/http.ts`（两个接口）、`sources/variational-python.ts`、`sources/rh-lighter.ts`、`scripts/variational-balance.py`；页面 `web/src/` 新增持仓页、改行情监控原油与海力士详情、`workspace-nav.ts`；测试与 `scripts/test.ts`。

**`fill_cache` 迁移与旧版本兼容**

- 结构：`fill_cache(account, scope, revision, data, updated_at, PRIMARY KEY(account, scope))`，即工作台表去掉 `owner` 列。服务以 `service` 方式打开库时 `CREATE TABLE IF NOT EXISTS`，与 A-3 加 `connections` 表相同；导入的新库直接带这张表。
- 缓存内容可丢：表缺失、读不出或写失败只让下一次冷读取改为完整读取历史；凭据换了（revision 不同）的行在读取时删除；断开连接与重新导入时一并删除。
- 旧版本：v0.53.0 及以前不认识这张表，也不会读写它；回滚后表留在库里不影响账本，重新升级后按 revision 校验继续使用。

**回滚**

`sudo bash install.sh --version v0.53.0`。不需要处理数据：`fill_cache` 只是缓存，旧版本忽略它；每日快照里多出的 `positions` 字段旧版本读取时忽略（工作台快照本就带这个字段）。

### A-5 实施记录（与上文不同或补充的地方）

- **后端**（提交 `3945481`）：
  - 按上文「改动范围」逐个复制，文件头注明了来源与差异；
  - 持仓服务与成交服务由 `createAssetStore` 持有，测试与示例可以注入 `positions` / `fills` 选项，替换交易所读取；
  - 每日快照通过 `peek` 取持仓缓存。
- **页面**：
  - 持仓页见 [frontend.md](frontend.md)《持仓页与成交标记（Asset A-5）》；
  - 原油、海力士详情的成交标记、套利成交面板与关联交易见 [monitor.md](monitor.md)《M14：成交标记与关联交易》；
  - 页面里「关联持仓」的标题沿用工作台 `related-positions.tsx` 的实际文案「关联交易」。
- **与工作台的差别**：
  - 只有本服务一个来源（工作台汇总多个 Asset 项目），来源名固定为「资产账本」，所以去掉了来源筛选和「（来源 n）」区分；
  - 页面直接读本服务接口，代替 iframe 桥接；
  - 关联交易 A-5 时放在图表下方；v0.57.0 起照工作台放在详情页右侧栏，Anthropic 也有（见 monitor.md《M14》的「详情页右侧栏」）。
- **与工作台不同的安全口径**（审查后修改）：持仓快照的只读权限校验失败（Binance 任一写权限或缺读权限、Bybit `readOnly≠1`、OKX `perm≠read_only` 或 config 不是单条）时：
  - 读取器抛带类型的 `PositionsPermissionError`（`code` 为 `POSITIONS_PERMISSION`，文案仍是 `POSITIONS_FAILED`）；
  - 成交刷新随即中止，不再用该凭据读 85 天历史，并删除该凭据在 `fill_cache` 里所有市场、所有范围的行；同一凭据（同一 revision）其它市场、其它范围的内存条目同时作废并清空历史与游标，之后它们遇到网络失败也不会把旧成交写回；
  - 该范围回应 `status: 'error'`，配固定文案 `FILLS_PERMISSION`，不回显上游内容，与网络失败的 `FILLS_FAILED` 区分；监控页成交面板据此提示到资产页更换只读 Key；
  - 持仓页对权限校验失败的 Key 仍显示上次完整持仓快照，本轮盈亏中的成交与账单随该凭据的权限作废；
  - Aster、Variational、Lighter 没有权限接口，不走这条路径；
  - 工作台 `hub-fills.ts` 第 189–192 行把它当普通快照失败，仍会读历史。
- **Binance 请求权重估算**（按读取器实际发出的请求估算，未在真实账户上实测）：
  - 本轮盈亏首次回溯 85 天时，每个持仓约 455。已有完整历史后只补缺口与最近十分钟，见下节；
  - 成交冷读：约 130 / 范围；之后的增量读取远小于此；
  - 持仓页：每 5 秒一次读接口，服务端缓存命中时为 0，缓存过期后约 5；
  - 这些都按出口 IP 计。与原油执行账户、同机的工作台共用出口 IP 时三者叠加，持仓多时注意 Binance 每分钟权重上限。
- **没做（登记）**：
  - Anthropic（ANT）的成交读取、执行归属与关联持仓合计：`fillsQueryMarket` 只接受 `oil` / `hynix`；Anthropic 详情的关联交易只列逐腿持仓。
  - A08 留到下一批；A14 不迁移。
- **测试**：
  - 后端：`test/asset-fills.test.ts`、`asset-positions-*.test.ts`、`positions.test.ts`；
  - 页面纯函数：`test/monitor-trades.test.ts`、`test/monitor-related.test.ts`；
  - 导航与路由：`test/workspace-nav.test.ts`、`test/web.test.ts`；
  - 所有交易所读取都换成替身。

### 持仓盈亏的历史增量读取

Binance、Bybit 和 OKX 的持仓页用实时账户快照确定当前方向和数量，随后从资产库重放本轮成交与资金账单。原油、海力士成交标记也会留下完整的原始成交。交易所接口、账户、凭据版本、产品范围和合约一致时，两处可以复用同一段记录。成交面板仍最多保存每组最近 2,000 笔供展示恢复，持仓盈亏可以回放更早的开仓。

`asset_history_windows` 在建库或服务首次以可写方式打开旧库时创建。每条记录包含一个连续毫秒区间和通过检查的原始字段，以 UTC 日期分段。完整读到空段也可复用。每次刷新都重查最近十分钟及尚未覆盖的区间，最新的成交查询保留开放上界，以发现交易所时钟略快的成交。Bybit 逐合约保留同毫秒成交顺序及结算流水。OKX 找到开仓时会读完该时间戳的分页。同合约反向腿仍参与资金费归属判断。

上游失败、游标异常或单段写盘失败时，下次从已完成的区间续读。成交面板发现同一笔成交的价格等固定字段冲突时，删除该组展示缓存与两条记录各自所在的原始区间，刷新时向交易所重新核对。争议发生前已发出的权限查询仍对当时的授权有效。更换或断开只读连接、从工作台重新导入账本，会在同一事务中清理旧账户历史。

打开资产库后，首次使用某个账户、凭据版本的私有历史前，服务先通过交易所权限接口确认只读。原油、海力士、各产品范围与持仓页共享同一次并发核验。成功后恢复已存成交、历史游标和刷新时间。持仓接口单独断网时，仍可按游标补成交，开平仓方向标为未知。首次核验遇到网络错误时，成交列表保持空，历史请求等到下次确认权限后发起。

已保存连接的持仓、成交或余额刷新发现只读权限被拒时，立即作废先前排队及在途的读取，清空该凭据在各市场的成交和游标，再尝试在一个事务中清除展示缓存与原始区间。SQLite 只读或写锁超时会使旧行留在库中。此时新打开的市场、空闲后重新加载的面板与重启后的服务仍须取得交易所的正面核验才能使用这些行。更换凭据按新版本独立核验，试连候选凭据失败保留已保存连接。回退可运行 `sudo bash install.sh --version v0.69.1`，该版本忽略原始历史表。

### 关联交易与成交回放共用持仓采样

资产页、监控关联交易和成交回放读取 Binance、Bybit、OKX 时，同一账户、凭据版本和产品范围共用一份完整的只读持仓采样。资产库的 `asset_position_snapshots` 每个账户和产品范围保留最近一份，记录实际查询起止时刻。验明当前凭据仍为只读后，采样开始后五秒内可复用，重复请求可等待同一次在途读取。历史成交、开平仓反推和本轮盈亏沿用实际采样时刻。执行器从自己的交易账户读取当前现场。

服务重启后先核验权限。最近一天内已超过五秒的持仓可按原时间显示为过期，同时后台重新采样。只读权限核验失败时，冷启动页面继续等待有效数据。更换或断开连接、重新导入及明确拒权会清理对应快照。旧库或只读库无法写缓存时仍可读取交易所。新增表只存归一化持仓字段，回退到 v0.70.2 可直接读取原账本。

在浏览器中，从正在同步的资产页切到持仓或行情监控时，若同步结束与新页面的读取交错，页面会在原时限内向服务再核对一次。账本、持仓或历史读取失败后，只有已有结果的项目才提示保留旧值。

### 每日套利仓位归因（v0.62.1）

- 资产刷新沿用现有同步节流，余额与持仓并行读取。持仓复用原有缓存与并发上限，资产同步最多等持仓请求 12 秒。本轮成交统计在后台完成，编辑资产等写入只取已有持仓缓存。
- 每两份快照按合约标的归入原油、海力士、ANT 或其他持仓，单腿也归入对应标的。Hyperliquid 使用资产里保存的钱包地址读取 `xyz`、`io` 永续仓位，按合约全名识别原油、海力士和 ANT，并保留交易所采样时间。两处目前提供浮盈亏，按快照内可核实的结算币价格折 USD，显示为部分贡献。
- 已配置范围读取失败、持仓快照缺失、换连接以及重复采样时保留未知。已平仓或本轮盈亏不可比时只计能核对的部分。旧快照已有的持仓按新规则归类，缺少覆盖记录的组保留未知。资产总额、资金流和出金沿用现有口径。
- 回滚版本为 v0.62.0。快照增加可选的持仓覆盖标记，旧版本可继续读取。

## A-6：原表导入（A08）

2026-11-16 开工。把工作台资产页「导入原表数据」搬过来：账本还是示例数据时，选一份由《资产统计.xlsx》生成的 JSON，先预览、再确认导入；导入前备份数据库。A14 不迁移（见批次表）。

- **等级 R3**（账本整体替换、数据库备份）。
- **对照的工作台代码**（`modules/asset/`，提交 `7745181`，这些文件与 `0014655` 相同）：
  - `lib/import-ledger.ts`（`importPlan`、`importLedger`）、`lib/source-ledger.ts`（`IMPORT_MAX_BYTES`、`parseSource` 及其 zod 规则）；
  - `app/api/import/route.ts`（`POST /api/import {source, apply}`）、`lib/api.ts`（请求体上限、`failure` 的报错口径）；
  - `app/import-ledger-dialog.tsx`（预览与确认弹窗）、`app/dashboard.tsx`（示例数据提示里的「导入原表数据」按钮，弹窗打开时暂停自动刷新）、`app/globals.css` 第 114 行（`.import-notice`、`.import-summary`）；
  - `scripts/import-workbook.py`（把原表转成 JSON；工作台由用户在命令行手动运行，服务端不调用它）。
- **范围**：
  - 服务端：`POST /api/asset/import`，在全局登录与页面请求标记检查之后，请求体上限 5 MB（单独放宽，其余接口仍是 16 KB）；规则照 `importLedger`：
    - 不能导入示例；
    - 同一份文件（sha256 指纹与上次导入相同）直接返回当前账本；
    - 账本已不是示例数据时拒绝（工作台判定：`source-ledger` 的 `source` 不是示例标记）；
    - 预览只返回摘要；应用时先备份数据库，再在一个事务里替换资产、写设置、把旧快照归档（`archived: true`，不进资产曲线）并写当天快照。
  - 页面：资产页示例数据提示里加「导入原表数据」，原位展开导入面板（本页的弹窗都改成原位面板），文案、摘要与按钮照工作台。
  - 脚本：`scripts/import-workbook.py` 照搬，仍由用户手动运行（需要 `openpyxl`），随安装包发布。
- **并发**：导入的预览与应用都在同步锁（`sync_locks`）里进行，同工作台 `withLock`。
  - 导入期间，A-2 的写入与 A-3 的同步取锁时得到 409「资产正在更新」；反过来，它们持锁时导入同样得到 409。
  - 写入时同样核对 `import-info`：备份与写入之间，账本被「从工作台导入」整体替换时，本次导入什么都不写（409）。
  - 页面上导入面板打开期间，跳过每分钟的自动同步（同工作台 `importOpenRef`）。
- **影响面**：
  - `src/asset/`：新增导入模块，补全 `source-ledger.ts` 的 `parseSource`，`store.ts` 加导入方法；
  - `src/http.ts`：新接口与它的请求体上限；
  - 资产页与样式、`deploy/package.sh`（打包脚本）、文档与测试。
  - 库结构不变：只新增设置键 `source-import-hash`，以及数据目录下的 `asset-backups/`（导入前的备份，只留最近 5 份）。
  - 划转、ADL、原油、期权、监控不变。
- **回滚**：
  - 代码：`sudo bash install.sh --version v0.54.0`，不用改配置。旧版本照常读取导入后的账本，归档快照沿用已有的 `archived` 口径，`source-import-hash` 旧版不读。
  - 数据（撤销某次导入，会丢掉导入之后的所有变化，见实施记录）：停服务后，用 `asset-backups/before-import-<编号>.sqlite` 覆盖 `asset.sqlite`，并删除同目录的 `asset.sqlite-wal`、`-shm`，再启动。命令写在实施记录里。


### A-6 实施记录

- **服务端**（`src/asset/source-import.ts`、`source-ledger.ts` 的 `parseSource`、`store.ts` 的 `importSource`、`src/http.ts`）：
  - `parseSource` 把工作台的 zod 规则逐条手写：未知字段丢弃、项目与类别去空白、`future`/`rowSum`/`difference` 按 `startedAt` 重算，结果按 schema 的键序构造，指纹（`sha256(JSON.stringify(解析结果))`）与工作台对同一文件算出的相同；起始快照、行合计、三条必有资产等台账规则与报错原文照搬。
  - `importPlan` 照搬（只把「现在」改成注入的时钟）：保留已同步的交易所余额、手动修改与当前汇率。
  - 接口 `POST /api/asset/import`，请求体 `{source, apply, fingerprint?}`，多余字段 400。预览返回 `{preview: true, summary, fingerprint}`；应用与「同一份文件已导入」返回账本视图加 `{preview: false, alreadyImported, import: {summary, backupName} | null}`（账本视图本身已有 `summary`，导入摘要放在 `import` 下）。
  - 报错：超过 5 MB 413「导入文件不能超过 5 MB」；格式不对 400 `invalid_input`；示例文件、账本已有原表数据等工作台的拒绝 400 `asset_rejected`（原文）；文件与预览时不同 409 `import_changed`；锁被占 409 `busy`；备份失败 503 `backup_failed`。
  - 备份：`<数据目录>/asset-backups/before-import-<uuid>.sqlite`。目录 0700（不能是符号链接，已存在而权限更宽时收紧到 0700），先以 0600 独占创建临时文件 `.partial-<uuid>.sqlite`，再用 node:sqlite 的在线备份 `backup()` 从单独的只读连接一步复制完（`rate: -1`；复制在线程池里进行，事件循环照常运转，ADL、划转等循环不被卡住；分步复制时别的连接在两步之间写一次源库就会从头重来，写得频繁时没有上限，审查实测 24 MB 的库每 5 毫秒写一次 8 秒都没完成），复制件改为普通日志模式（单个文件，没有 -wal/-shm），`PRAGMA quick_check` 通过并 fsync 后才改名为正式的 `before-import-<uuid>.sqlite`，再对目录 fsync；任一步失败删掉临时文件、返回备份失败，账本不动。进程在复制中途退出留下的 `.partial-*` 不算备份、不占保留名额，下一次导入备份前清掉。导入在备份完成后才进入写入事务。导入成功后只保留按修改时间最新的 5 份 `before-import-*.sqlite`，更早的删除（目录里其他文件不动；导入失败时不清理）。
  - 写入在同步锁租约的事务里：再核对 `source-ledger` 仍是预览时那份、`import-info` 未变（`lease.write`），然后替换资产、写 `source-ledger`、`source-import-hash`、`fx`、`fx-status`、`last-attempt='0'`，旧快照与示例的原表期全部归档为 `archive-<批次>-<序号>`，最后用 `saveSnapshot` 写当天快照。
- **页面**（`web/src/AssetImport.tsx`、`AssetPage.tsx`、`asset.css` 末节）：示例数据提示文案与「导入原表数据」按钮照工作台；点开后在提示下方原位展开面板，标题、说明、文件框、摘要块、帮助文字、「取消 / 导入并保留已有修改」照 `import-ledger-dialog.tsx`；客户端先查 5 MB 与 JSON 格式。请求走页面的写入器（同一时间只有一个写入或同步，401 回登录，409 与 5xx 后重读账本），超时按连接接口的 60 秒。面板挂载期间跳过自动同步、「刷新资产」按钮置灰（`web/src/asset-import-gate.ts`：面板挂载时占用、卸载时释放，所以关闭、切到别的标签、账本不再是示例而收起，任何一种离开都恢复同步；切换标签与打开交易所连接时面板关闭）。成功与重复导入的提示条文案照工作台的 toast。
- **脚本**：`scripts/import-workbook.py` 照搬，只加了头部说明、缺参数时的用法提示，默认输出改为当前目录的 `imported-ledger.json`（工作台写进自己源码树的 `lib/`）。随安装包发布到 `<安装目录>/current/scripts/`（默认安装目录 `/opt/trading-platform`，页面上按这个口径写），服务端不调用：它要 `openpyxl`，服务器上没有也不该为此装；用户复制到自己电脑上运行，再在页面选择输出文件。
- **与工作台的差异**：
  - 应用必须带预览返回的指纹，文件在预览后变了就 409（工作台只凭重新发送的内容）；
  - 备份用 node:sqlite 的在线备份分步复制并做完整性检查，目录 `asset-backups/`，只留最近 5 份（工作台 `db.backup()` 到 `.data/backups/` 后再 chmod，不清理）；备份失败明确 503 且不写入；
  - 写入事务里再核对一次源账本与 `import-info`，挡住备份与写入之间的「从工作台导入」；
  - 请求体字段严格校验；弹窗改为原位面板；面板里多一行说明导入文件从哪来。
- **撤销某次导入**（默认目录，root 执行）。注意：用备份覆盖会回到导入前的那一刻，导入之后的所有变化都会丢掉，包括同步来的余额、交易所连接与凭据的增删、出金与资金流登记、手动修改；只在导入本身有误、且之后没有需要保留的变化时这样做：
  ```bash
  systemctl stop trading-platform
  cd /var/lib/trading-platform
  cp asset-backups/before-import-<编号>.sqlite asset.sqlite && rm -f asset.sqlite-wal asset.sqlite-shm
  chown trading-platform: asset.sqlite && chmod 600 asset.sqlite
  systemctl start trading-platform
  ```
- **备份实测**（本机，Node 24.15，49 MB 的库，一步复制含完整性检查，各 3 次）：无并发写入 0.23–0.32 秒，期间 5 毫秒定时器最长间隔 8–21 毫秒；另一连接每 5 毫秒写一次时 0.29–0.45 秒完成（期间写入 32–57 次照常提交），最长间隔 17–35 毫秒（含主线程上的 quick_check 与这些写入本身）；备份文件均为 0600。对照：同一库用 `VACUUM INTO` 要 0.25–0.39 秒且全程阻塞事件循环；分步复制（每步 256 页）在持续写入下 20 秒内完成不了（测试里改回分步复制即超时失败）。
- **只靠浏览器验收、与工作台相同的行为**：
  - 自动同步暂停的判断接在 `AssetPage.tsx` 的 refresh 回调里（`startRefreshLoop` 的定时器直接调用它），这段接线没有单元测试，靠替身后端浏览器走查验收（面板一直打开 66 秒无自动同步；切到别的标签后 60 秒时同步照常发出）；`asset-import-gate.ts` 的占用与释放有单元测试。
  - 关掉面板后不立即同步，要等下一次每分钟的定时器或页面事件（重新可见、聚焦、恢复联网）才同步，与工作台相同。
- **测试**：`test/asset-source-import.test.ts`（解析规则；预览不写；应用后的资产、设置、归档与当天快照，备份文件权限与内容；同一文件再导入；示例文件、已有原表数据、指纹不符、缺指纹、多余字段的拒绝都不写；备份目录不可用时不写且锁已释放；锁被占时预览与应用都 409；导入与编辑同时发起时编辑被拒；HTTP 的登录顺序与页面标记 403、5 MB 上限、其余接口仍 16 KB、各类报错码；备份之后、写入之前发生工作台重新导入、`source-ledger` 被改、租约过期时都不写入；约 24 MB 的库备份期间事件循环持续运转、已存在目录被收紧、只保留最新 5 份；另一连接持续写源库时备份仍在限定时间内完成、事件循环在转、残留的 `.partial-*` 被清掉、复制失败不留临时文件；页面同步暂停的占用与释放，含 StrictMode 的挂载、卸载、再挂载）。`deploy/test-install.sh` 加了发布包含转换脚本的检查。页面在替身后端走了一遍 1280 与 390 宽度：坏文件报错、预览摘要、取消、确认导入后提示消失并生成备份，面板打开期间没有同步请求。
