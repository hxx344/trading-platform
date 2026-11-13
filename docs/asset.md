# Asset 模块：实施方案 v1.0

2026-11-13 用户决定：工作台原有的各模块都要在本仓库里具备（不在工作台上替换）。Asset（资产账本）按下面的批次接入，只在 `config.json` 配置了 `asset` 时启用；未配置时服务行为不变。

对照的工作台代码：`modules/asset`（最后修改提交 `0014655`）。工作台 Asset 的功能编号 A01–A15 沿用。

## 批次

| 批次 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| A-1 | 只读账本与计算口径：库结构、每日快照、账本读取、资产走势（A10）、日变化归因（A12）、出金与现金流的只读展示；从工作台导入历史数据的命令 | R2 | 进行中 |
| A-2 | 本地写入：手工资产（A06）、汇率（A07）、出金（A09）、现金流（A11）、同步锁 | R3 | 未开始 |
| A-3 | 凭据与中心化交易所余额同步（A01、A02：Binance、Bybit、OKX、Gate） | R3 | 未开始 |
| A-4 | 其余数据源（Aster 多账户 A03、Hyperliquid、Lighter RH、Variational A15） | R3 | 未开始 |
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

```
sudo -u trading-platform node /opt/trading-platform/current/src/asset/import.ts --from <工作台 ledger.sqlite 的路径> --owner <工作台用户名> --data-dir /var/lib/trading-platform
```

- 以只读方式打开工作台的库，把指定用户的 `assets`、`snapshots` 和页面用到的 `settings` 复制进 `asset.sqlite`，一个事务内整体替换（三张表先清空再写入，别的用户、源库里已删掉的设置都不会残留）。复制的设置按白名单：`source-ledger`（原表数据：起始快照与原表各期次，账本、历史与日变化都以它为基准，**缺了就拒绝导入**）、`initialized`、`fx`、`fx-status`、`withdrawals`、`cash-flow-audit-v1`、`aster-accounts`、各交易所的 `-status`、`last-attempt`。凭据（`connections`）不读也不导入。
- 账户标识不导入：`aster-accounts` 只留 `id`、`name`、`value`、`details`、`updatedAt`、`includeSpot`、`configured`、`lastSync`、`error`、`scope`（去掉钱包地址 `walletAddress` 与密钥尾号 `label`）；各交易所 `-status` 只留 `configured`、`lastSync`、`error`、`scope`（去掉 `label`）。
- 写入前先把要导入的内容全部读出并校验：JSON 能解析、资产与快照的基本字段、`fx` 为正数、`cash-flow-audit-v1` 按工作台的审计规则校验、`source-ledger` 有起始快照；资产、快照与设置里任何一层出现凭据类字段名（`apiKey`、`apiSecret`、`secret`、`privateKey`、`passphrase`、`vrToken`、`walletAddress`、`encrypted`、`credential(s)`、`signer`、`apiSecretKey`、`secretKey`、`password`、`mnemonic`、`seedPhrase`、`accessToken`、`authToken`，不分大小写，也不管中间的下划线与连字符）就拒绝导入，报错只写字段名、不带内容。各交易所状态与 Aster 账号的报错原文（`error`）里的钱包地址与 64 位十六进制串导入时隐去。资产行、快照、出金备注与资金流记录里的文字（包括自己填的“账户标识”）原样导入，页面显示的内容与工作台相同。任何一项不通过都不动已有的 `asset.sqlite`，命令输出“导入失败，未改动已有数据：<原因>”并以 1 退出。
- `--data-dir` 须是绝对路径，按服务同样的规则拒绝工作台数据目录；`--from` 不能是本服务自己的 `asset.sqlite`。
- 重复执行以最新一次为准；导入时刻、源文件名、用户与条数记在 `settings` 的 `import-info`。成功时输出资产、快照与设置的条数。
- 服务运行中也可以执行（WAL），页面下次读取就是新数据，不用重启。
- 需要运行命令的账号（`trading-platform`）能读到工作台的库文件；读不到时由 root 把 `ledger.sqlite`（连同同目录的 `ledger.sqlite-wal`，有的话）复制到该账号能读的位置再导入。
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

**回滚**：`sudo bash install.sh --version v0.10.1`，回退前先删掉 `config.json` 里的 `asset`（旧版本不认识这个字段，配置检查会失败）。主库不变；`asset.sqlite` 留在数据目录里，旧版本不读它。工作台的库只被只读打开，不受影响。

## 后续批次要先定的事

- A-3：工作台的凭据用 `<ASSET_DATA_DIR>/config.json` 里的 `credentialKey` 加密存在库里。本服务的做法（密钥放进 `secrets.json`，还是明文凭据直接写在 `secrets.json`）在 A-3 开工前定。
- A-6：凭据导出涉及执行账户绑定，按 R3 走安全审查。
