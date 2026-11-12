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

## 部署（Linux 服务器，root）

```bash
curl -fsSLO https://github.com/hxx344/trading-platform/releases/latest/download/install.sh && sudo bash install.sh
```

- **工作台在同一台服务器上时**，用 `sudo bash install.sh --import-workbench` 一步装好：从工作台导入已开启保证金平衡的配对、三个账户的凭据、ADL 设置和飞书机器人，写好 `config.json`、`secrets.json` 并启动。只读工作台数据，不改动工作台。导入的配对登记为停用；在工作台删除该配对后，到本项目页面点「启用」。只导入部分配对时加 `--pairs id1,id2`；工作台数据目录不在 `/var/lib/project-aggregation` 时加 `--workbench-data <目录>`。已有配置时只追加新配对，重复执行不改动。
- 首次执行放好程序（`/opt/trading-platform`）、系统账号 `trading-platform`、数据目录 `/var/lib/trading-platform` 和示例配置。按 `/etc/trading-platform/config.example.json` 与 `secrets.example.json` 写好 `config.json`、`secrets.json` 后再执行一次即启动 systemd 服务 `trading-platform`。
- 以后每次执行都是增量升级。脚本先只下载校验清单，程序、Node.js、单元和配置都没变就直接结束。有变化时先用新程序校验配置，不通过就保持原版本。重启后 90 秒内没有正常监听就自动回退到上一版本。改了配置也是再执行一次让它生效。
- 指定或回退版本：`sudo bash install.sh --version v0.1.0`。服务器访问不了 GitHub 时，在别处下载 Release 的三个文件放进同一目录，然后执行 `sudo bash install.sh --package <目录>`。
- 服务只监听 `127.0.0.1:4720`。在自己电脑上执行 `ssh -N -L 4720:127.0.0.1:4720 <服务器>`，再打开 `sudo cat /var/lib/trading-platform/access-url` 里的登录链接。
- 需要代理时写 `/etc/trading-platform/environment`，例如 `NODE_USE_ENV_PROXY=1` 与 `HTTPS_PROXY=…`。
- 只校验配置、不启动（`node` 用 `systemctl cat trading-platform` 里 ExecStart 的那个）：`sudo -u trading-platform node /opt/trading-platform/current/src/service/main.ts --config /etc/trading-platform/config.json --check-config`。
- 日志：`journalctl -u trading-platform -f`。

配对接管与回退步骤见 [docs/plan.md](docs/plan.md) 第 4 节。

## 来源

执行器代码迁自 project-aggregation `platform/executor`（提交 `62b6067`），ASTER 签名与划转探测迁自其 `server/contract-probes`。工作台只作历史参考，本仓库不回写工作台数据。
