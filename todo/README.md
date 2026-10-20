# dsh-plugin-todo

DeepSeek Harness 插件包：一个**由用户确认**的待办清单。

```js
import * as todo from 'dsh-plugin-todo'        // 宿主半：工具 + HTTP 路由 + /todo 命令
import { TodoStore } from 'dsh-plugin-todo/store'   // 存储 + 工作流状态机
import { createTodoApi } from 'dsh-plugin-todo/api' // 面板 JSON API
import 'dsh-plugin-todo/client'                    // 浏览器半（经典脚本，需 __ModuleLoader__）
```

- 存储：明文 JSON Lines，一层一个文件（`global` = `$DSH_HOME/todo/todos.jsonl`，`project` = `<项目根>/.dsh/todo/todos.jsonl`）。
- 模型工具：`todo_propose` / `todo_list` / `todo_get` / `todo_claim` / `todo_update` / `todo_submit` / `todo_complete` / `todo_void`。
- 人类命令：`/todo [add <标题> | done <id> | show <id>]`。
- 面板：侧边栏「待办」图标 + 中央 `main` 页面，数据走同进程的 `/api/todo` 路由。
  「交给 AI 完成」会先让你选**投递到哪条会话**（`当前会话` / `新建会话` / 其他会话；
  其他会话按最近更新排序，刚新建的那条排在最前）；
  全局待办还能再选**哪个项目**（既是会话列表的过滤条件，也是新会话的工作目录）。

两条不可绕过的规则（由 `lib/store.js` 的转换表强制，两端共用同一份代码）：

1. `proposed → open` 只能由**用户**在面板里 `accept`；模型不能确认自己提出的待办。
2. `done` 必须有一份用户确认记录：模型只能把 `confirmed` 的待办 `complete`；用户可以直接 `complete`，而这一动作本身就是确认，会写进 `acceptance`/`approval`。

完整说明（安装、状态机、配置、验证）见仓库根目录的 [`README.md`](../README.md)。
