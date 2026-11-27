# 审计遗留项修复与回归加固审查记录（v0.106.2）

- **基准版本**：`origin/main`（`89cb19f` / `v0.106.1`）
- **风险等级**：`R3`
- **回滚版本**：`v0.106.1`（本次无数据库结构、配置文件或 systemd 单元格式变更，可直接回退）

## 1. 改动范围与影响面

1. **摘要服务日志与状态脱敏**（[src/service/summary.ts](../../src/service/summary.ts)、[test/summary.test.ts](../../test/summary.test.ts)）
   - 发送失败异常捕获路径先调用 `redactDiagnostic(error.message)` 再 `.slice(0, 200)` 落库与写日志，避免先截断导致 URL 或 token 特征被切半漏脱敏。
   - `status()` 读取已落库的 `row.lastError` 时同样执行 `redactDiagnostic`，兼容历史未脱敏记录。
2. **特权导入与更新助手非 root 属主防线**（[src/service/take-handoff.ts](../../src/service/take-handoff.ts)、[src/service/import-helper.ts](../../src/service/import-helper.ts)、[src/service/update-helper.ts](../../src/service/update-helper.ts)、[test/import-workbench.test.ts](../../test/import-workbench.test.ts)、[test/update.test.ts](../../test/update.test.ts)）
   - 提取共享校验函数 `assertNonRootOwner(owner, label, currentUid = process.getuid?.())`，当进程以 `uid=0` 运行且目标属主同为 `uid=0` 时拒绝继续。
   - 在 `runImportHelper`、`recoverImportHelper`、`runUpdateHelper`、`recoverUpdateHelper` 及各自 CLI `--recover` 入口统一执行校验；注入 `checkHandoffDir` / `readOwner` / `currentUid` 钩子以支持跨平台单测，不影响生产默认路径。
3. **VarLighter 回测只读线程事务隔离与句柄清理**（[src/varlighter/replay-worker.ts](../../src/varlighter/replay-worker.ts)、[src/varlighter/store.ts](../../src/varlighter/store.ts)、[test/varlighter.test.ts](../../test/varlighter.test.ts)）
   - 回测 worker 查询前开启 `PRAGMA busy_timeout=2000; PRAGMA query_only=ON; BEGIN`，失败路径用独立 `try/catch` 包裹 `ROLLBACK` 保留原始错误，`finally` 关闭连接。
   - `prepareSampleRange` 将 `oldRange.iterate` 与 `selectRange.iterate` 移入 `try` 内并在 `finally` 中安全释放，防止局部初始化抛错时迭代器泄露。
4. **SvgPlot 曲线边界裁剪、高亮域保护与平仓标记边界**（[web/src/svg-plot-geometry.ts](../../web/src/svg-plot-geometry.ts)、[web/src/svg-plot.tsx](../../web/src/svg-plot.tsx)、[web/src/varlighter/parts.tsx](../../web/src/varlighter/parts.tsx)、[web/test/svg-plot-geometry.test.mjs](../../web/test/svg-plot-geometry.test.mjs)）
   - 抽取并测试 `inPlotDomain` 与方向无关的 `clampedBandY`；绘图 `clipPath` 垂直外扩 2px 避免极端贴边曲线半截裁切；悬停圆点与 `overlay` 移出 `<g clipPath>`；平仓空心圆增加 `trade.closedAt <= to` 边界判断。

## 2. 独立审查结论

1. **第一轮独立 R3 审查**（只读研究子代理）：发现 1 个 P1（`t.mock.method(process, 'getuid')` 与真实根目录检查在跨平台与 Linux CI 存在失败风险）、2 个 P2（`--recover` 分支未执行 `assertNonRootOwner`；`replay-worker` 回滚可能掩盖原异常及 `prepareSampleRange` 迭代器释放时机问题）、1 个 P3（`clampedBandY` 假设 y 轴随数值单调递减）。
2. **第二轮增量 R3 审查**（新开独立只读研究子代理）：确认上一轮 4 项问题全部闭环、无 P0/P1/P2 阻塞项，同意合入并发布 `v0.106.2`。其指出的 3 项非阻塞 P3 细节（`import-helper.ts` / `update-helper.ts` JSDoc 注释位置、`test/update.test.ts` 未使用参数 `t`、`svg-plot-geometry.test.mjs` `<g clipPath>` 标签深度匹配）已在提交前顺手修正并复验。

## 3. 验证状态

- **本机 Windows 已验证通过**：
  - `pnpm check`（`tsc -p tsconfig.json && tsc -p web/tsconfig.json`）
  - `pnpm build:web`
  - `node --test --test-reporter=dot test/summary.test.ts test/varlighter.test.ts web/test/varlighter-form.test.mjs web/test/svg-plot-geometry.test.mjs`
  - `node --test --test-reporter=dot --test-name-pattern="root 身份下拒绝由 root 拥有" test/import-workbench.test.ts test/update.test.ts`
  - 浏览器（`1280x800` 与 `390x844`）验收 `#/varlighter`、详情页与模拟盘页，零控制台与 CSP 报错、零横向溢出、超域标记不被裁切。
- **未在本机执行（交由 Linux CI `ci.yml` 与 `platform-systemd` 验证）**：
  - `test/import-workbench.test.ts` 与 `test/update.test.ts` 中依赖 POSIX `symlinkSync`、`chmod`（`0o600`）与真实 `uid` 的存量用例（Windows 非管理员下预期受限）；
  - 全量分片测试及 Ubuntu 真实 `systemd` 安装与升级验收。
