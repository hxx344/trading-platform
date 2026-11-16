# 取消服务的名义金额上限（R3）审查记录

- 日期：2026-11-16
- 范围：`src/contracts.ts`、`src/executor.ts`（上限改为可选、删除 24 小时窗口）、`src/service/{main,oil,oil-config,import-workbench}.ts`、页面 `web/src/{App,OilPage,HynixPage,OilRules}.tsx`、`web/src/{oil-rules-form,import-form,oil-types,types}.ts`、`web/src/styles.css`、`deploy/config.example.json`、`deploy/test-install.sh`、对应测试与文档、`package.json`（版本号）。
- 起因：用户要求取消全局的开单金额限制，单笔和 24 小时都取消。
- 等级：R3（影响资金的配置字段与下单约束）。一路独立只读审查（高风险档，含鉴权、凭据与交易执行边界），审查者与作者上下文隔离。
- 回滚：`sudo bash install.sh --version v0.49.2`。`config.json` 的 `oil` 里没有 `notionalLimits` 的（v0.50.0 之后才首次导入原油账户）先补上 `"notionalLimits": { "perJob": "200", "openPer24h": "1000" }`；原来就有的不用改。不改数据库（README 回退表、[docs/oil.md](../oil.md) 第 2 节）。

## 变更前对齐

- 用户可见行为：原油与海力士任务（手动与自动规则）不再受单笔 `perJob` 与 24 小时开仓 `openPer24h` 约束；页头、原油页、海力士页不再显示额度。
- 影响面：服务创建执行器时不再传上限，执行器不再要求实盘环境必须配上限；`oil.notionalLimits` 改为可选且不生效，导入不再写它；`/api/oil/state`、`/api/hynix/state` 不再带 `notionalLimits`。价格保护、交易所最小名义金额与数量上限、账户与持仓核对、外部挂单拒绝、合约锁、自动规则每日开仓次数不变。
- 失败与回滚：新版本读旧配置不出错（旧字段被接受后丢弃）；回滚见上。回到 v0.49.2 后它的 24 小时窗口会把 v0.50.0 期间确认的开仓也算进去，回退后最多 24 小时内新开仓可能被拒（安全方向）。
- 本次不做：金丝雀的 `perJob` / `totalOpen` 与 200 / 500 USDT 硬顶、CrossEx 的 `crossex.limits`、ADL 单批名义上限、划转单次上限都不动。Bybit 原生追价卖出不放开（见下）。

## 审查结论

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 1 | P2 | 原生追价卖出的拒绝条件依赖“配了上限”，去掉上限后这条从未在真实账户上走过的路径在服务里第一次可用；用户没有要求放开它 | 拒绝条件改为“配了上限或实盘环境”，服务照旧拒绝（`notional_chase_sell`），模拟环境不变；`test/live-wiring.test.ts` 补实盘无上限时的拒绝用例 |
| 1 | P2 | README 回退表没有 v0.50.0 一行，首次导入后回退会被 v0.49.2 的配置检查拒绝而用户不知道要补字段 | 回退表加一行 |
| 1 | P2 | `docs/oil.md` 链接的本记录尚不存在 | 即本文件 |
| 1 | P3 | 服务进程测试没有断言 `/api/state` 的 `notionalLimits` 为 `null` | 已补 |
| 1 | P3 | `docs/oil.md` 残留措辞（状态标题版本、范围表的“额度”、回滚后 24 小时窗口的说明） | 已改 |

审查者已核实：服务路径上不再有名义金额上限；已删除的符号与字段在 `src`、`web`、`deploy` 里没有残留引用；金丝雀仍要求并执行 `perJob` / `totalOpen`，`openNotionalUsed` 改写后与原累计形式等价（`jobs.created_at` 非空，原条件恒真）；`canary.ts` 里的 `ex.notionalLimits()!` 只在金丝雀里用；旧配置升级、全新导入、已有配置保留三种情况正确；`deploy/test-install.sh` 的 grep 与 `--check-config` 实际输出一致；没有被放宽的断言。未发现 P0、P1。

第 1 轮的 P2 修复只涉及一处条件、一个用例与文档，未再开第 2 轮审查；修复后重跑了下面列出的检查。

## 已运行

- `pnpm check` 通过（修复后重跑）。
- `pnpm build:web` 通过（修复前；修复未动页面）。
- `pnpm test` 全套（Windows，修复前）：失败 70 项，与同机 `origin/main`（`5474f53`）基线的失败项逐条相同，都是目录 fsync、符号链接、文件权限 0600 与“只在 Linux 上运行”的平台限制，其中包括本次改到的 `test/oil.test.ts` 服务进程用例与 `test/import-oil.test.ts` 命令行用例。
- 修复后重跑受影响的测试文件（`test/oil.test.ts`、`notional`、`import-oil`、`live-wiring`、`oil-rules-live`、`oil-chase`、`import-form`、`live-canary`、`hynix`、`oil-rules`、`http`、`executor`）：除上述平台限制的用例外通过。

## 未运行

- Linux 全量测试与 `deploy/test-install.sh`：本机是 Windows，按约定不用 WSL；交 CI，结果见发布提交。
- 浏览器 1280 / 390 对比：替身后端没有配置原油执行账户，原油页与海力士页不显示，页头的额度文字在替身上本来就不出现；本次只删除显示块，不改版式。
- 真实账户：没有在真实 Binance / Bybit 账户上下过超过旧上限的单。
