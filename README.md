# trading-platform

统一交易平台。第一阶段只做 ASTER 配对的两项核心功能：

- 保证金平衡划转：同一主账户下两个子账户之间按可用余额差额划转 USD1。
- ADL 应急处理：发现自动减仓后，对两账户合计多出的一侧分批下只减仓市价单，直到两边重新对冲。

方案、决策与进度见 [docs/plan.md](docs/plan.md)；执行器的状态机语义、回滚与已知限制见 [docs/executor.md](docs/executor.md)。

## 开发

需要 Node 24.15+ 与 pnpm。

```bash
pnpm install
pnpm check   # 类型检查
pnpm test    # 全部离线测试，不连任何交易所
```

本地模拟运行（只用模拟交易所）：`node src/main.ts --data-dir ./.data --port 4711`，浏览器打开 `http://127.0.0.1:4711`。

## 来源

执行器代码迁自 project-aggregation `platform/executor`（提交 `62b6067`），ASTER 签名与划转探测迁自其 `server/contract-probes`。工作台只作历史参考，本仓库不回写工作台数据。
