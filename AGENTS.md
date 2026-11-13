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
- 每个批次的审查记录放在 `docs/reviews/`。
