# 2026-11-26 DEX 价差：行情流配对的模拟盘按推送判断（v0.94.0）

- 范围：ddcc0e6 之后的一个提交。文件：`src/varlighter/feeds.ts`（两个行情流的 `onTop` 回调）、`engine.ts`（`onTop`、`pushPairs`、`sources.push`）、`views.ts`（`PushStats`）、`web/src/varlighter/VarLighterReady.tsx`、`VarLighterPage.tsx`（文案）、`test/varlighter.test.ts`、`docs/varlighter.md`、`docs/dexspread.md`、`docs/frontend.md`。
- 定级：R2。只动模拟盘的判断时机，不下单、不改库表与参数、不动鉴权与部署。
- 回滚版本：v0.93.0。不改数据，回退后开平仓回到按 5 秒样本判断。

## 审查结论

独立只读审查（子代理，R2 档）：无 P0、P1。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2 | 每次推送都重算 Lighter 盘口快照（整本盘口排序） | 已修：按推送判断时沿用 1 秒以内算过的快照（`PUSH_DEPTH_REUSE_MS`） |
| P2 | 文档的负载表述与代码不符（被挡信号每次读当日盈亏、自动配置重算与基线预热可能落在回调里） | 已改 `dexspread.md` 10.12 节 |
| P3 | 文档写最长持有只在样本上判断，实际推送时也判断 | 已改 |
| P3 | 判断出错时不重建基线跟踪器、日志可能刷屏 | 已修：出错时丢弃跟踪器，同一配对每分钟最多一条日志 |
| P3 | 推送与定时样本同一毫秒时这次不成交；成交样本可能计入基线 | 属实，已写进文档 |
| P3 | 换参数回测拿不到推送时刻的价，模拟盘成绩可能好于回测 | 已写进文档 |
| P3 | `lastBlocked` 只留最近一条，热门配对会盖掉别的 | 未改，登记 |
| P3 | 测试缺口：Entropy 腿的推送、按推送止损或超时、判断出错、成交后的采样间隔 | 补了「只有标记价变不判断」；其余登记 |
| P3 | 文档少一个空行；总览文案漏了「有持仓」 | 已改 |

审查者核实无问题的：推送回调与定时采样、Var 轮询、参数保存、手动平仓、重置之间没有重入；一条消息含多个市场不会在半更新状态上判断；成交回调里订阅、退订盘口安全；关闭后不再收到推送；推送路径与定时路径的检查项一致（共用 `tradeDecision`）；被挡住的信号没有写库、事件等副作用；旧服务端没有 `sources.push` 时页面不显示。

## 已运行

- 修复审查意见后：`pnpm check`、`pnpm build:web`、`git diff --check`、`node --test test/varlighter.test.ts test/varlighter-paper-commit.test.ts test/varlighter-local.test.ts`（67 通过，含新增的推送判断测试）。
- 修复前：`node --test web/test/varlighter-form.test.mjs`（9 通过）；`scripts/dev-varlighter.ts` 替身后端，无头浏览器 1280 宽度打开实盘准备页，「行情流配对」一行显示「按推送判断（启动以来）：266 次，成交 0 次」，无页面报错；390 宽度页面无横向溢出。修复只动后端与一句文案，浏览器没有重走。
- 分支 CI：提交 `fc39755` 的 https://github.com/hxx344/trading-platform/actions/runs/45796040297 全部通过。

## 未运行

- `pnpm test` 全量（本机是 Windows，以 CI 为准）。
- 线上真实行情下按推送判断的 CPU 占用未测。
