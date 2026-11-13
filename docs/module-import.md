# 行情监控与资产账本：从工作台导入面板启用（方案）

2026-11-13 用户决定：模块的启用与数据迁移一律做进设置页「从工作台导入」面板（及对应的命令行），不要求用户手改 `config.json`。本文是行情监控（[monitor.md](monitor.md)）与资产账本（[asset.md](asset.md)）接入面板的方案，接法照期权账户（[options.md](options.md) §3「导入」）。以后的新模块照本文做。

- 等级：R3（root 导入助手、配置写入、服务重启、往数据目录写库）。
- 回滚版本：v0.12.0（`sudo bash install.sh --version v0.12.0`）。本批不改配置格式（`monitor`、`asset` 两段与 v0.12.0 相同）、不改 `asset.sqlite` 结构，回退后已写入的配置与账本 v0.12.0 照常读取，无需先删字段。
- 影响面：`src/service/import-workbench.ts`（计划与命令行，新增 `filesUnchanged` 判断配置是否有变化）、新增 `src/service/import-modules.ts`（两个模块的读取与计划）、`src/service/import-channel.ts`（页面请求字段与用户名规则 `ASSET_OWNER`，服务进程只加载这个轻量文件）、`src/service/import-helper.ts`（导入顺序）、`src/asset/import.ts`（拆成读 / 校验 / 写三步，规则不变）、新增 `src/asset/import-writer.ts`（以数据目录属主身份运行的写账本子进程）、`deploy/install.sh`（`--monitor`、`--asset`、`--asset-owner`）、`web/src/ImportPanel.tsx` 与新增 `web/src/import-form.ts`、资产页空状态、文档。划转、ADL、原油、期权逻辑不变。

## 1 工作台里的位置（依据）

- 工作台每个内置模块的数据目录是 `<DATA_DIR>/modules/<模块>`（工作台 `server/modules/runtime.mjs` 第 131 行 `moduleData = path.join(dataDir, 'modules', id)`）。`DATA_DIR` 的取法与配对、原油、期权导入相同：`--workbench-data`，否则工作台环境文件 `/etc/project-aggregation.env` 的 `DATA_DIR`，否则 `/var/lib/project-aggregation`。
- 资产账本：`<DATA_DIR>/modules/asset/ledger.sqlite`（工作台 `server/recovery/data-catalog.mjs` 第 43 行；`server/modules/asset.mjs` 把 `ASSET_DATA_DIR` 设为模块数据目录，`modules/asset/lib/sqlite.ts` 第 98 行在其中打开 `ledger.sqlite`，WAL 模式）。
- 行情监控：模块数据在 `<DATA_DIR>/modules/monitor/`（`market.sqlite`、`perpetual/market.sqlite`，data-catalog.mjs 第 41–42 行）。Anthropic 股数设置只存在浏览器 localStorage 的 `workbench:anthropic-shares:v1`（工作台 `src/trading-preferences.ts` 第 8 行），由工作台主页面经桥接能力 `anthropic-shares` 交给 Monitor 页面，服务器上没有保存。所以导入时一律用默认股数（流通 12.7、完全稀释 16.7 十亿股），预览里写明；要改股数仍在 `config.json` 的 `monitor.anthropic.shares` 改（这是调参，不是启用）。

## 2 预览

页面「读取工作台」与命令行用同一套读取与计划（`previewImport` / `planImport`），在配对、原油执行账户、期权账户之外再列两项：

**行情监控**

- 本服务是否已启用（`config.json` 有没有 `monitor`）；已启用时显示现有股数，不改动。
- 工作台有没有 Monitor 模块（`<DATA_DIR>/modules/monitor` 是否存在），只作说明，不影响能否启用（公开行情不依赖工作台）。
- 股数：默认值，并说明工作台的股数设置只存在浏览器里、未带过来。
- 说明：不需要密钥；启用后服务器每 10 秒读报价、每 60 秒读 K 线，访问 Binance、Hyperliquid、Lighter RH 的公开行情接口。

**资产账本**

- 本服务是否已启用 `asset`；`asset.sqlite` 里已有导入时，上次导入的时刻、来源用户与条数（以服务账户只读打开 `asset.sqlite` 读 `import-info`；读不到时写原因）。
- 工作台 `ledger.sqlite` 的路径与状态，不能读取时逐项写原因：库不存在；不是普通文件（符号链接等）；归 root 而所在目录归别的账户；打不开或不是工作台资产库（缺表）；没有任何用户有账本（没有 `source-ledger` 设置）。
- 有账本的每个用户（`settings` 里有 `source-ledger` 的 owner，最多列 20 个）：资产条数、快照条数、最近的日快照日期，以及按 `importLedger` 的全部校验跑一遍后能否导入、不能时的原因（凭据字段、格式无效、缺起始快照等，原因只写字段名不带内容）；用户名不符合页面规则（见 §4）的标为不能从页面导入。
- 读取方式同 ASTER 库：root 在子进程里以 `ledger.sqlite` 属主的身份、空环境只读打开，正常加锁，只把行以 JSON 传回；校验在助手进程里做。SQLite 读取时可能新建的 `-wal`/`-shm` 归工作台账户。

## 3 导入

面板新增两个默认不勾选的选项「启用行情监控」「导入资产账本」（多个用户时在用户表里选一个，只有一个可导入的用户时自动选中）。只勾这两项、不选任何配对也可以。只重新导入资产账本时按钮显示「导入所选」，否则仍是「导入所选并重启服务」。

- **行情监控**：`config.json` 没有 `monitor` 时写入 `"monitor": { "anthropic": {} }`（默认股数）；已有时原样保留，不覆盖用户改过的股数，该项显示“已启用，保留现有设置”。
- **资产账本**：`config.json` 没有 `asset` 时写入 `"asset": {}`；已有时保留。账本按 `src/asset/import.ts` 的规则（只读打开来源库、写入前全部读出并校验、凭据表不读、设置白名单、钱包地址与密钥尾号去掉、一个事务整体替换）写入数据目录的 `asset.sqlite`。已启用 `asset` 时再勾选等于“重新导入最新账本”。
- `importLedger` 拆成三步，规则与报错不变：`readLedgerRows`（读来源库）、`prepareLedger`（校验与清洗，另对传回的行补做类型与设置白名单检查）、`writeLedger`（整体替换）；`importLedger` 仍是三步连用，命令行 `src/asset/import.ts` 不变。
- **身份与属主**：导入助手以 root 运行（`trading-platform-import.service`，`UMask=0077`）。数据目录 `/var/lib/trading-platform` 归服务账户、700，root 不在服务账户可写的目录里直接写文件（服务账户可以事先放符号链接），所以 `asset.sqlite` 由助手起的子进程（`src/asset/import-writer.ts write`，账本行经标准输入以 JSON 传入，`umask 077`）以数据目录属主（服务账户）的身份、空环境写入，与 `checkAsService` 以服务账户跑配置检查相同；新建的 `asset.sqlite` 及 `-wal`/`-shm` 归服务账户、600，服务照常只读打开。已有的 `asset.sqlite`（及 `-wal`/`-shm`/`-journal`）若归别的账户（例如曾以 root 手工导入）或不是普通文件，写入失败、不改动，提示改回属主后重试。命令行 `install.sh --import-workbench --asset` 同样以服务账户写入。上次导入信息也以服务账户读取，root 不打开数据目录里的库。

**顺序与失败行为**

1. 读工作台、读本服务配置、计划（纯计算）。任何一步失败：什么都不写。
2. 选了资产账本且计划可导入：先写 `asset.sqlite`。失败（校验不过、库被占用、属主不对、子进程超时 60 秒）：配置与已有 `asset.sqlite` 都不变，整次请求失败（同时选的配对、原油、期权、行情监控也不导入），提示原因，可重试。
3. 配置没有变化（`filesUnchanged`：只是重新导入账本，`asset` 已启用、其余都没选或已存在）：不写配置、不重启服务，结果为完成；页面下次读取就是新账本（服务读 `asset.sqlite` 不需要重启）。
4. 配置有变化：沿用现有流程——撤销记录 → 写配置与密钥 → 以服务账户 `--check-config` → 重启 → 健康检查；检查或启动失败时逐字节恢复导入前的配置并再次重启。此时第 2 步已写入的账本保留：若导入前没有启用 `asset`，服务不读它，等于没导入；若已启用，服务读到的是最新账本，与单独运行 `src/asset/import.ts` 的效果相同。结果消息写明“资产账本已写入、配置已恢复”，重新勾选导入即可（账本整体替换，重复执行结果相同）。
5. 助手中途被终止：配置按撤销记录处理（与现在相同）；账本要么整体写入、要么未写入（单个事务）。

选这个顺序的原因：账本的失败情形最多（校验、属主、锁），放在最前面失败时什么都没改；账本写入后无论配置成败都是一致、可用、可重试的状态。反过来先改配置再写账本，账本失败时要么回退一次已重启生效的配置（再重启一次），要么留下“已启用但未导入”的资产页。

**输出**：结果与日志只有用户名、条数、日期、文件路径与原因；不含凭据、钱包地址、账本内容。

## 4 页面请求

`POST /api/import` 的导入请求新增三个字段，逐项严格校验（与 `oil`、`options` 同一写法，`exactKeys` 拒绝未知字段）：

- `monitor`：只能是 `true`。
- `asset`：只能是 `true`；须同时带 `assetOwner`。
- `assetOwner`：只在 `asset` 为 `true` 时允许；字符串，1–64 个字符，只允许字母、数字和 `.`、`_`、`@`、`-`，首字符须是字母或数字。助手另外核对它在工作台账本的用户列表里。
- 预览请求不能带这三个字段。请求文件仍限 4 KiB。页面不能指定任何文件路径：来源库路径由助手按工作台数据目录推出，目标是服务的数据目录。

## 5 命令行

```
sudo bash install.sh --import-workbench --monitor --asset [--asset-owner <用户>]
```

- 可与 `--pairs`、`--oil`、`--options` 同用；只带 `--monitor` / `--asset` 时不导入配对。
- `--asset` 不带 `--asset-owner` 时，工作台账本只有一个用户就用它，多个用户时报错并列出用户名；`--asset-owner` 须和 `--asset` 一起用，用户名规则同页面。
- 导入器新增 `--monitor`、`--asset`、`--asset-owner`、`--data-dir`（安装脚本传入本服务数据目录）。账本先写、再写配置；之后安装脚本照旧检查配置、重启，失败时恢复导入前的配置（账本保留，同 §3 第 4 步）。
- 旧版本包不支持时安装脚本报“版本 … 不支持 --monitor / --asset”。

## 6 备选方式（保留）

- 手写 `config.json` 的 `monitor` / `asset` 段后执行 `sudo bash install.sh`。
- 单独运行 `sudo -u trading-platform node /opt/trading-platform/current/src/asset/import.ts --from <工作台数据目录>/modules/asset/ledger.sqlite --owner <用户> --data-dir /var/lib/trading-platform`。

## 7 测试

实际用例：`test/import-modules.test.ts`（8 项）、`test/import-form.test.ts`（3 项）、`deploy/test-install.sh` 新增 7 项检查。

- 单元：预览各状态（未启用 / 已启用、工作台有无 Monitor、账本不存在 / 不是普通文件 / 打不开 / 没有用户 / 多用户 / 某用户校验不过 / 用户名不合规、上次导入信息）；请求校验（布尔、用户名长度与字符集、缺 `assetOwner`、预览带新字段）；只勾这两项；已有 `monitor` / `asset` 不被覆盖；重新导入不重启；账本写入失败时配置与 `asset.sqlite` 都不变；配置检查失败时配置恢复、账本保留并在消息中说明；多用户选择；导入器命令行参数；页面表单转换（`web/src/import-form.ts`）。
- 安装测试（`deploy/test-install.sh`，Linux CI）：`--import-workbench --monitor --asset` 导入并通过配置检查、重复执行保留设置并重新导入账本、`--asset-owner` / `--monitor` / `--asset` 须和 `--import-workbench` 一起用。
- 只能在 Linux 服务器上验证：root 以 `ledger.sqlite` 属主身份读库、以服务账户身份写 `asset.sqlite`（属主与权限）、systemd 下的重启与恢复。

## 8 回滚

`sudo bash install.sh --version v0.12.0`。配置格式与库结构都没变，`monitor`、`asset` 两段与 `asset.sqlite` 回退后照常使用；v0.12.0 的面板没有这两项，回退后改用 §6 的备选方式。
