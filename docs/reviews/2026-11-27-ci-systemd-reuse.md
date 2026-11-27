# 主线复用发布前的 systemd 验收，验收重新分组

2026-11-27，R2。范围为 `fe837c6..HEAD` 的 `.github/workflows/ci.yml`、`scripts/ci-systemd.mjs`、`test/ci-systemd.test.ts`、`deploy/test-platform-systemd.sh`、`scripts/test-durations.json`、`AGENTS.md` 与 `.claude/skills/release/SKILL.md`。只影响 CI，生产安装器、`deploy/package.sh`、健康检查期限和服务进程不变。可将这批文件回退至 v0.105.1。

## 变慢的原因

统计最近 150 次成功的 CI 运行，除真实 systemd 验收外最长的任务稳定在 40 到 50 秒，整轮用时由 `platform-systemd` 决定。

- 主线复用基本不命中。11 月 26 日 19 次主线推送只有 6 次在 1.2 分钟内结束，其余都重跑了五组，约 2 分钟。原因有两个。其一，手动运行按发布流程落在最后一个代码提交上，主线推送的是其后的发布提交，提交号不同；最近 40 个发布提交都只改了 `package.json`。其二，同一个矩阵会分到 systemd 包为 `255.4-1ubuntu8.18` 与 `8.19` 的两种镜像，旧规则要求五组都与 `platform-plan` 所在 runner 的完整包版本相同；抽查的 5 次手动运行只有 1 次五组版本一致，同一提交的 [手动运行](https://github.com/hxx344/trading-platform/actions/runs/45900031979) 与 [主线运行](https://github.com/hxx344/trading-platform/actions/runs/45900316392) 因此没有复用。
- 各组本身变长。最慢一组的验收步骤从 11 月 21 日的约 60 秒涨到 11 月 26 日的 90 到 96 秒：v0.80.0 起每次安装多了内容，v0.90.0 多了 DEX 服务与它的故障回退，v0.101.0 多了场所账户的三次安装，v0.102.0 起程序包带上 14.5 MB 的 Lighter 签名器，`gzip -9` 每打一个夹具包多花约 2.1 秒（在 runner 上实测 `-9` 为 2.42 秒、`-1` 为 0.28 秒），行情与控制组一次要打 7 个包。
- 逐行计时的 [测量运行](https://github.com/hxx344/trading-platform/actions/runs/45964488129) 显示其余时间在安装器的服务重启、5 秒稳定观察和健康探测上，属于生产行为，本批不动。

## 做法

- 复用：`scripts/ci-systemd.mjs` 除本次提交外，还查最近 5 个第一父祖先中连续的一段，条件是从该祖先到本次提交只改了 `package.json`，且去掉 `version` 后内容相同。验收步骤的运行环境改为比较 Ubuntu 发行版、CPU 架构和 systemd 上游版本（Debian 版本号最后一个连字符之前的部分），摘要列出实际跑过的完整包版本。git 或接口读不到时照旧重新执行。
- 分组：五组改为七组。换端口从执行组拆出，损坏的降级从拓扑组拆出，update-helper 与控制面候选从行情组移到执行组。不带参数时顺序与原来逐行相同。夹具用的 `package.sh` 副本改用 `gzip -1`，并断言恰好替换一处。
- 单独运行的损坏降级组先用当前安装器装上 v0.64.0 并写入标记库，再进入原阶段，与拓扑组之后的现场一致。

## 实测

| 组 | 改动前验收步骤（[主线 v0.105.0](https://github.com/hxx344/trading-platform/actions/runs/45903527468)） | 改动后（[分支运行](https://github.com/hxx344/trading-platform/actions/runs/45966782913)） |
| --- | --- | --- |
| migration | 74 秒 | 73 秒 |
| components | 91 秒 | 51 秒 |
| execution | 89 秒 | 62 秒 |
| port | 在 execution 内 | 55 秒 |
| topology | 96 秒 | 62 秒 |
| downgrade | 在 topology 内 | 39 秒 |
| reconcile | 69 秒 | 63 秒 |

最慢一组由 96 秒降到 73 秒。同一份代码在不同 runner 上的耗时相差可达三成，那次分支运行还排队了约 35 秒才分到 runner，整轮 144 秒；前一次七组的 [分支运行](https://github.com/hxx344/trading-platform/actions/runs/45965490377) 没有排队，整轮 110 秒。

## 独立审查

第一轮（`fe837c6..78b6470`）：无 P0、P1。

- P2：祖先候选原先按 `platform-plan` 的路径表判断，路径表不含 `src/dex`、锁文件等，夹在手动运行与发布提交之间的这类提交会跳过真实验收。已改为只接受只改版本号的祖先，`ci.yml` 的路径判断还原为主线原样。路径表本身缺 `src/dex` 等路径是原有缺口，登记在下面。
- P2：候选计算在工作流的 bash 里，没有测试。已移入 `ci-systemd.mjs`，用临时 git 仓库覆盖父提交复用、隔两个版本提交、第二个候选读取失败、改了其他文件、改了 `package.json` 其他字段、重命名、合并提交的第二父、超过 5 个祖先。
- P3：单独运行的损坏降级组从全新安装起步，少了“先有双进程历史与标记库”的隐含覆盖。已补前置。
- P3：发布技能里的说明没写复用条件。已补。
- 待核实：只比较 systemd 上游版本可能漏掉 Ubuntu 补丁修订带来的行为差异。给不出复现路径；重新执行时同一矩阵同样会混用两个修订。

第二轮（`78b6470..efe4a74`）：无 P0、P1、P2，第一轮问题均已关闭。三条 P3：合并用例不能区分是否只认第一父，已改为合并结果等于第二父的夹具，去掉 `--first-parent` 的变异会让测试失败；夹具 git 继承外层 `GIT_*` 变量，已剔除；`test-durations.json` 里该测试的 4000 毫秒是估计值，下次测量时替换。

登记：`platform-plan` 的路径表不含 `src/dex`、`src/varlighter` 中签名器以外的文件与 `pnpm-lock.yaml`，只改这些文件的主线推送不触发真实 systemd 验收。迁移组的验收步骤 73 秒，成为最长的一组，可再把页面导入与四次页面更新拆出。

## 已运行

- `node --test test/ci-systemd.test.ts`（Windows 原生，1 通过）；`pnpm check`；Git for Windows Bash 对 `deploy/test-platform-systemd.sh` 的语法检查。
- 分支 CI 全部通过，含七组真实 systemd 验收：[78b6470](https://github.com/hxx344/trading-platform/actions/runs/45965490377)、[efe4a74](https://github.com/hxx344/trading-platform/actions/runs/45966782913)。

## 未运行

- 主线推送复用祖先提交上的手动运行，要到下一次发布推送才第一次发生。本批合入时的主线运行只能验证同一提交的复用。
- 不带参数的完整顺序运行（`all`）没有在 runner 上跑，依据是拆分只插入了分组边界。
- `pnpm test` 全套没有在本机跑，以分支 CI 为准。
