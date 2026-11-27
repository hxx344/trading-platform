# 副服务器巡检（main-watch）与本服务的心跳

主服务器整机宕机、断网或服务卡死时，本服务自己的飞书告警发不出来。这里的做法是让另一台服务器（副服务器）盯着它：本服务每 30 秒向副服务器推送一次签名心跳，副服务器每分钟检查一次，心跳断了或心跳说“未就绪”就发飞书告警，恢复后再通知一次。

- 状态：已实施，随 v0.47.0 发布；审查记录 [reviews/2026-11-16-watch.md](reviews/2026-11-16-watch.md)。
- 等级：R3（新的凭据字段与配置字段、安装脚本、发布文件、另一台服务器上的 root 安装器）。
- 回滚版本：v0.46.0。回退前先执行 `sudo bash install.sh --watch-off`（旧版本不认识 `watch` 字段，配置检查会失败）。副服务器上的巡检不用动：收不到心跳会告警，不想收到就在副服务器执行 `sudo bash install-watch.sh --uninstall`。

## 1 范围

做的事：

- 本服务内的心跳推送（`src/service/watch.ts`），不用在主服务器另装任何程序。
- 副服务器的巡检程序 `deploy/main-watch/main_watch.py` 与一键安装脚本 `deploy/install-watch.sh`，两个文件随每个正式版发布。
- 主服务器上的开关：`install.sh --watch-url / --watch-import / --watch-off`。
- 「运行状态」页的「副服务器巡检心跳」一栏。

不做的事：

- 不改划转、ADL、原油、期权等任何交易逻辑；推送失败只记日志和状态页，不影响它们。
- 不提供页面上的开关。令牌由副服务器生成，不在工作台的数据里，所以没有接进设置页「从工作台导入」面板；`--watch-import` 是命令行上的对应项（读本机工作台推送端的配置）。
- 不替副服务器开安全组，不改主服务器的防火墙（主服务器只有出站连接）。
- 不发现“交易所连不上”这类问题，判定与 `GET /api/ready` 相同（见 README《部署》）。

## 2 来源

巡检程序与安装脚本从工作台（project-aggregation）提交 `7745181` 复制而来：`tools/main-watch/main_watch.py`、`tools/main-watch/test_main_watch.py`、`deploy/install-main-watch.sh`、`deploy/test-main-watch-systemd.sh`。之后只在本仓库维护，不回写工作台。改动：

- 默认就绪地址改为 `http://127.0.0.1:4720/api/ready`。
- 安装脚本去掉了主服务器推送端（`--sender`）那一半：推送由本服务自己做。
- 安装脚本从本仓库的 GitHub Release 下载 `main_watch.py`，按 `SHA256SUMS` 校验。清单与文件来自同一个发布，能发现下载损坏或发布不完整，防不了发布本身被替换；这与 `install.sh` 对程序包的做法相同。
- 程序目录、配置文件、服务名都沿用 `main-watch`。已经用工作台版本部署过的副服务器直接执行新脚本就是升级，原有配置（含令牌和飞书机器人）保留。这条升级路径是对照两份脚本核对的（文件、配置键、服务名都相同），没有在 CI 里用工作台版本实际装一遍。
- 程序自带的单次推送模式（`--sender`，排查用）默认探测的就绪地址随之变成 4720。同一台机器上还装着工作台推送端、且它的配置没写 `READY_URL` 时，会因此探测错端口；工作台安装器总会写这一行，正常不会遇到。

## 3 协议

与工作台 main-watch 相同，两边可以混用。

- 请求：`POST <副服务器>/heartbeat`，正文是 JSON `{"sent_at": <毫秒时间>, "ready": <布尔>, "detail": "<未就绪原因，最多 200 字>"}`，不超过 4096 字节。
- 签名：请求头 `X-Main-Watch-Signature` 是以共享令牌为密钥、对正文字节做 HMAC-SHA256 的十六进制值。令牌本身不上线路。
- 接收端的检查：签名相符；`sent_at` 与本机时间相差不超过 120 秒；`sent_at` 比上一条收下的更大（防重放）。通过返回 204，否则 403。
- 判定：副服务器每分钟看最近一条心跳。超过 90 秒没有新的心跳，或最近一条 `ready` 为假，本轮算失败；连续失败达到阈值（默认 3 次，即心跳断开后约 3～5 分钟）发告警，之后每 30 分钟提醒，恢复时通知。

本服务这一侧：

- 启动 10 秒后发第一条，之后每 30 秒一条；一次推送最多等 10 秒，不在同一次里重试，不跟随跳转。
- `ready` 与原因来自 `src/runtime.ts` 的 `notReady()`，与 `/api/ready` 是同一个判定：服务正在停止、已失去写入租约，或某个循环 3 分钟内没完成一轮（原因里写循环名与秒数）。
- `sent_at` 只增不减，系统时间被往回调时也不会重复。
- 连续失败只在第一次和恢复时各记一条日志；其余看状态页。
- 服务停止时放弃在途的那一次，不拖慢停止。

传输是明文 HTTP 也可以用：正文只有时间、就绪与否和循环名，没有账户或密钥；签名防伪造和篡改，时间戳与递增检查防重放。能看到流量的人只能知道主服务器是否就绪。副服务器的端口仍应只对主服务器的出口 IP 开放。

## 4 配置

本服务的两个文件各多一段，都由 `install.sh` 写，不用手改：

```jsonc
// config.json
"watch": { "url": "http://<副服务器 IP>:8792/heartbeat" }
// secrets.json
"watch": { "token": "<32~256 位字母、数字、- 或 _>" }
```

- `watch.url` 须为 http 或 https，不能带账号或 `#` 片段，最长 300 字符。
- `config.json` 有 `watch` 而密钥文件没有 `watch.token` 时拒绝启动。
- 没有 `watch` 时不推送，状态页也没有那一栏。

## 5 操作

### 副服务器

```bash
curl -fsSLO https://github.com/hxx344/trading-platform/releases/latest/download/install-watch.sh
sudo bash install-watch.sh --heartbeat-listen 0.0.0.0:8792 --webhook <飞书机器人地址> --name 统一交易平台
```

- 配置有变化时，脚本结束会打印要在主服务器上执行的接入命令（经 `awk` + `--watch-token-stdin` 读取 `/etc/main-watch/config`，不在终端回显令牌）。没打印时（例如只是升级），令牌可在 `/etc/main-watch/config` 的 `HEARTBEAT_TOKEN` 行查看。
- 已经部署过（包括工作台版本）时不带参数执行即升级，配置保留；内容没变且服务正常时直接结束。
- 其他选项：`--heartbeat-token`（不给则自动生成）、`--main 主机:端口`（副服务器能直连主服务器页面时另外探测 `/api/ready`，传空串清除）、`--checks`、`--webhook-stdin`、`--secret`、`--secret-stdin`、`--threshold`、`--remind`、`--test`、`--version vX.Y.Z`（v0.47.0 起的版本）、`--uninstall`（保留 `/etc/main-watch`）。
- 安全组：放行 TCP 8792，来源只填主服务器的公网 IP。
- 排查：`sudo main-watch probe` 逐项探测并打印结果；`journalctl -u main-watch-heartbeat -u main-watch`。
- 文件：程序 `/opt/main-watch`，配置 `/etc/main-watch/config`（root 所有，含令牌与机器人地址），状态由 systemd 放在 `/var/lib/main-watch`。服务以专用账户运行，带 systemd 沙箱选项。

### 主服务器（本服务）

```bash
sudo awk -F= '$1=="HEARTBEAT_TOKEN"{print $2}' /etc/main-watch/config | sudo bash install.sh --watch-url http://<副服务器 IP>:8792/heartbeat --watch-token-stdin
```

- 写入两个文件，校验后重启服务；校验或启动失败时两个文件恢复原样。
- 这三个开关沿用当前已装版本，不联网升级（和 `--set-password` 一样）。已装版本早于 v0.47.0 时没有这个功能，脚本会先升级到最新正式版再开启。
- 只换地址时可以不带 `--watch-token`，沿用已保存的令牌。
- `sudo bash install.sh --watch-import`：地址与令牌取自本机工作台推送端的配置 `/etc/main-watch/sender`。
- 本机装着工作台的推送端（`main-watch-sender.timer`）且它推往同一个地址时，脚本会停用那个定时器（文件保留）。否则两个推送端轮流上报，接收端以最新一条为准，结果会来回跳。停用后副服务器只知道本服务是否就绪，**工作台是否正常不再上报**；还要盯工作台的话，在副服务器能直连它时用 `install-watch.sh --checks http://<主服务器地址>:3100/api/ready` 加一个检查目标。
- `sudo bash install.sh --watch-off`：去掉两段并重启。
- `--watch-token-stdin < /path/to/heartbeat-token` 从标准输入读取一行令牌，使令牌留在命令行参数和 shell 历史之外（手动传 `--watch-token <令牌>` 仍兼容）。
- 核对：页面「运行状态」→「副服务器巡检心跳」显示最近送达时刻；副服务器上 `sudo main-watch probe` 显示正常。
- 状态页显示 `HTTP 403` 时，核对两端令牌是否一致、两台服务器时间是否准确。主服务器的时间被往回调过并重启了服务时，在时间追上副服务器上一次收下的那条之前也会是 403。
- 显示超时或连接被拒时，核对副服务器安全组与 `main-watch-heartbeat` 服务。本服务配了代理（`/etc/trading-platform/environment` 里的 `NODE_USE_ENV_PROXY=1`）时心跳也走代理，副服务器看到的来源是代理的 IP；要直连就在同一个文件里加 `NO_PROXY=<副服务器 IP>`。

## 6 测试

- `test/watch.test.ts`：配置与密钥校验；正文与签名；失败、恢复、停止；开关的计划；**用本服务的推送代码对着真实的 `main_watch.py --serve` 推送**，再用 `main_watch.py --probe` 读出结果（本机有 python3 时运行）。
- `test/service.test.ts`：真实服务入口上按间隔推送，先报未就绪原因、再报就绪；`/api/status` 有送达情况而没有令牌。
- `deploy/main-watch/test_main_watch.py`：巡检程序自己的测试（告警轮次、飞书、接收端拒绝重放等）。
- `deploy/test-install.sh`：`--watch-url / --watch-import / --watch-off` 的参数检查、写入、恢复、输出不含令牌；发布文件含两个新文件且与校验清单一致。
- `deploy/test-watch-systemd.sh`：在 CI 的一次性 Ubuntu 上做真实 systemd 安装，覆盖从发布文件引导安装、校验和不符时拒绝、告警一轮、无变化重跑、不带参数重跑保留配置、卸载。
