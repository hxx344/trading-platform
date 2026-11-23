# 2026-11-24 轮询开销与监控面板分块（v0.82.2）

- 范围：提交 ec115fd、4678835（审查修复），相对 v0.82.1（6efbe30）。
  - `src/http.ts`、`src/read-view.ts`、`src/service/feishu.ts`
  - `web/src/App.tsx`、`web/src/MonitorPage.tsx`
  - `test/http.test.ts`、`test/read-view.test.ts`、`test/monitor-alerts.test.ts`、`test/news-feed.test.ts`
  - `scripts/test-durations.json`、`docs/frontend.md`、`docs/news.md`
- 等级：R2。只读接口加可选参数、展示读取协商名单、页面分块与 `memo`、通知队列清理频率；不触及下单、划转、鉴权与数据库结构。
- 审查方式：作者自审；`/review` 独立只读子代理一轮（看不到作者的对话与结论）。
- 回滚版本：v0.82.1，无数据或配置迁移。新页面配旧服务端时 `jobs=0` 被忽略、返回完整视图；旧服务端不认协商名单时回普通 200。

## 背景

这批改动最初做在落后远端 46 个提交的本地 main（v0.73.0）上，发布前才发现，分支 `claude/polling-cost-optimizations` 没有合入。本批在 v0.82.1 上重做仍然有效的部分。原方案里的任务列表表达式索引不再做：main 已有 `read_jobs_created`，且 `recentJobs` 的金油筛选改用 `json_each`，表达式索引用不上；原属 R3 的部分随之去掉。

## 改动

1. `/api/state?jobs=0`：不查询近期任务与名义上限，配对组页面改用它；不带参数的应答不变。
2. `/api/news`、`/api/news/moves` 加入展示读取的版本协商。
3. 行情监控页的原油、金油比、海力士、合约价差、异动行情面板按页签加载；合约价差的四个样式文件留在 `MonitorPage.tsx`、排在 `monitor.css` 之前。
4. `memo` 只加在快讯页、日志页、合约价差面板、异动行情面板。
5. 飞书出站队列的过期清理改为启动后第一次发送时执行、之后每小时一次。
6. `scripts/test-durations.json` 换成本分支 CI 测得的 214 项（原 152 项）。

## 结论

独立审查没有 P0、P1。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2 | 快讯两条路径进协商名单后，没有测试走真实路由验证“第二次读取回 204”和“204 时视图仍然生成”（异动行情靠这次读取判断有人在看） | 已修：`test/news-feed.test.ts` 的接口用例补两条路径的断言 |
| P3 | `pruneAt` 按墙上时钟推进，系统时间跳到未来再校回后，下一次清理要等真实时间追上 | 已修：时钟回拨超过一个间隔时立即清理 |
| P3 | 协商与清理频率只回填在 `docs/frontend.md`，模块文档没有指向 | 已修：`docs/news.md` 3.2 加指向 |

已核实（独立审查）：页面的 `ServiceState` 没有 `jobs` 与 `notionalLimits`，原油、海力士、金油页的任务来自各自的状态接口；只读令牌路由表不接受 `/api/state` 的查询参数，令牌读取不变；控制面转发保留查询串；204 时页面仍更新 `receivedAt`；四个加 `memo` 的组件只收稳定的 `onExpired`，没有靠父级重渲染更新的时间文字；`once` 判重键最多多留 1 小时，只会多抑制、不会多发。

## 已运行

- `pnpm check`、`pnpm build:web`：通过。`MonitorPage` 分块 368.40 kB → 112.33 kB（gzip 111.00 → 37.34 kB），样式文件与改动前逐字节相同（`cmp`）。
- 浏览器：`scripts/dev-monitor.ts` 预览，无头 Chrome 在 1280 与 390 宽度依次打开六个监控页签、快讯、日志、运行状态、总览；无横向溢出，各面板分块在点开页签时才加载，控制台只有预览服务没有的接口 404（`/api/host`、`/api/update`、`/api/read-token`、`/api/asset/*`、`/api/logs`）。
- GitHub CI（分支 `claude/polling-cost-v2`）：
  - [45242215228](https://github.com/hxx344/trading-platform/actions/runs/45242215228)（ec115fd，带 `measure_durations`）：`watch` 第一次在「损坏的部署被修复」一步失败，重跑通过，其余一次通过；本批没有改 `deploy/` 与巡检脚本，判断为偶发。
  - [45243181013](https://github.com/hxx344/trading-platform/actions/runs/45243181013)（4678835，审查修复后）：全部通过。

## 未运行

- 本机不跑测试，以 CI 为准。
- 真实服务上 204 的命中率与轮询开销的下降幅度没有测量。异动行情每 15 秒更新各频道的读取时刻，每 5 秒一次的读取里约三分之二能回 204。
- 明文 HTTP 局域网下页面走备用 SHA-256 实现的路径没有单独验证（与已在名单里的其他读取相同）。

## 评估过、这次不做

- `connector.account()` 的读取合并：R3，读取顺序是有意的，需要在真实账户上核对限频。
- 合约价差扫描每秒重算：照工作台移植的行为，先在浏览器里量再动。
- JSON 应答压缩与 brotli：静态资源已缓存一年，压缩 JSON 会占执行器线程。
