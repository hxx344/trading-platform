# trading-platform

统一交易平台。第一阶段只做 ASTER 配对的两项核心功能：

- 保证金平衡划转：同一主账户下两个子账户之间按可用余额差额划转 USD1。
- ADL 应急处理：发现自动减仓后，两账户合计多空偏差超过较大一侧的 0.5% 时，对多出的一侧分批下只减仓市价单，直到两边相等；偏差在 0.5% 内不减仓。

方案、决策与进度见 [docs/plan.md](docs/plan.md)；执行器的状态机语义、回滚与已知限制见 [docs/executor.md](docs/executor.md)。

## 开发

需要 Node 24.15+ 与 pnpm。

```bash
pnpm install
pnpm check       # 类型检查（服务端与页面）
pnpm build:web   # 构建服务页面到 web/dist（发布包与服务启动都需要）
pnpm test        # 全部离线测试，不连任何交易所
```

页面开发：服务照常运行（默认 http://127.0.0.1:4720），另开 `pnpm dev:web`，打开 http://127.0.0.1:5173 先登录，`/api` 由开发服务器转发（目标用 `TP_DEV_TARGET` 改）。页面源码在 `web/src`，规划见 [docs/frontend.md](docs/frontend.md)。

本地模拟运行（只用模拟交易所）：`node src/main.ts --data-dir ./.data --port 4711`，浏览器打开 `http://127.0.0.1:4711`。

## 部署（Linux 服务器，root）

```bash
curl -fsSLO https://github.com/hxx344/trading-platform/releases/latest/download/install.sh && sudo bash install.sh
```

- **首次执行即启动服务**（配置里还没有配对），然后在页面上导入：打开本机页面（见下），在「设置」页的「从工作台导入配对」里点「读取工作台」，页面列出工作台每个配对能否导入及原因；勾选后点「导入所选并重启服务」，约半分钟后新配对以停用状态出现在列表里。导入由安装脚本装好的 root 导入助手（`trading-platform-import.path` / `.service`）完成：只读工作台数据，写好 `config.json`、`secrets.json`，以服务账户校验后重启服务，启动失败时恢复导入前的配置。之后每个配对：在工作台删除该配对 → 页面点「启用」。
- 命令行方式仍可用：`sudo bash install.sh --import-workbench`（从工作台导入已开启保证金平衡的配对、三个账户的凭据、ADL 设置和飞书机器人，写好 `config.json`、`secrets.json` 并启动。只读工作台数据，不改动工作台。导入的配对登记为停用；在工作台删除该配对后，到本项目页面点「启用」。只导入部分配对时加 `--pairs id1,id2`；工作台数据目录不在 `/var/lib/project-aggregation` 时加 `--workbench-data <目录>`。已有配置时只追加新配对，重复执行不改动。
- 首次执行放好程序（`/opt/trading-platform`）、系统账号 `trading-platform`、数据目录 `/var/lib/trading-platform`、导入交接目录 `/var/lib/trading-platform-import`、示例配置和不含配对的空配置，并启动 systemd 服务 `trading-platform`。也可以按 `/etc/trading-platform/config.example.json` 与 `secrets.example.json` 手写配置后再执行一次。
- 以后每次执行都是增量升级。脚本先只下载校验清单，程序、Node.js、单元和配置都没变就直接结束。有变化时先用新程序校验配置，不通过就保持原版本。重启后 90 秒内没有正常监听就自动回退到上一版本（自动回退到 v0.7.0 之前的版本同样会用 `config.json` 的 `transfer` 覆盖页面改过的参数，见下）。改了配置也是再执行一次让它生效（配对的 `transfer` 与 `adl` 除外，见下）。
- 指定或回退版本：`sudo bash install.sh --version v0.1.0`。服务器访问不了 GitHub 时，在别处下载 Release 的三个文件放进同一目录，然后执行 `sudo bash install.sh --package <目录>`。
- 打开页面：
  - **Tailscale（推荐）**：在 `/etc/trading-platform/config.json` 加一行 `"host": "<服务器的 Tailscale IP>"`（`tailscale ip -4` 查看，只能填本机的具体 IP，不能填 `0.0.0.0`），再执行一次 `sudo bash install.sh`，之后直接打开 `http://<Tailscale IP>:4720/`。该地址绑不上时（开机 Tailscale 还没连上、节点已登出）服务照常运行，持续重试，间隔最长 30 秒；配置检查会提示地址不在本机网卡上。
  - **SSH 隧道**：服务总在 `127.0.0.1:4720` 监听，写不写 `host` 都能用。在自己电脑上执行 `ssh -N -L 4720:127.0.0.1:4720 <服务器>` 后打开 `http://127.0.0.1:4720/`。
  - **登录**：`sudo bash install.sh --set-password` 设置登录密码（输入两次、不回显，只保存 scrypt 摘要到 `/etc/trading-platform/login-password`；沿用当前已装版本，不联网升级；脚本化时加 `--password-stdin` 从标准输入读一行；更换密码同样执行，已登录的浏览器须重新登录），之后页面输入密码即可。连续输错 5 次后锁定 30 秒，每再错一次锁定时间加倍，最长 15 分钟；一小时没有输错就重新计数。`sudo cat /var/lib/trading-platform/access-url` 里的登录链接始终可用（也会解除锁定）；删除 `login-password` 再执行一次安装脚本即取消密码。登录状态保留 30 天，服务重启（升级、页面导入）后不用重新登录。
  - 页面分四页：「总览」（配对开关、持仓、ADL 处理）、「配对详情」（两侧余额走势、划转与 ADL 历史、结算依据）、「运行状态」（后台循环、数据库、请求权重、推送连接、飞书发件箱）、「设置」（每个配对的划转参数与 ADL 设置、从工作台导入）。划转参数与 ADL 设置保存在数据库里，`config.json` 里的 `transfer` 与 `adl` 只在配对第一次登记时作为初始值，之后以页面为准（两边不一致时启动日志会列出页面当前值）；改短检查间隔使空闲请求权重超出「每分钟上限减 ADL 预留」时会被拒绝，并给出能用的最短间隔。余额走势来自数据目录里的 `samples.sqlite`（每分钟一条，保留 30 天；删掉只丢走势图）。
  - 回退到 v0.7.0 之前的版本前，先把页面「设置」里改过的划转参数抄回 `config.json` 的 `transfer`（旧版本每次启动都用配置文件里的值覆盖）。安装脚本自动回退到 v0.7.0 之前的版本同样会用 `config.json` 的 `transfer` 覆盖页面改过的参数，配对保持启用；建议页面改完后同步写回 `config.json`。回退到 v0.4.0 之前的版本前，先从 `config.json` 删掉 `host`（旧版本不认识这个字段，配置检查会失败）。升级后启动失败时，安装脚本会先用上一版本校验当前配置，不通过就不自动回退并说明原因。
- 需要代理时写 `/etc/trading-platform/environment`，例如 `NODE_USE_ENV_PROXY=1` 与 `HTTPS_PROXY=…`。
- 只校验配置、不启动（`node` 用 `systemctl cat trading-platform` 里 ExecStart 的那个）：`sudo -u trading-platform node /opt/trading-platform/current/src/service/main.ts --config /etc/trading-platform/config.json --check-config`。
- 日志：`journalctl -u trading-platform -f`。

配对接管与回退步骤见 [docs/plan.md](docs/plan.md) 第 4 节。

## 来源

执行器代码迁自 project-aggregation `platform/executor`（提交 `62b6067`），ASTER 签名与划转探测迁自其 `server/contract-probes`。工作台只作历史参考，本仓库不回写工作台数据。
