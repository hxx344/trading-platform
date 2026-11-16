# 页面在线更新（系统更新，R3）审查记录

- 日期：2026-11-16
- 范围：`src/service/update.ts`、`update-types.ts`、`update-helper.ts`（新增）；`src/service/main.ts`、`src/http.ts`、`src/service/import-channel.ts`（接线、路由、导出两个读取函数）；`deploy/trading-platform-update.{path,service}`（新增）、`deploy/install.sh`、`deploy/package.sh`、`deploy/test-install.sh`；页面 `web/src/UpdateStatus.tsx`、`update-view.ts`、`updates.css`（新增）、`web/src/App.tsx`；测试 `test/update.test.ts`、`test/update-view.test.ts`；文档。
- 等级：R3（部署激活：新增由页面请求触发、以 root 运行 `install.sh` 的路径；改 `install.sh`）。

## 变更前对齐

见 [docs/update.md](../update.md) 第 1 节（用户可见行为、做法、影响面、失败与回滚、本次不做）。回滚版本 v0.50.0（`sudo bash install.sh --version v0.50.0`，不用改配置；残留的更新单元无害）。

## 审查结论

三轮独立只读审查，每轮新开审查者，上下文与作者隔离。第 1 轮分后端与部署、页面两位审查者；第 2 轮只复核第 1 轮的修复（全部确认已修复，另提 4 条 P3）；第 3 轮只看第 2 轮问题的修复差异。第 1 轮有 1 条 P0，已修复；P1 各轮均为无。

| 轮次 | 级别 | 问题 | 处理 |
| --- | --- | --- | --- |
| 1 | P0 | `install.sh` 以 root 按路径在交接目录（服务账户可写、无粘滞位）写就绪标记 `.update-helper` 并 `chmod 644`，会跟随服务放的符号链接：可让 root 在任意位置建文件，或借竞争把任意文件改成 644（凭据泄露） | 标记改放 root 所有的程序目录 `$APP_DIR/.update-helper`；服务用 `updateReadyFile()` 从 `releases/<包>/` 往上找；测试覆盖标记位置、权限与交接目录里没有 |
| 1 | P2 | 助手单元默认 `TimeoutStopSec=90`，超时停止时可能在 `install.sh` 健康检查或回退途中被 SIGKILL；服务端判中断的时限小于 1800+90 秒 | 单元加 `TimeoutStopSec=300`；`UPDATE_RUNNING_STALE_MS` 改为 2160 秒 |
| 1 | P2 | 回退只还原服务单元，助手单元留在新版本；以后新单元加参数时旧助手严格解析会拒绝 | 助手非严格解析、忽略未知参数；docs/update.md 写明助手单元参数只增不改 |
| 1 | P2 | 就绪标记写入与删除、启用失败、装旧包等部署分支没有测试；取请求缺符号链接、硬链接、过大用例 | `install.sh` 测试模式加 `TP_TEST_ARM` 钩子，`test-install.sh` 第 1 部分用替身 `systemctl` 测三种情况；`update.test.ts` 补三种请求文件 |
| 1 | P3 | `SHA256SUMS` 与 `install.sh` 同源，校验只防传输损坏 | docs/update.md 写明并登记残余风险（Release 附件被替换） |
| 1 | P3 | 服务端 `apply` 不查是否程序包安装 | 加 409 `update_unpackaged` |
| 1 | P3 | GitHub 应答先整体读入再判大小；限流恢复时间无上限 | 边读边数超 1 MB 中止；恢复时间最多 1 小时 |
| 1 | P3 | 自定义安装路径不会传给更新时的 `install.sh` | 文档注明只支持默认路径（登记，不改代码） |
| 1 | P2 | 页面：中断、无人取走、`id` 为空的失败结果都不会结束“盯住的任务”，页面一直每 2 秒读、断线时误显示“服务重启中” | 纯函数 `nextWatched()`，只盯运行中、本页请求待取走或刚成功的任务；补测试 |
| 1 | P2 | 页面：自写轮询在慢链路上每次应答都被丢弃（饿死）；写操作的结果会被之前发出的读取盖掉 | 改用 `use-live-resource`（在途读取不叠发，`commit` 作废旧读取） |
| 1 | P2 | 页面：写操作 200 但应答体不可解析时 `{}` 进入状态，渲染抛错白屏 | `parseUpdateView()` 形状校验，读取与写操作结果都先校验 |
| 1 | P2 | 页面：上述迁移与分支缺测试 | `test/update-view.test.ts` 补齐 |
| 1 | P3 | 确认区“自动回退”说得太绝对；README 章节名不对 | 改为“一般会自动回退，结果以安装脚本输出为准”；改为「部署（Linux 服务器，root）」 |
| 1 | P3 | 复制来的 `.update-nav` 高度与图标高亮被 shell.css 更高权重的规则盖掉 | `updates.css` 末尾按 `.app-shell > .sidebar` 限定再写两条，注明原因 |
| 1 | P3 | 确认结果未知后按钮立即恢复可点；确认成功后焦点丢失 | 结果未知时锁住确认直到之后的一次读取到达；焦点移到关闭按钮 |
| 2 | P3 | `.update-nav` 高度覆盖规则与 shell.css 同权重、后者后载入，仍不生效 | 选择器加 `.nav-item`；浏览器实测按钮高度约 50px |
| 2 | P3 | 助手删掉请求文件到写出第一份结果之间，读到“无请求、旧结果”，页面丢掉盯住的任务，安装若在 60 秒内完成就不会自动刷新 | 服务记住最后写出的请求，未被结果回答时 2 分钟内仍报告为等待；补测试 |
| 2 | P3 | `updateReadyFile()` 出错会连带把已装版本当成 `v0.0.0` | 拆成两个 `try` |
| 2 | P3 | `releaseNotes` 的注释错位到 `updateReadyFile` 上方 | 移回 |
| 3 | P3 | 不是本服务写的坏请求文件正被处理时用户恰好提交，助手为坏文件写的无 `id` 失败会被当成回答了新请求，退回修复前的空档行为 | 登记不改：要异常文件加毫秒级竞态，后果只是不自动刷新 |
| 3 | P3 | 测试缺“之后写的无 `id` 失败算回答”一支；多余空行 | 补断言；删空行 |

已核实无问题（第 1 轮）：取请求的 O_NOFOLLOW、属主、单链接、大小检查与按 inode 删除；版本号只能是比已装版本新的 `vX.Y.Z`，拼不出地址或参数；结果文件的临时名、O_EXCL、改属主后改名；curl 只走 https；`.path` 重启不影响运行中的助手；与导入、手工安装经安装锁互斥；HTTP 三个接口都在登录与请求标记检查之后；对话框的 Esc、焦点归还、CSP；`updates.css` 声明原样复制的行段与工作台逐行一致。

## 已运行

- `pnpm check`、`pnpm test`（全量，通过）、`pnpm build:web`。
- `bash deploy/test-install.sh 1`、`2`、`3`（各自通过；第 1 部分在修复后重跑，含新增的启用路径检查）。
- 替身后端（模拟执行器加可切换的更新状态）上无头浏览器 1280 与 390 宽度：可更新、确认区、运行中、失败、待启用五种状态与确认流程；无横向溢出、无 CSP 报错。

## 未运行

- systemd 真正触发 `.path`、root 下载 Release 并执行 `install.sh`、重启后页面自动刷新：本机没有 root 与 systemd 权限，首次在服务器上从页面更新时实测，结果回填 [live-results.md](../live-results.md)。
