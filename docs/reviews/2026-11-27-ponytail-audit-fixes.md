# 全仓安全与可靠性审计（/ponytail-audit）20 项修复审查记录（v0.112.2）

- **基准版本**：`origin/main`（`ce2c240` / `v0.112.1`；原分支基于 `c1ed586` / `v0.107.0`，已完成全量变基对接）
- **风险等级**：`R3`（执行状态机、ADL 撤单收敛、资产只读凭据权限边界、DEX 价差实盘持久化、特权部署脚本与实盘下单确认契约）
- **回滚版本**：`v0.112.1`（`ce2c240`）。`ce2c240..7130687` 无任何 SQLite 表结构、`user_version`、配置文件或密钥格式不兼容变更；新增的 JSON 可选字段（如 `closureEvidence` 行 `orderId`、`adl` 批次 `cancelNotSentSince`）可被旧版安全忽略，回退无需数据迁移或清理。

## 1. 改动范围与提交清单（`ce2c240..HEAD`）

1. **`22e2465`（`fix(execution)`）**：执行器追价认领事务归属与超时清理、ADL 挂单识别与撤单重试收敛、Bybit / CrossEx 拒单与并发边界、Ondo 止损触发守卫、`varlighter` / `dex-spread` 精度、实盘自编号/意图持久事务与回测连接隔离、`options` 平仓归因与序列化边界。
2. **`ab2e674`（`fix(security)`）**：部署脚本（`deploy/install.sh`、`deploy/install-watch.sh`）关闭向非特权子进程泄漏 root 写锁 FD 9 及经 `argv` 传入凭据/代理、副服务器 `main-watch` 慢读整请求超时断流与 `408` 响应、飞书发件箱 64 KB 响应上限与 16 KB 分批、`read-redact` / `read-token` 只读脱敏、资产库权限撤销与 429 限流竞态修复、行情 IPC 定时器泄漏清理，以及移除失效的 `account-control` 共享写者登记模块。
3. **`d752acf`（`fix(web)`）**：只读 POST 预览与 `varlighter/backtest` 超时归类、阻断写入接口非空不可解析 HTTP 200 误判成功与幂等请求号保护、MEV 风控参数乐观基线防轮询回滚、四处实盘下单确认逻辑收敛至 [web/src/order-confirm.ts](../../web/src/order-confirm.ts)，以及 `PositionCharts` / `TradingTerminal` / `SvgPlot` 高频渲染与句柄清理优化。
4. **`25814cc`（`fix(review)`）**：修复第一轮 R3 审查指出的 `executor.ts` 并发认领 TOCTOU 竞态、`adl.ts` `not-sent` 撤单后饿死查询与重启计时基线、期权 `closureEvidence` ±25 秒时钟偏移归因边界、`varlighter/plan.ts` 乘数精度对齐、`install-watch.sh` / `main_watch.py` `408` 护栏、`mev-form` 写操作禁用输入与 `order-confirm` 空响应校验，并清理无用夹具与过期测试时长记录。
5. **`ec7fd87`（`fix(review)`）**：修复第二轮 R3 审查指出的期权 `close_task_completed` 先前组平仓历史误吞（`priorCloseExec` 与缺失明细 fail-closed 补读）、同毫秒多笔部分平仓 `closureRowIdentity` 碰撞、前端四处下单确认可选链与 `jobs.length === 0` 守卫、`mev-form` 规范键序与粘性 `touched` 修复，以及 [docs/executor.md](../executor.md) 过时表述清理。
6. **`ad794f9`（`fix(ci)`）**：修复首轮分支 Ubuntu CI（run `46041656750`）暴露的 3 项失败：`src/asset/history-cache.ts` 恢复非币安账号 `permissionCurrent()` 权限代际守卫（修复 OKX 过期 `sync()` 误撤权）、`web/src/api.ts` 与 `test/web.test.ts` 对齐非空不可解析 200 按结果未知处理契约、`deploy/install.sh` 静态 9 分支代理 `export` 消除 `SC2163` 及 `deploy/install-watch.sh` / `docs/watch.md` 改用 `sed` 读令牌消除 `SC2016`。
7. **`7130687` & 本审查文档更新提交（纯文档）**：[docs/executor.md](../executor.md#L142) 收口“登记结清”残余措辞（改为“在途状态结清”），并将本审查记录更新至变基后的基准 `ce2c240`（`v0.112.1`）、第四轮审查结果与最终发布目标 `v0.112.2`。

## 2. 四轮独立只读 R3 审查结论

1. **第一轮独立 R3 审查（变基前 `c1ed586..2c3d1d0`，后端/部署与前端两名独立只读研究子代理）**：
   - 发现 4 项 P1、5 项 P2、6 项 P3，主要涉及并发认领 TOCTOU、`not-sent` 撤单后查询饿死、期权 `closedAt` 本机时间窗口截断、VarLighter 乘数精度、`install-watch.sh` 408 读取时序、MEV 乐观基线与前端空对象确认保护；已全部修复并附回归测试。
2. **第二轮增量 R3 审查（变基前 `2c3d1d0..10ed581`，后端与前端两名独立只读研究子代理）**：
   - 前端 `P0 = 0, P1 = 0`（3 P2 + 1 P3）；后端发现 1 P1（期权 `close_task_completed` 退役边界）、1 P2（同毫秒部分平仓碰撞）与 2 P3；已全部修复并附 ±25 秒时钟偏移与同毫秒回归测试。
3. **第三轮增量 R3 审查（变基前 `10ed581..1a51a0d`，新开独立只读研究子代理）**：
   - 复核第二轮闭环项与 3 项 CI 修复后确认 **`P0: 0`、`P1: 0`、`P2: 0`、`P3: 1`**，唯一 P3（[docs/executor.md](../executor.md#L142) 残余措辞）已于 `7130687` 关闭。
4. **第四轮变基后独立 R3 审查（`ce2c240..7130687`，新开独立只读研究子代理）**：
   - 逐项核实 6 个变基重叠文件（`src/varlighter/live.ts`、`src/varlighter/store.ts`、`test/dex-live.test.ts`、`test/varlighter.test.ts`、`src/read-token.ts`、`test/read-token.test.ts`）均完整保留 `v0.108.0..v0.112.1` 主线功能（去模拟盘接口、`deps.onOrderSent`、`deps.onEntropyFill`、账户/Entropy 表结构与路由收敛）及全部 20 项审计修复；
   - 核实与 `ce2c240` 新增 DEX 账户估值、Entropy 成本同步、`src/dex/*`、`web/src/varlighter/*` 及 `scripts/test-durations.json` 的交互兼容；
   - 结论：**`P0: 0`、`P1: 0`、`P2: 0`、`P3: 0`**，确认安全可回退至 `v0.112.1`（`ce2c240`），仅待更新本审查文档并跑通变基后全量分支 Ubuntu CI 后即可合入并发布 `v0.112.2`。

## 3. 验证与 CI 门禁状态

- **本机 Windows 已验证（基于变基后 `7130687`）**：
  - `pnpm check`、`pnpm build:web`、`python -m unittest deploy/main-watch/test_main_watch.py`（23/23 通过）；
  - `test/dex-live.test.ts`（39/39）、`test/varlighter.test.ts`（65/65）、`test/dex-{accounts,entropy-cost,service}.test.ts`（25/25）、`test/asset-{dex-spread,sync,fills,positions-service,positions-readers,positions-store}.test.ts`（185/185）、`web/test/{api,varlighter-form,order-confirm,mev-form}.test.mjs`（29/29），以及 `executor`、`adl`、`chase`、`transfer`、`market-ipc`、`control-continuity`、`options`、`options-performance`、`live-bybit`、`oil-rules-live` 全部通过；
  - `test/web.test.ts`「页面请求」匹配用例（3/3）及 `test/read-token.test.ts` 19/20 非 POSIX 用例通过；`read-token.test.ts:247`、`web.test.ts:47`、`live-wiring.test.ts`（3 项）与 `service.test.ts`（3 项）因 Windows 非管理员 NTFS/POSIX 权限与目录 `fsync` 限制交由 Ubuntu Linux CI 实测；
  - 变基前 `10ed581` 已用 `127.0.0.1` 替身服务完成 `#/mev/settings`（`1280x800` 与 `390x844`）浏览器双视口验收，0 报错、0 溢出（本次变基涉及前端的文件与 `v0.107.0..v0.112.1` 无重叠冲突）。
- **Ubuntu Linux CI 验证（禁止 WSL，以 GitHub Actions Ubuntu Runner 为准）**：
  - 变基前（`50473dd`）：run [`46044075674`](https://github.com/hxx344/trading-platform/actions/runs/46044075674)（`install_full=true`）全部作业通过（`lint`、`check`、`watch`、`install (all)`、`test (1..6)` 及全部 7 组 `platform-systemd`）。
  - 变基后门禁：提交本审查记录更新后，于 `ponytail_security_audit` 分支推送（`--force-with-lease`）并运行完整 `ci.yml -f install_full=true`，确认全部作业绿灯后，仅提升 `package.json` 版本号至 `0.112.2` 并原子推送 `HEAD:main` 与 `v0.112.2`（复用分支父提交已通过的 7 组 `platform-systemd` 验收）。
