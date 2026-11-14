# 来源与许可（CrossEx 模块）

本目录（`src/vendor/crossex/`）与页面 `web/src/crossex/`、测试 `test/crossex/`、`web/test/crossex/` 复制自 project-aggregation 工作台的 `modules/crossex`（提交 `7745181`；该模块来源 `hxx344/gate-crossex-arbitrage@804d284`，另合入 `640df2f`）。

工作台 CrossEx 模块参考并改编了 [your-quantguy/gate-crossex](https://github.com/your-quantguy/gate-crossex)（参考版本 `423356d89e5c8f41d9d9033f4db1f40299774ec0`）。原项目及其贡献者保留原有版权；原项目与工作台 CrossEx 模块均采用 **AGPL-3.0-only**，上述复制部分依照相同许可发布，完整条款见同目录 [LICENSE](LICENSE)。本仓库公开，部署修改版本时应提供该运行版本对应的完整源代码。

直接相关的上游文件包括：

- `apps/backend/src/crossex-client.ts`：账户、订单、费用、杠杆、风险档位及账户流水的字段契约。
- `apps/backend/src/market-hub.ts`：公开 WebSocket ticker、trade 与 funding_rate 订阅格式。
- `packages/public-data/src/index.ts`：八个交易所的真实历史 K 线端点与原生合约映射。
- 前端交易终端、持仓表、组合页、平仓对话框及双腿交易页面。

`src/vendor/decimal.mjs` 是 decimal.js 10.6.0（MIT，许可见文件头）。本仓库各复制文件的改动写在各自文件第一行。
