# 2026-11-25 只读令牌开放 Var/Lighter 数据，本机回测与 MCP 工具（v0.83.0）

- 范围：`src/read-token.ts`（白名单、`readTokenNewsView`）、`src/http.ts`（`/api/varlighter/samples`、快讯路由）、`src/varlighter/{engine,store,model,views}.ts`、`src/service/varlighter.ts`、`tools/mcp/readonly.ts`、`tools/varlighter/{pull,backtest}.ts`（新）、`test/{varlighter,varlighter-local,read-token,mcp-readonly,news-feed,monitor-goldoil}.test.ts`、`docs/{mcp,varlighter,observability}.md`。
- 等级：R3。改了只读令牌的白名单（凭据与鉴权）。本机工具与样本导出本身是 R2：只读本地库、只在客户端机器上运行、不进发布包。
- 影响面：令牌新增可读 Var/Lighter 的 `state`、`symbol`、`paper`、`readiness`、`samples`，`/api/host`，四个监控的 `quote`，`/api/news` 与 `/api/news/moves`，全部是 GET。Var/Lighter 的 POST（回测、参数、平仓、清空）、K 线、永续行情、资产账本、凭据与会话不放行。快讯的 `url` 对令牌改名 `link`，页面不变。
- 审查方式：作者自审，加独立只读审查子代理。第一轮审提交 a931883 相对 1b77f5c；修复后的增量 0aac7b0（改写提交信息后为 d8f60e0）由新开的审查者复核，并复核整体白名单。
- 回滚版本：v0.82.2。白名单随代码回到原样；`samples` 接口与本机工具没有写服务器上的任何数据；`read-token.json` 格式没变。

## 改动

1. `GET /api/varlighter/samples`：按报价时刻升序分页返回原始样本（列名加数组行，每页至多 1000 条），走 `(symbol, t)` 主键。
2. 白名单加上述 GET 接口；`readTokenNewsView` 把令牌读到的快讯链接改名 `link`。
3. `tools/varlighter/pull.ts`：用只读令牌把样本增量拉到本机 `.jsonl`，并保存参数与类别；`tools/varlighter/backtest.ts`：用仓库当前的 `runBacktest` 重放本机样本，支持 `grid` 扫参数。
4. MCP 新工具：`varlighter`、`varlighter_backtest`（先核对、再拉取、再在子进程里回测）、`host_status`、`market_quotes`、`news`。

## 第一轮结论

P1 1 条、P2 4 条、P3 4 条，全部已修或写进文档。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1 | 同一配对并发拉取（MCP 并行调用，或命令行与 MCP 同时）会按同一个 `after` 追加同一页，本机样本重复，回测重放同一分钟两次 | 已修：锁文件互斥，只写时刻大于本机最后一条的行；回测载入时跳过不递增的行并在 `skipped` 里计数；有并发用例 |
| P2 | 快讯的 `url` 是打码的标识字段，令牌读快讯时每条链接都被换成别名，并挤掉别名表里的账户别名 | 已修：令牌应答改名 `link`；有用例断言别名表仍为空 |
| P2 | 拉取被中断时留下半行，下次续拉时 `JSON.parse` 失败 | 已修：`lastSampleAt` 截掉没写完的最后一行；损坏的行给出明确提示；有用例 |
| P2 | 本机最后一条已超出服务器保留期时，中间缺的样本不报告 | 已修：拉取结果的 `gap`；回测输出 `gaps`、`gapCount`；有用例 |
| P2 | 本机回测把全部样本交给 `runBacktest`，服务器只给 `from` 之前一个基线窗口，`liveFrom` 等依赖样本范围的结果可能不同 | 已修：本机按同样的窗口取样本；用例改为与窗口切片比较 |
| P3 | 读 `/api/news/moves` 算“有人在看”，会延长异动行情轮询 | 写进 `docs/mcp.md` 8.3 |
| P3 | MCP 父进程用缓存的旧模块校验请求，AI 改了策略参数规则后要重启 MCP 才认 | 已修：`--check` 在子进程里核对，不合法不拉取 |
| P3 | 子进程超时时先报 stderr，看不出是超时 | 已修：先判 `killed` |
| P3 | `/api/host` 的 `connections[].detail` 可能带连线错误原文 | 写进 `docs/mcp.md` 8.3（经平台打码） |

## 第二轮复核

范围：提交 0aac7b0 相对 a931883，新开审查者；同时复核 1b77f5c..0aac7b0 的白名单。结论：没有 P0、P1。P2 2 条、P3 3 条，全部已修（提交 bce417d，改写提交信息后为 6dbf97c，代码相同）。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2 | 锁不记持有者、持有期间不刷新：一次拉取超过 5 分钟（429 连续等待）会被另一进程接管，先退出的一方再删掉对方的锁；两个等待者同时接管陈旧锁也会互删 | 已修：锁里写持有者标记，每页与 429 等待时刷新，只由持有者删除；接管先改名再核对内容，不是自己读到的那把就放回；写入前再读一次文件末尾，锁万一失效也不重复写 |
| P2 | “不合法的请求不拉取”在 MCP 层没有测试 | 已补：替身 `get` 断言没有任何请求、本机没有生成文件 |
| P3 | 锁等待复用注入的 `sleep`，测试传空操作时会空转、让不出事件循环 | 已修：锁等待固定 200 毫秒 |
| P3 | 回测读到另一进程正在追加的半行时报 `Unexpected end of JSON input` | 已修：没有换行结尾的最后一行不读；有用例 |
| P3 | `gaps` 统计整个本机文件，不限于回放区间 | 已修：单次回测另给 `replayGaps`；文档说明两者区别 |

已核实（第二轮）：`src/http.ts` 对令牌先判 `GET` 与白名单，新增路由全部只读；`samplesPage` 只读 `varlighter.sqlite`，参数逐个校验；`readTokenNewsView` 只作用于令牌应答；本机回测与服务器的样本窗口两端一致，网格里每个组合按自己的 `windowHours` 取样本；子进程超时与输出过大的报错区分正确。

CI 补充：a931883 与第一轮修复后的分支 CI 都有两处旧测试失败，都是本批改动的预期变化：一个 MCP 用例把新工具也放进同一个令牌，超过每分钟 30 次；金油用例仍断言令牌不能读 `quote`。已把新工具拆到单独的令牌、白名单断言改为可读。

未能核实：Windows 上多进程同时拉取时锁文件与 `ftruncateSync` 的实际行为（CI 只在 Linux 上覆盖同一进程内的并发）；对真实服务器的令牌读取与限额。上线后在另一台机器上经 Tailscale 实测，结果记进 [live-results.md](../live-results.md)。

## 已运行

- `pnpm check`：通过。
- 分支上手动运行的 ci：提交 a931883 与 0aac7b0 都是 test (6) 失败同样两项（见上），https://github.com/hxx344/trading-platform/actions/runs/45460375176 、https://github.com/hxx344/trading-platform/actions/runs/45463090548 ；提交 bce417d 全部通过 https://github.com/hxx344/trading-platform/actions/runs/45464125038 。之后只改写了两个修复提交的提交信息（6dbf97c 与 bce417d 的代码树相同），并加上本记录。
- 没有页面改动，不需要浏览器验证。
