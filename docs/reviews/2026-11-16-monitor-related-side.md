# 行情监控关联交易移到右侧栏（R2）审查记录

- 日期：2026-11-16
- 范围：`ae61caf`（变基前为 `2e68221`）与本记录所在的修复提交。文件：`web/src/{MonitorPage,MonitorOil,MonitorHynix,MonitorRelated}.tsx`、`web/src/monitor-related.ts`、`web/src/monitor.css`、`test/monitor-related.test.ts`、`docs/{monitor,asset,frontend}.md`、`README.md`（回退表）。
- 起因：用户要求行情监控三个标的（Anthropic、原油、海力士）的关联交易照旧工作台的布局显示在右边。
- 等级：R2（页面重排，三个详情页的版式与断点变化；只读展示，不读写数据）。一路独立只读审查，审查者与作者上下文隔离。
- 回滚：`sudo bash install.sh --version v0.56.0`，不用改配置，不动数据（README 回退表 v0.57.0 行）。

## 审查结论

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 1 | P2 | Anthropic 不做 ANT 组合合计的理由写成“资产账本只读 Binance、Bybit、OKX，读不到 Lighter RH”。实际上资产账本读 `rh-lighter`，Lighter RH 的 `ANTHROPIC` 持仓会被列出，与同一面板的提示矛盾 | 页面提示、`monitor-related.ts` 注释、monitor.md、asset.md 改为：Hyperliquid 持仓读不到；Binance ↔ Lighter RH 两腿都读得到，组合合计（工作台 `relatedAnthropicPair`）本次不做，登记在 asset.md |
| 1 | P2 | `2e68221` 把版本写成 v0.55.0，而 v0.55.0、v0.56.0 已由别的批次发布 | 变基后的 `ae61caf` 已改为 v0.57.0，代码相同；不另改 |
| 1 | P3 | Anthropic 用例名说覆盖 Hyperliquid 腿，但缺 `ANTUSDT`、`ANTHUSDT`、`ANT-USDT-SWAP` 等反例和 Lighter RH、OKX 的实际写法 | 已补反例与 `rh-lighter` 的 `ANTHROPIC` 持仓，用例名改为实际覆盖内容 |
| 1 | P3 | 单栏视口 701–1070px 时 Anthropic 工具栏仍不换行（待核实） | 替身后端 1000px 宽截图：工具栏可读、无溢出，与改版前相同，不改 |

审查者已核实：三个详情页都把关联交易放进右栏，合约价差页、市场关闭、未配股数、单市场时不受影响，与工作台 `monitor-hub.tsx` 一致；`pairedMarket` 类型收窄正确，“持仓列表不完整，暂不确认配对”只在可配对市场显示；`matchBase` 对 `1000ANTHROPICUSDT`、`ANTHROPIC2USDT` 等不误配；新增 CSS 选择器的优先级确实压过前面的同名规则，海力士表的最小宽度只在 781px 以上生效；sticky 侧栏在本服务外壳里有效；注释里的工作台行号（`7745181`、`c84ba27` 的 globals.css）都对；没有调试残留与夹带。未发现 P0、P1。

修复只涉及提示文案、注释、文档与测试，未再开第 2 轮审查。

## 已运行

- `pnpm check` 通过（修复后）。
- `node --test test/monitor-related.test.ts` 6 项通过（修复后）。
- `pnpm build:web` 通过（修复后）。
- 替身后端（`scripts/dev-monitor.ts`，持仓接口在浏览器里换成假数据）无头浏览器：修复前 800、1239、1240、1280、1400、1600、1920、390 宽度看了三个详情页，两栏与单栏切换正确，无横向溢出、无页面错误，主栏内无被裁内容；修复后 1000、1280 宽度复看 Anthropic。

## 未运行

- `pnpm test` 全量：只改页面与页面纯函数，相关测试已跑；交 CI。
- 与运行中的工作台并排截图：本机没有运行中的工作台，按工作台源码与 CSS 行号对照。
- 真实资产账本数据：替身后端没有持仓，用假数据看版式。
