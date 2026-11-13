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

- 本批没有选项，也不需要密钥。配置了 `asset`（或 `oil`、`monitor`）时 `pairs` 可以省略。

**数据**

- 独立库文件 `asset.sqlite`（数据目录内，自带建表、WAL），不给主库加迁移。
- 表与工作台 `ledger.sqlite` 同形，去掉 `owner` 一列（本服务只有一个使用者）：`assets(id, data)`、`settings(key, value)`、`snapshots(date, data)`（每个北京时间日期一行）。工作台的 `connections`（加密凭据）、`sync_locks`、`auth_attempts`、`fill_cache` 本批不建。
- 本批服务只读这个库，不写；库里的数据全部来自导入。

**从工作台导入历史数据**

```
sudo -u trading-platform node /opt/trading-platform/src/asset/import.ts --from <工作台 ledger.sqlite 的路径> --owner <工作台用户名> --data-dir /var/lib/trading-platform
```

- 以只读方式打开工作台的库，把指定用户的 `assets`、`snapshots` 和与展示有关的 `settings`（`fx`、`fx-status`、`withdrawals`、`cash-flow-audit-v1`、`aster-accounts` 的非敏感部分、各交易所的 `-status`、`last-attempt`、`initialized`）复制进 `asset.sqlite`，一个事务内整体替换。凭据（`connections`）不导入。
- 重复执行以最新一次为准；导入时刻与来源记在 `settings` 的 `import-info`。导入失败不改动已有数据。
- 服务运行中也可以执行（WAL），页面下次读取就是新数据。
- 需要运行命令的账号能读到工作台的库文件；读不到时把文件复制出来再导入。

**计算口径**

- 以下文件从工作台 `modules/asset/lib` 复制，只去掉对 Next.js、会话与凭据的依赖，计算不改：`asset-values.ts`、`performance-metrics.ts`、`daily-changes.ts`、`cash-flows.ts`、`withdrawals.ts`、`snapshot-history.ts`，以及它们用到的类型与工具。放在 `src/asset/`，文件头注明来源路径与提交号。
- 工作台 `modules/asset/tests` 里覆盖这些文件的用例原样搬到 `test/asset-*.test.ts`，作为口径没变的证据。

**接口**（都要登录，只读）

- `GET /api/asset/state`：是否已导入、导入时刻与来源、快照的日期范围；没配置 `asset` 时 404（页面据此不显示入口）。
- `GET /api/asset/ledger`：资产列表、汇率、最新快照的合计与分项（对照工作台 `app/api/ledger/route.ts` 的只读部分）。
- `GET /api/asset/history`：每日快照序列与收益指标（对照 `app/api/history/route.ts`）。
- `GET /api/asset/daily-changes`：日变化归因（对照 `app/api/daily-changes/route.ts`）。
- `GET /api/asset/withdrawals`、`GET /api/asset/cash-flows`：只读列表。
- 还没导入时这些接口返回空数据并标明 `imported: false`，不报错。

**页面**

- 地址 `#/asset`，标签“资产”，只在 `/api/asset/state` 有应答时显示。
- 对照工作台 `modules/asset/app/dashboard.tsx`、`asset-trend.tsx`、`daily-changes.tsx`、`withdrawals-panel.tsx`、`cash-flows-panel.tsx`（`0014655`）：总资产与分交易所合计、资产表、资产走势、日变化、出金与现金流列表。
- 页面顶部固定提示：本批只读，数据停留在导入时刻（写明时刻），同步与编辑尚未接入。所有写入入口（同步、添加资产、改汇率、记出金、连接交易所）本批不显示。
- 走势图用本仓库的 `svg-plot.tsx`。样式：`web/src/asset.css` 复制自工作台 `modules/asset/app/globals.css` 里这些页面用到的规则，每条选择器前加 `.asset-desk ` 限定范围。

**测试**

- 搬来的口径用例；新增：导入（只取指定用户、整体替换、失败不改动、不带凭据）、存储读取、配置解析、各接口的鉴权、404 与未导入时的应答。

**回滚**：`sudo bash install.sh --version v0.10.0`，回退前先删掉 `config.json` 里的 `asset`。主库不变；`asset.sqlite` 留在数据目录里，旧版本不读它。工作台的库只被只读打开，不受影响。

## 后续批次要先定的事

- A-3：工作台的凭据用 `<ASSET_DATA_DIR>/config.json` 里的 `credentialKey` 加密存在库里。本服务的做法（密钥放进 `secrets.json`，还是明文凭据直接写在 `secrets.json`）在 A-3 开工前定。
- A-6：凭据导出涉及执行账户绑定，按 R3 走安全审查。
