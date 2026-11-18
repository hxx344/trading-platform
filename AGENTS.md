# 协作规则

本文件是 trading-platform 面向所有编码代理的入口。用户当次指令优先于本文件。

主任务和各子代理的模型、推理档位默认随运行配置。用户当次另有指定时按其要求执行。

## 开发前必读

| 改动涉及 | 先读 |
| --- | --- |
| 任何页面（新模块页面、已有页面改版） | [docs/frontend.md](docs/frontend.md)《页面开发规则》 |
| 新模块接入、范围与决策 | [docs/plan.md](docs/plan.md) |
| 执行器、划转、ADL 语义 | [docs/executor.md](docs/executor.md) |
| 原油双腿 | [docs/oil.md](docs/oil.md) |
| 海力士双腿交易 | [docs/hynix.md](docs/hynix.md) |
| Gate CrossEx 跨所交易 | [docs/crossex.md](docs/crossex.md) |
| 期权 Greeks | [docs/options.md](docs/options.md) |
| Ondo 挂单奖励（挂单引擎、奖励市场盘口与收益模拟） | [docs/ondo.md](docs/ondo.md) |
| 行情监控（含海力士溢价监控与告警） | [docs/monitor.md](docs/monitor.md) |
| 资产账本 | [docs/asset.md](docs/asset.md) |
| 页面在线更新（系统更新）、`trading-platform-update.*` 单元、`update-helper.ts` | [docs/update.md](docs/update.md) |
| 只读 MCP 接入、只读接口令牌 | [docs/mcp.md](docs/mcp.md) |
| 副服务器巡检（main-watch）、心跳推送、`install-watch.sh` | [docs/watch.md](docs/watch.md) |
| 真实账户上已核实与待实测的事项 | [docs/live-results.md](docs/live-results.md)、[docs/plan.md](docs/plan.md) 第 6 节 |
| 新模块的启用与数据迁移（一律做进设置页「从工作台导入」面板及其命令行，不要求用户手改 `config.json`） | [docs/module-import.md](docs/module-import.md) |

新模块的页面和后端一样按文档开发：先在文档里写清范围、对照的工作台页面与回滚版本，再动手；做完把实际做法回填到对应文档。

## 检查

- 类型检查：`pnpm check`；测试：`pnpm test`；页面构建：`pnpm build:web`。
- 测试文件列表在 `scripts/test.ts`，新增测试目录改那里。CI 用 `TEST_SHARD=i/n` 按 `scripts/test-durations.json` 里的耗时均衡分片；分片明显不均时手动运行 ci 工作流（`gh workflow run ci.yml --ref <分支>`），用 `durations` 任务产物里的 `test-durations.json` 替换这个文件；本机负载高时测出的比例不可靠。
- 安装测试：`bash deploy/test-install.sh`，先 `pnpm build:web`。CI 分三部分并行（参数 1 安装升级、2 从工作台导入、3 巡检心跳），新检查放进对应的 `if part_is N` 块，不依赖别的部分留下的状态。改安装脚本时，手动运行 `ci.yml` 并选 `install_full=true` 可在 Ubuntu 上按完整顺序验证心跳、密码叠加在导入后的配置。涉及组件激活时，`platform-systemd` 在一次性 runner 上用真实服务验证迁移、独立升级和回退。
- 真实 systemd 验收按迁移与导入、行情与控制、执行与端口、新旧拓扑、部署记录修复五组并行。每组使用独立 Ubuntu runner，组内按原顺序验证。主线推送可复用同仓库、同一提交在相同 Ubuntu 发行版、CPU 架构和 systemd 软件包版本上已通过的手动验收，`platform-plan` 摘要链接到原运行。缺少任一组的成功步骤就重新跑五组。手动运行始终实际执行。无参数的 `deploy/test-platform-systemd.sh` 仍可在一次性 runner 上按完整顺序运行。
- 发布工作流（推送 `v*.*.*` 标签）只打包发布，`scripts/wait-ci.ts` 优先等待该提交最新的 main CI。原子推送后先给主线运行留出登记时间。主线失败时重跑失败的任务，或在失败后新建该提交的手动 CI。标签指向一次推送中较早的提交、没有对应主线运行时，执行 `gh workflow run ci.yml --ref <标签>` 补验。验收通过后可重跑发布运行里的失败任务。合并请求的结果不计入发布门禁。
- 改页面时按 [docs/frontend.md](docs/frontend.md)《页面开发规则》第 7 条在浏览器里验证。

## 合并前审查

定级、严重级别、审查维度、自审清单、独立审查、合并门槛、审查记录、提交信息格式与流程都在 [docs/code-review.md](docs/code-review.md)。

- 动手前按该文件第 2 节定级 R1/R2/R3；R3（资金、凭据与鉴权、部署激活、数据库结构、唯一写者边界）先写清影响面与回滚再改代码。
- 合入与发布不开合并请求：改动提交与改版本号的发布提交在本地备齐，本地检查与独立审查通过后，用 `git push --atomic origin HEAD:main v<版本>` 一次推送 main 与标签。这样 main 上只跑一次 ci，发布等的就是这一次；分开推送或走合并请求会让同样的代码多跑几次。ci 没通过时不会发布：偶发失败就重跑 ci 再重跑发布运行里失败的任务，代码有问题就在 main 上修复后用新版本号重新发布。只合入不发布时同样直接推 main。

### 按改动取用经验

改动前只读 [LESSONS.md](LESSONS.md) 里相关的条目，并核对当前源码。

| 改动涉及 | 条目 |
| --- | --- |
| 下单、平仓、对冲、划转、ADL、执行状态机 | L039 L054 L084 L091 L092 L093 L095 L100 L110 |
| 调度、轮询、恢复、页面读写竞争 | L049 L089 L091 L202 |
| 撤单、改挂和订单链路延时统计 | L203 |
| 行情、盘口新鲜度、价差保护 | L100 |
| 外部接口的历史读取与分页、“查无”判定 | L039 L093 |
| 从工作台导入、读别的进程的 SQLite、备份 | L063 |
| root 运行的安装脚本与助手、服务可写的交接目录 | L201 |
| 跨进程转发交易写入、更新后核对在途请求 | L204 |
| 同账户的规则持仓、手动调平与执行任务交接 | L205 |

审查中确认的缺陷值得复用时，按 LESSONS.md 的《记录规则》新增或更新条目，并登记到上表。
