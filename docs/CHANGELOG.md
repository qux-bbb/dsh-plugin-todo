# 更新日志

本项目的版本记录；每个已发布版本一节，新的在上。日期为发布日。

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
