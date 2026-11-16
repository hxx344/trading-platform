# 发布工作流不重跑 ci（R2）审查记录

- 日期：2026-11-16
- 范围：`.github/workflows/release.yml`、`scripts/wait-ci.ts`（新）、`test/wait-ci.test.ts`（新）、`AGENTS.md`（「检查」一节一条）。
- 等级：R2（CI 与发布工作流），一路独立只读审查。
- 回滚：还原 `release.yml` 到 v0.48.1（`fc10346`）的内容即回到“发布时重跑全部检查”；只影响发布流程，不影响服务与已发布的包。

## 变更前对齐

- 改前：推送 `v*.*.*` 标签后，release.yml 的 build 任务重跑 `pnpm check`、shellcheck、巡检单测，test 任务重跑六片测试；同一提交推到 main 时 ci.yml 已经跑过这些。
- 做法：
  - release.yml 新增 `ci` 任务（`actions: read`），运行 `node scripts/wait-ci.ts`，等该标签提交的 ci 运行通过；`publish` 改为 `needs: [ci, build]`。删去 test 任务和 build 任务里与 ci.yml 重复的三项。
  - build 任务保留页面构建、不带参数的 `deploy/test-install.sh`（完整顺序只在这里跑，ci.yml 里是三部分各自从首次安装开始）、打包与更新说明。
  - 门禁只认 `push` 与 `workflow_dispatch` 事件的运行：合并请求的运行测的是合并结果，`head_sha` 相同也不代表测过这个提交。任一这样的运行成功即放行；没有成功且都已结束则立即拒绝；还在排队或运行就等。
  - 时限：3 分钟内没见到任何运行即拒绝；见到过排队或运行中的运行后最多等 25 分钟；每 10 秒读一次，单次请求 20 秒超时。读取失败、应答条数少于 `total_count`、应答里混入别的提交都算读不到，不放行。
- 失败时：门禁拒绝只是不发布，按提示重跑 ci 或手动运行 ci 后重跑发布里失败的任务。
- 本次不做：build 任务的安装步骤不改用 `.github/actions/setup` 的缓存；完整顺序的安装测试不搬进 ci.yml。

## 审查结论

一路独立只读审查（上下文与作者隔离）。P0、P1 无。

已核实：只有 `push`、`workflow_dispatch` 的运行算数，每个运行校验 `head_sha`，条数不足算读取失败；重跑中的运行状态为未完成，不沿用上次结论；`cancelled`、`skipped`、`startup_failure` 等一律算未通过；没有找到 ci 未在该提交上通过却放行的路径。v0.48.1、v0.48.0、v0.47.1 三个标签提交各有一个 main 上成功的 push 运行，比发布运行早 1–2 秒创建，同时推送 main 与标签不会误拒。最坏等待（25 分钟 + 间隔 + 请求超时 + 准备步骤）低于任务的 30 分钟上限，计时用单调时钟。脚本在只装 Node 24.15.0、不装依赖的 runner 上可运行。移出的检查在 ci.yml 上逐项有对应任务（check、lint、test 六片）。只有 `ci` 任务多了 `actions: read`，写权限仍只在不运行项目代码的 publish。`test/wait-ci.test.ts` 会被 `scripts/test.ts` 收进。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2 | 缺审查记录与回滚说明 | 本文件 |
| P3 | “任一成功即通过”没写进注释，也没有“push 成功、之后手动运行失败”的用例 | 注释写明，补用例 |
| P3 | 入口块（请求地址、非 2xx、退出码）没有测试 | 读取抽成可注入 `fetch` 的 `readRuns` 并补测试；退出码与文案仍只在真实仓库上手工核对 |
| P3 | AGENTS.md「ci 只对每次推送到 main 的最新提交运行」不准确 | 改为说明门禁认哪些运行 |
| P3 | runner 排队久时整轮 ci 可能超过 25 分钟，门禁会拒绝 | 登记：默认拒绝且有界，重跑失败任务即可 |
| P3 | `release` 并发组只保留一个等待中的运行，门禁等待期间连续推三个标签时中间那个会被取消（改前已存在） | 登记，不改 |

## 已运行

本机为 Windows，Node v24.22.1。

- `pnpm check`：通过。
- `node --test test/wait-ci.test.ts`：5 项通过。
- 真实仓库上运行 `node scripts/wait-ci.ts`（审查修复前的版本）：main 上已通过的提交 `fc10346` 1 秒放行（退出 0）；只有合并请求运行的提交 `c179b63` 等 182 秒后拒绝（退出 1）；无效令牌读取失败（HTTP 401）189 秒后拒绝（退出 1）。审查修复后在 `fc10346` 上重跑：放行。
- PR 的 CI 与首次用新流程发布的结果见提交记录与发布运行。

## 未运行

- shellcheck、`deploy/test-install.sh`：本机没有 bash（约定不用 WSL），本次也没有改 shell 脚本；由 CI 与发布工作流实跑。
- 本地全套 `pnpm test`：只新增一个测试文件，由 CI 六片实跑。
- 门禁拒绝时的整条发布链路（publish 被跳过）：没有为此推一个会失败的标签；`needs` 的拦截与改前相同。
