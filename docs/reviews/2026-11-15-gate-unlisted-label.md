# Gate 未收录错误码的诊断（Asset，R3）审查记录

- 日期：2026-11-15
- 范围：`f30909b..` 本批提交：`src/asset/sources/gate.ts`、`test/asset-sources-gate.test.ts`、`docs/asset.md`、`package.json`（版本号）。
- 起因：真实账户的资产页 Gate 连接显示“Gate 读取失败（HTTP 500 · API_CODE_UNKNOWN）……请反馈此诊断代号，暂不能确定具体原因”，Gate 返回的 `label` 未收录时页面不显示它，无从反馈与判断。
- 等级：R3（改的是上游响应内容进入错误信息的边界，属凭据与鉴权相邻面，存疑按高一级）。一路独立只读审查（高风险档，与作者隔离）。
- 用户可见行为：未收录的 `label` 为纯大写字母单词以下划线连接、3–40 个字符时显示在诊断里；补收录 `SERVER_TIMEOUT`、`FAILED_RETRIEVE_ASSETS`；5xx 且没有已收录错误码时提示“请稍后重试”。已收录错误码的文字不变。
- 影响面：只有 Gate 读取失败时的诊断文字（写入 `gate-status` 与资产行的 `error`，经登录后的接口给页面，页面以文本渲染）。余额读取、签名、其他数据源不变。
- 失败与回滚：`sudo bash install.sh --version v0.29.0`，不用改配置与数据。
- 本次不做：真实错误码仍未知（本机没有该账户凭据）；升级后页面会显示出来，再据此收录或处理。

## 审查结论

无 P0/P1/P2，3 条 P3。

已核实：`UNLISTED_LABEL` 无 `m`/`s`/`u`/`i` 标志，`$` 只匹配输入结尾，换行、空格、NUL、数字、小写、全角与西里尔字母、首尾或连续下划线、少于 3 或多于 40 个字符都不放行（审查者用 node 逐项探测）；密钥、签名（含数字的十六进制）、网址、句子都不是该形状；`message`、`detail`、响应头始终不进诊断；与 `RESPONSE_HINTS` 代号同名的 `label` 退回 `API_CODE_UNKNOWN`；2xx 带 `label` 走同一分类；已收录 `label` 的输出与改动前相同；仓库里没有别处解析 Gate 诊断格式（`sync.ts` 只按 `Gate ` 前缀放行）；旧用例只移出 `FUTURE_GATE_ERROR` 一项并在新用例正向断言，没有放宽的断言。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P3 | 文件头写“5xx 诊断提示重试”比实际宽：已收录 `label` 在 5xx 下仍用原文字 | 已修：注释改为“没有已收录错误码的 5xx” |
| P3 | 5xx 配 `RESPONSE_EMPTY` 等时一句里出现两次重试提示 | 已修：只在后半句不含“重试”时加“请稍后重试” |
| P3 | `docs/asset.md` 没记下与工作台的差异 | 已修：A-3/A-4 一节补一条 |

审查者未核对的 `SERVER_TIMEOUT`、`FAILED_RETRIEVE_ASSETS`：作者在 Gate API v4 文档（<https://www.gate.com/docs/developers/apiv4/en/>，2026-11-15 读取）的错误码表里查到这两项。

## 已运行

- `pnpm check`（通过）；`node --test test/asset-sources-gate.test.ts`（32 个通过，P3 修复后重跑）。
- `node --test test/*.test.ts`（P3 修复前，Windows 本机）：863 个里 817 通过、43 失败、3 跳过；失败全部是本机平台原因（`fsync`、`symlink`、`rm` 报 EPERM，以及“实盘模式只在 Linux 上运行”），与本次改动无关，Gate 用例全部通过。

## 未运行

- Linux 上的全量测试（本机为 Windows，约定不用 WSL）：由发布工作流在打包前执行。
- 真实 Gate 账户：未用真实凭据复现 HTTP 500，真实 `label` 待升级后从页面读取。
- 浏览器走查：本次不改页面代码与版式。
