# 2026-11-26 DEX 价差拆成独立服务 trading-platform-dex（v0.90.0）

- 范围：f50dd8e 相对 v0.89.0（45f9d1e），加修复增量 f50dd8e..HEAD。文件：`src/dex/*`、`src/service/{dex,health-watch,main}.ts`、`src/http.ts`、`deploy/{install.sh,trading-platform.service,trading-platform-dex.service,component-digests.mjs,package.sh,test-install.sh,test-platform-systemd.sh}`、`scripts/dev-varlighter.ts`、`test/dex-service.test.ts` 与改为经转发的原有测试、`docs/{dexspread,update,observability,plan,varlighter}.md`、README。
- 等级：R3（部署激活、唯一写者边界、库的搬移、凭据跨进程传递）。
- 审查方式：方案两轮独立审查（处理见 docs/dexspread.md 11.12、11.13）；实施后新开 `r3-reviewer` 只读审查 f50dd8e；修复增量由再新开的审查者复核。
- 回滚版本：v0.89.0，必须用 v0.90.0 及以后的安装器回退（安装器把库交回执行面数据目录），见 docs/dexspread.md 11.6 与 README 回退表。

## 改动

1. 新单元 `trading-platform-dex.service`：独立账户与通信组，套接字 `/run/trading-platform-dex/dex.sock`，状态目录 `/var/lib/trading-platform-dex`（0700），读不到配置、凭据与执行数据目录。
2. 执行面不再导入 `src/varlighter/`（打包时断言），`/api/varlighter/*` 经套接字转发：确定没发出返回 503；写请求发出后应答丢失就断开页面连接（L204）；回测超时 504。
3. Var token 由执行面每 15 秒推送，`seq` 单调、60 秒租约，DEX 只存内存。
4. 库的搬移：root 所有的标记 `.dex-db` 决定权威库；复制由目录属主身份的 `move-db.ts` 完成，root 只接管道（L201）。
5. 激活顺序：行情、执行面、DEX、控制面；DEX 失败整体回退。关掉 `varLighter` 或降级时先把库交回再删单元。

## 实施后审查结论

没有 P0、P1。P2 4 条、P3 9 条，处理见 docs/dexspread.md 11.14，要点：

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P2 | 标记文件没落盘 | 已修：`sync` 临时文件与程序目录 |
| P2 | 复制工具取自固定的旧 DEX 组件目录 | 已修：取目标版本，回滚到无 DEX 版本时才用 `dex` 链接 |
| P2 | 缺带数据的迁移与降级、坏 DEX 候选、http 层断开连接的测试 | 已补（真实 systemd 验收与单元测试） |
| P2 | `status` 读失败时整轮不推 token | 已修：照推，只在确知不兼容时停推 |
| P3 | 导入未锁目标库、未限制收到库的结构；崩溃记录永久报告；墙钟回拨后推送被拒；文档状态与 README 行序；无用导出；打包断言只看退出码 | 已修 |
| P3 | 回测时安装探测超时会重启 DEX；旧安装器清理可能删掉 DEX 组件目录 | 写进已知限制 |

## 复核

（复核结论在复核完成后补记。）
