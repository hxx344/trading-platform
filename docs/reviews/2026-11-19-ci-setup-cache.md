# CI 共享 setup 缓存 Node 与依赖

2026-11-19，R2。范围为 `.github/actions/setup/action.yml`，提交 `f36e977`。回退版本 v0.68.0。发布包、安装器和服务进程不变。

## 基线

主线每个用到共享 setup 的任务都要花 8–10 秒准备 Node 和依赖。其中下载并解压 Node 24.15.0 约 5 秒。node_modules 缓存键含整份 `package.json`，主线推送的总是改了版本号的发布提交，所以每次都找不到缓存，要重新安装依赖。十几个任务还会同时去保存同一个键，只有一个能成功。[v0.67.1 主线](https://github.com/hxx344/trading-platform/actions/runs/44383070966)

## 做法

- 用 `actions/cache` 缓存 `${runner.tool_cache}/node/24.15.0`，包含 `x64/` 和 `x64.complete`。`setup-node` 在工具缓存里找到精确版本后直接使用，不再下载。
- 依赖缓存键为 `hashFiles('pnpm-lock.yaml')` 加上 `jq -S 'del(.version)' package.json` 的哈希。只改版本号不会换键；依赖、脚本、`packageManager`、pnpm 字段的任何改动仍会换键，命中时跳过 `pnpm install` 的前提不变。
- 先把清单哈希赋给变量再写入输出，这样 jq 失败时步骤在 `pipefail` 下直接失败，不会让键退化成空输入的哈希。

## 实测

[冷缓存](https://github.com/hxx344/trading-platform/actions/runs/44392660146)、[热缓存一](https://github.com/hxx344/trading-platform/actions/runs/44393061154)、[热缓存二](https://github.com/hxx344/trading-platform/actions/runs/44393478816)均通过。热缓存时日志出现 `Found in cache @ /opt/hostedtoolcache/node/24.15.0/x64` 和 node_modules 缓存命中，setup 步骤降到 3–6 秒。

同时试过用 `durations` 任务的新实测表替换 `scripts/test-durations.json`，最终未采用。新表在逐文件独立测量下 6 片完全均衡，但两次 CI 实测里 6 片合计耗时为 121 秒和 114 秒，最慢一片 23 秒和 26 秒。旧表五次运行的合计为 92–100 秒，最慢一片 20–22 秒。逐文件独立测出的耗时与文件在分片内并发运行的表现不一致，原表暂时保留。

## 独立审查

只读审查未发现 P0 或 P1。

- P2（已修复）：jq 失败时，命令替换不会让 `echo` 失败，缓存键会悄悄退化成只看 lockfile。现已改为先赋值再输出。
- P3（登记）：缓存解包中途失败，而 `x64.complete` 已解出时，`setup-node` 会把不完整的目录当成已安装。这种情况下后续的 node 或 tsc 会直接报错，不会静默产生错误结果。
- P3（登记，改动前已有）：键不包含 `.npmrc` 和 `pnpm-workspace.yaml`。仓库目前没有这两个文件，以后新增时应把它们加入 `hashFiles`。

已核实的内容：

- `setup-node` 工具缓存的目录约定。
- 调用本 action 的任务都先 checkout，且运行在带 jq 的 ubuntu-24.04 上。
- `platform-plan` 的路径过滤已包含 `.github/actions/setup`。
- 多个任务并发保存同一个键或缓存被逐出时，只会产生警告，任务不会失败。

## 未运行

本地没有跑代码测试，因为改动只涉及 CI 配置。主线发布提交能否命中缓存，要等本次推送后实测。
