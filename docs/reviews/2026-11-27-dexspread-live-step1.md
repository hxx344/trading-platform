# 2026-11-27 DEX 价差实盘第 1 步：场所账户录入与账户只读（v0.101.0）

- 范围：提交 57abfe0 及其后的审查修复提交，相对 7de7b61（v0.100.1 加方案文档）。文件：`src/dex/{keys,keys-setup,main,host}.ts`、`src/varlighter/{accounts,engine,feeds}.ts`、`deploy/{install.sh,trading-platform-dex.service,component-digests.mjs,test-install.sh,test-platform-systemd.sh}`、`web/src/varlighter/VarLighterReady.tsx`、`scripts/dev-varlighter.ts`、`test/dex-keys.test.ts`、`docs/{dexspread,varlighter,live-results}.md`、`LESSONS.md`、`AGENTS.md`。
- 等级：R3（凭据、部署激活）。方案、影响面与回滚在动手前写进 [dexspread.md](../dexspread.md) 第 12 节，实际做法在 12.13。
- 审查方式：作者自审，加独立只读审查子代理（`r3-reviewer`，高风险档）审 7de7b61..57abfe0；修复后再开一轮新的子代理复审修复提交。
- 回滚版本：v0.100.1。库不变，直接回退；`keys.env` 留在原处不被读取。

## 改动

1. `install.sh --set-dex-keys / --unset-dex-keys / --dex-keys-stdin`：root 助手 `src/dex/keys-setup.ts` 把 Lighter 主网账户编号、Lighter RH 账户编号、Entropy 地址写进 `/etc/trading-platform-dex/keys.env`（root 0600）。文件摘要并入 `dex-key`，只重启 DEX 服务。
2. DEX 单元以 `EnvironmentFile` 取内容，服务启动时取走并删除变量，之后每次取用前 `stat` 文件（L207）。
3. 引擎每 60 秒读三个场所的公开账户接口，实盘准备页新增「场所账户」，「账户资金」按实际余额判断。
4. 这一版没有私钥、签名器与下单。

## 第一轮审查结论

没有 P0。P1 1 条、P2 4 条、P3 4 条。

审查者核对过、没有发现问题的：文件与安装脚本的凭据边界（L201：目录与文件权限、`O_NOFOLLOW`、临时文件 0600 后改名、输入不进 argv、输出不含输入值、执行面与控制面是别的账户）；吊销的失败方向（`stat` 的各种失败都返回空账户）；部署激活（`dex-key` 只进 DEX 的组件键、文件不存在时不并入、目标版本没有助手时在激活前失败、base64url 与 `EnvironmentFile` 的解析相容、占位符都被替换）；回滚到 v0.100.1；账户应答的身份核对与数值解析；失败不进采样循环；视图不带编号与地址；测试没有恒真断言。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1 | 删掉 `process.env` 里的变量后，内容仍在 `/proc/<pid>/environ`，同账户进程读得到；12.13 却写成对子进程的隔离，并称「按最终形态做」 | 改文档，不改投递方式：12.13、`keys.ts` 与单元文件的注释如实写明暴露面，写明这条通道只放账户编号与地址（两者在场所公开接口上本来可查），**第 2 步放私钥前必须换投递方式**并加「服务账户读不到」的验收断言。登记 L211 |
| P2 | 「场所账户」只看是否录入，编号填错、读不到时仍显示已就绪，与文档不符 | 已修：最近一次读取失败且没有时限内读数的场所计为警告，并补断言 |
| P2 | 三个场所顺序读、共用一个 20 秒时限，一个场所不应答会让另外两个带着已中止的信号发出 | 已修：并行读，每个场所各取一个时限；补「第一个场所超时不影响后两个」的用例 |
| P2 | 文件核对的基准是服务自己第一次 `stat` 的结果，与 systemd 读入的内容没有绑定；比较项不含 ctime | 部分修复：加比较 ctime；启动时要求文件大小与拿到的内容对得上。启动空隙里换成等长内容的情形仍挡不住，写进 12.13，第 2 步换投递方式时一并解决 |
| P2（待核实） | 先校验 `sign` 再跳过零数量，Lighter 若对空仓返回 `sign: 0` 会让整个账户读取失败 | 已修：先跳过零数量再校验方向；空仓条目的真实取值登记为待实测 |
| P3 | 助手被杀会留下 root 0600 的临时文件 | 登记，未改：写进 12.13 |
| P3 | 写入后安装失败时运行中的服务停用账户，文档没写 | 已补文档 |
| P3 | 文件已写、服务未重启时显示「还没有录入」 | 已修：提示等 DEX 服务重启 |
| P3 | 注释指向已改的 12.4 | 已修：指向 12.13 |

## 复审结论

见文末《复审》。

## 已运行

- `pnpm check`、`pnpm build:web` 通过。
- 分支 CI（提交 57abfe0，手动运行，`install_full=true`）全部通过，含完整顺序的安装验收与真实 systemd 五组（迁移组里有账户文件权限、环境变量送达、只重启 DEX、移除后不再送达的断言）：<https://github.com/hxx344/trading-platform/actions/runs/45883919376>。审查修复后的提交再跑一次，链接写在发布提交里。
- 本机 `node --test test/dex-keys.test.ts`：8 通过（Windows 上只作参考，以 CI 为准）。
- 浏览器在替身后端（`scripts/dev-varlighter.ts`）上核对实盘准备页：1280 与 375 宽度，新检查项显示正常，手机宽度无横向溢出，没有新的控制台报错。

## 未运行

- 真实账户上的读取：等用户在服务器上执行 `--set-dex-keys` 后核对，已登记 [live-results.md](../live-results.md)。
- P1 的复现命令（以 DEX 账户读主进程 environ）没有在真机执行，按内核的访问规则判断。
- 实盘：这一版没有下单能力。
