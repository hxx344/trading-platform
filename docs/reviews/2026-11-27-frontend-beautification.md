# 前端视觉统一与交互升级代码审查记录（2026-11-27）

## 批次与定级

- **范围**：
  - 全站设计令牌抽离（`web/src/tokens.css`）、全局样式与严格 CSP 兼容主题统一（`web/src/styles.css`、各模块 CSS 及 13 个 `web/src/crossex/*.css`）；
  - 导航壳层升级：消除双重 `<h1>`、顶栏整合 `#status` 状态胶囊与刷新入口、桌面端可折叠侧栏、移动端抽屉可见焦点筛选以及统一单页头（含同步 `origin/main` 新增的 `ChainArbPage.tsx` 单页头）；
  - 服务端深色登录页（`src/http.ts`）；
  - 暗色模态弹窗队列与生命周期防重入守卫（`web/src/app-dialog-queue.ts`、`web/src/AppDialog.tsx`、`web/test/app-dialog.test.mjs`），全站原生 `alert()` / `confirm()` 清零并覆盖主线新增的多令牌 `ReadTokenSettings.tsx`、`VarLighterReady.tsx`、`FundingBookPage.tsx`、`MevPage.tsx`、`MevSetup.tsx` 与 `VarLighterLive.tsx`；
  - `StateViews.tsx` 骨架屏、`BalanceChart.tsx` / `AssetTrend.tsx` / `OptionsPerformance.tsx` 趋势渐变填充及 `docs/frontend.md` 说明更新。
- **风险定级**：**R2**
  - 不改变后端订单状态机、撮合风控、数据库结构、凭据管理或 systemd 部署脚本；但覆盖全站确认/告警弹窗迁移、异步确认快照锁定及多页面样式重构，按 R2 完成独立审查。
  - **回滚基线**：`v0.106.2`（`07af72f`，同步合入最新主线后仅涉前端展示与确认交互）。

## 五轮独立审查摘要

1. **首轮 R2 审查（`R2 Frontend Reviewer`）**：识别 3 P1 / 3 P2 / 1 P3（弹窗取消与互斥锁、`.button.danger` 选择器污染、`StatusPage.tsx` 早退缺 `<h1>`、`base-currency-picker` 层级、抽屉焦点及部分确认后闭包陈旧），**已全部修复**。
2. **第二轮增量审查（`R2 Incremental Reviewer`）**：确认首轮问题全部关闭，新提出 2 P2（`OptionsPage` 等 5 处异步护栏对齐与缺失 `AppDialog` 单测）与 1 P3（`AbortSignal` 监听清理），**已抽离 `app-dialog-queue.ts`、补充 `web/test/app-dialog.test.mjs` 并全部修复**。
3. **第三轮聚焦终审（`R2 Final Focused Reviewer`）**：针对上述 8 个核心文件复查，确认 **P0/P1/P2/P3 清零**。
4. **第四轮主线变基增量复审（`R2 Rebase Incremental Reviewer`）**：在 `git rebase origin/main`（`07af72f` / `v0.106.2`）合并 10 个冲突文件并适配 `origin/main` 新增前端页面后审查，确认主线功能与安全修复 100% 无损保留、原生 `alert`/`confirm` 全仓清零且严守 `style-src 'self'` CSP；发现 2 P1 与 2 P3：
   - `[P1]` `web/src/mev/MevPage.tsx` `Overview.start`：`await dialog.confirm` 后发送了 `latest.fault` / `latest.haltReason`，绕过服务端 `409 stale` 校验且未比对关键实盘参数快照；
   - `[P1]` `web/src/varlighter/VarLighterLive.tsx` `SwitchPanel.turnOn`：弹窗期间未锁定确认时刻看到的 `pairs` 与 `limits` 快照；
   - `[P3]` `web/src/mev/MevSetup.tsx` `SetupPanel.send` 缺少 `owner` 与 `deploy?.hash` 复核；
   - `[P3]` `web/src/perpetual.css` 移动端媒体查询（L22、86、90）未同步扩展 `.perp-heading h1`。
   - **处置**：已全部完成修复（`MevPage.tsx` 锁定 `seen` 快照且按 `seen.fault` / `seen.haltReason` 提交，`VarLighterLive.tsx` 锁定 `confirmedPairs` / `confirmedLimits` 并前后比对，补齐 `MevSetup.tsx` 与 `perpetual.css` 两处 P3）。
5. **第五轮修复复审（`R2 Post-Rebase Fix Reviewer`）**：核查 `MevPage.tsx`、`VarLighterLive.tsx`、`MevSetup.tsx`、`perpetual.css` 及类型检查，确认第 4 轮问题全部关闭，**P0 = 0、P1 = 0、P2 = 0、P3 = 0**。

## 最终验证结果

- **类型检查与前端构建**：
  - `pnpm check`：通过（exit 0）。
  - `pnpm build:web`：通过（344 ms 产出 `web/dist`，exit 0）。
- **本机单元测试**：
  - `node --test web/test/app-dialog.test.mjs`：4/4 通过。
  - 变基前完整前端与登录套件（`test/web.test.ts`、`test/login.test.ts`、`web/test/*.test.mjs`、`web/test/crossex/*.test.mjs`、`web/test/perpetual/*.test.mjs`）除 Windows 平台限制的 2 条用例（`test/login.test.ts:45` 仅限 Linux 属主检查、`test/web.test.ts:47` `symlinkSync` EPERM）外其余全过；完整全仓 Linux 测试由分支 CI 在合并 `main` 前把关。
- **浏览器实测验收（Playwright 1280×800 与 390×844）**：
  - 变基前后共三轮检查覆盖登录页及主站全部路由，包含主线新增页面 `#/chain-arb`、`#/fundingbook`、`#/mev`、以及 `#/status`、`#/settings` 等：`1280px` 与 `390px` 零横向溢出、`<h1>` 规范单标题、`.tp-dialog` 切路由自动取消关闭、#status 危险态背景色未被污染、390px 抽屉首焦点落在可见链接、零 JS 异常及零 CSP 报错。
