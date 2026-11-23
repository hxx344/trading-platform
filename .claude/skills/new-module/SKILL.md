---
name: new-module
description: 按项目规则接入一个新模块：先写模块文档（范围、等级、对照页面、回滚版本），再做后端、页面、导入面板、测试登记与索引，最后回填文档。只在用户输入 /new-module 时使用。
argument-hint: "<模块名与一句话目标>"
disable-model-invocation: true
---

# 接入新模块

模块：$ARGUMENTS

规则来源：[AGENTS.md](../../../AGENTS.md)、[docs/plan.md](../../../docs/plan.md)、[docs/frontend.md](../../../docs/frontend.md)《页面开发规则》、[docs/module-import.md](../../../docs/module-import.md)、[docs/code-review.md](../../../docs/code-review.md)。与本文冲突时以它们为准，并把本文改成一致。

## 1. 先写文档，再动代码

新建 `docs/<模块>.md`，开头一节写清（照 [docs/varlighter.md](../../../docs/varlighter.md) 第 1 节的写法）：

- **范围与等级**：按 code-review.md 第 2 节定 R1/R2/R3，存疑取高。碰下单、平仓、划转、凭据、部署激活、库结构、唯一写者边界的是 R3。
- **R3 四项**：要改变的用户可见行为、影响面（列到文件）、失败时会怎样与怎么回滚、本次不做而需要单独登记的事项。
- **默认开关**：默认开启还是要导入后才启用；关闭方式。
- **对照的工作台页面**：工作台（project-aggregation）里同功能的页面组件、样式与提交号；没有就写明，并写骨架照哪个已有页面。
- **回滚版本**：当前已发布的最新版本（`git describe --tags --abbrev=0 origin/main`），以及回滚后本模块留下的数据会怎样。
- **数据**：自己的库（如 `<模块>.sqlite`）和表；与其他模块的库不共享写入。

写完先给用户过一遍范围和等级。R3 必须等用户确认再写代码；R1、R2 说明一句后继续。

## 2. 后端

- 代码放 `src/<模块>/`，接进服务放 `src/service/<模块>.ts`，接口加在 `src/http.ts` 的 `/api/<模块>/*`。
- 动手前按 AGENTS.md《按改动取用经验》读相关的 LESSONS.md 条目，并核对当前源码，不凭记忆套用。
- 读外部接口：超时、重试、总时限有界（L039、L093）；调度扣除请求耗时（L049）；写操作让在途读取失效（L089）。

## 3. 页面

逐条照 frontend.md《页面开发规则》第 1–8 条做，重点：

- 结构、文案、确认提示照工作台同功能页面；样式原样复制，文件头注明来源路径与提交号。
- 共用组件不重写（`StateViews.tsx`、`use-live-resource.ts`、`svg-plot.tsx`、`api.ts`）；写操作走 `request-ids.ts`。
- 不写内联样式与脚本（CSP）；地址 `#/<页面>`，在 `web/src/workspace-nav.ts` 登记工作区。
- 表单到请求的转换放在 `web/src/<模块>-form.ts`，写不依赖 DOM 的单元测试。
- 需要本地预览就仿照 `scripts/dev-varlighter.ts` 写 `scripts/dev-<模块>.ts`：替身数据、临时目录、不联网。

## 4. 启用与数据迁移

需要从工作台带数据或启用开关的，一律做进设置页「从工作台导入」面板及其命令行，照 module-import.md 的预览、导入、页面请求、命令行、测试、回滚各节做，不要求用户手改 `config.json`。不需要导入的模块，在文档里写明“不进导入面板”和原因。

## 5. 测试与登记

- 测试文件放在 `scripts/test.ts` 的 `patterns` 已覆盖的目录；新目录要加进 `patterns`。
- 在 AGENTS.md「开发前必读」表里加一行，指向 `docs/<模块>.md`。
- 在 frontend.md 末尾加本模块页面一节（对照页面与提交、复制了哪些样式、回滚版本）。
- 本地：`pnpm check`、`pnpm build:web`，浏览器在替身后端上按 frontend.md 第 7 条验证 1280 与 390 两种宽度。测试在 CI 上跑（本机是 Windows 时不跑 `pnpm test`）：推分支后 `gh workflow run ci.yml --ref <分支>`。

## 6. 审查与回填

- 按 code-review.md 第 5 节自审；R2 以上按《独立审查》交给只读审查者（R3 用 `r3-reviewer` 子代理），每轮新开。
- 审查记录写 `docs/reviews/<日期>-<模块>.md`。
- 把实际做法回填到 `docs/<模块>.md`，删掉已不成立的方案描述。
- 提交信息按 code-review.md《提交信息》写。需要发布时用 `/release`。
