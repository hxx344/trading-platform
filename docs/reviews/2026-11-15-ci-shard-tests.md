# CI 测试分片并行（R2）审查记录

- 日期：2026-11-15
- 范围：`.github/workflows/ci.yml`、`.github/workflows/release.yml`、`package.json`（`test` 脚本）。
- 等级：R2（CI 与发布工作流）。

## 变更前对齐

- 目的：缩短 CI 墙钟时间。改前 `check` 任务串行约 135s，其中 `pnpm test` 52–69s、`deploy/test-install.sh` 约 30s、`pnpm check` 13s。
- 做法：`pnpm test` 从 `check` 拆到 `test` 任务，按 `node --test-shard` 分 1/2、2/2 两片并行；PR 新推送取消该 PR 的旧运行，main 上每次运行单独分组，不排队不取消；`release.yml` 同样拆出两片，`publish` 依赖 `build` 与 `test`。
- `package.json`：设置 `TEST_SHARD` 时在文件列表之前加 `--test-shard`（放在文件列表之后会作为测试参数被忽略，已实测）；不设时与原来相同。
- 失败时与回滚：只影响 CI 与发布流程，不影响服务。回滚即还原这三个文件；已发布的包不受影响。
- 本次不做：按耗时均衡分片（node 按排序后下标取模分配）；release 复用 main 上 CI 的结果而不重跑。

## 审查结论

一路独立只读审查（上下文与作者隔离）。P0、P1 无。

已核实：`publish` 为 `needs: [build, test]` 且无 `if:`，任一分片失败、取消或超时都不会发布；`fail-fast: false` 不放松门禁；test 任务权限为顶层 `contents: read`，release 中 checkout 带 `persist-credentials: false`。node v24.15.0 先排序文件再按 `index % total` 过滤，两片互补、与 sh 展开顺序无关。临时目录与端口均动态分配，分片不引入新的跨文件依赖。main 无分支保护，任务名变化不影响必需检查。文档中的 `pnpm test` 不设变量时行为不变，无需同步。

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 1 | P2 | main 上所有运行同在 `ci-refs/heads/main` 组，排队中的运行会被更新的运行替换取消，且 main 运行从并行变成串行，与“main 不取消”不符 | 组名改为 PR 用 `github.ref`、其余用 `github.run_id` |
| 1 | P3 | 分片按下标取模，耗时可能不均 | 登记，按实际耗时再定 |
| 1 | P3 | release 的 test 任务在标签版本检查之前就开跑 | 不改：token 只读，publish 仍被 build 拦住；串行会抵消本次目的 |
| CI | — | 首次 PR CI 中分片 1 失败：`test/import-workbench.test.ts` 启动服务时要求 `web/dist/index.html`，作者交接时误称测试不依赖页面构建 | 两个工作流的 test 任务在测试前加 `pnpm build:web`（约 1s） |

## 已运行

- YAML 解析校验；替身 node 核对 `TEST_SHARD` 设与不设时的展开参数；三文件上前置 `--test-shard` 时 1/2、2/2 测试数 34+14=48，与不分片相同。
- PR #48 首次 CI：`check` 65s、`watch` 26s 通过，`test (2)` 52s 通过，`test (1)` 41s 失败（原因见上表）。修复后的 CI 结果见下节。

## 未运行

- 本地全套 `pnpm test`：只改脚本参数，由 CI 两个分片实跑。
