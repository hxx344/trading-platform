# 提示词文件审计与整理（纯文档）审查记录

- 日期：2026-11-17
- 范围：`AGENTS.md`、`LESSONS.md`、`docs/code-review.md`、`docs/plan.md`、`.claude/commands/review.md`。不改代码、配置与发布包内容。
- 等级：纯文档（R1）。作者自查，没有独立审查。
- 回滚：还原本次提交即可，不影响已安装的服务。

## 做了什么

- `AGENTS.md`：删去对其他文件的复述，只留指路。
  - 《合并前审查》删去三条（P0/P1 清零与独立审查、「已运行」写法、审查记录位置），它们的正文在 `docs/code-review.md` 第 6 节；保留“R3 先写影响面与回滚”和“合入与发布不开合并请求”。
  - 删去“启用与数据迁移一律做进导入面板”的单独段落，并入必读表的对应行；备选方式见 `docs/module-import.md` 第 6 节。
  - 必读表的页面一行去掉 `docs/frontend.md` 规则摘要；《检查》里的截图宽度改为指向该文件《页面开发规则》第 7 条。
- `docs/code-review.md`：写明 `/review` 只在 Claude Code 里可用，其他代理按《独立审查》一节交接。
- `.claude/commands/review.md`：意见格式与「待核实」判定改为引用 `docs/code-review.md`，不再逐字重复。
- `LESSONS.md`：
  - 索引表去掉“本仓库的应用”一列（与每条末尾的同名段落重复，L201 一行两处已经不一致），只留编号与标题。
  - L201 补上索引链接指向的锚点。
  - L100 适用条件里的“本仓”改为“工作台的”（指的是工作台的 `server/trading-auto.mjs`）。
  - L092、L093、L095、L110 的「根因」「以后做法」压缩，去掉只描述工作台实现的细节，文件开头的说明同步改写。
- `docs/plan.md`：《当前状态》标题由 v0.17.0 改为 v0.58.0（表内各行已写到 v0.58.0，标题一直没跟上）。

## 作者自查

- `AGENTS.md` 删去的每条规则在 `docs/code-review.md`、`docs/frontend.md`、`docs/module-import.md`、`docs/plan.md` 里都有正文。
- 改动涉及的相对链接与锚点有效（`LESSONS.md` 索引 13 个锚点逐个核对）。
- `LESSONS.md` 压缩的四条：适用条件与「本仓库的应用」未改；压缩后的做法没有新增原文之外的要求。

## 未核查

- 压缩的四条没有与工作台当前的 `LESSONS.md` 重新对照，只对照了本文件改动前的文本。
- `docs/plan.md`《当前状态》只改了标题版本号，表内各行没有逐项对照各模块文档；`docs/options.md`、`docs/asset.md` 等模块文档自己的《当前状态》标题版本号本次未动。
- `AGENTS.md` 必读表没有 `docs/hynix.md`、`docs/crossex.md` 两行，本次未补。
- 没有在 Markdown 渲染器里预览。
