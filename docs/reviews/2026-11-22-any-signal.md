# 2026-11-22 中止信号组合泄漏导致写入租约丢失（v0.79.0 未发布，v0.79.1）

- 现象：飞书频繁收到「【服务异常停止】写入租约已失去（续租超时），持有者未变化」，交易服务随后被 systemd 重启。
- 根因：Node 24.15 的 `AbortSignal.any()` 只要来源里有长期信号（服务停止信号、连接生命周期），每次调用都会留下回收不掉的内存：带 `AbortSignal.timeout` 时每次约 1.7 KB，不带时约 170 B。行情读取每次都调用，堆随运行时间上涨，全量 GC 停顿 67–91 秒，超过 60 秒的租约期限。服务器上的证据：只有本进程卡顿，每小时的卡顿次数在每次重启后从零重新爬升，时钟、OOM、数据库大小都正常。本机同版本 Node 复现：30 万次调用后，强制 GC 堆仍有 508 MB。
- 范围：新增 `src/any-signal.mjs`、`src/any-signal.d.mts`、`test/any-signal.test.ts`。替换 `src/` 下全部 `AbortSignal.any`，涉及 asset、service、monitor、news、market、vendor 共 30 个文件。`src/vendor/ondo/client.mjs` 在请求结束时中止局部控制器。另改 LESSONS L206、AGENTS.md 路由表。租约语义不变。
- 等级：R2（行情读取、调度与共享基础设施；不改资金、凭据、数据库结构和唯一写者边界）。审查方式：作者自审，加两轮独立只读审查子代理。
- 回滚版本：v0.78.0（回滚后泄漏和租约丢失会重新出现）。

## 结论

P0 为 0。P1、P2 已在第二轮修复，第二轮复审为“无 P0–P2”。

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 自测 | — | 首版全部弱引用：结果只被自身监听器引用时被提前回收，负载下 `market-monitor`「Var 公开资金费…10 秒截止」漏掉中止 | 改为带超时的结果在计时器结束前强引用 |
| 1 | P1 | 中间版全部强引用：不带超时、成功路径上没有来源中止的组合（持仓与成交刷新、CrossEx 资金费、cached 目录加载等）每次钉住约 1.6 KB | 已修：混合持有，不带超时的结果改为弱引用，由 FinalizationRegistry 解除；补守卫用例（强引用写法 9 万次增长 166 MiB，现实现 0 MiB） |
| 1 | P2 | 使用前提只写在注释里，类型声明和测试都没有体现 | 已修：d.mts 补 JSDoc，加守卫用例 |
| 1 | P3 | 转发发生在来源的监听器里，与原生的同步标记时机不同 | 模块注释写明 |
| 1 | P3 | `timeoutMs` 不做校验 | 注释与 d.mts 写明；现有调用点都传常量 |
| 1 | P3 | vendor 文件头仍写“只改导入路径” | 已修 |
| 2 | P3 | 文档里“放在局部变量里”不准确：函数被优化后，await 之后不再读取的局部变量不会被保存 | 已修：三处改为“await 后仍读取、被闭包捕获或交给在途消费方” |
| 2 | P3 | 弱引用分支依赖 undici、http 在请求在途期间持有信号，没有测试守护 | 已修：加本地服务器用例（fetch、http.request，响应头与响应体两个阶段各覆盖） |
| 2 | P3 | 不抵抗 `stopImmediatePropagation()` | 模块注释写明；src 内没有这种用法 |

已核实：
- 所有不带超时的调用点在需要中止的整段时间里都可达：要么 await 之后还会读取，要么被闭包捕获，要么交给 fetch、http.request 或 `untilAborted`。
- `ondo/client.mjs` 在 finally 里 abort，不影响超时判定、不影响读取响应，也不影响连接复用。
- 中止原因、TimeoutError、重入、重复 finish、回收回调晚于 finish 到达这几种情况的行为都符合预期。

## v0.79.0 CI 失败与 v0.79.1 修复

v0.79.0（`367a0ce`）推送后主线 CI 的 test (6) 失败，失败用例是 `market-monitor`「Var 公开资金费…直到执行端 10 秒截止才中止」，发布被门禁拦下，没有产出正式版。

- 原因：`monitor-data.ts:167` 的 `life` 不带超时，被弱持有。测试替身 `variationalFetch` 只在信号上挂监听器，它的 Promise 只能靠中止结束。信号、监听器、Promise、挂起的帧只互相引用，GC 后整体被回收，中止丢失。本机用 `--expose-gc` 每 100ms 强制 GC 可以稳定复现：v0.79.0 失败，修复后通过。
- 修复：不带超时的结果改为“自身有 abort 监听器时强引用，没有时弱引用”，与原生 `AbortSignal.any` 一致。监听器通过实例上的 add/removeEventListener 计数；作为别的组合来源时挂的转发监听器不计入。fetch 在请求回收后会移除监听器：6000 个已完成请求后堆增长 0.15 MiB。新增“只被等待中止的监听器引用”用例：旧版 0/50，新版 50/50。
- 第三轮独立审查：无 P0–P2。5 条 P3 已处理，`onabort` 会计入、绕过实例方法观察不到、成功路径需移除监听器、可达性说法、用例次数说明，均已写进注释、d.mts 和 LESSONS。另核实 Node 24.15 下 fetch、http.request、events.once、addAbortListener、timers/promises、stream 都经过实例方法；每次调用额外开销约 1.5 µs。

## 已运行

- `pnpm check`。
- 全量 `pnpm test` 两次，均退出码 0：强引用中间版约 2878 条，混合持有版约 2879 条。混合持有版之后只改了注释和测试，新增的 fetch / http.request 用例单独连跑 3 次通过。
- 首版全量测试有两条失败：`market-monitor`「…10 秒截止」由首版缺陷导致，已修；`service`「接管检查…」属已知的高负载不稳定测试，后两次全量均通过。
- `test/any-signal.test.ts` 连跑多次通过。复审另外 4 进程并发复刻了内存用例：带超时增长 4–7 MiB，不带超时约 0 MiB，阈值为 20 MiB。

- v0.79.1：`pnpm check`；`test/any-signal.test.ts`（9 条）多次通过；`test/market-monitor.test.ts` 全文件连跑 2 次通过；强制 GC 下的对比复现见上文。全量 `pnpm test` 在 P3 注释修改前跑过一次，只有 `service`「接管检查」因“持仓接收时间超前本机时钟”失败（高负载时钟竞争，与本次无关），单独连跑 3 次通过。

## 未运行

- `pnpm build:web`、浏览器验收：页面代码未改（`web/src/PerpetualPaper.tsx` 在浏览器里运行，没有这个泄漏，未改）。
- `deploy/test-install.sh`、真实 systemd 验收：未改安装脚本与单元。
- 服务器上的长时间观察：升级后由用户观察「服务器状态」里的堆内存，以及每小时「报价读取失败」的次数。
