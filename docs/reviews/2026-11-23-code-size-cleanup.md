# 2026-11-23 代码量清理：删重复副本与无引用代码

- 范围：基于 `66ecd3a`（v0.80.1）的一次提交，54 个文件（含本记录），代码净减约 790 行，不改变行为。
  - 重复副本：删除 `web/src/perpetual-{spreads,types,fees,fx}.ts`，页面（19 个文件）与页面测试（3 个文件）改从 `src/vendor/` 同名文件导入；删除 `probes/lib/decimal.ts`，`probes/aster-transfer.ts` 直接导入 `src/decimal.ts`。
  - 无引用代码：删除 `web/src/crossex/PnlBreakdown.tsx`；删除 12 个无引用导出（`src/adl-contracts.ts` 的 `ADL_ORDER_ID`、`src/sim-aster-trading.ts` 的 `newAdlClientOrderId`、`src/asset/sync.ts` 的 `isConflict`、`src/varlighter/feeds.ts` 的 `RH_REST` 与 `RH_STREAM`、`src/varlighter/strategy.ts` 的 `OpenLeg`、`web/src/crossex/` 的 `CROSSEX_READ_TIMEOUT_MS`、`stateLabel`、`scenarioNames`、`opportunityStaleReason`、`valuationStaleReason`、`web/src/oil-form.ts` 的 `SYMBOL_LABEL`）。
  - 样式：9 个样式文件里删除 26 个未使用类名对应的规则。
  - 测试：删除两条只守护已删副本的逐字节比对用例（`test/contract.test.ts`、`test/monitor-perpetual-depth.test.ts`）。
  - 文档：`docs/monitor.md`、`docs/frontend.md`、`docs/executor.md` 与 6 个文件头同步。
- 等级：R2（页面导入路径与构建产物变化；不改资金、凭据、数据库结构和唯一写者边界，`src/` 里只删无引用的导出）。审查方式：作者自审，加一轮独立只读审查子代理。
- 回滚版本：v0.80.1（回滚不需要改配置或数据）。

## 结论

P0、P1 为 0。P2 一条、P3 三条已修复，另一条 P3（缺审查记录）由本文件补上。

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 自测 | — | `test/monitor-perpetual-depth.test.ts` 的「副本一致」用例读已删除的页面副本而失败 | 用例与只为它服务的辅助函数一并删除 |
| 自测 | — | 首轮未使用类名扫描只看 `web/`，把 `performance-positive / negative / neutral`（由 `src/asset/performance-metrics.ts` 返回）与 `weak`（质量等级取值）误判为未使用 | 改为全仓库核对，这 4 个类保留 |
| 1 | P2 | `docs/monitor.md` M-5a 实施记录、`docs/frontend.md` 仍把已删除的页面副本和比对测试写成现状 | 已修：两处改为指向「单份来源」 |
| 1 | P3 | 5 个页面文件头仍写「未改动」，`src/vendor/perpetual-scanner-data.ts` 的注释仍说 `PerpetualSpread` 在 `web/src` | 已修 |
| 1 | P3 | `docs/executor.md` 写探针共用代码在 `probes/lib/`，未提直接导入 `src/decimal.ts` | 已修 |
| 1 | P3 | `src/asset/sync.ts` 末尾多一个空行 | 已修 |
| 1 | P3 | 缺审查记录 | 本文件 |

已核实（独立审查）：
- HEAD 上四对页面副本与 `src/vendor/` 同名文件只有首行注释不同；这四个文件没有可变的模块级状态，页面从打包两份变为一份不改变行为。
- 改写后的导入全部指向存在的文件，全仓库没有对已删路径的残留引用；`web/tsconfig.json` 与 vite 在 HEAD 上已覆盖 `src/vendor` 的跨目录导入。
- 发布包（`deploy/package.sh`）不含 `web/src` 与 `probes/`，`deploy/component-digests.mjs` 不引用被删文件。
- 被删导出全仓库整词搜索为 0。真实 ADL 批次号由 `src/adl.ts` 自己生成；`AssetConflict` 的判断在 `src/http.ts` 直接用 `instanceof`；varlighter 实际用 `LIGHTER_ENDPOINTS[venue]`。
- 26 个被删类名在全仓库非样式文件里字面搜索为 0，模板拼接点（`update-tag ${…}`、`perp-quality-grade ${…}`、`spread-up`）都不产生被删类名；选择器列表里只删一项的，保留项的声明未变。
- `src/decimal.ts` 没有任何导入，探针改用它不会加载执行器；除被删断言外没有别处依赖 `probes/lib/decimal.ts`。

没有合并的重复：`src/vendor/asset-identity.mjs` 与 `src/vendor/crossex/asset-identity.mjs` 分别对应工作台的两个提交，合并要改 6 个 CrossEx 文件的导入与来源说明，只省 14 行，保留。

## 已运行

- `pnpm check`、`pnpm build:web`：通过。
- 本机（Windows）逐文件运行全部 214 个测试文件：186 个通过，27 个失败，1 个超时（`test/asset-source-import.test.ts`）。失败原因是本机限制：符号链接与 `fsync` 被拒绝、600 权限断言、实盘代码只支持 Linux、路径分隔符。在未改动的 `66ecd3a` 上运行同一批失败文件，失败用例清单相同（本次改动只多出上表「副本一致」一条，已处理）。
- 与改动直接相关的测试（`test/contract.test.ts`、`test/perpetual/`、`web/test/perpetual/`、`web/test/crossex/`、`test/varlighter*.test.ts`、`test/adl*.test.ts`）587 条通过。
- 浏览器：`scripts/dev-monitor.ts` 替身行情下，行情监控「合约价差」页在 1280 与 390 宽度渲染正常（30 行组合）、无横向溢出；控制台只有替身不提供的接口的 404（`/api/update`、`/api/host`、`/api/read-token`、`/api/asset/positions`）。

## 未运行

- Linux 上的全量 `pnpm test`：由主线 CI 把关。本机超时的 `test/asset-source-import.test.ts` 没有在基线上对比。
- CrossEx、原油、资产、Ondo、ASTER、系统更新各页的浏览器走查：这些页面只删了没有元素匹配的样式规则与无引用的导出，只做了静态核实。
- `deploy/test-install.sh`、真实 systemd 验收：未改安装脚本与单元。
