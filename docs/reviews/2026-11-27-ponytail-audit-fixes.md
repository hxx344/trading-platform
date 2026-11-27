# 全仓安全与可靠性审计（/ponytail-audit）20 项修复审查记录（v0.107.1）

- **基准版本**：`origin/main`（`c1ed586` / `v0.107.0`）
- **风险等级**：`R3`（执行状态机、ADL 撤单收敛、资产只读凭据权限边界、特权部署脚本与实盘下单确认契约）
- **回滚版本**：`v0.107.0`（`c1ed586`）。`c1ed586..1a51a0d` 无任何 SQLite 表结构、`user_version`、配置文件或密钥格式不兼容变更；新增的 JSON 可选字段（如 `closureEvidence` 行 `orderId`、`adl` 批次 `cancelNotSentSince`）可被旧版安全忽略，回退无需数据迁移或清理。

## 1. 改动范围与提交清单（`c1ed586..1a51a0d`）

1. **`611dfd6`（`fix(execution)`）**：执行器追价认领事务归属与超时清理、ADL 挂单识别与撤单重试收敛、Bybit / CrossEx 拒单与并发边界、Ondo 止损触发守卫、`varlighter` / `dex-spread` 精度与回测连接隔离、`options` 平仓归因与序列化边界。
2. **`98bb003`（`fix(security)`）**：部署脚本（`deploy/install.sh`、`deploy/install-watch.sh`）关闭向非特权子进程泄漏 root 写锁 FD 9 及经 `argv` 传入凭据/代理、副服务器 `main-watch` 慢读整请求超时断流与 `408` 响应、飞书发件箱 64 KB 响应上限与 16 KB 分批、`read-redact` / `read-token` 只读脱敏、资产库权限撤销与 429 限流竞态修复、行情 IPC 定时器泄漏清理，以及移除失效的 `account-control` 共享写者登记模块。
3. **`2c3d1d0`（`fix(web)`）**：只读 POST 预览与 `varlighter/backtest` 超时归类、阻断写入接口非空不可解析 HTTP 200 误判成功与幂等请求号保护、MEV 风控参数乐观基线防轮询回滚、四处实盘下单确认逻辑收敛至 [web/src/order-confirm.ts](../../web/src/order-confirm.ts)，以及 `PositionCharts` / `TradingTerminal` / `SvgPlot` 高频渲染与句柄清理优化。
4. **`10ed581`（`fix(review)`）**：修复第一轮 R3 审查指出的 `executor.ts` 并发认领 TOCTOU 竞态、`adl.ts` `not-sent` 撤单后饿死查询与重启计时基线、期权 `closureEvidence` ±25 秒时钟偏移归因边界、`varlighter/plan.ts` 乘数精度对齐、`install-watch.sh` / `main_watch.py` `408` 护栏、`mev-form` 写操作禁用输入与 `order-confirm` 空响应校验，并清理无用夹具与过期测试时长记录。
5. **`b7d8a7f`（`fix(review)`）**：修复第二轮 R3 审查指出的期权 `close_task_completed` 先前组平仓历史误吞（`priorCloseExec` 与缺失明细 fail-closed 补读）、同毫秒多笔部分平仓 `closureRowIdentity` 碰撞、前端四处下单确认可选链与 `jobs.length === 0` 守卫、`mev-form` 规范键序与粘性 `touched` 修复，以及 `docs/executor.md` 过时表述清理。
6. **`1a51a0d`（`fix(ci)`）**：修复首轮分支 Ubuntu CI（run `46041656750`）暴露的 3 项失败：`src/asset/history-cache.ts` 恢复非币安账号 `permissionCurrent()` 权限代际守卫（修复 OKX 过期 `sync()` 误撤权）、`web/src/api.ts` 与 `test/web.test.ts` 对齐非空不可解析 200 按结果未知处理契约、`deploy/install.sh` 静态 9 分支代理 `export` 消除 `SC2163` 及 `deploy/install-watch.sh` / `docs/watch.md` 改用 `sed` 读令牌消除 `SC2016`。
7. **本审查记录提交（纯文档）**：同步关闭第三轮指出的 [docs/executor.md](../executor.md#L142) 轻微 P3 措辞残留（“登记结清”→“在途状态结清”）并落库本文件。

## 2. 三轮独立只读 R3 审查结论

1. **第一轮独立 R3 审查（`c1ed586..2c3d1d0`，后端/部署与前端两名独立只读研究子代理）**：
   - 共发现 4 项 P1、5 项 P2、6 项 P3，主要涉及并发认领 TOCTOU、ADL `not-sent` 退回与 `cancels >= 3` 查询饿死、期权 `closedAt` 本机时间窗口截断、VarLighter 乘数精度、`install-watch.sh` 408 读取时序、MEV 乐观基线与前端空对象确认保护。
   - **处置**：全部在 `10ed581` 修复并附回归测试。
2. **第二轮增量 R3 审查（`2c3d1d0..10ed581`，后端与前端两名独立只读研究子代理）**：
   - 前端确认首轮问题闭环且 `P0 = 0, P1 = 0`，指出 3 项 P2 与 1 项 P3（四腿空 `jobs`、四页面空值访问、`mev-form` 键序与粘性 `touched`）；
   - 后端确认首轮问题闭环，发现 1 项 P1（`close_task_completed` 组平仓后 60 秒内重开同腿被误吞）、1 项 P2（同毫秒部分平仓 `rowIdentity` 碰撞）与 2 项 P3（测试分支冗余、`docs/executor.md` 残余措辞）。
   - **处置**：全部在 `b7d8a7f` 修复并附 ±25 秒时钟偏移与同毫秒回归测试。
3. **第三轮增量 R3 终审（`10ed581..1a51a0d`，新开独立只读研究子代理）**：
   - 复核第二轮全部闭环项与 `1a51a0d` 3 项 CI 修复及相邻调用链后确认：**`P0: 0`、`P1: 0`、`P2: 0`、`P3: 1`**，确认可安全回退至 `v0.107.0` 并同意推进合并与发布。
   - 唯一 `P3` 为 [docs/executor.md](../executor.md#L142) 第 142 行“登记结清”历史措辞，已于本次纯文档提交一并收口。

## 3. 验证与 CI 门禁状态

- **本机 Windows 已验证**：
  - 提交 `10ed581` 时已通过：`pnpm check`、`pnpm build:web`、`python -m unittest deploy/main-watch/test_main_watch.py`（23/23 通过）、执行器/ADL/期权/DEX 相关测试及全部 `web/test` 测试；并用 `127.0.0.1` 替身服务完成 `#/mev/settings` 在 `1280x800` 与 `390x844` 视口浏览器复验（0 控制台报错、0 横向溢出）。
  - 提交 `1a51a0d` 后已通过（第三轮复核同版实测）：`pnpm check`、`pnpm build:web`、`options` 与 `options-performance`（64/64）、6 个资产库测试文件（194/194）、`web/test/{order-confirm,mev-form,api}.test.mjs`（17/17）、`test/web.test.ts` 中“页面请求”匹配用例（3/3）。`test/web.test.ts:47` 存量 `symlinkSync` 用例在非管理员 Windows 下因 `EPERM` 不计通过，交由 Ubuntu Linux CI 覆盖。
- **Ubuntu Linux CI 验证（禁止 WSL，以 GitHub Actions Ubuntu Runner 为准）**：
  - 首轮全量 CI（run [`46041656750`](https://github.com/hxx344/trading-platform/actions/runs/46041656750)，`install_full=true` on `b7d8a7f`）：`check`、`watch`、`install (all)`、`test (1/3/4/5)` 与全部 7 组 `platform-systemd` 通过；暴露 `lint`、`test (2)`、`test (6)` 3 项失败，已全部在 `1a51a0d` 修复。
  - 最终发布门禁：在提交本审查记录后，于分支 `ponytail_security_audit` 执行 `gh workflow run ci.yml --ref ponytail_security_audit -f install_full=true`，确认全部分片、`shellcheck`、`install (all)`、`watch` 与 7 组 `platform-systemd` 全部通过后，再以仅递增 `package.json` 版本号至 `0.107.1` 的发布提交执行原子推送与正式发布（使主线 CI 直接复用已通过的 7 组 `platform-systemd` 验收）。
