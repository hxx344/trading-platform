# 协作规则

本文件是 trading-platform 面向所有编码代理的入口。用户当次指令优先于本文件。

## 开发前必读

| 改动涉及 | 先读 |
| --- | --- |
| 任何页面（新模块页面、已有页面改版） | [docs/frontend.md](docs/frontend.md)《页面开发规则》：React + Vite，照工作台同功能页面排版，样式从工作台复制并注明来源提交 |
| 新模块接入、范围与决策 | [docs/plan.md](docs/plan.md) |
| 执行器、划转、ADL 语义 | [docs/executor.md](docs/executor.md) |
| 原油双腿 | [docs/oil.md](docs/oil.md) |
| 期权 Greeks | [docs/options.md](docs/options.md) |
| 行情监控 | [docs/monitor.md](docs/monitor.md) |
| 资产账本 | [docs/asset.md](docs/asset.md) |
| 真实账户上已核实与待实测的事项 | [docs/live-results.md](docs/live-results.md)、[docs/plan.md](docs/plan.md) 第 6 节 |
| 新模块的启用与数据迁移、从工作台导入 | [docs/module-import.md](docs/module-import.md) |

新模块的页面和后端一样按文档开发：先在文档里写清范围、对照的工作台页面与回滚版本，再动手；做完把实际做法回填到对应文档。

新增模块的启用与数据迁移一律做进设置页「从工作台导入」面板及其命令行（`install.sh --import-workbench` 的对应参数），不要求用户手改 `config.json`；手写配置与单独的迁移命令只作备选。做法照 [docs/module-import.md](docs/module-import.md)。

## 检查

- 类型检查：`pnpm check`；测试：`pnpm test`；页面构建：`pnpm build:web`。
- 改页面时在替身后端上用浏览器走一遍，截 1280 和 390 宽度与工作台同页面对比。

## 合并前审查

定级、严重级别、审查维度、自审清单、提交信息格式与流程都在 [docs/code-review.md](docs/code-review.md)。

- 动手前按该文件第 2 节定级 R1/R2/R3；R3（资金、凭据与鉴权、部署激活、数据库结构、唯一写者边界）先写清影响面与回滚再改代码。
- P0/P1 清零才可合并，P2 修复或登记；R2 以上要有独立只读审查，审查者与作者的上下文隔离，作者不能是唯一审查者。
- 「已运行」只写真实执行过的命令与结果，没运行的写明原因。
- 每个批次的审查记录放在 `docs/reviews/`。

### 按改动取用经验

改动前只读 [LESSONS.md](LESSONS.md) 里相关的条目，并核对当前源码。

| 改动涉及 | 条目 |
| --- | --- |
| 下单、平仓、对冲、划转、ADL、执行状态机 | L039 L054 L084 L091 L092 L093 L095 L100 L110 |
| 调度、轮询、恢复、页面读写竞争 | L049 L089 L091 |
| 行情、盘口新鲜度、价差保护 | L100 |
| 外部接口的历史读取与分页、“查无”判定 | L039 L093 |
| 从工作台导入、读别的进程的 SQLite、备份 | L063 |

审查中确认的缺陷值得复用时，按 LESSONS.md 的《记录规则》新增或更新条目，并登记到上表。
