# trading-platform

统一交易平台。第一个模块是 ASTER 配对的两项核心功能：

- 保证金平衡划转：同一主账户下两个子账户之间按可用余额差额划转 USD1。
- ADL 应急处理：发现自动减仓后，两账户合计多空偏差超过较大一侧的 0.5% 时，对多出的一侧分批下只减仓市价单，直到两边相等；偏差在 0.5% 内不减仓。

第二个模块“原油双腿”（Binance/Bybit 的 BZUSDT、CLUSDT，同所或跨所两腿）自 v0.8.0 起可用（2026-11-13、11-14 已在真实账户上开仓、平仓各两笔，见 [docs/live-results.md](docs/live-results.md)），方案与进度见 [docs/oil.md](docs/oil.md)；`config.json` 里没有 `oil` 时服务仍只服务 ASTER，行为与之前相同。

第三个模块“期权 Greeks”（Bybit BTC 期权铁鹰 / 卖出宽跨：手动开平仓、周五定时开仓、收益页、组合询价）自 v0.11.0 起可用，方案与进度见 [docs/options.md](docs/options.md)；只在 `config.json` 有 `options` 时启用，启用在设置页「从工作台导入」里完成（见下文部署一节）。

第四个模块“行情监控”（工作台 Monitor 分批接入，方案与进度见 [docs/monitor.md](docs/monitor.md)）第一批是 Anthropic 价差：Binance、Hyperliquid（xyz:ANT、io:ANTH）、Lighter RH 的报价与 15 分钟 K 线，按每股口径算溢价，只读公开行情，不需要密钥。在设置页「从工作台导入」里勾选「启用行情监控」即可启用（命令行 `sudo bash install.sh --import-workbench --monitor`，见下文部署一节），写入的是 `"monitor": { "anthropic": {} }`；也可以手写这一段（可加 `"shares": { "outstanding": 12.7, "diluted": 16.7 }`，十亿股，不写用这两个默认值，须满足 1 ≤ 流通 ≤ 完全稀释 ≤ 100）；只配 `monitor` 时 `pairs` 可以省略。第二批起加了原油价差（Binance BZUSDT / CLUSDT 标记价与 15 分钟 K 线，布伦特 − WTI，USDT / 桶），配置写 `"oil": {}`，导入时随「启用行情监控」一起写入，已启用的配置会补上缺的市场。没有 `monitor` 时不采集、不显示页面，行为与之前相同。启用后服务器会定时访问 Binance、Hyperliquid、Lighter RH 的公开行情接口（`deploy/config.example.json` 带了这一项，安装脚本生成的配置不带）；服务器所在地区被某家交易所限制时，那一家读不到，页面显示为快照或暂无数据，其余功能不受影响。

第五个模块“资产账本”（工作台 Asset）分批接入：第一批（v0.12.0）是从工作台导入的账本、资产走势、日变化归因、出金与资金流的只读展示，第二批（v0.16.0）可在页面编辑手动资产、修改汇率、登记出金与资金流，第三批（v0.19.0）连接交易所并在页面打开时每 60 秒同步余额、行情与人民币汇率（凭据加密保存在数据目录）。方案与进度见 [docs/asset.md](docs/asset.md)；只在 `config.json` 有 `asset` 时启用，启用与导入账本都在设置页「从工作台导入」里完成（见下文部署一节）。

新增模块的启用与数据迁移一律做进「从工作台导入」面板及其命令行，不要求手改 `config.json`，见 [docs/module-import.md](docs/module-import.md)。

方案、决策与进度见 [docs/plan.md](docs/plan.md)；执行器的状态机语义、回滚与已知限制见 [docs/executor.md](docs/executor.md)。

## 开发

需要 Node 24.15+ 与 pnpm。

```bash
pnpm install
pnpm check       # 类型检查（服务端与页面）
pnpm build:web   # 构建服务页面到 web/dist（发布包与服务启动都需要）
pnpm test        # 全部离线测试，不连任何交易所
```

页面开发：服务照常运行（默认 http://127.0.0.1:4720），另开 `pnpm dev:web`，打开 http://127.0.0.1:5173 先登录，`/api` 由开发服务器转发（目标用 `TP_DEV_TARGET` 改）。页面源码在 `web/src`，所有模块的页面都按 [docs/frontend.md](docs/frontend.md)《页面开发规则》开发（照工作台同功能页面排版、复制工作台样式）。

本地模拟运行（只用模拟交易所）：`node src/main.ts --data-dir ./.data --port 4711`，浏览器打开 `http://127.0.0.1:4711`。

本地看资产页（假数据，不读真实账本）：`pnpm build:web` 后执行 `node scripts/asset-demo.ts --data-dir <空目录的绝对路径> --port 4730`，用数据目录 `access-url` 里的链接登录，打开 `http://127.0.0.1:4730/#/asset`。

## 部署（Linux 服务器，root）

```bash
curl -fsSLO https://github.com/hxx344/trading-platform/releases/latest/download/install.sh && sudo bash install.sh
```

- **首次执行即启动服务**（配置里还没有配对），然后在页面上导入：打开本机页面（见下），在「设置」页的「从工作台导入配对」里点「读取工作台」，页面列出工作台每个配对能否导入及原因；勾选后点「导入所选并重启服务」，约半分钟后新配对以停用状态出现在列表里。导入由安装脚本装好的 root 导入助手（`trading-platform-import.path` / `.service`）完成：只读工作台数据，写好 `config.json`、`secrets.json`，以服务账户校验后重启服务，启动失败时恢复导入前的配置。之后每个配对：在工作台删除该配对 → 页面点「启用」。
- 命令行方式仍可用：`sudo bash install.sh --import-workbench`（从工作台导入已开启保证金平衡的配对、三个账户的凭据、ADL 设置和飞书机器人，写好 `config.json`、`secrets.json` 并启动。只读工作台数据，不改动工作台。导入的配对登记为停用；在工作台删除该配对后，到本项目页面点「启用」。只导入部分配对时加 `--pairs id1,id2`；工作台数据目录不在 `/var/lib/project-aggregation` 时加 `--workbench-data <目录>`。已有配置时只追加新配对，重复执行不改动。
- 原油执行账户（Binance/Bybit，见 [docs/oil.md](docs/oil.md)）：页面「从工作台导入」的预览同时列出工作台的原油执行账户（交易所、账户模式、打码账户、能否导入及原因），勾选「导入原油执行账户」后随导入一起写入；命令行为 `sudo bash install.sh --import-workbench --oil`（只导入原油账户；同时导入配对再加 `--pairs`）。工作台里有实盘启用的原油自动规则、执行中或待核对的原油规则，或该交易所还有未结束的执行任务时，拒绝导入该交易所账户，须先在工作台停用规则并让任务完成或停止；已配置的交易所不覆盖。原油与海力士下单不设名义金额上限（v0.50.0 起），导入不写 `oil.notionalLimits`，已有的这一项不再生效。导入后页面出现「原油」标签。
- 行情监控与资产账本（见 [docs/module-import.md](docs/module-import.md)）：
  - 页面「从工作台导入」的预览同时列出行情监控（本项目是否已启用、股数取默认值）与资产账本（工作台 `<工作台数据目录>/modules/asset/ledger.sqlite` 里每个用户的资产与快照条数、能否导入及原因，以及本项目上次导入），勾选「启用行情监控」「导入资产账本」（多个用户时选一个）后随导入一起写入，只勾这两项也可以。
  - 命令行为 `sudo bash install.sh --import-workbench --monitor --asset [--asset-owner <用户>]`（两项可分开用，也可与 `--oil`、`--options`、`--pairs` 同用；账本有多个用户时须加 `--asset-owner`）。
  - 行情监控写入默认股数（流通 12.7、完全稀释 16.7 十亿股；工作台的股数设置只存在浏览器里，带不过来），已启用时保留现有设置。
  - 资产账本先写入数据目录的 `asset.sqlite`（以服务账户身份写入，600），再写配置并重启；账本写入失败时什么都不改；配置检查或启动失败时恢复导入前的配置，已写入的账本保留，重新勾选导入即可。
  - 已启用 `asset` 时再导入只整体替换账本、不重启服务，页面下次读取就是新数据。
  - 账本行不带凭据、钱包地址与密钥尾号；工作台保存的交易所连接（v0.19.0 起）由以工作台库属主身份运行的子进程用工作台资产模块 `config.json` 的 `credentialKey` 解开，经管道直接交给写入子进程，用本服务的密钥（数据目录 `asset-credential.key`）重新加密，与账本在同一事务写入；预览与结果只列连接名，工作台密钥缺失或解不开时只导入账本并写明原因（规则见 [docs/asset.md](docs/asset.md) A-3/A-4）。重新导入会整体替换账本与已保存的连接，页面上做过的修改一并被覆盖。
  - 备选：手写 `config.json` 的 `monitor` / `asset` 段后执行 `sudo bash install.sh`，账本用 `sudo -u trading-platform node /opt/trading-platform/current/src/asset/import.ts --from <工作台数据目录>/modules/asset/ledger.sqlite --owner <工作台用户名> --data-dir /var/lib/trading-platform` 单独导入（`trading-platform` 账户须能读到工作台的库）。
- 期权账户（工作台期权模块 Greeks 的 Bybit 密钥与风险上限，见 [docs/options.md](docs/options.md)）：页面「从工作台导入」的预览同时列出工作台期权账户（打码 UID、能否导入及原因），勾选「导入期权账户」后随导入一起写入；命令行为 `sudo bash install.sh --import-workbench --options`（可与 `--oil`、`--pairs` 同用）。工作台开着自动开仓（`AUTO_OPEN`）、不是实盘主网、还有未结束的订单 / 执行任务 / RFQ，或还在跟踪一组策略时拒绝导入；导入时用密钥读一次 Bybit 账户 UID 并检查权限、绑定 IP 与统一账户。已配置 `options` 时不覆盖。导入后页面出现「期权」标签，导入写入的配置里定时开仓为关闭（要用时在期权页打开；数据目录里留有以前的 `options.sqlite`、且当时在页面打开过定时开仓时，沿用页面上的开关，导入后先在期权页确认），工作台期权模块此后不能再用这个账户下期权单。
- 首次执行放好程序（`/opt/trading-platform`）、系统账号 `trading-platform`、数据目录 `/var/lib/trading-platform`、导入交接目录 `/var/lib/trading-platform-import`、示例配置和不含配对的空配置，并启动 systemd 服务 `trading-platform`。也可以按 `/etc/trading-platform/config.example.json` 与 `secrets.example.json` 手写配置后再执行一次。
- 以后每次执行都是增量升级。脚本先只下载校验清单，程序、Node.js、单元和配置都没变就直接结束。有变化时先用新程序校验配置，不通过就保持原版本。重启后 90 秒内没有正常监听就自动回退到上一版本（自动回退到 v0.7.0 之前的版本同样会用 `config.json` 的 `transfer` 覆盖页面改过的参数，见下）。改了配置也是再执行一次让它生效（配对的 `transfer` 与 `adl` 除外，见下）。
- 页面在线更新（v0.51.0 起）：侧栏「系统」组的「系统更新」查看最新正式版，确认后由服务器上的 root 更新助手执行一次 `install.sh --version <新版本>`（校验、重启、失败回退照旧）。从 v0.50.0 及更早版本升级时要先在服务器上手工执行一次上面的一键部署命令，页面才会从“待启用”变为可用。只能升级、不能在页面降级。详见 [docs/update.md](docs/update.md)。
- 指定或回退版本：`sudo bash install.sh --version v0.1.0`。服务器访问不了 GitHub 时，在别处下载 Release 的三个文件放进同一目录，然后执行 `sudo bash install.sh --package <目录>`。回退前先看下文《回退到旧版本》。
- 打开页面：
  - **Tailscale（推荐）**：在 `/etc/trading-platform/config.json` 加一行 `"host": "<服务器的 Tailscale IP>"`（`tailscale ip -4` 查看，只能填本机的具体 IP，不能填 `0.0.0.0`），再执行一次 `sudo bash install.sh`，之后直接打开 `http://<Tailscale IP>:4720/`。该地址绑不上时（开机 Tailscale 还没连上、节点已登出）服务照常运行，持续重试，间隔最长 30 秒；配置检查会提示地址不在本机网卡上。
  - **SSH 隧道**：服务总在 `127.0.0.1:4720` 监听，写不写 `host` 都能用。在自己电脑上执行 `ssh -N -L 4720:127.0.0.1:4720 <服务器>` 后打开 `http://127.0.0.1:4720/`。
  - **登录**：`sudo bash install.sh --set-password` 设置登录密码（输入两次、不回显，只保存 scrypt 摘要到 `/etc/trading-platform/login-password`；沿用当前已装版本，不联网升级；脚本化时加 `--password-stdin` 从标准输入读一行；更换密码同样执行，已登录的浏览器须重新登录），之后页面输入密码即可。连续输错 5 次后锁定 30 秒，每再错一次锁定时间加倍，最长 15 分钟；一小时没有输错就重新计数。`sudo cat /var/lib/trading-platform/access-url` 里的登录链接始终可用（也会解除锁定）；删除 `login-password` 再执行一次安装脚本即取消密码。登录状态保留 30 天，服务重启（升级、页面导入）后不用重新登录。
  - 页面固定有四页，按配置另有模块页：
    - 「配对组」（配对开关、两侧余额与走势、持仓、ADL 处理、划转与 ADL 历史、结算依据）
    - 「运行状态」（后台循环、数据库、请求权重、推送连接、飞书发件箱与定时摘要；开了副服务器巡检心跳时多一栏送达情况）
    - 「日志」（服务日志，与 `journalctl -u trading-platform` 相同，可只看告警与问题；数据目录 `logs.sqlite` 保留 14 天、最多 5 万行，删掉只丢页面上的日志）
    - 「设置」（每个配对的划转参数与 ADL 设置、从工作台导入）
    - 配置了原油执行账户时还多一个「海力士」页（SK 海力士 ADR 与正股的溢价与盘口、持仓、下单预览与实盘确认、任务；同所两腿名义平衡：净敞口读数、可在页面修改的调平线 / 硬上限 / 最小差额、飞书告警与一键单腿调平，阈值存在数据目录的 `hynix.sqlite`；与原油共用执行账户和执行器，见 [docs/hynix.md](docs/hynix.md)）
    - 配置了原油执行账户时多一个「原油」页（价差与盘口、持仓、下单预览与实盘确认、任务与人工处理、自动开平仓，以及原油总盈亏：每分钟记录持仓浮盈亏、每 5 分钟同步资金费 / 平仓盈亏 / 手续费账单，存在数据目录的 `oil-pnl.sqlite`，这个文件打不开时只是不显示盈亏，其余照常）
    - 配置了 `options` 时多一个「期权」页（执行台、持仓、组合执行、收益、组合询价，见 [docs/options.md](docs/options.md)）
    - 配置了 `monitor` 时多一个「行情监控」页（Anthropic 价差：对比合约切换、当前溢价与两边每股价、溢价率 / 每股价差 / 每股价格走势、近期观察、换算说明；配置了原油时多一个「原油」标签：当前价差与两腿标记价、价差 / 价格对比走势、近期观察；原油与海力士的图表下方有交易所实时对比表，列出各交易所同所两腿的价差与资金费年化，只在页面打开时按需读取各交易所公开行情，结果 5 秒内共用；对比表下方是多空价差资金费：原油 Binance 4 小时、海力士 Hyperliquid 每小时的已结算资金费，后台每 5 分钟回补一次，存进 `monitor.sqlite`，按区间显示累计资金费与累计年化；点对比表某一家的年化可展开这一家两腿最近 60 天的实际结算（按需读取交易所公开历史，5 分钟内共用，不入库）；三个市场的价差走势图都有 7 日均线、20 日布林带与 Z-score，可按市场开关）。行情由服务后台采集（报价每 10 秒、K 线每 60 秒），K 线历史在数据目录的 `monitor.sqlite`（最多保留 400 天；删掉只丢历史，重启后从交易所回补最近约 50 天），这个文件打不开时只是不显示行情监控页，其余功能照常。
    - 配置了 `asset` 时多一个「资产」页（资产总览、历史记录、出金记录；交易所连接；可编辑手动资产、修改汇率、登记出金与资金流；页面打开时每 60 秒同步交易所余额、行情与汇率，服务端不定时同步）。
  - 划转参数与 ADL 设置保存在数据库里，`config.json` 里的 `transfer` 与 `adl` 只在配对第一次登记时作为初始值，之后以页面为准（两边不一致时启动日志会列出页面当前值）；改短检查间隔使空闲请求权重超出「每分钟上限减 ADL 预留」时会被拒绝，并给出能用的最短间隔。
  - 余额走势来自数据目录里的 `samples.sqlite`（每分钟一条，保留 30 天；删掉只丢走势图）。
- 需要代理时写 `/etc/trading-platform/environment`，例如 `NODE_USE_ENV_PROXY=1` 与 `HTTPS_PROXY=…`。
- 合约价差的质量依据（可选）：CoinGecko 演示键 `COINGECKO_DEMO_API_KEY=…`、币种到 CoinGecko id 的覆盖 `PERPETUAL_COIN_IDS={"XXX":"coin-id"}` 也写在这个文件里，改后 `sudo systemctl restart trading-platform`；不设时走公开限额与自动匹配。
- 只校验配置、不启动（`node` 用 `systemctl cat trading-platform` 里 ExecStart 的那个）：`sudo -u trading-platform node /opt/trading-platform/current/src/service/main.ts --config /etc/trading-platform/config.json --check-config`。
- 日志：页面「日志」，或 `journalctl -u trading-platform -f`。
- 外部巡检（v0.46.0 起）：`GET /api/ready` 不用登录，服务就绪时返回 200 `{"ready":true}`，否则返回 503 `{"ready":false}`，不带其他内容。
  - 就绪的条件：服务没在停止、持有写入租约，并且「运行状态」页列出的每个循环最近 3 分钟内都完成过一轮。这些循环是划转、ADL、持仓读取，以及历史清理（配了原油执行账户时换成两腿任务循环）。刚启动、还有循环没完成第一轮时是 503。原油规则、期权、行情监控、资产、飞书发件、用户推送等其他后台循环不参与判定。
  - 它判断的是进程在运行、持有租约、这些循环没卡住，**发现不了交易所连不上**：划转、ADL、持仓读取单轮里的交易所报错都记在各自的状态与事件里，这一轮仍算完成，接口照样是 200；这类故障由服务自己的飞书告警和页面提示处理。例外是配了原油、有未结束的两腿任务且交易所持续超时的时候，两腿任务循环一轮可能超过 3 分钟，接口会暂时变成 503。
  - 只支持 GET（HEAD、OPTIONS 等方法照旧要登录，返回 401）。接口只在服务监听的地址上可达（`127.0.0.1` 与 `config.json` 的 `host`），Host 头检查照旧（须是本机回环地址或 `config.json` 的 `host`），不需要也不应该为它对公网开放端口。
  - 副服务器能直连本机（例如同在一个 Tailscale 网络）时，可以让副服务器的巡检直接探测 `http://<本机 Tailscale IP>:4720/api/ready`（`install-watch.sh --main <本机 Tailscale IP>:4720`）。连不到时用下一条的心跳。
- 副服务器巡检心跳（v0.47.0 起，见 [docs/watch.md](docs/watch.md)）：本服务每 30 秒向副服务器推送一次签名心跳，带上是否就绪；副服务器 90 秒收不到或收到“未就绪”算一次失败，连续 3 次（约 3～5 分钟）发飞书告警。主服务器只有出站连接，不用开端口，也不用另装程序。
  - 副服务器：`curl -fsSLO https://github.com/hxx344/trading-platform/releases/latest/download/install-watch.sh && sudo bash install-watch.sh --heartbeat-listen 0.0.0.0:8792 --webhook <飞书机器人地址> --name 统一交易平台`，安全组放行 TCP 8792、来源只填本机公网 IP。已部署过（含工作台版本的 main-watch）时不带参数执行即升级，配置保留。
  - 本机：执行副服务器脚本结束时打印的命令 `sudo bash install.sh --watch-url http://<副服务器 IP>:8792/heartbeat --watch-token <令牌>`。本机装过工作台推送端的，用 `sudo bash install.sh --watch-import` 直接沿用它的地址与令牌，并停用它（之后副服务器只收到本服务的就绪情况，工作台不再上报）。关闭用 `sudo bash install.sh --watch-off`。这几个开关沿用当前已装版本，不联网升级。
  - 核对：页面「运行状态」→「副服务器巡检心跳」；副服务器上 `sudo main-watch probe`。
- 飞书定时运行摘要（照工作台的「ASTER 运行摘要」卡片）：默认每 60 分钟一张，服务首次启动约 2 分钟后发第一张；重启沿用下次发送时间，停机错过的周期只补发一张（启动约 2 分钟后，等持仓与余额读到再发），不逐期补发。发往 `secrets.json` 的 `feishuScheduled` 机器人（格式同 `feishu`：`{"webhook": "…", "secret": "…"}`；页面导入新配对时从工作台的 `FEISHU_SCHEDULED_WEBHOOK_URL` / `FEISHU_SCHEDULED_SIGN_SECRET` 带过来），没有时发往告警机器人 `feishu`。间隔在页面「设置」→「飞书定时运行摘要」修改（1–1440 分钟，0 关闭，保存后以页面为准、重启保留），那里也能「立即发送一张」；没在页面改过时用 `config.json` 的 `"summary": {"intervalMinutes": 30}`（改完执行一次 `sudo bash install.sh`）。换了机器人（例如补上 `feishuScheduled`）后，重启约 2 分钟会先发一张到新机器人。只有原油、没有配对时不发。

配对接管与回退步骤见 [docs/plan.md](docs/plan.md) 第 4 节。

## 回退到旧版本

`sudo bash install.sh --version <版本>`。回退前按下表处理：目标版本早于表中某一行的版本时，那一行就要做；跨过多个版本时，涉及的每一行都要做。旧版本不认识的配置字段会让配置检查失败，安装脚本因此也不会自动回退。

| 回退到早于 | 回退前要做的事 | 说明 | 详见 |
| --- | --- | --- | --- |
| v0.55.0 | 先在原油页、海力士页把 OKX 腿的任务都处理到结束（待人工处理的先人工确认）、停用 OKX 规则，再从 `config.json` 的 `oil.accounts` 和密钥文件删掉 `okx` 项 | 旧版本见到 `okx`（配置或密钥文件）启动失败，整个服务不运行。删掉后：已结束的 OKX 任务不影响启动，主页与原油页照常读出；未结束的 OKX 任务不会让旧版本起不来，但旧版本没有 OKX 连接器，任务一直停在运行中，不撤 OKX 上的挂单、不核对成交与持仓（实测见详见一栏） | [docs/oil.md](docs/oil.md) 第 10.5 节 |
| v0.55.0 | 不用改配置 | 旧版本没有资产页「导入原表数据」；导入后的账本旧版本照常读取，数据目录的 `asset-backups/` 旧版本不读，留着即可 | [docs/asset.md](docs/asset.md) A-6 节 |
| v0.54.0 | 不用改配置 | 旧版本没有持仓页与行情监控的成交、关联交易面板；`asset.sqlite` 里新增的 `fill_cache` 只是缓存，旧版本不读，留着即可 | [docs/asset.md](docs/asset.md) A-5 节 |
| v0.53.0 | 不用改配置。先停用全部海力士规则与分批的原油规则，并处理掉它们的持仓与未结束任务 | 旧版本读不了海力士规则与分批规则（显示“规则参数无法读取”，不判断、不下单）；不分批的原油规则照常运行，但不再带阈值界限，只受基点价格保护界限约束 | [docs/hynix.md](docs/hynix.md) 第 8.3 节 |
| v0.52.1 | 不用改配置 | 旧版本每 30 分钟检查一次新版本，没有每分钟的发布页探测 | [docs/update.md](docs/update.md) 第 3 节 |
| v0.52.0 | 不用改配置。先在「海力士」页确认没有未结束或待人工处理的调平任务（待人工处理的要先人工确认），否则旧版本起不来。只有没做过调平任务时才能干净回退；做过之后建议升到修复版本而不是回退 | 旧版本按双腿读取任务，读到单腿的调平任务（含已完成的）会出错：有未结束或待人工处理的调平任务时旧版本启动失败，整个服务（含 ASTER 划转与 ADL）不运行；已结束的只要还在最近 20 个任务里，主页与海力士页的状态就读不出，直到被 20 个更新的任务挤出去。数据目录的 `hynix.sqlite`（平衡阈值）旧版本不读，留着即可 | [docs/hynix.md](docs/hynix.md) 第 7.5 节 |
| v0.51.0 | 不用改配置 | 旧版本没有页面在线更新；已装的 `trading-platform-update.path` 与 `.service` 留着无害（没人写更新请求就不会触发），要清掉见详见一栏 | [docs/update.md](docs/update.md) |
| v0.50.0 | `config.json` 的 `oil` 里没有 `notionalLimits` 的（v0.50.0 之后才首次导入原油账户），先补上 `"notionalLimits": { "perJob": "200", "openPer24h": "1000" }`；原来就有的不用改 | 旧版本要求这一项并恢复单笔与 24 小时开仓名义金额上限；回退后 24 小时内，之前确认的开仓也计入额度 | [docs/oil.md](docs/oil.md) 第 2 节 |
| v0.49.0 | 不用改配置。先在「海力士」页确认没有未结束或待人工处理的海力士任务 | 旧版本不认识海力士合约，无法推进、核对或释放这些任务；库结构未变 | [docs/hynix.md](docs/hynix.md) 第 4 节 |
| v0.48.0 | 不用改配置 | 旧版本里期权启动检查失败（Bybit 不通、密钥被拒、账户被占用、状态无法恢复）会让整个服务拒绝启动，ASTER 划转与 ADL 一起停；新版本只停期权并每 60 秒重试 | [docs/options.md](docs/options.md) 第 3 节 |
| v0.47.0 | 开了巡检心跳的先执行 `sudo bash install.sh --watch-off` | 旧版本不认识 `config.json` 与 `secrets.json` 的 `watch`，配置检查会失败；关闭后副服务器收不到心跳会告警，改用直连探测或卸载副服务器巡检 | [docs/watch.md](docs/watch.md) |
| v0.46.0 | 不用改配置。副服务器巡检（main-watch）指向了 `/api/ready` 的，先改回 `tcp://<地址>:4720`（设了登录密码时也可以用 `http://<地址>:4720/login`，没设密码时它返回 401） | 旧版本没有 `/api/ready`，不登录访问返回 401，巡检会持续告警 | 《部署》的外部巡检一条 |
| v0.36.0 | 从 `config.json` 删掉 `monitor.perpetual`（只配了合约价差时删掉整个 `monitor`） | 旧版本不认识 `perpetual`；`monitor.sqlite` 里的 `control.perpetual` 旧版本忽略 | [docs/monitor.md](docs/monitor.md) M-4a |
| v0.30.0 | 从 `secrets.json` 删掉 `feishuMonitor` | 旧版本按白名单读密钥；`monitor.sqlite` 里待应用的导入与“已导入”记录旧版本忽略；`notify-monitor.sqlite` 留在数据目录，其中未送达的行情告警不再发送 | [docs/monitor.md](docs/monitor.md) M-3b |
| v0.21.0 | 从 `config.json` 删掉 `monitor.hynix`（只配了海力士时删掉整个 `monitor`） | 旧版本不认识 `hynix` 市场；`monitor.sqlite` 里的海力士 K 线旧版本不读，再升级回来照常续用 | [docs/monitor.md](docs/monitor.md) M-2b |
| v0.20.0 | 从 `config.json` 删掉 `monitor.oil`（只配了原油时删掉整个 `monitor`） | 旧版本不认识 `oil` 市场；`monitor.sqlite` 里的原油 K 线旧版本不读，再升级回来照常续用 | [docs/monitor.md](docs/monitor.md) M-2a |
| v0.19.0 | 不用改配置 | `asset.sqlite` 新增的 `connections` 表与数据目录的 `asset-credential.key` 旧版本不读；回退期间资产页不同步，交易所行停在最后一次同步的值，再升级回来连接照常可用 | [docs/asset.md](docs/asset.md) A-3/A-4 |
| v0.28.0 | 不用改配置 | 原油盈亏库 `oil-pnl.sqlite` 旧版本不读，文件留在数据目录；再升级回来时账单从截止点续同步，停用期间的浮盈亏采样缺失、曲线在该段断线 | [docs/oil.md](docs/oil.md) 第 9 节 |
| v0.18.0 | 不用改配置 | 原油自动规则存在单独的 `oil-rules.sqlite`，旧版本不读；观察规则不下单，回退后不再记录信号，再升级回来时规则还在，原来在观察的继续观察（连续次数从零开始） | [docs/oil.md](docs/oil.md) 第 7 节 |
| v0.17.0 | 不用改配置。先在期权页「组合询价」确认没有未结束的询价（标签上不显示「进行中」；已成交但还没转成跟踪的也算未结束） | 旧版本不读询价记录，也不会因它拦下交易；询价成交的开仓组合照常跟踪与平仓，收益页该组在旧版本显示待核对 | [docs/options.md](docs/options.md) 第 4 节 |
| v0.16.0 | 不用改配置 | `asset.sqlite` 新增的 `sync_locks` 表旧版本不读；资产页回到只读，显示的是页面写入后的数据，不会回到导入时刻 | [docs/asset.md](docs/asset.md) A-2 |
| v0.15.0 | 不用改配置 | 配置与 `asset.sqlite` 照常可用，只是导入面板没有行情监控与资产账本两项，改用手写配置与单独的账本导入命令 | [docs/module-import.md](docs/module-import.md) 第 8 节 |
| v0.14.0 | 不用改配置 | `options.sqlite` 里新增的成交台账与收益采样表旧版本不读，再升级回来时继续使用；回退期间没有收益采样，曲线在这段断开 | [docs/options.md](docs/options.md) 第 4 节 |
| v0.13.0 | 先在期权页关闭定时开仓、确认没有进行中的期权任务，再从 `config.json` 的 `options` 删掉 `autoOpen`、`openHourUtc`、`openMinuteUtc`、`openWindowSeconds`、`marketFallback` | 旧版本按白名单读期权字段，多出字段会拒绝启动；`options.sqlite` 里多出的定时开仓记录旧版本会忽略 | [docs/options.md](docs/options.md) 第 4 节 |
| v0.12.0 | 从 `config.json` 删掉 `monitor` 与 `asset` | 旧版本不认识这两个字段；数据目录里的 `monitor.sqlite` 与 `asset.sqlite` 可以留着，旧版本不读它们 | [docs/monitor.md](docs/monitor.md)、[docs/asset.md](docs/asset.md) |
| v0.11.0 | 先在期权页确认没有进行中的期权任务和未结束订单，再从 `config.json` 删掉 `options`、从 `secrets.json` 删掉 `bybitOptions` | 旧版本不认识这些字段；`options.sqlite` 留在数据目录，旧版本不读 | [docs/options.md](docs/options.md) 第 4 节 |
| v0.10.0 | 从 `config.json` 删掉 `summary`、从 `secrets.json` 删掉 `feishuScheduled` | 旧版本不认识这些字段；页面导入配对时会自动写入 `feishuScheduled`，自己没写过也要检查 | [docs/frontend.md](docs/frontend.md)《日志页与定时摘要状态》 |
| v0.8.0 | 先在原油页确认没有未结束的原油任务，再从 `config.json` 删掉 `oil`、从 `secrets.json` 删掉 `binance`/`bybit` | 旧版本不认识这些字段 | [docs/oil.md](docs/oil.md) 第 4 节 |
| v0.7.0 | 把页面「设置」里改过的划转参数抄回 `config.json` 的 `transfer` | 旧版本每次启动都用配置文件里的值覆盖。安装脚本自动回退到 v0.7.0 之前的版本同样会覆盖，配对保持启用；建议页面改完后同步写回 `config.json` | [docs/frontend.md](docs/frontend.md) F3 |
| v0.4.0 | 从 `config.json` 删掉 `host` | 旧版本不认识这个字段 | |

回退到早于 v0.3.0 的版本、或回退到 v0.1.0 的注意事项见 [docs/plan.md](docs/plan.md) 第 7 节。升级后启动失败时，安装脚本会先用上一版本校验当前配置，不通过就不自动回退并说明原因。

## 来源

执行器代码迁自 project-aggregation `platform/executor`（提交 `62b6067`），ASTER 签名与划转探测迁自其 `server/contract-probes`，资产账本的计算口径与页面样式复制自其 `modules/asset`（提交 `0014655`），副服务器巡检程序与安装脚本复制自其 `tools/main-watch` 与 `deploy/install-main-watch.sh`（提交 `7745181`）。工作台只作历史参考，本仓库不回写工作台数据。
