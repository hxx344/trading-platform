# 在线更新

页面侧栏「系统」组的「系统更新」：查看当前版本与最新正式版，确认后由服务器上的 root 更新助手执行一次 `install.sh --version <最新版>`。对照工作台的同名功能（project-aggregation `src/UpdateStatus.tsx` 提交 `c03c83f`、`src/updates.css` 提交 `9222ed6`、`docs/deployment.md`），按本服务已有的「从工作台导入」root 助手方式做成更轻的一套。

## 1. 变更前对齐（R3：部署激活）

**用户可见行为**

- 侧栏「系统」组多一个「系统更新」按钮，下方小字显示状态（已是最新、发现新版本、检查失败、正在更新、待启用）；有新版本时按钮高亮。
- 点开是对话框：当前版本 → 最新正式版、该版本的更新说明、上次检查时间；「检查更新」手动查一次；「查看更新」→ 确认区说明会重启服务 → 「确认更新到 vX」。
- 更新期间对话框显示进度（安装脚本最近的输出行）；服务重启时页面会断开几十秒，恢复后自动读取结果；成功后自动刷新页面载入新版本，失败时显示失败原因和安装脚本最后几行输出（是否已自动回退到原版本由 `install.sh` 输出说明）。
- 只能升级到比已装版本新的正式版，不能在页面降级；回退仍用命令行 `--version`。

**怎么做**

- 版本检查在服务进程里：每 30 分钟（启动后约 1 分钟第一次）读 GitHub `repos/hxx344/trading-platform/releases/latest`，取版本号、标题、更新说明、发布时间。手动检查最短间隔 60 秒；GitHub 返回限流时按它给的恢复时间暂停，手动检查也不绕过；其他失败按 1、2、4、8、15 分钟退避。走服务已有的代理设置（`NODE_USE_ENV_PROXY`）。
- 只支持默认安装路径（`/opt/trading-platform` 等）：助手执行的 `install.sh` 不带 `TP_APP_DIR` 之类的自定义路径变量。
- 「确认更新」：服务在页面导入用的交接目录（`/var/lib/trading-platform-import`，root 所有、服务组可写）写一个 `update-request.json`（只有请求编号、目标版本、时间）。新增 systemd 单元 `trading-platform-update.path` 监视这个文件，触发 root 单次服务 `trading-platform-update.service`。
- 更新助手（`src/service/update-helper.ts`，root）：只接受服务账户写的、2 分钟内的、格式为 `vX.Y.Z` 且比已装版本新的请求；用 curl 下载该版本的 `SHA256SUMS` 与 `install.sh`，核对 `install.sh` 的 SHA-256 后执行 `bash install.sh --version vX.Y.Z`；输出最近 40 行与阶段写进 `update-result.json`（服务账户可读），结束时写成功或失败。`install.sh` 本身照旧做程序包校验、配置检查、重启、90 秒健康检查和失败回退。
- 与导入、手动安装互斥：`install.sh` 持安装锁，另一个安装或导入在跑时本次更新失败并说明原因，不排队。
- 交接目录、服务单元、配置格式都不变；`install.sh` 只把新的两个单元加进已有的「页面助手单元」循环（渲染、安装、开机启用 `.path`）。

**影响面**

- 新增 root 执行路径：页面请求 → root 运行从 GitHub 下载的 `install.sh`。信任边界与手工一键部署相同：靠 TLS 与 GitHub 账号、Release 附件的完整性；`SHA256SUMS` 与 `install.sh` 同源，核对它只防下载不完整或混用不同版本的文件，不证明来源。残余风险（登记）：Release 附件被替换后，页面一点就会以 root 执行它，与手工执行一键部署命令相同。请求里只有版本号，经正则与“比已装版本新”两道检查，不能传任意参数、地址或降级。能发请求的只有已登录页面（POST 照旧要 `x-pa-executor` 头与会话）。
- 更新会重启服务：与手工执行 `install.sh` 相同，划转与 ADL 循环停几十秒，执行中的任务按已有恢复逻辑续上；确认区写明这一点。
- 服务进程多一个对 api.github.com 的只读请求（每 30 分钟一次），不带凭据。
- 不碰下单、划转、ADL、凭据、数据库结构与配置格式。

**失败时与回滚**

- 版本检查失败：页面显示原因，不允许开始更新，交易不受影响。
- 更新失败：`install.sh` 在新版本启动不过时自动回退并确认旧版本运行；助手把结果和输出尾部写给页面。助手本身被 systemd 超时（30 分钟）或中断时，`ExecStopPost` 把未结束的结果标为“已中断”。
- 回滚本功能：`sudo bash install.sh --version v0.49.1`（README 回退表 v0.50.0 一行）。旧版本的 `install.sh` 不认识更新单元，不会删掉它们；残留的 `trading-platform-update.path` 无人写请求，不会触发。要清掉就 `sudo systemctl disable --now trading-platform-update.path` 并删除 `/etc/systemd/system/trading-platform-update.{path,service}`。

**本次不做（登记）**

- 工作台的 GitHub Token 配置、更新方式（源码 / CI 包）选择、事件流推送、下载进度条、新版本弹窗提醒、各阶段耗时：本服务只有一个程序包、更新由 `install.sh` 一次完成，页面每 2 秒读一次结果即可。
- 页面降级与选择任意版本。
- 首次启用：已装 v0.49.1 及更早版本的服务器上没有更新单元，需要在服务器上手工执行一次一键部署命令，之后才能在页面更新（页面在这种情况下显示“待启用”）。

## 2. 实际做法（v0.50.0）

**服务（`src/service/update.ts`，以服务账户运行）**

- `readInstalledVersion()` 读程序目录的 `VERSION`（`vX.Y.Z <提交>`，打包时写入）；开发检出没有它时取 `package.json`，标为非程序包，页面不允许更新。读不出版本号时只让在线更新不可用，不影响启动。
- `createUpdates()`：`tick()` 由后台循环每 15 秒调用一次，是否真的去 GitHub 由它按 30 分钟周期、首检 60 秒、退避和限流时间决定；`check()` 是手动检查（60 秒内第二次返回 429 `update_check_wait`，限流期间返回 429 `update_rate_limited`）；`abort()` 在服务停止时中止进行中的请求。请求带 20 秒超时、只认 1 MB 以内的应答、链接只认本仓库的 Release 页。
- `apply({ version })` 依次拒绝：字段不对（400）、版本格式不对（400 `update_version`）、没有交接目录或没有就绪标记（409 `update_disabled`）、不是最近一次检查到的最新版（409 `update_changed`）、上次检查失败（409 `update_check_failed`）、不比已装版本新（409 `update_current`）、交接目录读不了（503）、有未取走的请求或运行中的更新（409 `update_busy`）。通过后以临时文件加改名写 `update-request.json`（600）。另外本机不是程序包安装时拒绝（409 `update_unpackaged`）。GitHub 应答边读边数，超过 1 MB 即中止；限流的恢复时间最多取 1 小时后。
- 助手先删请求文件、再写第一份“进行中”结果。服务记住自己最后写出的请求，请求文件不在、结果还没回答它（结果的 `id` 相同，或写在它之后的 `id` 为空的失败）时，2 分钟内仍按“等待处理”报告，页面不会在这段空档里丢掉盯住的任务（审查第 2 轮 P3）。服务重启后不再记得，只影响这段空档。
- 就绪标记 `<程序目录>/.update-helper`（`/opt/trading-platform/.update-helper`，root 所有、服务只读）由 `install.sh` 在更新 `.path` 启用并运行后写入，启用失败或所装版本没有更新助手时删掉；服务用 `updateReadyFile()` 从自己所在的 `releases/<包>/` 往上找到它，页面据此显示“待启用”。标记不放交接目录：那里服务账户可写，root 按路径写入会跟随服务放的符号链接（审查 P0）。

**HTTP（`src/http.ts`）**：`GET /api/update` 读状态，`POST /api/update/check`（空对象）手动检查，`POST /api/update/apply`（`{ version }`）确认更新；与其他接口一样要登录会话，POST 要 `x-pa-executor` 头；服务没接更新时三者 404。

**root 助手（`src/service/update-helper.ts`，`trading-platform-update.service` 启动）**

- 启动先把上次遗留的“进行中”结果标为中断（`--recover` 也由 `ExecStopPost` 调用，助手超时或被停止时同样处理）。
- 取请求：文件须为普通文件、单链接、属服务账户，否则删掉并写失败结果；取走即删除。请求超过 2 分钟、版本格式不对、本机不是程序包安装、版本不比已装的新，都写失败结果并说明原因，不下载。
- 下载 `releases/download/<版本>/SHA256SUMS` 与 `install.sh` 到临时目录（curl 只走 https、TLS 1.2 以上、重试 3 次），核对 `install.sh` 的 SHA-256 后以 `bash install.sh --version <版本>` 执行；输出去掉颜色控制符、每行最多 300 字、保留最近 40 行，有变化时每 2 秒、否则每 20 秒写一次 `update-result.json`（改归服务账户，600）。
- 退出码为 0 且 `current/VERSION` 已是目标版本才算成功；否则取输出里最后一条“安装失败：”（没有时取最后一行）作为原因，附当前版本。

**部署**：新单元 `deploy/trading-platform-update.path`（`PathChanged=@IMPORT_DIR@/update-request.json`）与 `deploy/trading-platform-update.service`（`Type=oneshot`、`TimeoutStartSec=1800`、`TimeoutStopSec=300`（超时停止时 `install.sh` 正在健康检查或回退，给它做完的时间；服务端把运行超过 2160 秒的结果算中断）、`PrivateTmp=yes`、读 `/etc/trading-platform/environment` 的代理设置）。`install.sh` 把它们并入导入助手的单元循环（`HELPER_UNITS`：渲染、安装、变更判断与 daemon-reload），`arm_path` 启用并启动两个 `.path`；所装版本带 `update-helper.ts` 且更新 `.path` 启用成功时写就绪标记。`package.sh` 把两个模板放进程序包。服务单元与命令行参数不变（沿用 `--import-dir`）。

**助手单元的命令行参数只增不改**：`install.sh` 回退版本时只还原服务单元，助手单元留在较新版本；助手以非严格模式解析参数、忽略不认识的，旧助手在新单元下照样工作。改参数含义或删参数要另想办法（例如回退时连助手单元一起还原）。

**页面**：见 [frontend.md](frontend.md)《系统更新（v0.50.0）》。

**测试**：`test/update.test.ts`（版本比较与更新说明、检查周期与退避、限流、确认更新的各项拒绝与请求文件、助手的成功、校验不符、下载失败、安装失败、过期与不更新的请求、非服务账户的请求、中断恢复、HTTP 路由的登录与请求标记）；`test/update-view.test.ts`（页面文字与能否开始更新）；`deploy/test-install.sh` 第 1 部分检查两个更新单元的路径已填好、测试模式不写就绪标记，并用替身 `systemctl`（`TP_TEST_ARM=1`）走启用路径：标记写在程序目录且为 644、交接目录里没有；更新 `.path` 启用失败时删掉标记且安装照常成功；装没有更新助手的版本时删掉标记、保留单元。

**未在本机验证**：systemd 真正触发 `.path`、root 下载 GitHub Release 并执行 `install.sh`、重启后页面自动刷新（本机没有 root 与 systemd 权限），首次在服务器上更新时实测并回填 [live-results.md](live-results.md)。

审查记录：[reviews/2026-11-16-online-update.md](reviews/2026-11-16-online-update.md)。
