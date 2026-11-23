# 2026-11-24 开放缺陷修复：会话撤销、通知入队确认、原油阻塞通知、资产读取快照与汇率证据（v0.82.1）

- 范围：提交 fe75ff0（#69）、eb9a792（#71）、7a65973（#70）、4a49821（#11、#63）、1f061b9（第一轮审查修复），相对 v0.82.0（6dfcef6，变基后）。变基后对应 f2e8ec8、006ee1a、3271986、47daf7b、a8dbc6f，内容不变；main 期间只进了 Var/Lighter 与 CI 配置的改动，与本批文件不重叠。
  - #69：`src/sessions.ts`、`src/http.ts`、`web/src/SettingsPage.tsx`、`test/sessions.test.ts`、`test/http.test.ts`、`docs/plan.md`。
  - #71：`src/service/health-watch.ts`、`src/crash-guard.ts`、`src/service/main.ts`，同类路径 `src/service/feishu.ts`（保证金平衡告警）、`src/read-token.ts`（到期提醒）；`test/observability.test.ts`、`test/service.test.ts`、`test/read-token.test.ts`、`docs/observability.md`。
  - #70：`src/oil/rules.ts`、`src/oil/rule-live.ts`、`src/service/oil.ts`、`test/oil-rules-live.test.ts`、`docs/oil.md`。
  - #11、#63：`src/asset/{db,store,types,sync,daily-positions,daily-changes}.ts`、`src/asset/sources/hyperliquid.ts`、`test/asset-{store,sync,daily-changes,sources-hyperliquid}.test.ts`、`docs/asset.md`。
- 等级：R3（#69 属鉴权：会话撤销的持久化与接口应答）。其余为 R2：通知与恢复、规则状态里的通知待办（不改规则判断与下单）、只读接口与采集数据（不改数据库结构）。
- 审查方式：作者自审；三路独立只读审查子代理分别审 #69 与 #71、#70、#11 与 #63；第一轮修复后新开审查者复核 1f061b9。#70 与 #11、#63 的实现由作者派出的实现子代理完成，审查者与实现者不同。
- 回滚版本：v0.82.0。会话文件格式不变；`last-crash.json` 格式不变；原油规则状态 JSON 多一个可选的 `unsent`，旧版本忽略并在下一次写状态时丢掉（已解除阻塞而未交出的通知不再补发）；资产行 JSON 多一个可选的 `quote`，旧版本忽略；没有表结构变化。

## 改动

1. #69：会话文件在退出、注销全部或到期时依次尝试换新文件、删除文件、原地改写；三者都失败时 `persisted()` 为假，退出接口返回 500（`session_not_persisted`）并清 cookie，页面弹窗说明；之后任何一次会话写入都补写。启动时装载丢弃的会话写不进文件不算未落盘。
2. #71：依赖巡检的首报、重复提醒、恢复与行情重启通知在入队成功后才推进状态；入队失败下一轮重试，同一问题只在第一次失败和恢复入队时记日志；首报到期却未能入队、问题已恢复的补发一条「（已恢复）」。崩溃标记改为读出、按 `crash:进程:时间` 键 `notifyOnce` 入队、再删除。同类路径一并修：保证金平衡告警入队后才写 `sentAt`，`insert()` 的「告警：」日志移到 INSERT 之后；只读令牌到期提醒交给通知后才标记。
3. #70：规则状态另存待交接列表 `unsent`，与当前阻塞状态无关，只有交接确认才移除；旧状态里未交出的阻塞通知读取时迁入；每条规则最多 20 条。
4. #11：资产读接口经单独的只读连接，`BEGIN` 后在同一个同步调用里读 `import-info` 与该接口的全部查询再 `COMMIT`；异步读取器在第一个 `await` 前发出全部查询，之后再查询报 `SNAPSHOT_CLOSED`。
5. #63：Hyperliquid 读取返回总额所用的 USDC/USD 报价（来源与时间），随资产行与每日快照保存；归因按持仓采样时刻核对时效后使用，不合格保持未知；旧快照不变。

## 结论

独立审查与复核没有遗留 P0、P1。第一轮共 1 条 P1（测试期望值错误，CI 实际失败），已修；P2 3 条，修 2 条、1 条写进「未运行」；P3 若干，修复或登记如下。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1 | `test/observability.test.ts` 崩溃报告用例期望 `'Error: boom'`，实际为 `'boom'`（CI 45228613057 的 test (3) 失败） | 已修 |
| P2 | #71 同类路径没改：保证金平衡告警先写 `sentAt` 再入队；只读令牌到期提醒先标记再通知 | 已修，两处各加失败用例（`service.test.ts` 用 SQLite 触发器制造入队失败） |
| P2 | 队列持续写不进时依赖巡检每 10 秒每个问题记一行日志；`insert()` 在 INSERT 前写「告警：」 | 已修：同一问题只记第一次失败与恢复；日志移到 INSERT 之后 |
| P2 | 设置页改动没有浏览器验证，R3 未写回滚版本 | 回滚版本已写；浏览器验证见「未运行」 |
| P3 | 启动时装载丢弃的会话写不进文件会置上未落盘，之后退出误报 500 | 已修 |
| P3 | 注销失败提示文案（「写入和删除」、cookie 已清仍让用户再操作一次） | 已修文案 |
| P3 | 首报未入队、问题先恢复时整件静默 | 已修：补发「（已恢复）」 |
| P3 | `docs/asset.md` 两处描述比实现宽（跨行借用报价、出错关闭连接的范围） | 已修文档；报价不新鲜时持仓变化显示未知也写进文档 |
| P3 | `docs/oil.md` 没写回退对 `unsent` 的影响 | 已修文档 |
| P3 | #70 没有「入队失败后转待核对」路径的用例 | 登记：代码行为已由审查核实，`toReview` 只清 `live.blocked`；下次改 `toReview` 时补用例 |
| P3 | `unsent` 超过 20 条时静默丢最早的，不记事件 | 登记 |
| P3 | 补发的阻塞通知正文不带生成时间，晚到时看不出阻塞已解除 | 登记 |
| P3 | `noticeSent` 对读取失败转待核对的状态写回归一化结果，原始字段被覆盖 | 登记，影响小 |
| P3 | 崩溃标记保留期间再次崩溃会覆盖旧标记 | 登记，需两次失败叠加 |
| P3 | 复核：`insert()` 日志仍在事务提交前，整批事件回滚或 COMMIT 失败时会多出或重复「告警：」行 | 登记，只影响日志 |
| P3 | 复核：保证金平衡告警与令牌提醒的入队失败日志没有限流，队列持续不可写时每 2 秒一行 | 登记，只影响日志 |
| P3 | 读取周期时多读一次 snapshots | 不改 |

已核实（独立审查）：会话写入各失败组合下 `persisted()` 与磁盘一致，原地改写写到一半读成格式错误只会全部重新登录、不会复活；500 应答与日志不含 cookie，控制面原样转发；`notifyOnce` 去重键保留 7 天；`unsent` 在所有清除阻塞的路径下保留，页面写与规则循环写之间没有跨 await 的读改写；资产各读接口都在同一事务里发出全部查询，`SNAPSHOT_CLOSED` 不会在正常路径触发，只读连接不挡写者；报价方向为 USDC→USD，不参与总额，不跨快照借用。

## 已运行

- `pnpm check`、`pnpm build:web`：通过。
- GitHub CI（分支 `claude/fixable-issues-fcc357`）：
  - [45228613057](https://github.com/hxx344/trading-platform/actions/runs/45228613057)（4a49821）：test (3) 因上述 P1 失败，其余通过。
  - [45230169494](https://github.com/hxx344/trading-platform/actions/runs/45230169494)（1f061b9）：全部通过，含 test 六个分片、install 三部分与 platform-systemd 五组。
- 实现子代理在本机跑过资产相关的几个测试文件（违背了本机不跑测试的约定）；结论以 CI 为准。

## 未运行

- 设置页「注销未落盘」弹窗的浏览器验证：需要数据目录与文件都不可写的替身环境；接口应答由 `test/http.test.ts` 覆盖，页面只多一个弹窗分支，没有布局变化。
- 真实服务器上数据目录只读、通知库写满等故障注入；真实 Hyperliquid 账户上报价时效阈值（60 秒 / 15 分钟 / 5 分钟）是否合适。
