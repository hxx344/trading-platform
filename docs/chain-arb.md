# 链上折价套利

## 首版范围

在「链上」工作区按指定币种和 USDT 预算比较两条路线。链上用 KyberSwap 的指定金额买入报价，首批覆盖 Ethereum、Arbitrum One 和 BNB Smart Chain。交易所先接 Gate 的 USDT 现货和 USDT 线性永续。币种由链和 ERC-20 合约地址确定，交易所代码仅用于查目录。沿用行情监控的配置、设置页导入和命令行启用入口，不新增账户、密钥、配置迁移或常驻采集。

- 现货路线按预计到账数量逐档吃买盘，核对所选链的币种身份、充值状态与交易状态。结果是当前盘口下的估算，到账前价格可能变化。
- 永续路线按可覆盖的数量比较链上买入均价和开空均价，列出开仓基差。基差收敛情景单独列示，手续费、链上开销、资金费与离场成本须有明确口径。
- 同名异币、报价过期、盘口不足、上游不可用时展示具体原因。页面按需订阅单个币，离开后停止刷新。服务端只请求固定公开行情接口。
- R2，只读测算。回退版本 v0.95.0。工作台 7745181 的 `modules/monitor/app/perpetual-panel.tsx` 和 `server/perpetual-spot-transfer.mjs` 提供行情与链身份显示参考。工作台没有对应的链上买入页面。沿用现有页面组件与样式，使用两张独立结果卡，在手机上按现货、永续顺序阅读。

## 使用与测算

通过设置页「从工作台导入」启用行情监控，或运行 `sudo bash install.sh --import-workbench --monitor`。已有合约价差监控的服务升级后可直接打开「链上 → 链上折价套利」。关闭合约价差监控后查询暂停。首版不存查询历史。

填写链、ERC-20 合约地址、Gate 币种代码与买入预算。示例为 Arbitrum One 的 ARB。计价统一按 USDT，比价以链上的 USDT 和交易所 USDT 等值为前提。Ethereum 使用 USDT，Arbitrum One 使用 USDT0，BNB Smart Chain 使用 Binance-Peg USDT。买入均价为实际输入金额除以 KyberSwap 路由预计输出的代币数量；每次获取目标合约的 decimals，以链上最小单位换算。

Gate 先以代码查资产目录，再按链和地址核对身份。以公开买盘逐档计算足额卖出或开空的均价，展示可覆盖数量与剩余零头。现货须能按该网络充值；提现状态单列。代币转账税、到账数量、账户最低充值额与个人费率需要按交易所和代币实际规则核对。对不能按面额全额到账的代币，当前现货测算不适用。

现货预估差额按可卖数量分摊链上成本，然后扣卖出手续费及输入的路线其他成本（Gas、发送代币等）。永续按整张合约向下取整，开仓基差为开空均价除以链上买入均价减一。收敛情景假设对应数量的现货和永续按同一价格退出，按开仓名义金额估算两次永续手续费，再扣输入的其他成本（Gas、现货离场等）。资金费与未覆盖的尾差单独留给操作者评估。两条路线其他成本留空时，页面只显示毛差额。费率单位为 bp，1 bp = 0.01%。

安装版由行情进程访问固定的 KyberSwap 路由、链 RPC 的只读 eth_call 和 Gate 的公开目录、盘口，经本机 IPC 返回执行服务。页面每 10 秒查询；服务端按报价源时间和盘口最后变更时间检查，任一有效路线最早的数据满 15 秒后，该快照撤下。同一读者最多同时处理四个查询。没有私钥、签名、订单、提币指令或数据库迁移。

代币数量从最小单位开始计算，到每条路线按交易步长向下取整后再格式化。现货卖单的最低价格按 Gate 买一价与允许滑点计算。永续空单还受实时标记价偏离限制，两条下限取较高者。任一市场在允许范围内的盘口不足时，该路线显示原因。[Gate 现货市价单示例](https://www.gate.com/announcements/article/48909) · [Gate 永续限价规则](https://www.gate.com/help/futures/futures-logic/22083/contract-order-price-limit)

公开接口参考：[KyberSwap EVM 报价](https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps)、[Gate 现货](https://www.gate.com/docs/developers/apiv4/en/spot/)、[Gate 永续](https://www.gate.com/docs/developers/apiv4/en/futures/)。
