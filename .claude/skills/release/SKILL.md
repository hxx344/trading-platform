---
name: release
description: 把已完成的改动合入 main 并发布 v<版本>：核对合并门槛、定版本号、本地检查、分支 CI、发布提交、原子推送 main 与标签，跟到发布完成。用户说“发布”“发版”“合入并发布”“推到 main”或输入 /release 时使用。
argument-hint: "[版本号，如 v0.82.0；或一句发布摘要]"
---

# 合入与发布

规则来源：[AGENTS.md](../../../AGENTS.md)《合并前审查》与《检查》、[docs/code-review.md](../../../docs/code-review.md) 第 6 节。两者与本文冲突时以它们为准，并把本文改成一致。

参数：$ARGUMENTS（可空。给了版本号就用它；给了摘要就用作发布提交标题）

用户已经要求发布时，一路做到发布完成，不逐步停下来问。只在下面写明“停下”的地方停。不用 `--force`、`--no-verify`，不删或移动已推送的标签。

## 1. 确定要发布的提交

```bash
git fetch origin --tags
git status --short --untracked-files=all
git log --oneline origin/main..HEAD
```

- 工作区有未提交的改动：属于本次任务的，先按 code-review.md《提交信息》提交；归属不明的，停下问用户。
- `origin/main..HEAD` 为空：没有可发布的内容，告诉用户并结束。
- HEAD 不在 `origin/main` 之上（`git merge-base --is-ancestor origin/main HEAD` 失败）：`git rebase origin/main`。有冲突就停下报告，不自行取舍。不用裸 `git stash`。
- 只有纯文档提交：直接 `git push origin HEAD:main`，不改版本号、不打标签，结束。

## 2. 核对合并门槛

对 `origin/main..HEAD` 里每个代码、配置或测试提交逐项核对：

1. 提交信息有「更新说明：」「风险等级：」「已运行：」。「更新说明：」和内容在同一行，发布说明按行提取它。
2. R2、R3：`docs/reviews/` 有覆盖这些提交的审查记录，结论是 P0、P1 为 0，P2 已修或已登记。缺独立审查时，按 code-review.md《独立审查》新开一个只读审查子代理（R3 用 `r3-reviewer`），只给差异范围、code-review.md 和待核查重点，不给自己的结论。审出 P0、P1 就停下报告，不发布。
3. R3：审查记录或模块文档写明了回滚版本。
4. 模块文档已回填实际做法；改动范围与提交描述一致，没有夹带。

缺的是作者能补的（提交信息、审查记录、文档回填），补上再继续。

## 3. 定版本号

```bash
node -p "require('./package.json').version"
git describe --tags --abbrev=0 origin/main
```

两者应一致（`package.json` 是 `0.81.0`，最新标签是 `v0.81.0`）。不一致就停下报告。

- 参数给了版本号：用它，确认它比当前版本大。
- 否则看待发布提交的类型：有 `feat` 升次版本号（0.81.0 → 0.82.0）；只有 `fix`、`perf`、`refactor`、`chore` 升修订号（0.81.0 → 0.81.1）。
- 确认标签没被占用：`git tag -l v<版本>` 与 `git ls-remote --tags origin v<版本>` 都为空。

## 4. 本地检查

```bash
pnpm check
pnpm build:web
```

测试以 CI 为准，本机是 Windows 时不跑 `pnpm test`（权限、符号链接、路径分隔符等 Linux 语义会大量误报）。改了页面时，按 docs/frontend.md 第 7 条的浏览器验证应在实现阶段已经做过；没做就先做。

## 5. 分支 CI

推 main 之前，让待发布的最后一个代码提交在 CI 上通过一次：

```bash
git push origin HEAD
gh workflow run ci.yml --ref <当前分支>
gh run list --workflow ci.yml --branch <当前分支> --limit 1 --json databaseId,url,headSha
```

- 核对 `headSha` 就是刚推的提交，再用 `gh run watch <id> --exit-status` 在后台等它结束（一条阻塞命令，结束时会通知，不要自己反复查询）。把运行链接告诉用户。
- 同一提交已有通过的手动 CI 运行时可以复用，不重跑。
- 这次运行里通过的真实 systemd 验收，主线在发布提交上会直接复用，不用为此在发布提交上再跑一次。条件是发布提交只改 `package.json` 的版本号，且 runner 的 Ubuntu 发行版、CPU 架构和 systemd 上游版本与那次运行相同；不满足时主线会重跑七组。
- 改了安装脚本或部署激活：按 AGENTS.md《检查》改用 `gh workflow run ci.yml --ref <分支> -f install_full=true`。
- 失败：偶发（网络、runner）就 `gh run rerun <id> --failed`；代码问题就修复、提交，回到第 4 步。修复属于新逻辑时按 code-review.md 重新定级和复核。

## 6. 发布提交与标签

只改 `package.json` 的 `version`，然后：

```bash
git add package.json
git commit -F <提交信息文件>
git tag v<版本>
```

提交信息照已有的发布提交写（如 `f16df4f`），不写「更新说明：」（否则发布说明会重复一行）：

```text
chore(release): v<版本> <一句摘要，取本次主要改动>

风险等级：R1（发布版本号）
已核对 package.json 与标签版本，正式发布由本提交的主线 CI 把关。

（署名行按会话的署名要求写入）
```

标签用轻量标签（仓库现有标签都是）。

## 7. 原子推送

```bash
git push --atomic origin HEAD:main v<版本>
```

- 被拒（main 已前进）：`git tag -d v<版本>`，`git fetch origin`，`git rebase origin/main`。新进的提交改了代码就回到第 4 步重做检查和分支 CI；只改了文档就重新打标签再推。
- 不要分开推 main 和标签，也不要开合并请求：那样同样的代码会多跑几次 CI。

## 8. 跟到发布完成

```bash
gh run list --workflow ci.yml --commit <发布提交> --json databaseId,url,status,conclusion
gh run list --workflow release.yml --limit 3 --json databaseId,url,headBranch,status,conclusion
```

推送后主线 CI 需要一点时间登记，读不到就稍后再读一次，不要连续查询。找到 `headBranch` 为 `v<版本>` 的发布运行后，用 `gh run watch <id> --exit-status` 在后台等它结束。发布运行里的 `ci` 任务由 `scripts/wait-ci.ts` 等主线 CI 的结果。

- 主线 CI 偶发失败：`gh run rerun <ci 运行> --failed`，通过后 `gh run rerun <发布运行> --failed`。
- 标签指向的提交没有主线运行：`gh workflow run ci.yml --ref v<版本>` 补验，通过后重跑发布运行里失败的任务。
- 代码问题：在 main 上修复，用新版本号重新走本流程。已推送的标签不删不移。

完成后核对：

```bash
gh release view v<版本> --json url,assets,body
```

资产齐全，说明里列出了本次各提交的「更新说明」。

## 9. 汇报

告诉用户：版本号、发布页链接、主线 CI 与发布运行的链接、发布说明里的条目、回滚版本（R3 时）、没有验证的部分。服务器上的升级由用户在页面「系统更新」或 `install.sh` 里做，本流程不碰服务器。
