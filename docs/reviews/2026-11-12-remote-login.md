# Tailscale 监听与页面登录密码（R3）审查记录

- 日期：2026-11-12
- 改动：
  - `config.json` 可选 `host`：只收本机的具体 IP。服务总在 `127.0.0.1` 监听，另在该地址监听，绑不上时持续重试；Host 头放行该地址；`access-url` 写两行。涉及 `src/service/config.ts`、`src/runtime.ts`、`src/http.ts`、`src/data-dir.ts`。
  - 页面登录密码：scrypt 摘要存 `CONF_DIR/login-password`。登录表单需同源提交，按进程限速，同时只验证一个。`access-url` 链接保留为兜底。涉及 `src/login-password.ts`、`src/http.ts`。
  - 安装脚本：`install.sh --set-password`（可加 `--password-stdin`）；配置检查输出监听地址与密码状态；回退前用上一版本校验当前配置；单元加 `After=tailscaled.service`。涉及 `deploy/install.sh`、`deploy/trading-platform.service`、`src/service/main.ts`。
- 等级：R3（鉴权、凭据处理、部署激活）。
- 影响面：
  - 网页的监听地址和登录方式改变。划转与 ADL 逻辑不变。
  - 不写 `host`、不设密码时行为同 v0.3.0，只多一种无效登录页文案；`access-url` 仍是一行。
- 回滚：
  - 先从 `config.json` 删去 `host`，再执行 `install.sh --version v0.3.0`。
  - `login-password` 留着无害，v0.3.0 不读它。

## 第一轮（独立审查）

无 P0。未发现可直接利用的鉴权绕过、会话固定、DNS rebinding 或时序泄露。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1-1 | 配置地址重试 2 分钟后以 listen-failed 停掉整个服务。Tailscale 登出或节点过期时，划转与 ADL 会随网页一起反复停、反复告警 | 回环总监听，健康只看回环。配置地址由另一个 `net.Server` 交给同一 HTTP 服务，无限重试（2 秒翻倍到 30 秒，同一错误只提示一次），绝不停服务。测试用 127.0.0.2 被占用模拟，覆盖先失败后成功 |
| P2-1 | 健康检查 90 秒短于重试 120 秒；自动回退可能退到不认识 `host` 的旧版本 | 健康改看回环，此项随之消除。回退前用上一版本校验当前配置，不通过就不回退并说明 |
| P2-2 | `--check-config` 不检查 `host` 是否在本机网卡上 | 配置检查对不在本机的地址给出提示（不判失败：开机或 Tailscale 登出时本来就会缺） |
| P2-3 | `--set-password` 顺带联网升级到最新版 | 未指定 `--version` / `--package` 时沿用当前已装包，不联网（安装测试指向不可达地址验证） |
| P2-4 | 新密码与删除 `http-session` 发生在配置检查之前，检查失败后状态不一致 | 新密码纳入导入的撤销备份，检查或启动失败时恢复原密码；`http-session` 在检查通过后才删（安装测试覆盖） |
| P3 | 错误计数永不衰减；无 Sec-Fetch-Site 时接受 `Origin: null`；超长请求体计一次失败且一直读；先读密码后查 root；`curl \| bash -s -- --set-password` 会把脚本下一行当密码；`maxlength` 单位不一致；成功登录无日志；cookie 不区分端口；文档缺 SSH 隧道兜底 | 一小时无错误清零，令牌登录也清零；登录页 `referrer-policy: same-origin`，拒绝 `null`（浏览器实测带真实 Origin）；413 并关闭连接，不计失败；环境检查移到读密码前；非终端须 `--password-stdin`；`maxlength` 512；成功登录记来源地址；cookie 与端口问题写入 `docs/plan.md` §7；README 写明回环总可用 |

## 第二轮（新开独立审查，只看第一轮修复）

第一轮问题全部关闭，无 P0/P1。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2-5 | 配置地址已在监听后再收到错误（如描述符耗尽时接受连接失败），会进入重试，`listen` 抛 `ERR_SERVER_ALREADY_LISTEN`，进程崩溃 | 已在监听时只记日志、不重试；重试前也确认尚未监听 |
| P3 | `host` 写回环地址会与总在的回环监听冲突，永远绑不上；脚本本身从标准输入读入时 `--password-stdin` 会读到脚本下一行；沿用已装包时目录缺失报错不清楚；旧版本不支持设置密码时没提示先升级；两处注释措辞；测试未覆盖停止后关闭监听、重试等待中停止 | `host` 拒绝 `127.*`、`::1`、`::ffff:127.*`；脚本从标准输入读入时拒绝 `--password-stdin`，非终端提示改为先下载脚本；目录缺失时提示加 `--version` 或 `--package`；旧版本提示先 `sudo bash install.sh` 升级；注释改为“另外监听”；补两个运行循环测试 |

## 第三轮（新开独立审查，只看第二轮修复）

第二轮问题全部关闭，无 P0/P1/P2。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P3 | “停止后不再重试监听”断言 50 毫秒内测不出 60 秒的重试；映射回环正则 `::ffff:7f` 过宽，误伤 7.240.0.0/12 等映射地址；沿用已装包时只查文件存在，内容不符会走到未定义的 `base`；“已装版本”提示在 `--version` 指定旧版本时不准；回环主监听上的接受连接错误仍会停服务（与 P2-5 同类） | 断言改为地址空出后连接被拒；正则改为 `::ffff:7fXX:`，补 7.240.0.1 不被拒的用例；改为比对文件内容；提示改为“所选版本”；主监听已在监听时的错误同样只记日志 |

已运行：

- `pnpm -s check`
- `node --test --test-reporter=dot test/*.test.ts`：全部通过（第三轮修复后重跑）
- `bash deploy/test-install.sh`：全部通过
- `shellcheck deploy/*.sh`：无输出
- Chromium 实测：密码表单错误与正确登录，表单带同源 Origin 与 `Sec-Fetch-Site: same-origin`

未运行：systemd 下真实 Tailscale 地址的开机等待、root 下 `--set-password` 交互输入，须在服务器验证。
