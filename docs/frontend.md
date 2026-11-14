# 页面前端：实施方案

2026-11-12 定稿。现有页面是 `src/page.ts` 里手写的单个 HTML 字符串，功能少、难扩展。改为 React + Vite：在 CI 里预构建成静态文件，随发布包分发，服务器运行时仍然不需要任何依赖。

## 页面开发规则（所有模块）

2026-11-13 起，所有模块的页面（ASTER、原油，以及以后接入的 ANT、期权、Aero 等）都按本节开发。下面 F1–F3 和《原油页样式》是按这些规则做的实例，新模块照着做。

1. **框架**：React + Vite，源码在 `web/src`，`pnpm build:web` 预构建，随发布包分发。不在服务端拼 HTML 字符串，也不另起一个前端工程。
2. **先找工作台的同功能页面**：动手前在工作台（project-aggregation）找到这个功能原来的页面组件和样式（`src/*.tsx`、`src/*.css`、`modules/<模块>/`），页面结构、区块顺序、文案、确认提示都照它排。工作台没有对应页面时，按已有页面（总览、配对详情、原油页）的组件和样式拼，不自己设计新样式。
3. **样式直接复制**：需要的工作台 CSS 规则原样复制到 `web/src/` 下的 CSS 文件，只保留用到的规则，规则内容不改，文件头注明来源路径和提交号（例：`trading.css` 来自工作台 `src/trading.css` 提交 `a12e583`）。本服务另需的样式只写在 `styles.css` 末尾《本服务》之后，每个模块一小节。颜色、间距、圆角一律用设计令牌（`--surface-*`、`--text-*`、`--radius-*` 等），不写死数值。
4. **共用组件不重写**：状态与空数据用 `StateViews.tsx`；读取用 `use-live-resource.ts`（页面隐藏时暂停、失败保留上次结果并标明陈旧、401 提示重新登录）；走势图用 `svg-plot.tsx`。需要工作台别的组件时同样复制并注明来源提交，请求层统一走 `api.ts`。
5. **写操作**：带 `x-pa-executor` 头和请求编号，用 `request-ids.ts`：应答到达前重试沿用同一编号，结果未知时不换编号、不提示“已过期”，只有服务端明确拒绝才换编号。实盘下单、划转等资金操作先预览再确认，确认文案沿用工作台。
6. **CSP 与路由**：页面 CSP 不放行内联脚本和样式，不写 `<style>`、`<script>` 和 `style=` 属性，样式都放进 CSS 文件。新页面用地址 `#/<页面>` 路由，没配置的模块不显示入口（同原油页）。
7. **验证**：浏览器在替身后端上把新页面走一遍，截 1280 和 390 两种宽度与工作台同页面对比，不能比工作台难看；确认无 CSP 报错、手机宽度无横向溢出（表格在自己的框内横向滚动）。表单到请求的转换放在不依赖 DOM 的 `*-form.ts` 里写单元测试。
8. **文档**：新模块在本文件末尾加一节，写清对照的工作台页面与提交、复制了哪些样式、回滚版本。

## 页面一览

| 页面 | 地址 | 何时显示 | 本文小节 |
| --- | --- | --- | --- |
| 配对组 | `#/`、`#/pair/<配对>` | 总是 | F1–F3、《ASTER 页面按工作台重排（F4）》 |
| 运行状态 | `#/status` | 总是 | F2、《日志页与定时摘要状态》 |
| 日志 | `#/logs` | 总是 | 《日志页与定时摘要状态》 |
| 设置 | `#/settings` | 总是 | F3、《定时摘要间隔在设置页修改》、《导入面板：行情监控与资产账本》 |
| 原油 | `#/oil` | `GET /api/oil/state` 有应答（配置了 `oil`） | 《原油页样式》，页面内容见 [oil.md](oil.md) 第 3 节 |
| 期权 | `#/options`，子页 `#/options/positions`、`#/options/orders`、`#/options/performance`、`#/options/rfq` | `GET /api/options/state` 有应答（配置了 `options`） | 《期权页》 |
| 行情监控 | `#/monitor` | `GET /api/monitor/state` 有应答（配置了 `monitor`） | 《行情监控页》 |
| 资产 | `#/asset` | `GET /api/asset/state` 不是 404（配置了 `asset`；账本读取失败时也显示） | 《资产页》《资产页写入》 |

下面各节按接入批次记录当时的做法；后一批改掉前一批的地方以后一批为准（例如 F4 把总览与配对详情合并成配对组，A-2 去掉了 A-1 的只读提示）。

## 范围与批次

| 批次 | 内容 | 风险 |
| --- | --- | --- |
| F1 | 页面骨架；ASTER 服务页按原有功能逐项迁移；页面的 CSP 不再放行内联脚本和样式 | R2 |
| F2 | 只读扩展：配对详情（余额走势、划转历史分页、结算依据）、ADL 事件与持仓、告警与运行状态（飞书发件箱、推送连接、请求权重、服务健康）；余额采样表（独立库文件，见 F2） | R2 |
| F3 | 划转参数入库（`config.json` 只作初值，同 `adl`）、设置页、导入入口并入设置 | R3，两路审查 |

步骤 5 实盘切换不等前端。

## F1

**页面**

- 源码在 `web/`，`pnpm build:web` 构建到 `web/dist/`（不进 git）。发布包带上 `web/dist/`，服务从安装目录的 `web/dist/` 读取。
- 只迁移 ASTER 服务页，即旧的 `ASTER_PAGE`：状态行、从工作台导入、保证金平衡配对与启停、最近划转、账户持仓、ADL 设置与事件、重新开始。文案、确认提示、请求编号沿用规则（应答到达前重试沿用同一编号）都照旧。
- 原油双腿原型（`src/main.ts`）的 `PAGE` / `LIVE_PAGE` 不属于本产品，保持原样。
- 从工作台复制 `StateViews.tsx`、`live-resource.ts`、`use-live-resource.ts`，以及设计令牌、面板、提示条、空状态等样式，文件头注明来源提交 `056e9c3`。请求层按本服务的接口约定（`x-pa-executor` 头、错误字段 `message`）重写。
- 读取改为共享读取层：页面隐藏或离线时暂停，恢复后立即重读；刷新失败时保留上次结果并标明不是当前数据；401 提示重新登录。间隔仍为 2 秒。

**服务**

- `GET /` 返回构建出的 `index.html`；`GET /assets/<文件>` 返回构建产物（须登录；文件名带内容哈希，缓存一年，`private`）。
- 页面 CSP：`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`。登录页仍是服务端生成的内联页面，头部不变。
- 启动和 `--check-config` 都会加载页面文件。缺少 `index.html`、带内联脚本或样式、出现非普通文件，都算失败：安装时配置检查不通过，保持原版本。
- 打包前必须先构建：`package.sh` 找不到 `web/dist/index.html` 就报错。CI 和发布流程在打包前运行 `pnpm build:web`。

**验证**

- 单元测试：页面文件的加载与拒绝条件、`/` 与 `/assets/` 的鉴权、响应头和 404；请求编号沿用规则。
- 安装测试：发布包带上页面文件，配置检查会加载它们。
- 浏览器：在替身 ASTER 上逐块走一遍（配对启停、ADL 保存与非法值提示、刷新中断时的陈旧提示；导入预览与重新开始依赖导入助手与停止的事件，由单元测试与代码对照覆盖），确认没有 CSP 报错，手机宽度下表格可横向滚动。

**回滚**：在服务器上执行 `sudo bash install.sh --version v0.4.4`。本批不改数据库，也不改配置格式。

## F2

只读扩展，不新增任何写操作，也不改划转与 ADL 的判断逻辑。

**余额采样**

- 单独的库文件 `samples.sqlite`（数据目录内，和告警发件箱 `notify.sqlite` 一样自带表结构），不给主库 `executor-live.sqlite` 加迁移：旧版本遇到更高的结构版本会拒绝打开，主库一迁移，回退到 v0.5.0 和安装脚本的自动回退都会起不来。删掉这个文件只丢走势历史。
- 服务层每 30 秒读一次各配对上划转检查存下的最新余额（只有启用的配对会被检查），两侧最早的接收时刻比该配对上一条样本晚 60 秒以上才记一条：多侧与空侧的可用余额和权益，以及当时是否晚于最近一笔划转的结算。划转核心不改。
- 保留 30 天，每小时清理一次。按每分钟一条算，一个配对 30 天约 4.3 万条。

**接口**（都要登录，只读）

- `GET /api/transfer-pairs/<配对>/balances?range=6h|24h|7d|30d`：时间范围内每段取最后一条，最多约 720 个点。
- `GET /api/transfer-pairs/<配对>/history?before=<游标>&limit=<1–50>`：该配对的划转，新的在前，按 `(创建时刻, 编号)` 翻页，带结算依据（判定依据、回执流水号、结算说明、核对到的候选流水数、发送前快照覆盖的侧、余额刷新时刻、是否接管恢复）。
- `GET /api/adl/pairs/<配对>/incidents?before=<游标>&limit=<1–20>`：该配对的 ADL 事件，含证据、各合约进度和批次。
- `GET /api/status`：服务健康（启动时刻、库结构版本、WAL 大小、写事务统计、各循环最近一次成功与连续失败）、请求权重（本进程一分钟内用量、上限与 ADL 保留、交易所报告的出口 IP 本分钟用量、冷却）、推送连接（每个子账户是否连着、连上的时刻、最近一条消息、断开次数与最近原因）、飞书发件箱（是否配置、待发与失败重试条数、最近发送成功时刻、最近错误、最近 20 条）。

**页面**

- 顶部分三页：总览（F1 原样）、配对详情、运行状态，用地址里的 `#/pair/<配对>`、`#/status` 区分，刷新和返回都停在原页。
- 配对详情：当前余额与设置、余额走势（多侧、空侧可用余额两条线，悬停看权益与差额；相邻样本间隔超过 3 分钟（长范围取每段时长的两倍）的时段断线）、划转历史（逐页加载，可展开结算依据）、该配对持仓、ADL 事件历史（逐页加载，可展开批次）。
- 运行状态：上面四块；推送断开、权重冷却、发件箱有失败重试时标红。
- 走势图从工作台复制 `modules/monitor/app/svg-plot.tsx` 与 `lib/svg-plot.ts`（提交 `8bc3bee`），去掉 Next.js 标记。
- 刷新：总览仍 2 秒；详情第一页与运行状态 5 秒；走势 60 秒。翻出来的旧页不自动刷新，同一编号以最新一页为准。

**验证**

- 单元测试：采样的节流、去重与保留期；走势分段取点；两个历史接口的翻页游标与上限、非法参数；`/api/status` 各块的内容与鉴权；发件箱与推送连接状态。
- 浏览器：替身 ASTER 上三页各走一遍，走势有数据与空数据、翻页、展开结算依据，确认没有 CSP 报错，手机宽度不横向溢出。

**回滚**：`sudo bash install.sh --version v0.5.0`。主库不变；`samples.sqlite` 留在数据目录里，旧版本不读它。

## F3

划转参数改由页面维护，加一个设置页，把导入入口并进去。涉及资金参数的写入（R3），两路独立审查。

**划转参数入库**

- 主库不迁移：划转参数本来就存在 `transfer_pairs` 每行的记录里，划转评估在发送前的写事务里会重读配对，参数在评估途中变了就放弃本轮、下一轮按新参数规划（已有逻辑）。
- 启动登记改为：配对第一次登记时用 `config.json` 里的 `transfer` 作初始值；已登记的配对保留库里的参数，配置文件里的值与库里不同时只写日志提示“以页面为准”，与 `adl` 相同。换了账户的配对照旧重新登记为停用，参数仍沿用库里的。配置里删掉又加回的配对沿用库里上次的参数。
- 新接口 `POST /api/transfer-pairs/<配对>/config`（须登录，`x-pa-executor` 头，带 `requestId`）：字段同 `transfer`（门槛、最小与单次上限、保留比例、两侧固定保留额、冷却、检查间隔），按 `parseTransferConfig` 的严格模式校验（字段须齐全，`null`、对象、列表、布尔都拒绝，不补默认值）；另须带 `expected`（草稿开始时的完整参数），与库里当前值不一致时返回 409 `config_changed`；同一请求编号重放返回当前结果，编号用于别的内容时拒绝；写入后立即生效，记事件 `transfer-pair-config`（带改前与改后）。
- 检查间隔会改变请求权重：写入前按改后的间隔重算全部配对的空闲用量，超过本进程的每分钟上限减 ADL 预留就拒绝并说明能用的最小间隔。启动时若库里的间隔让用量超过上限，只记日志与页面提示，不拒绝启动（限速器照常拒绝超额请求）。
- 配对启用中也可以修改；有未结清的划转时照样写入（已发出的划转不受影响）。

**设置页**

- 新增第四页 `#/settings`：每个配对一块，显示当前划转参数并可修改（数值输入、默认值提示、提交前确认改动项）、ADL 自动减仓与单批上限（从总览移来，总览只保留只读显示），以及“从工作台导入配对”（从总览移来）。
- 表单在服务端返回错误时保留输入并显示原因；保存成功后以服务端返回的值为准。刷新时不覆盖正在编辑的输入。
- 保存时带上草稿开始时的参数（`expected`），期间被其他页面改过就拒绝（`config_changed`），输入保留，可点“载入最新值”放弃草稿；页面数据陈旧时两个保存按钮都禁用。改参数发一条飞书通知，只列改动字段。

**验证**

- 单元测试：首次登记用配置初值、已登记保留库值并提示；接口校验、请求编号重放与复用、权重超限拒绝、评估途中改参数放弃本轮；鉴权与写请求头。
- 浏览器：替身 ASTER 上改一项参数并看到下一轮按新值规划；非法值与权重超限的提示；导入入口在设置页可用；手机宽度不溢出。

**回滚**：`sudo bash install.sh --version v0.6.0`。主库不变；旧版本启动时会用 `config.json` 的 `transfer` 覆盖页面改过的参数，回退前把页面上的值抄回 `config.json`。安装脚本自动回退到 v0.7.0 之前的版本同样会用 `config.json` 的 `transfer` 覆盖页面改过的参数，配对保持启用；建议页面改完后同步写回 `config.json`。

## 原油页样式（v0.8.1）

原油页（`web/src/OilPage.tsx`）按旧工作台原油交易页（`OilTradingPage` / `TradingSpread` / `TradingExecution`）的结构排版：价差与持仓并排，下面是额度、任务和下单表单，确认前在表单上方显示预览卡片。样式从工作台复制到 `web/src/trading.css`，来源是 `src/trading.css`（提交 `a12e583`）和 `src/trading-execution.css`（提交 `1d06abd`），只保留原油页用到的规则，规则内容不改。本服务另需的样式写在 `styles.css` 末尾的原油页一节。数据读取、请求编号和确认逻辑都没改。

**回滚**：`sudo bash install.sh --version v0.8.0`。只改页面，不改接口、数据库和配置。

## ASTER 页面按工作台重排（F4）

2026-11-13 按《页面开发规则》第 2 条返工：F1–F3 的 ASTER 页面是照本仓库旧的手写页迁移的，没有照工作台 ASTER 模块排版。只改页面，不改接口、执行逻辑、数据库和配置。

**对照的工作台页面**：`modules/aster/dashboard`（提交 `b2fae14`）的 `app/page.tsx`（顶栏、页头、功能标签）、`components/pairs-workspace.tsx`（配对组）、`pair-adl-panel.tsx`、`pair-account-positions.tsx`、`account-positions-table.tsx`。

**页面结构**

- 外壳照工作台 ASTER 页：顶栏品牌、页头（标题、连接状态、写者代次与更新时刻）、下划线式功能标签：配对组、运行状态、设置，配了原油时加“原油”。实盘提示条当时保留，v0.29.2 去掉（见文末）。
- 配对组（`#/`、`#/pair/<配对>`，原“总览”和“配对详情”合并）：标题行带配对选择；配对状态面板（运行指示、启用 / 停用、A/B 两侧权益与可用四格、当前划转与说明）；下面左右两栏——左栏 A、B 账户持仓（工作台持仓表的列，本服务没有的杠杆、占用保证金、强平价不显示）、两侧多空核对、余额走势，以及折叠的划转记录、ADL 事件记录、配对设置（划转参数与 ADL 设置，从设置页移来）；右栏 ADL 应急处理（已保存配置、单批上限、最近补查、当前事件与“重新开始自动减仓”）和保证金平衡（说明、最后划转、最近检查、触发差额与单次范围、转出侧保留）。
- 设置页只剩“从工作台导入”与请求权重说明；运行状态页内容不变，改用同一套面板样式。

**样式**

- `web/src/aster.css` 复制自工作台 `modules/aster/dashboard/app/globals.css`（提交 `b2fae14`）：只取上述页面用到的规则，规则内容不改；每条选择器前加 `.aster-desk ` 限定范围（工作台的 `.panel`、`.muted` 等类名与 `styles.css` 同名，不限定会改到原油页）；调色板从 `:root` 移到 `.aster-desk`；`body` 规则作用在 `.aster-desk`，标题、表格、表单元素（`h2`、`table`、`label` 等）的基础规则只作用在包住 ASTER 页内容的 `.aster-module` 内，原油页在它外面。
- 工作台 ASTER 页的按钮、下拉、表格单元格来自 shadcn（Tailwind）。本服务不引入 Tailwind：按钮沿用已复制的工作台主界面 `.button`，标签页照工作台标签的 `data-slot`/`data-active` 写法套用复制来的 `.workspace-navigation` 规则，表格单元格、输入框、开关、下拉按 `components/ui/table.tsx`、`input.tsx`、`switch.tsx`、`select.tsx` 的类名换算成普通 CSS 写在 `aster.css` 末尾并注明（开关是带 `role="switch"` 的复选框，下拉用原生 `select`）。
- 划转记录、ADL 事件记录只在展开时挂载，折叠时不轮询；配对设置第一次展开后保持挂载，点“ADL 设置”会展开它并聚焦单批上限。

**验证**：替身 ASTER 上配对组、运行状态、设置三页与原油页各走一遍；1280 与 390 宽度和工作台同页面截图对比；无 CSP 报错、手机宽度无横向溢出；启用 / 停用、保存划转参数与 ADL 设置、导入入口照常可用。

**回滚**：`sudo bash install.sh --version v0.8.1`。只改页面。

## 日志页与定时摘要状态（v0.10.0）

**对照的工作台页面**：工作台没有日志页，按《页面开发规则》第 2 条用本服务运行状态页的部件拼：`panel` + `section-head`、按钮组（同余额走势的时间范围按钮，`aria-pressed`）、`table.data`、分页历史（`paged-history.ts`，与划转记录同一套“最新一页 5 秒刷新、更早的按需读取”）、`StateViews.tsx` 的加载与错误状态。

**页面**

- 新标签「日志」（`#/logs`，在 `.aster-module` 内，与运行状态同级）：时间、级别（告警 / 问题 / 信息）、内容三列，新到旧；按钮切换“全部”和“告警与问题”（分别读 `/api/logs`、`/api/logs/problems`）；底部“加载更早的记录”。级别由服务端按行首“告警：”与失败、出错、断开等关键词判断。
- 运行状态页在飞书发件箱下加「飞书定时运行摘要」：间隔与发往哪个机器人（定时机器人或告警机器人）、下次发送、最近成功、最近错误。

**样式**：只在 `styles.css` 加两条 `table.data.log-table` 规则：内容列换行显示（等宽字体），手机宽度表格不设最小宽度，避免日志表横向滚动。

**回滚**：`sudo bash install.sh --version v0.9.0`（先按 README 删掉 `config.json` 的 `summary` 与 `secrets.json` 的 `feishuScheduled`；页面导入配对时会自动写入 `feishuScheduled`，自己没写过也要检查）。

## 定时摘要间隔在设置页修改（v0.10.1）

**对照的工作台页面**：工作台的定时通知间隔只在环境变量里改；表单照本服务「配对设置」的写法（`pair-settings-form form-stack` + `settings-form-grid`、字段下方 `small` 提示、错误在按钮上方、成功在按钮旁），外层用 `execution-live-state` 留边距。

**页面**

- 设置页在「从工作台导入」下加「飞书定时运行摘要」：间隔（分钟，0 关闭）、「保存间隔」（没改不可点）、「立即发送一张」（未配置机器人或已关闭时不可点）、「撤销修改」。右上角写发往定时机器人还是告警机器人。
- 保存后页面的值优先于 `config.json` 的 `summary.intervalMinutes`，重启后保留；下一张在一个间隔之后。立即发送在几秒内发出（服务刚启动约 2 分钟内会等持仓与余额读到），之后按间隔继续。
- 运行状态页的摘要面板写出间隔来自页面还是 `config.json`，「最近成功」后写发到了哪个机器人。

**接口**：`POST /api/summary/interval`（`{"intervalMinutes": n}`，0–1440 整数）、`POST /api/summary/send`（`{}`），都要登录与页面请求标记，返回摘要状态。

**回滚**：`sudo bash install.sh --version v0.10.0`。页面设置的间隔存在 `notify.sqlite` 新加的列里，v0.10.0 不读，回滚后按 `config.json` 的间隔发送。

## 期权页（v0.11.0）

**对照的工作台页面**：工作台期权模块 `modules/greeks/app/static/index.html`、`app.js`、`style.css`（提交 `2f0593d`）。页面 `web/src/OptionsPage.tsx`，表单与计算在不依赖 DOM 的 `web/src/options-form.ts`（有单元测试）。顶部「期权」标签只在 `GET /api/options/state` 有应答时出现。

**页面**：执行台（指标行、期权链、策略腿与到期收益图、Greeks 汇总、执行控制、账户保证金健康度）、持仓（持仓、近期成交）、组合执行（进行中 / 历史任务卡片）。开平仓先生成计划，再在确认对话框核对腿、金额与净价限制并勾选后提交；请求编号沿用 `RequestIds`。RFQ 与收益统计不在本批（G2）。

**样式**

- 工作台样式复制到 `web/src/options.css`，每条规则加 `.options-desk ` 前缀，文件头写明来源与提交号；只保留本页用到的规则，规则内容不改。
- 在 `main.tsx` 里排在 `styles.css`、`aster.css` 之后引入。外壳根元素是 `.aster-desk`，`aster.css` 里 `.aster-desk .muted / .panel / .button / .count` 的规则会盖过期权页样式，所以 `styles.css` 末尾的期权页一节用 `.aster-desk .options-desk` 前缀把行高、溢出、按钮换行和计数边距恢复成工作台的样子。
- CSP 不允许行内样式：到期收益图与进度条用 SVG 画，不用 canvas 和 `style` 宽度；策略腿表在窄屏横向滚动（`.strategy-body .legs`）。
- 确认对话框的计划倒计时按收到计划时的本机时间加上计划有效期计算，不用服务器时间戳相减，避免本机与服务器时钟偏差；到期后取消勾选并禁用提交。

**导入面板**：预览列出工作台期权账户（打码 UID、能否导入及原因），勾选「导入期权账户」后随导入一起写入（默认不勾选）。

**回滚**：`sudo bash install.sh --version v0.10.1`（先按 [options.md](options.md) 第 4 节删掉 `options` 与 `bybitOptions`）。

**G2a（v0.13.0）**：执行控制底部“计划开仓”一行改为定时开仓状态（下次时间 / 窗口中 / 已关闭）和“打开定时 / 关闭定时”按钮，打开前 `confirm()` 列出时间、策略、数量、上限与 IOC 设置（文字在 `options-form.ts` 的 `autoOpenConfirm`）；提示条与“LIMIT / BBO”标记随 IOC 设置变化；委托明细执行列区分 BBO / IOC；定时任务卡片标题前加“定时”标签。工作台的定时开仓开关在环境文件里，这里是页面新增的。

**G2b 收益（v0.14.0）**：对照工作台 `modules/greeks/app/static/index.html` 的 `pane-perf`、`performance.js` 与 `style.css` 的 `performance-*` 规则（提交 0c5a219）。第四个标签“收益”（`#/options/performance`）：标题“策略实盘收益 · 按每次组合开仓累计”，工具条（同步状态、结算币种选择、刷新），四个统计数（到期组合综合净收益、纳入统计的到期组合、胜率、采样最大回撤），综合曲线，“每次开仓收益详情”与覆盖说明，每组一个可展开的 `<details>`（金额六项、说明、待核对原因、该组持仓盈亏采样曲线、逐笔成交），页脚口径说明。差异：曲线用本服务的 `SvgPlot`（工作台手画 SVG 三次曲线），断开位置由接口的 `gapBefore` 给出（抽稀后的点距不能再用来判断缺口）；每组采样曲线只在展开时画；曲线上的圆点约每 ⌈n/80⌉ 个点画一个（另加最后一点与结束点，结束点放大），采样数显示接口抽稀前的真实采样数。读取每 30 s 一次，只在本标签打开时读；读失败保留上次结果并在状态行说明。还没有数据时币种显示 USDC；所选币种与展开的组合由期权页保存，切换标签再回来不丢。样式按原规则复制到 `options.css`，加 `.options-desk ` 前缀；曲线容器的高度（280px，窄屏 240px）是本服务自己的规则 `.performance-plot`（SvgPlot 需要容器给高度）。回滚：`sudo bash install.sh --version v0.13.0`。

**G2c 组合询价（v0.17.0）**：对照工作台 `modules/greeks/app/static/index.html` 的 `pane-rfq`（第 153–176 行）、`app.js` 的 `renderRfq` / `quoteLegComparison` 与 `style.css` 的 `rfq-*` 规则（提交 2f0593d）。第五个标签“组合询价”（`#/options/rfq`，组件 `web/src/OptionsRfq.tsx`）：标题与状态标签，说明行加“创建 RFQ ↗”“取消询价”，询价 ID / 类型 / 有效期 / 报价数，每家报价一张卡（做市商与覆盖腿数、到期与剩余秒数、报价净额、链净额差、预估手续费、执行按钮、不能执行的原因，逐腿对比），执行确认对话框沿用 `trade-dialog`（腿与价格、三项金额、风险说明、勾选后提交）。差异：创建用执行台当前的策略与数量，发起前 `confirm()`；报价是否可执行、净额与手续费由服务算好，页面不自己算；确认绑定报价内容指纹（`quoteFingerprint`），报价更新后取消勾选并提示，报价消失或已提交时自动关闭；剩余秒数按服务时钟换算。读取在询价未结束时每 2 s、否则每 5 s，切走本标签即停。创建沿用 RequestIds，应答丢失时再点用同一请求编号核对。纯函数在 `options-form.ts`（`rfqCreateBody`、`rfqExecuteBody`、`rfqCreateProblem`、`rfqOpen`、`quoteFingerprint`、`quoteSecondsLeft`）。样式按原规则复制到 `options.css`，多选择器规则只取 rfq 部分，加 `.options-desk ` 前缀。回滚：先确认没有未结束的询价，再 `sudo bash install.sh --version v0.16.0`。

## 行情监控页（Monitor M-1）

**对照的工作台页面**：`modules/monitor/app/anthropic-panel.tsx`（提交 `35ebb94`）与 `spread-chart.tsx`（`4be9aa4`），按它在工作台 Hub 里嵌入显示的样子（不显示工作台顶栏）。数据规则复制自 `lib/anthropic-history.ts`（`35ebb94`）、`lib/market.ts` 与 `lib/chart-ranges.ts`（`8470785`）、`lib/chart-sampling.ts`（`7581e78`），放在 `web/src/monitor-history.ts`；走势图用已复制的 `svg-plot.tsx`。

**页面**：新标签「行情监控」（`#/monitor`，只在 `/api/monitor/state` 有应答时显示，与原油页一样在 `.aster-module` 外）：工具栏（对比合约 xyz:ANT / io:ANTH / Lighter RH、刷新）、状态行、股数说明、各类错误与快照提示、四格读数、走势图（溢价率 / 每股价差 / 每股价格，1 周 / 1 月 / 全部）、近期观察、如何比较、数据来源与覆盖范围。文案沿用工作台，股数说明改为“服务配置股数”。没做成交标记、技术指标、股数同步。

**样式**：`web/src/monitor.css`，来源是工作台 `modules/monitor/app/design-tokens.css`（`9ca6f68`，令牌放在 `.monitor-desk` 上）与 `globals.css`（`77f3cf2`，本页用到的规则，顺序与数值不改，选择器加 `.monitor-desk ` 前缀）；另有 preflight 的几条与 ASTER 外壳泄漏规则的复位，取法见 [docs/monitor.md](monitor.md) 的 M-1 实施记录。不引入 Tailwind，无内联样式（图表提示框位置沿用 `svg-plot.tsx` 的 CSSOM 写法）。

**验证**：`scripts/dev-monitor.ts` 替身行情下在浏览器里切换对比合约、图表标签、时间范围、展开来源、悬停提示；DOM 内只有 `svg-plot` 提示框的 CSSOM 定位。

**回滚**：`sudo bash install.sh --version v0.11.0`（先删掉 `config.json` 的 `monitor`）。

## 资产页（Asset A-1）

**对照的工作台页面**：`modules/asset/app`（提交 `0014655`）的 `dashboard.tsx`（页头、标签、六格汇总、资产明细表与交易所分项、分交易所合计、历史记录与出金记录）、`asset-trend.tsx`（资产变化走势、年化与上月指标、每月表现）、`daily-changes.tsx`（每日波动）、`withdrawals-panel.tsx`、`cash-flows-panel.tsx`。方案与接口见 [asset.md](asset.md)。

**页面**

- 标签“资产”（`#/asset`），只在 `/api/asset/state` 有应答（服务配置了 `asset`）时显示。页面放在 `.aster-module` 之外，外层是 `.asset-desk`；三个子页“资产总览 / 历史记录 / 出金记录”照工作台的标签排。
- 只读：工作台的同步、添加资产、改汇率、记出金、登记资金流、连接交易所等入口都不显示；顶部固定提示数据停留在导入时刻。没导入时显示空状态：指向设置页「从工作台导入」（带跳转按钮），手工导入命令作为备选。
- 与工作台不同：历史记录的“查看明细”在表格上方原位展开面板（工作台是弹窗，本页没有复制弹窗组件）；每日波动展开时才读取 `/api/asset/daily-changes`；资金流面板只有记录列表、审计历史和作废记录，没有登记表单。
- 文案与格式化（金额、过期标签、汇率状态、历史来源、交易所分项说明、每日波动排序、资金流行）照工作台写在不依赖 DOM 的 `web/src/asset-format.ts`，由 `test/asset-format.test.ts` 覆盖；合计与指标由服务端用复制来的工作台函数算好（`src/asset/views.ts`），页面不重算。
- 读取用 `use-live-resource.ts`：状态、账本与历史每 60 秒重读（总览的走势也用历史），出金记录只在出金子页读取；资金流随总览读一次、每日波动展开时读一次，都不定时重读（导入后数据只在重新导入时变）。走势图用 `svg-plot.tsx`。

**样式**

- `web/src/asset.css` 复制自工作台 `modules/asset/app/globals.css`（提交 `0014655`），只取上述页面用到的规则，规则内容不改；每条选择器前加 `.asset-desk ` 限定范围；`:root` 调色板与字体移到 `.asset-desk`（工作台的 `--card`、`--primary`、`--border` 等与 `styles.css`、`aster.css` 同名，在资产页内按工作台取值）；工作台内嵌模式（`.hub-embedded`）下的页头与页面留白规则直接作为本页规则。`main.tsx` 里排在 `aster.css` 之后。
- 工作台这些页面的表格与标签来自 shadcn（`components/ui/table.tsx`、`tabs.tsx`）。本服务不引入 Tailwind，按其类名换算成普通 CSS 写在 `asset.css` 末尾并注明；本页另需的少量规则（原位明细面板、导入命令、资金流列表、走势浮层边框）写在最后一节。与 `aster.css` 一样放在模块自己的 CSS 文件末尾，而不是 `styles.css`，因为它们都限定在 `.asset-desk` 内。

**验证**：`node scripts/asset-demo.ts` 的假数据上，无头浏览器 1440 与 390 宽度走过总览（明细展开、每日波动展开）、历史记录（查看明细）、出金记录；无页面错误，390 宽度三页都没有横向溢出。未与工作台同页面并排截图对比（本机没有运行中的工作台资产页）。

**回滚**：`sudo bash install.sh --version v0.11.0`，回退前先删掉 `config.json` 里的 `asset`。

## 资产页写入（Asset A-2，v0.16.0）

**对照的工作台页面**：`modules/asset/app`（提交 `0014655`）`dashboard.tsx` 的编辑弹窗与汇率弹窗、KPI 里的 `kpi-edit` 按钮、资产表的编辑按钮，`withdrawals-panel.tsx` 的登记 / 修改 / 删除，`cash-flows-panel.tsx` 的登记与修改 / 作废表单。行为与接口见 [asset.md](asset.md) 的 A-2。

- 弹窗改为原位面板（`.edit-panel`），字段、文案、按钮与工作台相同。差异：汇率说明（自动更新未接入）与只读文案的删改（见 asset.md）；编辑与汇率面板保存时按钮显示“正在保存”、取消按钮禁用；汇率输入加 `max=1000`、资金流日期加 `max`（今天），与服务端校验一致；资金流表单打开时隐藏“登记资金流”按钮；工作台弹窗是模态的，本页几个面板可同时展开，所以报错只显示在发起写入的那个面板里。
- 样式：`.form-grid`（含 `.checkbox-label`）、`.form-actions`、`.row-actions`、`.kpi-edit`、`.button.primary` 与两条宽度媒体查询复制自工作台 `globals.css`（`0014655`），加 `.asset-desk ` 前缀，放在 `asset.css` 写入表单一节；原位面板、表单里的 `select` 与勾选框里的输入框、资金流面板里的缩小字号、“已保存”提示写在文件末尾的本服务规则。
- 验证：`scripts/asset-demo.ts` 假数据上无头浏览器 1280 与 390 宽度走过全部写入；390 宽度无横向溢出（出金表在表格容器内横向滚动，同工作台）；无页面错误。本机无头浏览器没有中文字体，截图只用来看版式。

## 资产页同步与交易所连接（Asset A-3/A-4，v0.19.0）

**对照的工作台页面**：`modules/asset/app`（提交 `0014655`）`dashboard.tsx` 的“刷新资产”按钮与 `startRefreshLoop`（`lib/refresh-loop.ts`）、侧栏“数据连接”、“交易所连接”视图与连接弹窗，`aster-accounts-panel.tsx` 的 Aster 多账号。行为与接口见 [asset.md](asset.md) 的 A-3。

- 同步：页面打开、可见且联网时每 60 秒 `POST /api/asset/sync`，回到前台、重新联网时立即同步一次（`web/src/asset-refresh-loop.ts` 原样复制工作台 `refresh-loop.ts`）。同步占用页面唯一的写入名额：期间表单按钮禁用；自动同步遇到写入进行中直接跳过，页面隐藏时中止；自动同步的 409（账本正被另一次同步或导入占用）等下一分钟，不提示。手动“刷新资产”成功后提示“已完成刷新，更新状态见资产明细”，失败在提醒条显示“同步失败”。超时：同步 80 秒，连接与 Aster 账号 60 秒，其它写入 20 秒（同工作台）。
- 连接视图：新增“交易所连接”标签（未连接数显示为“N 待连接”），卡片、说明、按钮文案与工作台相同。连接弹窗改为视图顶部整行展开的面板（`.connect-panel`），字段按交易所区分：Var 填 vr-token，Hyperliquid、Lighter RH 填地址，其余 API Key + Secret，OKX 加 Passphrase，Bybit 加账户地区（原生 `select`）。Aster 新增 / 更新 / 移除确认改为账号卡片内的原位面板。差异：Var 的“测试访问”诊断未移植；面板多一个“取消”按钮；Aster 新账号 id 用 `newRequestId()`（页面走 http 时没有 `crypto.randomUUID`）。
- 总览：侧栏由 A-1 的“分交易所合计”恢复为工作台的“数据连接”（每行点开对应连接，Aster 跳到连接视图），交易所资产 KPI 显示“N 个账户待连接 / 账户已连接”，汇率面板文案恢复工作台原文，页脚加各视图说明。
- 样式：`.connections-grid`、`.connection-card*`、`.aster-*`、`.loading-spin`、`.section-note`、`.exchange-mark.virtual` 复制自工作台 `globals.css`（`0014655`，行号见 `asset.css` 注释），规则与先后次序不改，加 `.asset-desk ` 前缀；连接面板整行展开与 Aster 卡片内面板的规则写在 `asset.css` 末尾。

## 导入面板：行情监控与资产账本

设置页「从工作台导入」预览多两块：行情监控（本项目是否已启用、工作台有无 Monitor、股数取默认值的说明）与资产账本（本项目是否已启用与上次导入、工作台账本路径、每个用户的条数与能否导入，多个用户时单选）；勾选「启用行情监控」「导入资产账本」后随导入一起写入，默认不勾选，只勾这两项也可以。只重新导入资产账本时按钮为「导入所选」（不重启服务）。请求体、按钮文案与确认文案在不依赖 DOM 的 `web/src/import-form.ts`，由 `test/import-form.test.ts` 覆盖。方案见 [module-import.md](module-import.md)。

**回滚**：见 [module-import.md](module-import.md) 第 8 节（配置格式与库结构都没变，回退后改用备选方式）。

## 原油自动规则区块（O2a）

原油页下单表单下方新增「自动开平仓」区块（`web/src/OilRules.tsx`），结构与文案照工作台 `src/TradingAutoRules.tsx`，样式从工作台 `src/trading-execution.css` 第 287–311 行（提交 `1d06abd`）原样复制到 `trading.css` 末尾。差异：只有观察模式，表单没有“保存后立即启用实盘”与实盘确认；卡片的“每日最多开仓”注明转实盘后生效。读取每 3 秒一次（`/api/oil/rules`），读失败或数据超过 16 秒未更新时停用写按钮；写请求返回后直接用应答里的新视图，应答不确定或修订号冲突（409）时重新读取。表单到请求体的换算与校验在不依赖 DOM 的 `web/src/oil-rules-form.ts`，由 `test/oil-rules-form.test.ts` 覆盖。规则语义见 [oil.md](oil.md) 第 7 节。

**验证**：替身 Binance / Bybit 上新建只观察规则，晃动 BZ 盘口后按连续次数记录信号；1280 与 390 宽度无横向溢出、无 CSP 报错。

**回滚**：`sudo bash install.sh --version v0.17.0`。不用改配置；`oil-rules.sqlite` 留在数据目录，旧版本不读。

## 行情监控页：原油价差（Monitor M-2a，v0.20.0）

**对照的工作台页面**：`modules/monitor/app/oil-panel.tsx`（提交 `9c652bc`）按它在 Hub 里嵌入显示的样子（不显示顶栏），走势图同 M-1 的 `spread-chart.tsx`（`4be9aa4`）；数据规则复制自 `lib/oil-history.ts` 与 `lib/oil-chart-config.ts`（`89f26e5`），放在 `web/src/monitor-oil.ts`；市场标签照 `app/monitor-hub.tsx`（`77f3cf2`）的 `hub-market-nav`。

**页面**：「行情监控」页配了两个以上市场时顶部显示市场标签（Anthropic / 原油），选中的记在浏览器里。原油面板（`web/src/MonitorOil.tsx`）：工具栏、状态行、错误与快照提示、缺口提示、四格读数（当前价差、布伦特、WTI、区间平均价差）、走势图（价差 / 价格对比，1 周 / 1 月 / 全部）、近期观察、如何比较、数据来源与覆盖范围，文案沿用工作台，来源说明按本服务的采集方式改写。走势图从 `MonitorPage.tsx` 移到共用的 `web/src/MonitorChart.tsx`，标签由各市场图表配置的 `modes` 给出。没做：多空资金费图（M-2d）、指标（M-2e）、成交标记、Hub 概览卡片。

**样式**：市场标签的规则取自工作台 `globals.css`（`77f3cf2`），追加在 `web/src/monitor.css` 末尾（去掉 shadcn 的 `[data-slot]`，标签行在 `.monitor-main` 内，左右外边距为 0）；原油面板与 Anthropic 用同一组规则。无内联样式。

**验证**：`scripts/dev-monitor.ts` 替身行情下 1280 与 390 宽度切换市场、图表标签、时间范围，悬停提示，刷新后记住所选市场；无横向溢出、无 CSP 报错（控制台只有未配置模块的入口探测 404）。

**回滚**：`sudo bash install.sh --version v0.19.0`（先删掉 `config.json` 的 `monitor.oil`）。

## 行情监控页：海力士溢价（Monitor M-2b，v0.21.0）

**对照的工作台页面**：`modules/monitor/app/dashboard.tsx`（提交 `9c652bc`）按它在 Hub 里嵌入显示的样子（不显示顶栏），走势图同 M-1 的 `spread-chart.tsx`（`4be9aa4`，`HYNIX_SPREAD_CHART` 去掉指标周期、填充与成交标记）；历史提示复制自 `lib/market-service.ts` 的 `describeMarket`（`8470785`），放在 `web/src/monitor-hynix.ts`。

**页面**：市场标签多一个“海力士”。海力士面板（`web/src/MonitorHynix.tsx`）：工具栏、状态行、错误与快照提示、缺口与过时提示、四格读数（当前 ADR 溢价率、ADR、正股 ÷ 10、区间平均溢价率）、走势图（溢价率 / 美元价差 / 价格对比，1 周 / 1 月 / 全部，默认全部）、近期观察、如何比较、数据来源与覆盖范围，文案沿用工作台，来源说明按本服务的采集方式改写。没做：多空资金费图（M-2d）、指标（M-2e）、成交标记、Hub 概览卡片。

**样式**：与 Anthropic、原油面板用同一组规则，没有新增。无内联样式。

**验证**：`scripts/dev-monitor.ts` 替身行情下 1280 与 390 宽度切换到海力士、三个图表标签，刷新后记住所选市场；无横向溢出（390 宽度近期观察表在表格容器内横向滚动，同原油），控制台只有未配置模块的入口探测 404。

**回滚**：`sudo bash install.sh --version v0.20.0`（先删掉 `config.json` 的 `monitor.hynix`）。

## 行情监控页：多交易所对比（Monitor M-2c，v0.23.0）

**对照的工作台页面**：`modules/monitor/app/exchange-comparison.tsx`（提交 `568a20d`）与 `hooks/use-exchange-quotes.ts`（`8470785`），放在原油、海力士详情的图表组之后、近期观察之前（同工作台 `app/oil-panel.tsx` 的 `children` 位置）。样式复制自 `app/globals.css`（`77f3cf2`）的交易所对比规则与“旧”标签，全部加 `.monitor-desk` 前缀，追加在 `web/src/monitor.css` 末尾，去掉了资金费面板与 Hub 卡片的规则。

**页面**：`web/src/MonitorExchanges.tsx`：标题与刷新按钮、对比表（交易所 / 报价口径、两腿价格、价差、海力士多一列 ADR 溢价率、做空 / 做多价差年化）、说明、可展开的资金费周期与计算口径。每个交易所一行，各自用 `useLiveResource` 每 15 秒读一次（超时 20 秒，Lighter 冷启动要先读目录再取快照），某一家失败只影响那一行（保留上次数据并标“保留数据 · 待更新”与“旧”）。时间按 UTC 显示。年化当时不可点（M-2d-3 起可点开结算历史）；Variational 一行固定“未接入”。

**验证**：`scripts/dev-monitor.ts` 替身行情下 1280 与 390 宽度，原油 7 行、海力士 6 行齐全，展开说明、点刷新正常，无横向溢出（390 宽度按工作台改为卡片式行）；控制台只有未配置模块的入口探测 404。

**回滚**：`sudo bash install.sh --version v0.22.0`，不用改配置。

## 行情监控页：多空价差资金费（Monitor M-2d，v0.24.0）

**对照的工作台页面**：`modules/monitor/app/settled-funding-panel.tsx`（提交 `8bc3bee`），配置照 `app/oil-funding-panel.tsx` 与 `app/hynix-funding-panel.tsx`，放在原油、海力士详情的交易所对比表之后。样式复制自 `app/globals.css`（`77f3cf2`）的资金费面板规则（第 90–93、210–211、247、308–315、473 行），全部加 `.monitor-desk` 前缀，追加在 `web/src/monitor.css` 末尾。

**页面**：`web/src/MonitorFunding.tsx`（`OilFundingPanel`、`HynixFundingPanel`）与 `web/src/monitor-funding.ts`（接口校验、区间终点）：区间累计年化与累计资金费读数、小时费率 / 累计资金费 / 累计年化曲线（`SvgPlot`，悬停显示该结算时点的费率、累计与年化）、覆盖说明、状态与刷新按钮、可展开的计算口径与数据来源。时间范围与上方价差图共用同一组按钮的值。`useLiveResource` 每 5 分钟读一次（超时 30 秒），503 `not_ready` 当作载入中，503 `funding_unavailable` 显示服务给的原因；接口标 `complete: false`（分段回补中）时状态行写“正在分段回补，已到 …”，区间终点取已有的最后一次结算；“全部”的起点不早于服务的 400 天保留期。原油面板多“当前预估”（等数量 / 等名义，选择存 `localStorage` 的 `monitor:oil:basis:v1`，读写包在 try/catch 里）。

**验证**：`scripts/dev-monitor.ts` 替身行情下 1280 与 390 宽度，原油、海力士面板读数、覆盖说明、区间切换（1 周 / 1 月）、曲线切换、等名义口径、悬停提示与展开说明正常，海力士分段回补中（已到 09-08）的状态行与可点的刷新按钮正常，无横向溢出，控制台只有未配置模块的入口探测 404。

**回滚**：`sudo bash install.sh --version v0.23.0`，不用改配置。

## 行情监控页：技术指标（Monitor M-2e，v0.25.0）

**对照的工作台页面**：`modules/monitor/app/spread-chart.tsx`（提交 `4be9aa4`）的指标部分，计算复制自 `lib/indicators.ts`（`8bc3bee`，在 `src/vendor/indicators.mjs`）。样式复制自 `app/globals.css`（`77f3cf2`）第 31、33–34、196–197、247、286–290 行的指标规则，全部加 `.monitor-desk` 前缀，追加在 `web/src/monitor.css` 末尾。

**页面**：共用的 `web/src/MonitorChart.tsx` 在溢价率 / 价差标签下加技术指标开关（7 日均线、布林带 · 20 日、Z-score · 20 日）、最新读数与 Z-score 状态、主图的布林带与均线图层、悬停提示里的指标值、Z-score 小图（与主图同步悬停）和可展开的“指标怎么看”；价格标签不显示。指标先在读到的全部 K 线（所选范围加 21 天）上计算再截取范围。开关存 `localStorage` 的 `monitor:chart:<anthropic|oil|hynix>:v1`（读写包在 try/catch 里，读不到按默认全开），图表标签仍是页面状态。原油与海力士的缺口提示改为只数所选范围内的 K 线（`rangeGaps`）。

**验证**：见 [docs/reviews/2026-11-14-monitor-m2e.md](reviews/2026-11-14-monitor-m2e.md) 的浏览器验收一节。

**回滚**：`sudo bash install.sh --version v0.24.0`，不用改配置。

## 行情监控页：对比表结算历史（Monitor M-2d-3，v0.27.0）

**对照的工作台页面**：`modules/monitor/app/exchange-funding-history.tsx`（提交 `7896143`）与 `app/exchange-comparison.tsx` 的年化按钮，规则复制自 `lib/exchange-funding-*.ts`（在 `src/vendor/exchange-funding-history.mjs`）。样式复制自 `app/globals.css`（`77f3cf2`）第 7–10 行，全部加 `.monitor-desk` 前缀，追加在 `web/src/monitor.css` 末尾；累计读数用等宽数字。

**页面**：`web/src/MonitorExchanges.tsx` 的做空 / 做多年化改为按钮（`aria-expanded` / `aria-controls`，带展开箭头），同一时间只展开一家一个方向；表说明多一句“点击年化可查看最近实际结算。”。面板 `web/src/MonitorFundingHistory.tsx`：标题与刷新、收起按钮、说明、状态行（已更新 / 部分记录待更新 / 保留历史 · 待更新与采集时间、服务给的原因）、快捷区间与自定义 UTC 区间（`datetime-local`，校验无效时间与 60 天上限）、两腿各自的累计读数、覆盖说明、结算明细表与翻页。`useLiveResource` 每 5 分钟读一次，超时 75 秒（首次回补 60 天可能要十几秒），没有数据且出错时每 30 秒重试；收起时焦点回到点开它的按钮。时间全部按 UTC（工作台是北京时间）。

**验证**：见 [docs/reviews/2026-11-14-monitor-m2d3.md](reviews/2026-11-14-monitor-m2d3.md) 的浏览器验收一节。

**回滚**：`sudo bash install.sh --version v0.26.0`，不用改配置。

## 原油盈亏与资金费（O4，v0.28.0）

**对照的工作台页面**：`src/OilTradingPage.tsx` 的盈亏标签（原油四腿总盈亏、区间资金费、资金费流水）与 `src/TradingPnlChart.tsx`（提交 `a12e583`）。

**页面**：原油页自动开平仓区块下方新增 `web/src/OilPnl.tsx`，三个区块照工作台排：总盈亏（区间按钮近 1 / 7 / 30 / 90 天、五项读数、曲线与采样滑块，曲线组件照 `TradingPnlChart` 复制）、区间账单与各腿（资金费 / 平仓盈亏 / 手续费汇总、各账户持仓读取与账单同步状态、各账户各合约明细表）、账单流水（每页 50 条、上下翻页）。工作台只有资金费汇总与流水，这里汇总与流水同时列出三类账单。读取每 30 秒一次（`/api/oil/pnl`）；切换区间或翻页时保留上一次结果并提示正在读取。样式从工作台 `src/trading.css`（`a12e583`）第 77–130、187、191、211–229 行及对应手机宽度规则原样追加到 `web/src/trading.css` 末尾。口径见 [oil.md](oil.md) 第 9 节。

**验证**：模拟交易所预览（两天采样、注入资金费与一次部分平仓）上 1280 与 390 宽度无横向溢出、区间切换正常。

**回滚**：`sudo bash install.sh --version v0.27.0`，不用改配置。

## 去掉常驻的红色实盘提示条（v0.29.2）

2026-11-15 用户反馈：页面顶部常驻的红色“实盘：……”提示条看起来像出了错误。常驻说明不再用报错的红色。

- 外壳（`App.tsx`）：去掉每个页面顶部都显示的 ASTER 实盘提示条。其中“启用前请先在工作台停用并删除同一配对”在配对状态面板的说明里本来就有；划转与 ADL 的行为见 [executor.md](executor.md)。“会话已失效”的提示条不变。
- 原油页（`OilPage.tsx`）：去掉顶部的实盘提示条。“同一账户请勿同时在工作台下原油单或开启原油自动规则”移到下单预览的灰色说明末尾（确认按钮上方）；实盘下单仍在预览后由“确认并实盘开仓 / 平仓”按钮确认，上限说明原本就在该段里。
- 其余红色、黄色文字都只在真实的失败或陈旧状态下出现，未改。样式只删掉 `styles.css` 里不再用到的 `.oil-page>.callout`。
- 回滚：`sudo bash install.sh --version v0.29.1`，不改接口、配置与数据。
