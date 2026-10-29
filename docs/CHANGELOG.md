# 更新日志

本项目的版本记录；每个已发布版本一节，新的在上。日期为发布日。

## 未发布

### 待办：已完成 / 已作废也能直接维护

以前归档等于冻住：已完成的待办行内只有「重新打开」，想补一句话也得先重开；已作废的连编辑都会失败（`update` 转换排除了 `void`）。想到要补充、或者觉得作废的事还能做，都只能绕路。

- `lib/store.js`：`update` 的目标状态覆盖全部 7 个状态——它不改状态，所以编辑一条已归档的待办不会把它复活；`USER_ACTIONS.done` / `.void` 补上 `update`，面板与 API 下发的 `actions` 因此都带它。
- 已完成的待办补充后仍是「已完成」，`approval` / `completion` 记录保留；已作废的可以先修正再重开，`voided` 原因保留到重开为止。
- `lib/client.js`：展开详情新增「改状态」下拉。选项完全由服务端的 `actions` 推导，不再维护第二份状态清单：已完成/已作废 → 待办；待你接受 → 待办/已完成/已作废；待你确认 → 已完成/进行中/已作废；待你补充 → 进行中/已完成/待办/已作废。选中即执行对应动作，沿用原有的确认框与打回/作废原因输入，不新增非法状态路径。
- 模型侧不变：仍然没有 `complete`，也没有任何把待办变成 `done` 的路径。

验证：`cd todo; node --test` → 175 个测试全绿（42 suites）。

### 面板：直接看到哪些项目有待办

以前面板一次只显示一个项目，想知道别的项目有没有待办，只能逐个切过去看。

- `GET /api/todo/state` 的 `projects` 每项新增 `projectRoot` / `enabled` / `total` / `attention`：服务端按项目根只读一次待办文件，再把结果发给解析到同一个根的工作区；面板按项目根只显示一个条目，避免把同一批待办数两遍。
- 面板**标题正下方**新增「项目待办」条：列出所有有待办的项目及条数、其中多少条待你处理，末尾另列「全局」的条数与待你处理数；当前项目高亮，点项目或「全局」即切换。没有待办的项目不上条（当前项目除外），空项目不会占位。
- 标题行只保留「需要你处理 N 条」，项目/全局总数改由概览条承载，同一个数字不会出现两次。
- 项目下拉框在名称后标注条数（如 `proj · 3 条`），不动下拉也能按数字选项目。
- 概览与列表一起刷新；当前项目的数字直接取自正在显示的层级，改完待办立刻同步，其余项目在刷新/切换时更新。
- 只暴露 `global` 层级（`level: global`）时概览只列全局条目；只暴露 `project` 时没有全局条目，面板不会显示无效数字。

验证：`cd todo; node --test` → 170 个测试全绿（42 suites）。

### 修复：「交给 AI 完成」只属于还没开工的待办

点过「交给 AI 完成」之后待办进入 `working`（面板显示「AI 进行中」），但行内和展开后的详情里还留着同一个按钮——再点一次会把同一件事重复投递给另一个会话。`blocked`（待你补充）也一样：它卡在等你回答，换会话替不了你回答，而投递后的 `claim` 还会把 AI 的提问清成 `null`，等于白点。

- `lib/store.js`：`USER_ACTIONS` 里只有 `open` 保留 `request`（含义是“交给 AI 开始做”）；`working` / `blocked` 改为提供 `reopen`，即「重开待办」——把待办退回 `open`，由用户显式决定重新开始。`reopen` 会清掉认领标记、待答提问和待确认提交（历史里仍留有记录），`accepted` 保留。
- `lib/client.js`：展开详情里的「交给 AI 完成」不再由写死的状态清单决定，改为读服务端返回的 `actions`，与行内按钮同源；`working` / `blocked` 上的 `reopen` 显示为「重开待办」，点按前二次确认（会丢掉 AI 的进展与提问），`done` / `void` 上仍是「重新打开」。
- `test/*`：动作表断言同步；新增重开已开工待办的状态机用例、渲染用例（进行中/待补充都不出交付入口且都有「重开待办」）与确认框用例；全交叉矩阵的拒绝对数下限随动作表下调（56 通过 / 98 拒绝）。

验证：`cd todo; node --test` → 173 个测试全绿（42 suites）。

## v0.1.1 — 2026-10-24

修复 DSH `0.2.1-rc.3` 及以后版本上的启动崩溃。

### 问题

`0.2.1-rc.3` 起，浏览器端模块系统按 `package.json` 的包名给每个插件分配 entry id；而 0.1.0 的 `lib/client.js` 仍用改名前的 `dsh-plugin-todo` 注册 factory。宿主按 `@qux-bbb/dsh-plugin-todo` 查不到 factory，于是再执行一次 bundle，第二次注册撞上已存在的 id，抛出 `duplicate factory registration`，整个 web boot 失败（`1 entry did not activate`），桌面端随即触发 profile 恢复。

### 修复

- `lib/client.js`：`window.__ModuleLoader__.load({ id })` 改为包名 `@qux-bbb/dsh-plugin-todo`。
- `lib/client.js`：样式节点的 `data-plugin` 同步为包名，保证热重载/禁用时样式能被正确认领和清理。
- `test/client.test.js`：注册 id 与 `data-plugin` 的断言改为对照 `package.json` 的 `name`，防止后续改名再次漂移。

### 验证

- `node --test`（165 个测试、42 suites）全绿。
- `node scripts/smoke-runtime.mjs` → PASS。
- 用真实 loader 在隔离 profile 上 `--dump-config`，todo 条目正常组合、路径解析为 `file:///.../plugins/todo/lib/index.js`。

### 升级

已装 0.1.0 的用户请升级：

```powershell
npm install @qux-bbb/dsh-plugin-todo@0.1.1
```

或重新运行 `scripts/install-todo.mjs --profile desktop`。0.1.0 已在 npm 上标记为 deprecated。

## v0.1.0 — 2026-10-24

首个公开版本：DeepSeek Harness（DSH）的**由人确认的待办清单**插件。

### 发布渠道

- GitHub Release：<https://github.com/qux-bbb/dsh-plugin-todo/releases/tag/v0.1.0>
- npm：`@qux-bbb/dsh-plugin-todo@0.1.0`

### 功能

- **7 状态工作流**：`proposed → open → working → review → done`，另有 `blocked`（等回答）与 `void`（作废，可重开）。
- **两条硬规则**写在 `lib/store.js` 的状态机里：
  1. `proposed → open` 只能由用户在面板里 `accept`，模型不能确认自己提的待办；
  2. 只有用户能收尾：模型最多 `todo_submit` 把待办交到 `review`，用户 `confirm` **即完成**（确认动作本身写入 `approval`），模型没有任何路径把待办标成 `done`。
- **7 个模型工具**：`todo_propose`、`todo_list`、`todo_get`、`todo_claim`、`todo_update`、`todo_submit`、`todo_void`；另有 `/todo` 命令（`add` / `done` / `show`）。
- **面板**：侧边栏「待办」+ 中央页面；3 个筛选分组（待我处理 / 进行中 / 全部）、搜索、手动添加、查看/编辑详情、行内操作；状态全部中文展示。
- **交给 AI 完成**：可选择投递到当前会话、新建会话或其他会话（冷会话也能投；其他会话按最近更新排序），全局待办还能选项目。
- **存储**：明文 JSONL，两级目录——`<DSH_HOME>/todo/todos.jsonl`（全局）与 `<项目根>/.dsh/todo/todos.jsonl`（项目）。
- **安装脚本**：`scripts/install-todo.mjs` 把插件拷进 profile 并写入带首尾标记的托管 patch 条目，支持 `--dry-run` / `--verify` / `--uninstall` / `--scope home` 等；只用 Node 内置模块，无需 `npm install`。

### 相对初始提交的变更

- 状态机 8 → 7：去掉没有独立信息量的 `confirmed` 中间态，用户确认即完成；模型工具 8 → 7（`todo_complete` 下线）。
- 面板筛选页签 10 → 3 个分组，不再一个状态一个页签。
- 「需要你处理」的判定收敛到服务端一处：`summarize` 输出 `attention`，面板只读该字段。
- 修复 `npm test` 在 Node 22+ 上失败的问题（`node --test` 传目录参数会被当作 glob 匹配到目录本身），改用默认发现。
- 分发前补齐 MIT `LICENSE` 与本更新日志。

### 验证

- `cd todo; npm test` → **165 个单元测试全绿**（42 suites）。
- `node scripts/smoke-runtime.mjs` → 真实 Cordis 运行时端到端冒烟通过（含「模型提交 → 用户确认即完成」全流程、两条硬规则、面板 API、会话投递）。

### 安装

```powershell
git clone https://github.com/qux-bbb/dsh-plugin-todo.git
cd dsh-plugin-todo
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\install-todo.mjs --profile desktop
```

前置条件：DSH 至少启动过一次（`$DSH_HOME` 与自带 Node 运行时是那时建好的）。装完重启一次应用。详见根目录 `README.md`。
