# 页面在后台时完成更新后的刷新、别处发起的更新（R2）审查记录

- 日期：2026-11-19
- 范围：`4808e67..` 本批提交（`d68e436`、`b2fcd50`、`4d99ff6`、`923fece` 及审查收尾提交）；`web/src/live-resource.ts`、`web/src/use-live-resource.ts`、`web/src/update-view.ts`、`web/src/UpdateStatus.tsx`、`web/test/live-resource.test.mjs`（新增）、`test/update-view.test.ts`、`scripts/test.ts`（加入 `web/test/*.test.mjs`）、`docs/update.md` 第 4 节、`docs/frontend.md` 第 4 条。
- 等级：R2（共享页面读取层的调度与恢复；不碰服务端、更新助手、安装脚本、凭据与数据）。
- 回滚版本：v0.70.1（`sudo bash install.sh --version v0.70.1`，不用改配置）。

## 审查结论

三轮独立只读审查（每轮新开审查者，只给差异范围、`docs/code-review.md` 与待核查重点）。

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 1 | P2 | 载入版本取第一次读取；页面在后台打开时不读，回到前台第一次读到的已是新版本，漏刷新 | 还没读到载入版本时也在后台读取（`readsInBackground()` 的 `!loaded`）；无头浏览器场景覆盖 |
| 1 | P2 | 服务一直读不到时后台每 2 秒读取，没有上限 | 距上次成功读取满 10 分钟停读（`BACKGROUND_SILENCE_MS`）；第 2 轮发现首版修法有误，见下 |
| 1 | P2 | 测试只覆盖正常路径 | 补在途读取、401、读取中关闭后台读取、`nextLoaded()`；`useLiveResource` 重新订阅后 `background` 一致性没有 React 测试设施，登记不补（审查已核对代码：重新订阅从 ref 取当前值） |
| 1 | P3 | 隐藏时带后台读取的订阅者加入已暂停的共享条目走 `catchUp`，状态停在 paused | `subscribe` 遇到暂停条目改走 `revive`，补测试 |
| 1 | P3 | 注释与文档说「按间隔补读」，实际立即补读 | 措辞改为「立即补读一次」 |
| 2 | P1 | 首版上限用 `offline` 判断：停读后状态为 paused、`offline` 为假，后台读取立即重开、不等间隔重读，循环不止 | 改为按保留的错误计算 `silentMs`（暂停时错误保留，读成功才清空），条件只看 `silentMs`；补与读取层串联的测试（换回首版条件会失败） |
| 2 | P2 | 单测把循环写成预期 | 改断言 |
| 2 | P3 | 注释只说对一半 | 改注释 |
| 3 | P3 | 串联测试缺下限，且没覆盖停读后恢复 | 补下限断言与恢复段 |

第 3 轮结论：上一轮问题均已关闭，没有 P0/P1。

已核实无问题（摘要）：

- 抽出的 `revive` 与原 `wake` 循环体逐行一致；没有订阅者打开 `background` 时，其它页面的读取行为不变。
- 停读、恢复、401 停止、离线、在途请求、`interrupted` 各组合下没有计时器泄漏、重复请求或卡在 paused。
- 版本比较不会反复刷新（刷新后以新的第一次读取为载入版本）；安装进行中（含可能的回退）由 `!updating(view)` 挡住；任务失败、中断、请求过期后后台读取随之关闭。
- 错误只在读取成功与写入应答时清空，`silentMs` 不随暂停状态翻转。

## 已运行

- `pnpm check`（通过，最后一次修复后重跑）。
- `pnpm test`（全量通过，在 `923fece` 上；收尾提交只改测试，另跑 `node --test web/test/live-resource.test.mjs test/update-view.test.ts` 通过）。
- `pnpm build:web`（通过）。
- 无头浏览器 + 拦截请求的替身接口，四个场景通过：本页跟着的更新在后台完成后刷新；空闲隐藏时不读、别处的更新回到前台后刷新；版本未变不刷新；在后台打开的页面先读到载入版本，别处更新后回到前台刷新。

## 未运行

- 服务器上的真实在线更新与真实浏览器后台节流（本机无 root 与 systemd），首次在服务器上更新时实测并回填 [live-results.md](../live-results.md)。
- 页面样式未改，未做 1280 / 390 截图对比。
