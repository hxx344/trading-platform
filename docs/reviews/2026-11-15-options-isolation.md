# 期权启动失败只停期权（issue #10，R3）审查记录

- 日期：2026-11-15
- 范围：`src/service/options.ts`（启动失败分类 `OptionsStartError`、可中止的启动检查、`createOptionsSupervisor`）、`src/service/main.ts`（接线：首次启动、任务消息转发、视图、后台循环、停服顺序）、`web/src/App.tsx`（503 时保留期权入口）、`web/src/options-form.ts`（`startRefused` 认 503 `options_unavailable`）、`test/options-isolation.test.ts`（新增）、`test/options-form.test.ts`、`docs/options.md`、`README.md`。
- 等级：R3（服务启动与唯一写者边界：期权账户锁、状态库与引擎的创建时机；期权的资金写入入口）。

## 变更前对齐

- 用户可见行为：同时配置 ASTER 配对与期权时，期权启动失败（Bybit 不通或超时、密钥 / 账户没通过检查、本机另一个进程占用此期权账户、`options.sqlite` 打不开或状态无法恢复）不再让整个服务拒绝启动。服务照常启动，ASTER 划转、ADL 与其他模块照常运行；期权停用，`/api/options/*` 读写都回 503 `options_unavailable` 并写明原因，飞书每个原因每次进程启动一条，每 60 秒从头重试，通过后飞书告知并开始轮询。做法照 CrossEx 已有的 `createCrossexSupervisor`。
- 影响面：
  - 期权失败时：账户锁已释放、已打开的 `options.sqlite` 已关闭，不创建引擎、不跑期权循环、不向 Bybit 发写请求；视图在引擎不存在时一律 503，写请求在任何发送之前被拒。
  - 重试是一次完整的新启动（取锁 → 启动检查 → 打开库 → 按服务启动时的规则恢复状态）。状态恢复语义不变：进行中的任务改为恢复中并请求停止，不补发旧请求。
  - 仍拒绝启动的：`config.json` / `secrets.json` 解析不过；ASTER 写入租约与 ASTER 账户锁冲突；原油启动检查（本次不改）。
  - 期权账户锁被占用按“只停期权”处理，而不是拒绝整个服务：这把锁只覆盖期权账户，取不到锁时本进程不会写期权；把它当成拒绝启动正是 issue 要解决的耦合。issue 验收里“共享锁冲突仍拒绝”按 ASTER 租约与账户锁理解，现有行为不变。
  - 首次启动检查仍在主库打开之前、同一位置等待完成，正常时启动顺序与耗时不变。引擎创建从通知器建好之后挪到启动检查之后，引擎在通知器就绪前发的消息先缓存，就绪后补发。
  - 停服：`onStopping` 中止进行中的启动（启动检查立即放弃）；期权循环照旧在停止时关闭引擎（停止任务、撤单核对）；`onStopped` 在循环结束后关闭 `options.sqlite` 并释放锁。
  - 安装与导入：期权启动检查失败不再让安装判定启动失败、自动回退旧版本。导入期权时本来就先用密钥核对一次，不受影响。
- 失败时与回滚：期权停用期间不下单、不对账；已有挂单留在交易所，恢复后由对账循环核对（与停服期间相同）。回滚 `sudo bash install.sh --version v0.47.1`，不用改配置和数据；回滚后期权启动失败会再次让整个服务拒绝启动（README 回退表已加一行）。
- 本次不做：
  - 原油启动检查失败仍拒绝整个服务（原油有自己的执行任务与 ASTER 的执行器共用主库，隔离需要单独设计）。
  - “运行状态”页与 `/api/ready` 不单列期权是否启动；就绪判定不含期权循环（与改前相同）。
  - 定时运行摘要不加期权一行。

## 审查结论

独立只读审查（每轮新开审查者，上下文与作者隔离），第 2 轮只复核第 1 轮的修复。

已核实（第 1 轮）：期权失败时锁在 `prepareOptions` 内释放、库在监督器内关闭、不建引擎，视图第一步即 503，写请求在 `readJson` 之后、任何发送之前被拒；`attempt ??=` 与 `running` 保证同时只有一次启动、不会有两个引擎；中止检查到 `running` 赋值之间同步执行，没有竞态窗口；停服时已在运行的照常进入期权循环并 `engine.close()`；`runtime.ts` 在 drainMs 超时后仍等循环结束才进 `onStopped`；`startWired` 各失败路径都经 `releaseOil → stopOptions` 释放锁与库；消息缓存不丢不重；503 正文与飞书只用固定文字，细节只进日志；`options_unavailable` 只由监督器产生且 `running` 不会回退，`startRefused` 的改动安全；文档与代码一致；安装判据是“90 秒内正常监听”，“不再自动回退”成立。

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 1 | P2 | 重试成功后写“【期权已启动】”若抛错（notify.sqlite 满或忙），`loop` 在期权循环之前退出：对账等循环不跑，停服时也不 `engine.close()` | `notify` / `notifyOnce` 包 try/catch，失败只记日志 |
| 1 | P2 | 失败期间 `notifyOnce` 抛错会结束 `loop`，期权不再重试 | 同上 |
| 1 | P2 | issue 验收“Bybit 超时”“恢复需重新验证、不补发旧请求”没有专门用例，`ORDER_PATHS` 断言在没有进行中任务时空过 | 新增两条：启动检查超时（300 ms）；状态库带两条挂着的护翼单，失败后重试通过，断言任务 `stopRequested`、只有本服务发出的撤单、没有 `order/create`、交易所订单数不变 |
| 1 | P3 | 测试在失败期间探测账户锁，可能与 150 ms 的重试互相抢锁 | 失败期间的锁探测改在重试间隔 60 s 的用例里做 |
| 1 | P3 | Bybit 业务码拒绝（IP 未绑定 10010、密钥无效 10003）归为 unreachable，页面没提 IP | 原因文字补“本服务器 IP 不在密钥白名单内，详见服务日志”；按错误码细分登记，不在本批做 |
| 1 | P3 | `locked` 的日志细节含完整 UID | 只进日志，与改前及 CrossEx 一致，不改 |
| 1 | P3 | README、docs/options.md 写的 v0.48.0 须与发版一致 | 发版时核对 |
| 1 | 待确认 | 期权账户锁冲突按“只停期权”处理，偏离 issue 验收“共享锁冲突仍拒绝”的字面 | 理由见“变更前对齐”；在 issue 里说明，请作者确认 |

## 已运行

- `pnpm check` 通过；`pnpm build:web` 通过。
- 第 1 轮修复后：`node --test test/options-isolation.test.ts test/options-form.test.ts test/options.test.ts test/import-options.test.ts test/crossex-service.test.ts test/service.test.ts` 全部通过。`options-isolation` 六个服务级故障注入：Bybit 不通后恢复；密钥被拒反复重试只提醒一次、状态库属于另一账户；账户被另一进程占用后释放；停服时进行中的启动检查立即放弃；启动检查超时；带进行中任务的状态在重试通过后恢复且不补发下单。
- 本机全套 `pnpm test`：15 分钟超时被终止，卡在 `test/service.test.ts`（不涉及期权）；该文件单独运行 19 项全部通过，几秒完成。本机高负载下的已知不稳定现象，全套以 CI 两个分片为准（见下）。
