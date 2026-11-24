# 2026-11-25 MCP 快照工具 snapshot（v0.87.0）

- 范围：`tools/mcp/{snapshot,readonly}.ts`、`test/mcp-readonly.test.ts`、`docs/mcp.md`（第 4 节、8.5、8.6）。
- 等级：R2。只改运行在客户端机器上的只读 MCP 服务端，平台、令牌白名单与范围都不变；所读的 6 个接口都已在 `system` 或 `public` 范围里。
- 影响面：MCP 新增 `snapshot` 工具（`system` 或 `public` 范围的令牌列出），把 `/api/host`、`/api/status` 与四个行情报价整理成 `entity`/`metric`/`label`/`value`/`unit`/`asOf`/`stale`/`status` 行。
- 审查方式：作者自审，加两轮独立只读审查子代理，每轮新开，不给作者结论。
- 回滚版本：v0.86.0。MCP 服务端随仓库检出运行、不在发布包里，回退只少这个工具。

## 第一轮（6287da5）

没有 P0、P1。P2 3 条、P3 5 条，已修（48e5dcd）。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2 | 控制面进程的重启次数平台不统计（恒为 0），却作为 0 次输出 | 已修：只给行情服务出 `restarts` 行 |
| P2 | 一次冷调用 6 个请求，令牌每分钟 30 次；被 429 拒绝时看起来像模块不可用 | 已修：工具描述写明请求量、不要频繁轮询；结果顶层 `rateLimited` |
| P2 | 运行状态行只用手写夹具测试，循环名与真实的不同，没有经过 `readTokenSystemStatus` 投影 | 已修：夹具按 `src/runtime.ts` 的实际结构构造并经投影；真实服务用例断言投影后的行 |
| P3 | 真实循环名本身以“循环”结尾，标签变成“循环循环” | 已修：`<名称>：连续失败次数` |
| P3 | Anthropic 的 Binance 价格应为 USDT；各场所资金费率期长不同 | 已修：Binance 为 USDT，Hyperliquid 标“每小时”，原油另给 `funding_interval` |
| P3 | 缓存时间从发出请求时算，慢的读取不再共用 | 已修：读取完成时才开始计时，进行中的读取一律共用 |
| P3 | `/api/host` 读不到时，已读到的 `/api/status` 行也丢掉 | 已修：`system.runtime` 缺一个来源时为 `partial` |
| P3 | 文档把测试写得比实际宽；第 4 节的错误规则没写 `snapshot` 的例外 | 已修 |

## 第二轮（48e5dcd，并复核整体）

没有 P0、P1。P2 2 条、P3 2 条，已修（3beb402）。第一轮八项逐项核实已修好。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2 | 文档与注释说采集器未就绪时平台回 JSON `null`，实际是 503 `not_ready`；为此加的分支与测试走不到 | 已修：撤回 `platformGet` 的改动与该分支，测试改用 503 `not_ready` |
| P2 | Anthropic 各腿报价口径不同（io:ANTH、Lighter RH 每单位 17.68 股），标签只写“标记价”，容易被当成价差 | 已修：标签写明每单位股数，另给 `per_share` 行；替身改用真实量级 |
| P3 | 8.6 的第三批验证项仍写“单个来源 503 时该组 unavailable” | 已修 |
| P3 | `rateLimited` 说明写“等一分钟”，429 也可能来自同时请求数限制 | 已修：改为稍后再调用，每分钟次数用完时等到下一分钟 |

已核实（两轮合计）：
- 行只取名单里的有限数值，标签是固定文字。主机名、路径、磁盘 `label`、连线 `detail`、循环与依赖的错误原文、告警正文、飞书都不出行；来源新增的字段不出现。
- 不读 `portfolio` 范围。带 `portfolio` 的令牌读到完整的 `/api/status`，也只按名单取字段。
- 范围筛选与 `groups` 校验先于任何读取；范围未知时给全部分组，由平台的 403 兜底。
- 缓存按 `get` 共用（`serve()` 里是同一个函数）；401 不缓存并整次报错。

未能核实：
- 真实平台与真实 MCP 客户端上的端到端调用，与第一批、第二批一起实测，记进 [live-results.md](../live-results.md)。
- 最坏情况下 6 个请求各 20 秒超时的总耗时。
- 客户端与服务器的时钟偏差对 `stale` 的影响。

## 已运行

- `pnpm check`：通过。
- 分支 ci：
  - 6287da5 工具列表断言没有加 `snapshot`：https://github.com/hxx344/trading-platform/actions/runs/45475927193
  - 48e5dcd 全部通过：https://github.com/hxx344/trading-platform/actions/runs/45478045161
  - 3beb402：https://github.com/hxx344/trading-platform/actions/runs/45479067472
