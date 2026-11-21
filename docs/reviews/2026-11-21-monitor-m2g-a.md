# 2026-11-21 金油比随原油监控启用（M-2g G-a，v0.78.0）

- 范围：本批一个功能提交。文件：`src/service/monitor-config.ts`、`src/service/import-modules.ts`；测试 `test/monitor-goldoil.test.ts`、`test/monitor-oil.test.ts`、`test/monitor-control.test.ts`、`test/import-modules.test.ts`；文档 `docs/monitor.md`「M-2g」。
- 等级：R2（只读行情监控的配置解析与导入计划，不涉及资金、凭据与库结构）。审查方式：作者自审 + 独立只读审查子代理一轮，修复后作者复核增量。
- 回滚版本：v0.77.0，不用改配置（本批不把 `goldoil` 写进 `config.json`）。

## 结论

修复后 P0、P1 为 0。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1 | `test/monitor-oil.test.ts` 的配置、摘要与 `/api/monitor/state` 断言仍按只配原油写，全量测试必失败 | 已修：期望值加上隐含的金油比与其开关；单独重跑通过 |
| P3 | 导入时只配了原油，说明文字没提金油比已随原油运行 | 已修：「已有的原油价差、金油比保留现有设置」；补断言 |
| P3 | 本次导入新加 `oil` 时仍会写出 `goldoil: {}`，这类配置回到 v0.73.0 前要手动删 | 登记；与 M-2f 行为一致，文档已写明 |
| P3 | Binance `XAUUSDT` 未在真实接口核对，升级后所有配了原油监控的服务都会去采 | 登记；本机访问 Binance 返回 451。最坏情况是金油比标签报错，告警默认关闭、无档位，冷却只由 418/429 触发；待实测项已在 live-results.md「行情监控金油比」 |

已核实：采集器、告警、开关、状态接口与页面标签都取解析后的配置，金油比随原油出现且开关独立；没有把解析结果写回 `config.json` 的路径；其他导入流程（告警、模拟盘、Var token）按原始 JSON 判断，与隐含规则不矛盾；用到解析后 `{ oil }` 且跑循环的测试已关掉金油比并在收尾停掉全部采集器。

## 已运行

- `pnpm check`、`pnpm build:web`。
- 全量 `node scripts/test.ts --test-timeout=120000`（修复前）：`monitor-oil`（P1）、`import-workbench`（工作树未构建页面）、`transfer`（本机高负载）失败；修复与构建后单独重跑 `test/monitor-oil`、`test/import-modules`、`test/monitor-control`、`test/monitor-goldoil`、`test/import-workbench`、`test/transfer` 通过。

## 未运行

- 浏览器验证（页面代码未改，标签取自服务端 `state.markets`）。
- 真实 Binance 接口（本机地区限制）、`deploy/test-install.sh`（未改安装脚本）。
