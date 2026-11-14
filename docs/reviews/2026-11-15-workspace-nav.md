# 导航按工作区组织（N-1，R2）审查记录

- 日期：2026-11-15
- 范围：`0c0c07c..` 本批提交：`web/src/workspace-nav.ts`（新）、`web/src/shell.css`（新）、`web/src/App.tsx`、`web/src/aster.css`、`web/src/styles.css`、`web/src/main.tsx`、`test/workspace-nav.test.ts`（新）、`docs/frontend.md`、`docs/plan.md`、`package.json`（版本号）。做法见 [docs/frontend.md](../frontend.md) 文末《导航按工作区组织》。
- 起因：用户确认页面导航照工作台统一平台方案第 2 节按 8 个工作区组织；第一批照方案 7.1 只改菜单分组与路由，不改接口和数据。
- 等级：R2（改全部页面共用的外壳与导航，不涉及资金、凭据、执行、数据库）。作者以外的只读子代理独立审查一轮。
- 回滚：`sudo bash install.sh --version v0.31.0`。

## 审查结论

无 P0 / P1。下列问题本批已处理：

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2 | 期权页右下角固定提示框 `.options-desk .notice` 与侧栏同为 `z-index:20`，DOM 靠后，手机宽度下盖住打开的抽屉 | `styles.css` 导航一节在 760px 以下把抽屉与遮罩提到 22 / 21（元素名选择器，压过后加载的 `shell.css`），浏览器核对计算值 |
| P2 | 只验了 1280 与 390，侧栏常驻且内容区最窄的中间宽度没看 | 补 800 与 1024：行情监控页 800 宽度刷新区溢出 41px（监控页断点按整窗宽度算），在 761–912px 套用它 700px 的页头折行规则；复查 761 / 800 / 912 / 913 / 1024 无溢出 |
| P3 | `test/workspace-nav.test.ts` 分组 id 断言用被测数据推导期望值，同义反复 | 改为字面 id 数组 |
| P3 | `frontend.md` 复制行号写成 166–171，实际 166–170 | 改正 |

登记、不改：

- 手机宽度顶栏不吸顶（工作台同样不吸顶），已在文档写明照工作台。
- `docs/frontend.md` 第 3 行 `page.ts` 的说明顺带改正（它现在只在缺少构建产物时兜底），与导航无关，在 PR 里写明。

## 已运行

- `pnpm check`、`pnpm build:web`（通过）；`node --test test/workspace-nav.test.ts`（3 个用例通过）。
- `pnpm test` 全量：只有 `test/transfer.test.ts`“恢复：发送中被接管的划转……”失败（等待超时：划转已出站），单独连跑 3 次失败 2 次，属于时序不稳定；本批未改 `src/` 与该测试。
- 浏览器（无头 chromium，`scripts/asset-demo.ts` 与 `scripts/dev-monitor.ts` 替身）：1280 / 390 宽度 6 页分组、高亮、面包屑、溢出、抽屉交互 44 项通过；800 / 1024 宽度 12 项无溢出；控制台只有未配置模块的入口探测 404。

## 未运行

- 原油页、期权页的内容区：替身后端没有这两个模块，只用拦截的状态应答核对了入口分组位置。
- 与工作台同页面并排截图对比：本机没有运行中的工作台；本机无头浏览器缺中文字体，截图只用来看版式。
